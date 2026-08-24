import { spawn } from 'child_process';
import { writeFile, readFile, access, mkdir } from 'fs/promises';
import { constants, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const BOARD_MAP = {
  esp32: 'esp32dev',
  esp32dev: 'esp32dev',
  esp32s2: 'esp32-s2-saola-1',
  esp32s3: 'esp32-s3-devkitm-1',
  esp32c3: 'esp32-c3-devkitm-1',
};

const WINDOWS_PIO_CANDIDATES = [
  join(homedir(), 'AppData', 'Local', 'Packages', 'PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0', 'LocalCache', 'local-packages', 'Python312', 'Scripts', 'pio.exe'),
  join(homedir(), 'AppData', 'Local', 'Packages', 'PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0', 'LocalCache', 'local-packages', 'Python311', 'Scripts', 'pio.exe'),
  join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'Scripts', 'pio.exe'),
  join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'Scripts', 'pio.exe'),
  join(homedir(), 'AppData', 'Roaming', 'Python', 'Python312', 'Scripts', 'pio.exe'),
  join(homedir(), 'AppData', 'Roaming', 'Python', 'Python311', 'Scripts', 'pio.exe'),
];

async function resolvePio() {
  if (process.platform !== 'win32') {
    return { cmd: 'pio', args: ['run'] };
  }
  for (const candidate of WINDOWS_PIO_CANDIDATES) {
    try {
      await access(candidate, constants.X_OK);
      return { cmd: candidate, args: ['run'] };
    } catch {
      // try next candidate
    }
  }
  return { cmd: 'cmd', args: ['/c', 'pio', 'run'] };
}

function buildIni(boardId) {
  return `[env:target]
platform = espressif32
board = ${boardId}
framework = arduino
monitor_speed = 115200
build_flags = -DCORE_DEBUG_LEVEL=0
`;
}

function findBin(projectDir) {
  const standard = join(projectDir, '.pio', 'build', 'target', 'firmware.bin');
  if (existsSync(standard)) return standard;
  return null;
}

export async function compileFirmware({
  source,
  board = 'esp32',
  jobId = 'unknown',
  onLog = () => {},
  timeout = 300_000,
} = {}) {
  const boardId = BOARD_MAP[board.toLowerCase()] ?? 'esp32dev';
  const startMs = Date.now();
  const log = [];

  const emit = (line) => {
    log.push(line);
    onLog(line);
  };

  const cacheBase = join(homedir(), '.chip-build-cache');
  const projectDir = join(cacheBase, boardId);
  await mkdir(projectDir, { recursive: true });

  emit(`[COMPILE] Project dir: ${projectDir}`);
  emit(`[COMPILE] Board: ${boardId}`);

  await writeFile(join(projectDir, 'platformio.ini'), buildIni(boardId), 'utf8');

  const srcDir = join(projectDir, 'src');
  await mkdir(srcDir, { recursive: true });

  const preparedSource = source.includes('Arduino.h')
    ? source
    : `#include <Arduino.h>\n${source}`;

  await writeFile(join(srcDir, 'main.cpp'), preparedSource, 'utf8');

  emit('[COMPILE] Running: pio run …');

  const { cmd, args } = await resolvePio();
  emit(`[COMPILE] Spawning: ${cmd} ${args.join(' ')}`);
  const child = spawn(cmd, args, { cwd: projectDir, env: { ...process.env } });

  await new Promise((resolve, reject) => {
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Compile timed out after ${timeout / 1000}s`));
    }, timeout);

    const handleData = (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        if (line.trim()) emit(line);
      }
    };

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`pio run exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(new Error(`Failed to start pio: ${err.message}. Is PlatformIO installed? Run: pip install platformio`));
    });
  });

  const binPath = findBin(projectDir);
  if (!binPath) {
    throw new Error('Compile succeeded but firmware.bin not found in .pio/build/target/');
  }

  const firmwareBuf = await readFile(binPath);
  const bootloaderPath = join(projectDir, '.pio', 'build', 'target', 'bootloader.bin');
  const partitionsPath = join(projectDir, '.pio', 'build', 'target', 'partitions.bin');

  let finalBuf = firmwareBuf;
  let flashOffset = '0x10000';

  if (existsSync(bootloaderPath) && existsSync(partitionsPath)) {
    try {
      const bootloaderBuf = await readFile(bootloaderPath);
      const partitionsBuf = await readFile(partitionsPath);
      const mergedSize = 0x10000 + firmwareBuf.length;
      const mergedBuf = Buffer.alloc(mergedSize, 0xff);
      bootloaderBuf.copy(mergedBuf, 0x1000);
      partitionsBuf.copy(mergedBuf, 0x8000);
      firmwareBuf.copy(mergedBuf, 0x10000);

      finalBuf = mergedBuf;
      flashOffset = '0x0';
      emit(`[COMPILE] Built complete self-booting merged image (${mergedBuf.length} bytes @ 0x0)`);
    } catch (err) {
      emit(`[COMPILE] Note: Merging bootloader skipped: ${err.message}`);
    }
  }

  const binBase64 = finalBuf.toString('base64');
  const durationMs = Date.now() - startMs;

  emit(`[COMPILE] Done — ${finalBuf.length} bytes in ${(durationMs / 1000).toFixed(1)}s`);

  return { binBase64, binSize: finalBuf.length, offset: flashOffset, durationMs, log };
}
