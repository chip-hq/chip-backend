import { spawn } from 'child_process';
import { writeFile, readFile, access, mkdir, rm } from 'fs/promises';
import { constants, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  inferLibrariesFromSource,
  librariesForComponents,
} from './hardware-components.js';

const BOARD_MAP = {
  esp32: 'esp32dev',
  esp32dev: 'esp32dev',
  esp32s2: 'esp32-s2-saola-1',
  esp32s3: 'esp32-s3-devkitm-1',
  esp32c3: 'esp32-c3-devkitm-1',
};

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

export function buildIni(boardId, libDeps = []) {
  const lines = [];

  if (libDeps.length > 0) {
    lines.push('[platformio]');
    lines.push(`libdeps_dir = ${toIniPath(LIB_CACHE_DIR)}`);
    lines.push('');
  }

  lines.push('[env:target]');
  lines.push('platform = espressif32');
  lines.push(`board = ${boardId}`);
  lines.push('framework = arduino');
  lines.push('monitor_speed = 115200');
  lines.push('build_flags = -DCORE_DEBUG_LEVEL=0');

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
} = {}) {
  const boardId = BOARD_MAP[board.toLowerCase()] ?? 'esp32dev';
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
  emit(`[COMPILE] Board: ${boardId}`);
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

  await writeFile(join(projectDir, 'platformio.ini'), buildIni(boardId, resolvedLibs), 'utf8');

  const srcDir = join(projectDir, 'src');
  await mkdir(srcDir, { recursive: true });

  const preparedSource = source.includes('Arduino.h')
    ? source
    : `#include <Arduino.h>\n${source}`;

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

    const binPath = findBin(projectDir);
    if (!binPath) {
      const err = new Error('Compile succeeded but firmware.bin not found in .pio/build/target/');
      err.log = log;
      throw err;
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
      } catch (mergeErr) {
        emit(`[COMPILE] Note: Merging bootloader skipped: ${mergeErr.message}`);
      }
    }

    const binBase64 = finalBuf.toString('base64');
    const durationMs = Date.now() - startMs;

    emit(`[COMPILE] Done — ${finalBuf.length} bytes in ${(durationMs / 1000).toFixed(1)}s`);

    return {
      binBase64,
      binSize: finalBuf.length,
      offset: flashOffset,
      durationMs,
      log,
      libraries: resolvedLibs,
    };
  } finally {
    // Drop ephemeral per-job tree; keep shared library cache for reuse
    await safeRm(projectDir);
  }
}
