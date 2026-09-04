import { buildIni, compileFirmware } from '../services/platformio-runner.js';

const ini = buildIni('esp32dev', []);
console.log('--- core-only platformio.ini ---');
console.log(ini);

if (ini.includes('lib_deps') || ini.includes('libdeps_dir')) {
  console.error('FAIL: core-only ini has library config');
  process.exit(1);
}

const expected = [
  '[env:target]',
  'platform = espressif32',
  'board = esp32dev',
  'framework = arduino',
  'monitor_speed = 115200',
  'build_flags = -DCORE_DEBUG_LEVEL=0',
  '',
].join('\n');

if (ini !== expected) {
  console.error('FAIL: ini differs from original shape');
  console.error({ ini, expected });
  process.exit(1);
}
console.log('ini matches original core-only shape');

const source = `#include <Arduino.h>
void setup(){ pinMode(2, OUTPUT); }
void loop(){ digitalWrite(2, HIGH); delay(500); digitalWrite(2, LOW); delay(500); }
`;

console.log('--- core-only compile (no libraries field) ---');
const result = await compileFirmware({
  source,
  board: 'esp32',
  jobId: `test_core_${Date.now()}`,
  onLog: (line) => {
    if (/COMPILE|SUCCESS|FAILED|Error|lib_deps|Library Manager/.test(line)) {
      console.log(line);
    }
  },
  timeout: 600_000,
});

console.log('CORE-ONLY SUCCESS bytes=', result.binSize, 'libs=', result.libraries, 'ms=', result.durationMs);
if (result.libraries.length !== 0) {
  console.error('FAIL: unexpected libs');
  process.exit(1);
}
console.log('BACKWARD COMPAT OK');
