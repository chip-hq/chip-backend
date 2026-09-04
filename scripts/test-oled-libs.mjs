import { compileFirmware } from '../services/platformio-runner.js';

const source = `#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

void setup() {
  Wire.begin();
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Chip OLED OK");
  display.display();
}

void loop() {}
`;

console.log('--- OLED stack compile (GFX + SSD1306 + BusIO) ---');
const result = await compileFirmware({
  source,
  board: 'esp32',
  libraries: [
    'adafruit/Adafruit GFX Library',
    'adafruit/Adafruit SSD1306',
    'adafruit/Adafruit BusIO',
  ],
  jobId: `test_oled_${Date.now()}`,
  onLog: (line) => {
    if (/Library|Installing|Downloading|Error|Unknown|SUCCESS|FAILED|COMPILE|Took/.test(line)) {
      console.log(line);
    }
  },
  timeout: 600_000,
});
console.log('OLED SUCCESS bytes=', result.binSize, 'ms=', result.durationMs);
