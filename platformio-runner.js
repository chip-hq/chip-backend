// platformio-runner.js
// Compiles ESP32 Arduino source code using PlatformIO CLI.
// Creates an isolated temp project per job, compiles, and returns the .bin.
//
// Usage:
//   import { compileFirmware } from './platformio-runner.js';
//   const result = await compileFirmware({ source, board, jobId, onLog });

import { spawn } from 'child_process';
import { mkdtemp, writeFile, readFile, rm, access, mkdir } from 'fs/promises';
import { constants, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

// Known PlatformIO board IDs for common ESP32 variants.
const BOARD_MAP = {
  esp32: 'esp32dev',
  esp32dev: 'esp32dev',
  esp32s2: 'esp32-s2-saola-1',
  esp32s3: 'esp32-s3-devkitm-1',
  esp32c3: 'esp32-c3-devkitm-1',
};

// Probe common locations where pip may have installed pio.exe on Windows.
// pip often drops scripts into an MS Store Python's LocalCache which is NOT on PATH.
const WINDOWS_PIO_CANDIDATES = [
  // MS Store Python 3.12 (most common in 2024-25)
  join(
    homedir(),
    'AppData',
    'Local',
    'Packages',
    'PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0',
    'LocalCache',
    'local-packages',
    'Python312',
    'Scripts',
    'pio.exe'
  ),
  // MS Store Python 3.11
  join(
    homedir(),
    'AppData',
    'Local',
    'Packages',
    'PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0',
    'LocalCache',
    'local-packages',
    'Python311',
    'Scripts',
    'pio.exe'
  ),
  // Traditional Python install
  join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'Scripts', 'pio.exe'),
  join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'Scripts', 'pio.exe'),
  join(homedir(), 'AppData', 'Roaming', 'Python', 'Python312', 'Scripts', 'pio.exe'),
  join(homedir(), 'AppData', 'Roaming', 'Python', 'Python311', 'Scripts', 'pio.exe'),
];

/**
 * Find the pio executable. On Windows, pip often installs into a Scripts dir
 * that isn't on PATH; we probe known locations before falling back to 'pio'.
 * @returns {Promise<{cmd: string, args: string[]}>}
 */
async function resolvePio() {
  if (process.platform !== 'win32') {
    // -j 1 ensures single-thread compilation to stay strictly within 512MB RAM on free cloud instances
    return { cmd: 'pio', args: ['run', '-j', '1'] };
  }
  for (const candidate of WINDOWS_PIO_CANDIDATES) {
    try {
      await access(candidate, constants.X_OK);
      return { cmd: candidate, args: ['run', '-j', '1'] };
    } catch {
      // not found or not executable — try next
    }
  }
  // Last resort: invoke via cmd so PATH is re-evaluated by the shell
  return { cmd: 'cmd', args: ['/c', 'pio', 'run', '-j', '1'] };
}



// The platformio.ini template for an Arduino-framework ESP32 project.
function buildIni(boardId) {
  return `[env:target]
platform = espressif32
board = ${boardId}
framework = arduino
monitor_speed = 115200
build_flags = -DCORE_DEBUG_LEVEL=0
`;
}

// Locate the compiled firmware binary inside the PlatformIO build tree.
function findBin(projectDir) {
  // Standard build path for a named env called "target"
  const standard = join(projectDir, '.pio', 'build', 'target', 'firmware.bin');
  if (existsSync(standard)) return standard;
  return null;
}

/**
 * Compile Arduino/ESP32 source using PlatformIO.
 *
 * @param {object} opts
 * @param {string}   opts.source   - C++ source code (Arduino sketch)
 * @param {string}  [opts.board]   - Board slug (default: "esp32")
 * @param {string}  [opts.jobId]   - Job ID for log labeling
 * @param {Function}[opts.onLog]   - Called with each log line as it arrives
 * @param {number}  [opts.timeout] - Compile timeout in ms (default: 120 000)
 * @returns {Promise<{binBase64:string, binSize:number, durationMs:number, log:string[]}>}
 */
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

  // Create an isolated temp directory for this compile job.
  const projectDir = await mkdtemp(join(tmpdir(), `chip-build-${jobId}-`));
  emit(`[COMPILE] Project dir: ${projectDir}`);
  emit(`[COMPILE] Board: ${boardId}`);

  try {
    // Write platformio.ini and the user's source.
    await writeFile(join(projectDir, 'platformio.ini'), buildIni(boardId), 'utf8');

    const srcDir = join(projectDir, 'src');
    await mkdir(srcDir, { recursive: true });

    // Arduino sketch compatibility: ensure <Arduino.h> is included
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

    // Read the compiled binary.
    const binPath = findBin(projectDir);
    if (!binPath) {
      throw new Error('Compile succeeded but firmware.bin not found in .pio/build/target/');
    }

    const binBuf = await readFile(binPath);
    const binBase64 = binBuf.toString('base64');
    const durationMs = Date.now() - startMs;

    emit(`[COMPILE] Done — ${binBuf.length} bytes in ${(durationMs / 1000).toFixed(1)}s`);

    return { binBase64, binSize: binBuf.length, durationMs, log };
  } finally {
    // Always clean up the temp directory.
    rm(projectDir, { recursive: true, force: true }).catch(() => {});
  }
}
