/**
 * Chip — Circuit Generation Service
 * Manages execution of SKiDL scripts and circuit netlist/schematic generation.
 */

import { spawn } from 'child_process';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { getOrFetchSymbolDir } from './r2-symbols.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SKIDL_RUNNER_PY       = join(__dirname, 'skidl_runner.py');
const LED_CIRCUIT_PY        = join(__dirname, 'led_circuit.py');
const ARTIFACT_GENERATOR_PY = join(__dirname, 'generate_circuit_artifact.py');

const WINDOWS_PYTHON_CANDIDATES = [
  join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
  join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
  join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
  join(homedir(), '.platformio', 'penv', 'Scripts', 'python.exe'),
];

/**
 * Resolves the python executable and arguments to use.
 */
function resolvePython() {
  if (process.env.PYTHON_BIN) {
    return { cmd: process.env.PYTHON_BIN, args: [] };
  }

  // Docker / Linux venv
  if (existsSync('/root/.platformio/penv/bin/python3')) {
    return { cmd: '/root/.platformio/penv/bin/python3', args: [] };
  }
  if (existsSync('/root/.platformio/penv/bin/python')) {
    return { cmd: '/root/.platformio/penv/bin/python', args: [] };
  }

  if (process.platform === 'win32') {
    for (const cand of WINDOWS_PYTHON_CANDIDATES) {
      if (existsSync(cand)) {
        return { cmd: cand, args: [] };
      }
    }
    // Use py -3.12 or py
    return { cmd: 'py', args: ['-3.12'] };
  }

  return { cmd: 'python3', args: [] };
}

function getSymbolDir() {
  if (process.env.KICAD_SYMBOL_DIR) {
    const custom = resolve(__dirname, '..', process.env.KICAD_SYMBOL_DIR);
    if (existsSync(custom)) return custom;
    if (existsSync(process.env.KICAD_SYMBOL_DIR)) return process.env.KICAD_SYMBOL_DIR;
  }
  const rootDir = resolve(__dirname, '../../kicad-symbols-master');
  if (existsSync(rootDir)) return rootDir;
  return resolve(__dirname, '../../kicad-symbols-master');
}

/**
 * Checks if SKiDL and KiCad symbol libraries are properly configured.
 */
export async function checkCircuitEnvironment() {
  const { cmd, args: pyArgs } = resolvePython();
  const symbolDir = await getOrFetchSymbolDir();
  const env = {
    ...process.env,
    KICAD_SYMBOL_DIR: symbolDir,
  };

  return new Promise((resolveResult) => {
    const child = spawn(cmd, [...pyArgs, SKIDL_RUNNER_PY, '--check'], { env, cwd: tmpdir() });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      try {
        const parsed = JSON.parse(stdout.trim());
        resolveResult({ ...parsed, exitCode: code });
      } catch {
        resolveResult({
          skidlAvailable: false,
          error: stderr || stdout || 'Unknown error checking SKiDL environment',
          exitCode: code,
        });
      }
    });

    child.on('error', (err) => {
      resolveResult({
        skidlAvailable: false,
        error: `Failed to launch Python (${cmd}): ${err.message}`,
        exitCode: -1,
      });
    });
  });
}

/**
 * Step 2 validation: Ask SKiDL to load a real KiCad component and report the result.
 * Defaults to Device:R (resistor) — the simplest possible part.
 *
 * @param {string} lib  - library name, e.g. 'R' (maps to Device.kicad_symdir/R.kicad_sym)
 * @param {string} part - part name,    e.g. 'R'
 */
export async function testPartLoad(lib = 'R', part = 'R') {
  const { cmd, args: pyArgs } = resolvePython();
  const symdir = lib.endsWith('.kicad_symdir') ? lib : `${lib}.kicad_symdir`;
  const symfile = part.endsWith('.kicad_sym') ? part : `${part}.kicad_sym`;
  const symbolDir = await getOrFetchSymbolDir([{ dir: symdir, part: symfile }]);
  const env = {
    ...process.env,
    KICAD_SYMBOL_DIR: symbolDir,
  };

  return new Promise((resolveResult) => {
    const child = spawn(
      cmd,
      [...pyArgs, SKIDL_RUNNER_PY, '--test-part', '--lib', lib, '--part', part],
      { env, cwd: tmpdir() }
    );
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', () => {
      try {
        // stdout may include SKiDL warnings before the JSON; find the JSON block
        const jsonMatch = stdout.match(/(\{[\s\S]*\})/);
        if (jsonMatch) {
          resolveResult(JSON.parse(jsonMatch[1]));
        } else {
          resolveResult({
            skidlAvailable: false,
            libraryPath: null,
            componentLoaded: false,
            componentName: `${lib}:${part}`,
            pins: [],
            error: stderr || stdout || 'No JSON output from runner',
          });
        }
      } catch {
        resolveResult({
          skidlAvailable: false,
          libraryPath: null,
          componentLoaded: false,
          componentName: `${lib}:${part}`,
          pins: [],
          error: stderr || stdout || 'Failed to parse runner output',
        });
      }
    });

    child.on('error', (err) => {
      resolveResult({
        skidlAvailable: false,
        libraryPath: null,
        componentLoaded: false,
        componentName: `${lib}:${part}`,
        pins: [],
        error: `Failed to launch Python (${cmd}): ${err.message}`,
      });
    });
  });
}

/**
 * Searches KiCad symbol library directories for matching symbols.
 *
 * @param {string} query - Symbol or library name search term
 */
export async function searchKiCadSymbols(query = '') {
  const { cmd, args: pyArgs } = resolvePython();
  const symbolDir = await getOrFetchSymbolDir();
  const env = {
    ...process.env,
    KICAD_SYMBOL_DIR: symbolDir,
  };

  return new Promise((resolveResult) => {
    const child = spawn(
      cmd,
      [...pyArgs, SKIDL_RUNNER_PY, '--search', query],
      { env, cwd: tmpdir() }
    );
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', () => {
      try {
        const jsonMatch = stdout.match(/(\{[\s\S]*\})/);
        if (jsonMatch) {
          resolveResult(JSON.parse(jsonMatch[1]));
        } else {
          resolveResult({ success: false, error: stderr || stdout || 'No output', results: [] });
        }
      } catch {
        resolveResult({ success: false, error: stderr || stdout || 'Parse error', results: [] });
      }
    });

    child.on('error', (err) => {
      resolveResult({ success: false, error: err.message, results: [] });
    });
  });
}

/**
 * Loads part details and pins using SKiDL.
 *
 * @param {string} lib  - Library name (e.g. 'R' or 'ESP32-PICO-D4')
 * @param {string} part - Part name (e.g. 'R' or 'ESP32-PICO-D4')
 */
export async function getComponentDetails(lib = 'R', part = 'R') {
  const { cmd, args: pyArgs } = resolvePython();
  const symdir = lib.endsWith('.kicad_symdir') ? lib : `${lib}.kicad_symdir`;
  const symfile = part.endsWith('.kicad_sym') ? part : `${part}.kicad_sym`;
  const symbolDir = await getOrFetchSymbolDir([{ dir: symdir, part: symfile }]);
  const env = {
    ...process.env,
    KICAD_SYMBOL_DIR: symbolDir,
  };

  return new Promise((resolveResult) => {
    const child = spawn(
      cmd,
      [...pyArgs, SKIDL_RUNNER_PY, '--details', '--lib', lib, '--part', part],
      { env, cwd: tmpdir() }
    );
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', () => {
      try {
        const jsonMatch = stdout.match(/(\{[\s\S]*\})/);
        if (jsonMatch) {
          resolveResult(JSON.parse(jsonMatch[1]));
        } else {
          resolveResult({ success: false, error: stderr || stdout || 'No output' });
        }
      } catch {
        resolveResult({ success: false, error: stderr || stdout || 'Parse error' });
      }
    });

    child.on('error', (err) => {
      resolveResult({ success: false, error: err.message });
    });
  });
}

/**
 * Step 3: Build the ESP32 → R 220Ω → LED → GND circuit using real KiCad parts.
 * Runs led_circuit.py which uses actual component identifiers resolved in Step 2.
 */
export async function buildLedCircuit() {
  const { cmd, args: pyArgs } = resolvePython();
  const symbolDir = await getOrFetchSymbolDir();
  const env = {
    ...process.env,
    KICAD_SYMBOL_DIR: symbolDir,
  };

  return new Promise((resolveResult) => {
    const child = spawn(cmd, [...pyArgs, LED_CIRCUIT_PY], { env, cwd: tmpdir() });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', () => {
      try {
        const jsonMatch = stdout.match(/(\{[\s\S]*\})/);
        if (jsonMatch) {
          resolveResult(JSON.parse(jsonMatch[1]));
        } else {
          resolveResult({
            success: false,
            error: stderr || stdout || 'No JSON output from led_circuit.py',
          });
        }
      } catch {
        resolveResult({
          success: false,
          error: stderr || stdout || 'Failed to parse circuit output',
        });
      }
    });

    child.on('error', (err) => {
      resolveResult({
        success: false,
        error: `Failed to launch Python (${cmd}): ${err.message}`,
      });
    });
  });
}

/**
 * Step 4 & 5: Generate and persist a versioned circuit artifact for a project.
 * Runs generate_circuit_artifact.py which writes netlist + JSON to outDir.
 *
 * @param {Object} options
 * @param {string} options.projectId     - The project to associate with
 * @param {string} options.outDir        - Directory to write artifacts into (e.g. .../versions/v1/)
 * @param {number} [options.version=1]   - Monotonically increasing version number
 * @param {string} [options.resistorValue='220'] - Resistor value
 */
export async function generateProjectCircuit({ projectId, outDir, version = 1, resistorValue = '220' }) {
  const { cmd, args: pyArgs } = resolvePython();
  const symbolDir = await getOrFetchSymbolDir();
  const env = {
    ...process.env,
    KICAD_SYMBOL_DIR: symbolDir,
  };

  await mkdir(outDir, { recursive: true });

  return new Promise((resolveResult) => {
    const child = spawn(
      cmd,
      [
        ...pyArgs,
        ARTIFACT_GENERATOR_PY,
        '--project-id', projectId,
        '--out-dir', outDir,
        '--version', String(version),
        '--resistor-value', String(resistorValue),
      ],
      { env, cwd: tmpdir() }
    );
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', () => {
      try {
        const jsonMatch = stdout.match(/(\{[\s\S]*\})/);
        if (jsonMatch) {
          resolveResult(JSON.parse(jsonMatch[1]));
        } else {
          resolveResult({
            projectId,
            version,
            success: false,
            error: stderr || stdout || 'No JSON output from artifact generator',
          });
        }
      } catch {
        resolveResult({
          projectId,
          version,
          success: false,
          error: stderr || stdout || 'Failed to parse artifact generator output',
        });
      }
    });

    child.on('error', (err) => {
      resolveResult({
        projectId,
        version,
        success: false,
        error: `Failed to launch Python (${cmd}): ${err.message}`,
      });
    });
  });
}

/**
 * Step 8: Compile an arbitrary/edited circuit definition into a new version.
 */
export async function generateProjectCircuitFromDefinition({ projectId, outDir, version = 1, definitionPath }) {
  const { cmd, args: pyArgs } = resolvePython();
  const symbolDir = await getOrFetchSymbolDir();
  const env = {
    ...process.env,
    KICAD_SYMBOL_DIR: symbolDir,
  };

  await mkdir(outDir, { recursive: true });

  return new Promise((resolveResult) => {
    const child = spawn(
      cmd,
      [
        ...pyArgs,
        ARTIFACT_GENERATOR_PY,
        '--project-id', projectId,
        '--out-dir', outDir,
        '--version', String(version),
        '--definition', definitionPath,
      ],
      { env, cwd: tmpdir() }
    );
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', () => {
      try {
        const jsonMatch = stdout.match(/(\{[\s\S]*\})/);
        if (jsonMatch) {
          resolveResult(JSON.parse(jsonMatch[1]));
        } else {
          resolveResult({
            projectId,
            version,
            success: false,
            error: stderr || stdout || 'No JSON output from artifact generator',
          });
        }
      } catch {
        resolveResult({
          projectId,
          version,
          success: false,
          error: stderr || stdout || 'Failed to parse artifact generator output',
        });
      }
    });

    child.on('error', (err) => {
      resolveResult({
        projectId,
        version,
        success: false,
        error: `Failed to launch Python (${cmd}): ${err.message}`,
      });
    });
  });
}

/**

 * Executes a SKiDL Python script and returns generated outputs.
 * 
 * @param {Object} options
 * @param {string} options.code Python SKiDL script content
 * @param {string} [options.jobId] Unique job identifier
 * @param {function} [options.onLog] Optional log streaming callback
 * @param {number} [options.timeout=60000] Execution timeout in ms
 */
export async function runCircuitScript({
  code,
  jobId = `circuit-${Date.now()}`,
  onLog = () => {},
  timeout = 60_000,
}) {
  const { cmd, args: pyArgs } = resolvePython();
  const symbolDir = await getOrFetchSymbolDir();

  const cacheBase = join(homedir(), '.chip-circuit-cache');
  const jobDir = join(cacheBase, jobId);
  await mkdir(jobDir, { recursive: true });

  const scriptPath = join(jobDir, 'circuit.py');
  await writeFile(scriptPath, code, 'utf8');

  const log = [];
  const emit = (line) => {
    log.push(line);
    onLog(line);
  };

  emit(`[CIRCUIT] Starting circuit generation job: ${jobId}`);
  emit(`[CIRCUIT] Using symbol library: ${symbolDir}`);

  const env = {
    ...process.env,
    KICAD_SYMBOL_DIR: symbolDir,
  };

  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, [...pyArgs, SKIDL_RUNNER_PY, '--script', scriptPath, '--out', jobDir], {
      cwd: jobDir,
      env,
    });

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Circuit generation timed out after ${timeout / 1000}s`));
    }, timeout);

    const handleData = (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        if (line.trim()) emit(line);
      }
    };

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);

    child.on('close', async (exitCode) => {
      clearTimeout(killTimer);
      if (exitCode === 0) {
        emit('[CIRCUIT] Generation completed successfully');
        
        // Scan for common generated files (netlist, xml, svg)
        const netlistPath = join(jobDir, 'circuit.net');
        let netlist = null;
        if (existsSync(netlistPath)) {
          netlist = await readFile(netlistPath, 'utf8');
        }

        resolvePromise({
          success: true,
          jobId,
          jobDir,
          netlist,
          log,
        });
      } else {
        reject(new Error(`Circuit runner exited with code ${exitCode}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(new Error(`Failed to start circuit runner: ${err.message}`));
    });
  });
}
