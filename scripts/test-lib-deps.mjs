import {
  compileFirmware,
  normalizeLibraries,
  buildIni,
  LibraryResolveError,
} from '../services/platformio-runner.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const libs = normalizeLibraries([
  'adafruit/Adafruit GFX Library',
  '  bblanchon/ArduinoJson@^7.0.0  ',
  '',
]);
assert(libs.length === 2, 'normalize should keep 2 libs');
console.log('normalize ok:', libs);

try {
  normalizeLibraries(['../../etc/passwd']);
  throw new Error('path should be blocked');
} catch (e) {
  if (e.message.includes('should be blocked')) throw e;
  console.log('path block ok');
}

try {
  normalizeLibraries(['bad;rm -rf']);
  throw new Error('ini inject should be blocked');
} catch (e) {
  if (e.message.includes('should be blocked')) throw e;
  console.log('ini inject block ok');
}

const ini = buildIni('esp32dev', libs);
assert(ini.includes('lib_deps ='), 'ini missing lib_deps');
assert(ini.includes('libdeps_dir'), 'ini missing libdeps_dir');
console.log('ini ok');

const coreOnlyIni = buildIni('esp32dev', []);
assert(!coreOnlyIni.includes('lib_deps'), 'core-only must not set lib_deps');
assert(!coreOnlyIni.includes('libdeps_dir'), 'core-only must not set libdeps_dir');
console.log('backward-compat ini ok');

const source = `#include <Arduino.h>
#include <ArduinoJson.h>
void setup() {
  Serial.begin(115200);
  JsonDocument doc;
  doc["ok"] = true;
  serializeJson(doc, Serial);
}
void loop() {}
`;

console.log('--- compiling with ArduinoJson ---');
const result = await compileFirmware({
  source,
  board: 'esp32',
  libraries: ['bblanchon/ArduinoJson'],
  jobId: `test_lib_${Date.now()}`,
  onLog: (line) => {
    if (/Library|lib_deps|PACKAGES|Compiling|Linking|Took|Error|Unknown|INSTALL|Downloading|COMPILE|SUCCESS|FAILED/.test(line)) {
      console.log(line);
    }
  },
  timeout: 600_000,
});
console.log('SUCCESS bytes=', result.binSize, 'offset=', result.offset, 'libs=', result.libraries, 'ms=', result.durationMs);

console.log('--- compiling with bogus library (expect LIBRARY_RESOLVE) ---');
try {
  await compileFirmware({
    source: '#include <Arduino.h>\nvoid setup(){}\nvoid loop(){}\n',
    board: 'esp32',
    libraries: ['definitely-not-a-real-library/DoesNotExistXYZ123'],
    jobId: `test_badlib_${Date.now()}`,
    onLog: () => {},
    timeout: 180_000,
  });
  console.error('FAIL: expected LibraryResolveError');
  process.exit(1);
} catch (err) {
  if (err instanceof LibraryResolveError || err.code === 'LIBRARY_RESOLVE') {
    console.log('LIBRARY_RESOLVE ok:', err.message.slice(0, 200));
  } else {
    console.error('Unexpected error type:', err.name, err.message);
    process.exit(1);
  }
}

console.log('ALL CHECKS PASSED');
