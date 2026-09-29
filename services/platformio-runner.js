import { spawn } from 'child_process';
import { writeFile, readFile, access, mkdir, rm } from 'fs/promises';
import { constants, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import {
  inferLibrariesFromSource,
  librariesForComponents,
} from './hardware-components.js';
import { resolveBoard } from './platforms.js';

const MAX_LIBRARIES = 25;

/** Override with CHIP_BUILD_CACHE_DIR for a persistent volume in production. */
export const CACHE_BASE = process.env.CHIP_BUILD_CACHE_DIR
  ? process.env.CHIP_BUILD_CACHE_DIR
  : join(homedir(), '.chip-build-cache');

/** Shared PlatformIO lib_deps install cache (separate from per-job project trees). */
export const LIB_CACHE_DIR = join(CACHE_BASE, 'libraries');

const WINDOWS_PIO_CANDIDATES = [
  join(homedir(), 'AppData', 'Local', 'Packages', 'PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0', 'LocalCache', 'local-packages', 'Python312', 'Scripts', 'pio.exe'),
  join(homedir(), 'AppData', 'Local', 'Packages', 'PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0', 'LocalCache', 'local-packages', 'Python311', 'Scripts', 'pio.exe'),
  join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'Scripts', 'pio.exe'),
  join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'Scripts', 'pio.exe'),
  join(homedir(), 'AppData', 'Roaming', 'Python', 'Python312', 'Scripts', 'pio.exe'),
  join(homedir(), 'AppData', 'Roaming', 'Python', 'Python311', 'Scripts', 'pio.exe'),
  join(homedir(), '.platformio', 'penv', 'Scripts', 'pio.exe'),
];

const LIB_RESOLVE_PATTERNS = [
  /UnknownPackageError/i,
  /Could not find the package/i,
  /Unable to resolve/i,
  /LibraryNotFound/i,
  /PackageNotFound/i,
  /VCSBaseException/i,
  /Error:\s+Could not find/i,
  /Library Manager:\s+.*not found/i,
  /Unknown library/i,
  /No such package/i,
  /Could not install.*(library|package)/i,
];

const NETWORK_FAILURE_PATTERNS = [
  /HTTPSConnectionPool/i,
  /ConnectionError/i,
  /NewConnectionError/i,
  /NameResolutionError/i,
  /Failed to establish a new connection/i,
  /Temporary failure in name resolution/i,
  /Max retries exceeded/i,
  /Read timed out/i,
  /ConnectTimeout/i,
  /SSLError/i,
  /urlopen error/i,
  /Could not connect/i,
  /Network is unreachable/i,
];

export class LibraryResolveError extends Error {
  constructor(message, { unresolved = [], log = [] } = {}) {
    super(message);
    this.name = 'LibraryResolveError';
    this.code = 'LIBRARY_RESOLVE';
    this.unresolved = unresolved;
    this.log = log;
  }
}

export class LibraryNetworkError extends Error {
  constructor(message, { log = [] } = {}) {
    super(message);
    this.name = 'LibraryNetworkError';
    this.code = 'LIBRARY_NETWORK';
    this.log = log;
  }
}

/** Serialize pio runs so shared libdeps_dir installs cannot corrupt each other. */
let compileChain = Promise.resolve();

function withCompileLock(fn) {
  const run = compileChain.then(fn, fn);
  // Keep the chain alive even if a job fails
  compileChain = run.then(() => {}, () => {});
  return run;
}

async function resolvePio() {
  if (process.platform !== 'win32') {
    // Docker / Linux production image puts pio on PATH via /.platformio/penv/bin
    return { cmd: 'pio', argsPrefix: [] };
  }
  for (const candidate of WINDOWS_PIO_CANDIDATES) {
    try {
      await access(candidate, constants.X_OK);
      return { cmd: candidate, argsPrefix: [] };
    } catch {
      // try next candidate
    }
  }
  return { cmd: 'cmd', argsPrefix: ['/c', 'pio'] };
}

function toIniPath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Normalize optional libraries / libDeps input into a clean string list.
 * Accepts PlatformIO Registry names: "ArduinoJson", "bblanchon/ArduinoJson",
 * "adafruit/Adafruit GFX Library@^1.11.0", etc.
 */
export function normalizeLibraries(libraries) {
  if (libraries == null) return [];
  if (!Array.isArray(libraries)) {
    throw new Error('"libraries" must be an array of library name strings');
  }

  const out = [];
  for (const item of libraries) {
    if (typeof item !== 'string') {
      throw new Error('Each library entry must be a string (e.g. "adafruit/Adafruit GFX Library")');
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (/[\r\n;#]/.test(trimmed)) {
      throw new Error(`Invalid library name (contains forbidden characters): ${JSON.stringify(item)}`);
    }
    // Block path-like / shell-ish injection while still allowing owner/name and https git URLs
    if (
      trimmed.includes('..')
      || /^[A-Za-z]:/.test(trimmed)
      || trimmed.startsWith('/')
      || trimmed.startsWith('\\')
      || /^file:/i.test(trimmed)
    ) {
      throw new Error(`Invalid library name (paths are not allowed): ${JSON.stringify(item)}`);
    }
    out.push(trimmed);
  }

  if (out.length > MAX_LIBRARIES) {
    throw new Error(`Too many libraries (max ${MAX_LIBRARIES})`);
  }

  return out;
}

/** Merge explicit libs with inferred libs (explicit first, then fill gaps). */
export function mergeLibraries(explicit = [], inferred = []) {
  const out = [];
  const seen = new Set();
  for (const lib of [...explicit, ...inferred]) {
    const key = String(lib).split('@')[0].trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(lib);
  }
  if (out.length > MAX_LIBRARIES) {
    throw new Error(`Too many libraries after auto-infer (max ${MAX_LIBRARIES})`);
  }
  return out;
}

export { inferLibrariesFromSource, librariesForComponents };
export { listHardwareComponents, resolveComponents } from './hardware-components.js';
export { resolveBoard, compilableBoardSlugs, listPlatforms } from './platforms.js';

/**
 * Every build ships an OTA-capable partition table (dual app slots + otadata)
 * from the FIRST flash onward — retrofitting later needs a cable re-flash.
 * 4MB layout fits ESP32/S2/C3; S3 devkits (8MB) get the bigger table.
 * Offsets keep bootloader@0x1000 / partitions@0x8000 / app@0x10000 so the
 * merged USB image layout is unchanged.
 */
const PARTITION_CLASS = {
  esp32dev: '4mb',
  'esp32-s2-saola-1': '4mb',
  'esp32-c3-devkitm-1': '4mb',
  'esp32-s3-devkitm-1': '8mb',
};

export function otaPartitionsCsv(boardId) {
  const cls = PARTITION_CLASS[boardId] ?? '4mb';
  const url = new URL(`../firmware/partitions-chip-ota-${cls}.csv`, import.meta.url);
  return readFile(fileURLToPath(url), 'utf8');
}

export function buildIni(platform, boardEntry, libDeps = []) {
  const lines = [];

  if (libDeps.length > 0) {
    lines.push('[platformio]');
    lines.push(`libdeps_dir = ${toIniPath(LIB_CACHE_DIR)}`);
    lines.push('');
  }

  lines.push('[env:target]');
  lines.push(`platform = ${platform.pio.platform}`);
  lines.push(`board = ${boardEntry.pioBoard}`);
  lines.push(`framework = ${platform.pio.framework}`);
  lines.push('monitor_speed = 115200');
  // Dual OTA slots are an ESP32-only arrangement — other families use the
  // board default layout and cannot receive Chip OTA updates.
  if (platform.ota) {
    lines.push('board_build.partitions = partitions-chip-ota.csv');
    lines.push('build_flags = -DCORE_DEBUG_LEVEL=0');
  }

  if (libDeps.length > 0) {
    lines.push('lib_deps =');
    for (const dep of libDeps) {
      lines.push(`    ${dep}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function findBin(projectDir) {
  const standard = join(projectDir, '.pio', 'build', 'target', 'firmware.bin');
  if (existsSync(standard)) return standard;
  return null;
}

/**
 * Collect the flashable artifact for a platform. ESP32 merges bootloader +
 * partitions + app into one self-booting image; every other family ships
 * its native file (plain .bin, Intel HEX for AVR, UF2 for RP2040).
 */
function findArtifact(projectDir, platform) {
  const dir = join(projectDir, '.pio', 'build', 'target');
  const kind = platform.artifact || 'bin';
  if (kind === 'hex') {
    const hex = join(dir, 'firmware.hex');
    if (existsSync(hex)) return { path: hex, artifact: 'hex', filename: 'firmware.hex' };
  }
  if (kind === 'uf2') {
    const uf2 = join(dir, 'firmware.uf2');
    if (existsSync(uf2)) return { path: uf2, artifact: 'uf2', filename: 'firmware.uf2' };
  }
  const bin = findBin(projectDir);
  if (bin) return { path: bin, artifact: 'bin', filename: 'firmware.bin' };
  return null;
}

function extractUnresolvedLibraries(logLines, requested) {
  const text = logLines.join('\n');
  const found = new Set();

  for (const lib of requested) {
    const escaped = lib.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameOnly = lib.split('@')[0].trim();
    const nameEscaped = nameOnly.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`Could not find the package[^\\n]*${escaped}`, 'i'),
      new RegExp(`UnknownPackageError[^\\n]*${escaped}`, 'i'),
      new RegExp(`Unable to resolve[^\\n]*${escaped}`, 'i'),
      new RegExp(`Could not find the package[^\\n]*${nameEscaped}`, 'i'),
      new RegExp(`UnknownPackageError[^\\n]*${nameEscaped}`, 'i'),
    ];
    if (patterns.some((re) => re.test(text))) {
      found.add(lib);
    }
  }

  const quoteMatches = text.matchAll(
    /(?:Could not find the package with|UnknownPackageError:|Unable to resolve)[^\n]*?['"`]([^'"`]+)['"`]/gi,
  );
  for (const m of quoteMatches) {
    if (m[1]) found.add(m[1].trim());
  }

  return [...found];
}

function isLibraryResolveFailure(logLines) {
  return logLines.some((line) => LIB_RESOLVE_PATTERNS.some((re) => re.test(line)));
}

function isNetworkFailure(logLines) {
  return logLines.some((line) => NETWORK_FAILURE_PATTERNS.some((re) => re.test(line)));
}

function runPio(cmd, args, { cwd, timeout, emit, env: extraEnv = {} }) {
  const child = spawn(cmd, args, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
      // Ensure non-interactive PlatformIO in containers / CI
      PLATFORMIO_DISABLE_PROGRESSBAR: 'true',
      CI: process.env.CI || '1',
    },
  });

  return new Promise((resolve, reject) => {
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
        const err = new Error(`pio run exited with code ${code}`);
        err.exitCode = code;
        reject(err);
      }
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(new Error(`Failed to start pio: ${err.message}. Is PlatformIO installed? Run: pip install platformio`));
    });
  });
}

async function safeRm(dir) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

export async function compileFirmware({
  source,
  board = 'esp32',
  libraries,
  libDeps,
  components,
  jobId = `job_${Date.now()}`,
  onLog = () => {},
  timeout = 300_000,
  agentHeader = null,
  wifiConfig = null,
} = {}) {
  const resolved = resolveBoard(board) ?? resolveBoard('esp32');
  const platform = resolved.platform;
  const boardEntry = resolved.board;
  const boardId = boardEntry.pioBoard;
  const startMs = Date.now();
  const log = [];
  const explicitLibs = normalizeLibraries(libraries ?? libDeps);
  const componentLibs = librariesForComponents(components ?? []);
  const inferredLibs = inferLibrariesFromSource(source);
  const resolvedLibs = mergeLibraries(explicitLibs, [...componentLibs, ...inferredLibs]);

  const emit = (line) => {
    log.push(line);
    onLog(line);
  };

  // Per-job project dir avoids concurrent compiles clobbering platformio.ini / main.cpp
  const projectDir = join(CACHE_BASE, 'builds', jobId);
  await mkdir(projectDir, { recursive: true });

  if (resolvedLibs.length > 0) {
    await mkdir(LIB_CACHE_DIR, { recursive: true });
  }

  emit(`[COMPILE] Project dir: ${projectDir}`);
  emit(`[COMPILE] Platform: ${platform.vendor} ${platform.label} — board: ${boardEntry.label} (${boardId})`);
  emit(`[COMPILE] Flash package: ${platform.flash?.tool ?? 'n/a'} (${platform.flash?.package ?? 'no flasher yet'})`);
  if (components?.length) {
    emit(`[COMPILE] Components: ${components.join(', ')}`);
  }
  if (resolvedLibs.length > 0) {
    emit(`[COMPILE] Libraries (${resolvedLibs.length}): ${resolvedLibs.join(', ')}`);
    if (!explicitLibs.length && (componentLibs.length || inferredLibs.length)) {
      emit('[COMPILE] Libraries auto-resolved from components / #includes');
    }
    emit(`[COMPILE] Library cache: ${LIB_CACHE_DIR}`);
  } else {
    emit('[COMPILE] Libraries: (none — core only)');
  }

  await writeFile(join(projectDir, 'platformio.ini'), buildIni(platform, boardEntry, resolvedLibs), 'utf8');

  if (platform.ota) {
    try {
      await writeFile(join(projectDir, 'partitions-chip-ota.csv'), await otaPartitionsCsv(boardId), 'utf8');
      emit('[COMPILE] Partition table: chip-ota (dual app slots, OTA-ready)');
    } catch (err) {
      emit(`[COMPILE] Warning: OTA partition table unavailable (${err.message}); build uses board default and cannot receive OTA updates.`);
    }
  } else {
    emit(`[COMPILE] No OTA partitions on ${platform.label} — first-flash layout is the board default.`);
  }

  const srcDir = join(projectDir, 'src');
  await mkdir(srcDir, { recursive: true });

  // The Chip Agent realtime/OTA client is ESP32 Arduino code — only link it
  // on the platform it compiles on.
  if (platform.id === 'esp32' && typeof agentHeader === 'string' && agentHeader.length > 0) {
    await writeFile(join(srcDir, 'chip_agent.h'), agentHeader, 'utf8');
    emit('[COMPILE] Chip Agent header linked (chip_agent.h) — realtime + OTA client available to the sketch.');
  }

  if (platform.id === 'esp32' && wifiConfig?.mode && wifiConfig.mode !== 'disabled') {
    const { wifiConfigHeader } = await import('./wifi-config.js');
    await writeFile(join(srcDir, 'chip_wifi_config.h'), wifiConfigHeader(wifiConfig), 'utf8');
    emit(`[COMPILE] WiFi mode injected: ${wifiConfig.mode}`);
  }

  const wifiBuildSource = platform.id === 'esp32' && wifiConfig?.mode && wifiConfig.mode !== 'disabled'
    ? source.replace(/^\s*#define\s+CHIP_WIFI_(?:SSID|PASS|PASSWORD)\s+.*$/gm, '')
    : source;
  const wifiInclude = platform.id === 'esp32' && wifiConfig?.mode && wifiConfig.mode !== 'disabled'
    ? '#include "chip_wifi_config.h"\n'
    : '';
  const preparedSource = `${wifiInclude}${wifiBuildSource.includes('Arduino.h') ? wifiBuildSource : `#include <Arduino.h>\n${wifiBuildSource}`}`;

  await writeFile(join(srcDir, 'main.cpp'), preparedSource, 'utf8');

  emit('[COMPILE] Running: pio run -j 1 …');

  const { cmd, argsPrefix } = await resolvePio();
  // Single-job compile — U8g2 / large libs OOM-kill the Railway container with default parallelism
  const args = [...argsPrefix, 'run', '-j', '1'];
  emit(`[COMPILE] Spawning: ${cmd} ${args.join(' ')}`);

  try {
    await withCompileLock(async () => {
      try {
        await runPio(cmd, args, {
          cwd: projectDir,
          timeout,
          emit,
          env: {
            // Cap toolchain parallelism further on small hosts
            PLATFORMIO_BUILD_FLAGS: process.env.PLATFORMIO_BUILD_FLAGS || '',
            MAKEFLAGS: '-j1',
          },
        });
      } catch (err) {
        if (/Killed|out of memory|ENOMEM/i.test(log.join('\n')) || err.exitCode === 137) {
          const oom = new Error(
            'Compile ran out of memory on the build server (process was killed). ' +
              'Use a smaller library (e.g. Adafruit SH110X instead of U8g2) and retry.',
          );
          oom.code = 'COMPILE_OOM';
          oom.log = log;
          throw oom;
        }
        if (resolvedLibs.length > 0 && isNetworkFailure(log)) {
          throw new LibraryNetworkError(
            'Failed to download libraries from the PlatformIO Registry (network error). ' +
              'Retry the compile; if it keeps failing, check outbound HTTPS access to registry.platformio.org.',
            { log },
          );
        }
        if (resolvedLibs.length > 0 && isLibraryResolveFailure(log)) {
          const unresolved = extractUnresolvedLibraries(log, resolvedLibs);
          const detail = unresolved.length > 0
            ? `Could not resolve library dependencies from the PlatformIO Registry: ${unresolved.join(', ')}. ` +
              'Use PlatformIO Registry names (e.g. "adafruit/Adafruit GFX Library", "bblanchon/ArduinoJson@^7.0.0"). ' +
              'See https://registry.platformio.org'
            : `One or more libraries could not be resolved from the PlatformIO Registry. ` +
              `Requested: ${resolvedLibs.join(', ')}. Check names at https://registry.platformio.org`;
          throw new LibraryResolveError(detail, {
            unresolved: unresolved.length ? unresolved : resolvedLibs,
            log,
          });
        }
        err.log = log;
        throw err;
      }
    });

    const found = findArtifact(projectDir, platform);
    if (!found) {
      const err = new Error(`Compile succeeded but no flashable artifact found (.pio/build/target/ has no ${platform.artifact})`);
      err.log = log;
      throw err;
    }

    const firmwareBuf = await readFile(found.path);
    const bootloaderPath = join(projectDir, '.pio', 'build', 'target', 'bootloader.bin');
    const partitionsPath = join(projectDir, '.pio', 'build', 'target', 'partitions.bin');

    // ESP32 merged image: bootloader + partitions + app, flashed at 0x0.
    // Every other family flashes its native artifact at its own layout.
    let finalBuf = firmwareBuf;
    let flashOffset = platform.id === 'esp32' ? '0x10000' : '0x0';
    let flashFilename = found.filename;

    if (platform.artifact === 'merged-bin' && existsSync(bootloaderPath) && existsSync(partitionsPath)) {
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
        flashFilename = 'firmware_merged.bin';
        emit(`[COMPILE] Built complete self-booting merged image (${mergedBuf.length} bytes @ 0x0)`);
      } catch (mergeErr) {
        emit(`[COMPILE] Note: Merging bootloader skipped: ${mergeErr.message}`);
      }
    } else if (platform.artifact === 'hex') {
      flashFilename = 'firmware.hex';
      emit(`[COMPILE] Intel HEX artifact ready (${firmwareBuf.length} bytes of HEX) — flash with the ${platform.flash.tool} package.`);
    } else if (platform.artifact === 'uf2') {
      flashFilename = 'firmware.uf2';
      emit(`[COMPILE] UF2 artifact ready (${firmwareBuf.length} bytes) — drop onto the BOOTSEL drive.`);
    }

    const binBase64 = finalBuf.toString('base64');
    const durationMs = Date.now() - startMs;

    emit(`[COMPILE] Done — ${finalBuf.length} bytes in ${(durationMs / 1000).toFixed(1)}s`);

    return {
      binBase64,
      binSize: finalBuf.length,
      offset: flashOffset,
      filename: flashFilename,
      artifact: found.artifact,
      platformId: platform.id,
      durationMs,
      log,
      libraries: resolvedLibs,
    };
  } finally {
    // Drop ephemeral per-job tree; keep shared library cache for reuse
    await safeRm(projectDir);
  }
}
