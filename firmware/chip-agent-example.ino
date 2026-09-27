// Chip Agent example — blink + realtime + OTA in one sketch.
// 1. Claim the board: POST /api/devices/claim {"deviceId":"bench-01","chip":"ESP32"}
// 2. Paste the returned token below, set WiFi + server host.
// 3. compile_firmware with components: ["chip-agent"], then flash over USB.
// 4. Later builds go OTA with zero cables (publish_ota / Fleet tab).

#define CHIP_WIFI_SSID  "YOUR_WIFI"
#define CHIP_WIFI_PASS  "YOUR_PASSWORD"
#define CHIP_SERVER_HOST "chip-backend.up.railway.app"
#define CHIP_SERVER_PORT 443
#define CHIP_DEVICE_ID   "bench-01"
#define CHIP_DEVICE_TOKEN "PASTE_CLAIM_TOKEN_HERE"
#define CHIP_FIRMWARE_VERSION "1.0.0"

#include "chip_agent.h"

#define LED_PIN 2

unsigned long lastBlink = 0;
bool ledOn = false;
int bootCount = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  bootCount += 1;
  chipAgentBegin();  // WiFi + realtime link + rollback discipline (call last)
}

void loop() {
  if (millis() - lastBlink >= 2000) {
    lastBlink = millis();
    ledOn = !ledOn;
    digitalWrite(LED_PIN, ledOn ? HIGH : LOW);
    // Live telemetry the dashboard charts without polling:
    chipTelemetry("led", ledOn ? "on" : "off");
    chipTelemetry("boots", (long) bootCount);
  }
  chipAgentLoop();  // heartbeat, telemetry flush, commands, OTA (call often)
}
