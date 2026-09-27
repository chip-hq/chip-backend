#pragma once
/*
 * Chip Agent — realtime + OTA client for ESP32-class boards.
 * ---------------------------------------------------------------------------
 * Bake this into EVERY firmware (see usage below) or the board can never be
 * updated over the air after the build that omits it.
 *
 * What it does:
 *  - joins WiFi, opens a WebSocket to the Chip backend as role=device
 *  - heartbeats + hello (identity, firmware version) for presence
 *  - sends telemetry: chipTelemetry("temp", 23.5) / chipTelemetry("s", "on")
 *  - handles commands: reboot, status, ota_check (+ ack for all)
 *  - downloads OTA releases over HTTPS, verifies SHA-256, flashes the
 *    inactive OTA slot and reboots; confirms the boot (rollback discipline)
 *
 * Usage in your sketch:
 *   #define CHIP_WIFI_SSID  "MyWifi"
 *   #define CHIP_WIFI_PASS  "secret"
 *   #define CHIP_SERVER_HOST "chip-backend.up.railway.app"
 *   #define CHIP_SERVER_PORT 443
 *   #define CHIP_DEVICE_ID   "bench-01"
 *   #define CHIP_DEVICE_TOKEN "..."   // from POST /api/devices/claim (once)
 *   #define CHIP_FIRMWARE_VERSION "1.0.0"
 *   #include "chip_agent.h"
 *   void setup() { ... chipAgentBegin(); }
 *   void loop()  { ... chipAgentLoop(); }
 *
 * Libraries (auto-resolved by components: ["chip-agent"]):
 *   links2004/WebSockets, bblanchon/ArduinoJson   (Update/WiFi/HTTPClient/esp_ota = core)
 *
 * Rollback note: crash-loop auto-revert additionally needs
 * CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE in the bootloader config. The Chip
 * partition tables ship otadata + dual app slots, and this agent always
 * marks a boot healthy after 30 s (or rolls back explicitly on self-detected
 * faults such as repeated WiFi failure after a fresh OTA).
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Update.h>
#include <esp_ota_ops.h>
#include <mbedtls/sha256.h>

#ifndef CHIP_WIFI_SSID
#define CHIP_WIFI_SSID ""
#endif
#ifndef CHIP_WIFI_PASS
#define CHIP_WIFI_PASS ""
#endif
#ifndef CHIP_SERVER_HOST
#define CHIP_SERVER_HOST ""
#endif
#ifndef CHIP_SERVER_PORT
#define CHIP_SERVER_PORT 80
#endif
#ifndef CHIP_DEVICE_ID
#define CHIP_DEVICE_ID "default_device"
#endif
#ifndef CHIP_DEVICE_TOKEN
#define CHIP_DEVICE_TOKEN ""
#endif
#ifndef CHIP_FIRMWARE_VERSION
#define CHIP_FIRMWARE_VERSION "0.0.0"
#endif
#ifndef CHIP_BOARD_NAME
#if defined(CONFIG_IDF_TARGET_ESP32S3)
#define CHIP_BOARD_NAME "ESP32-S3"
#elif defined(CONFIG_IDF_TARGET_ESP32S2)
#define CHIP_BOARD_NAME "ESP32-S2"
#elif defined(CONFIG_IDF_TARGET_ESP32C3)
#define CHIP_BOARD_NAME "ESP32-C3"
#else
#define CHIP_BOARD_NAME "ESP32"
#endif
#endif
#ifndef CHIP_WIFI_TIMEOUT_MS
#define CHIP_WIFI_TIMEOUT_MS 15000
#endif
#ifndef CHIP_TELEMETRY_INTERVAL_MS
#define CHIP_TELEMETRY_INTERVAL_MS 10000
#endif
#ifndef CHIP_HEARTBEAT_INTERVAL_MS
#define CHIP_HEARTBEAT_INTERVAL_MS 25000
#endif
#ifndef CHIP_VALIDATE_AFTER_MS
#define CHIP_VALIDATE_AFTER_MS 30000
#endif

namespace chip_agent {
namespace {

WebSocketsClient ws;
bool wsConnected = false;
unsigned long lastWsAttempt = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastTelemetry = 0;
unsigned long bootValidateAt = 0;
bool rollbackPending = false;
int wifiFailStreak = 0;

// Latest telemetry values set by the sketch (small fixed slots).
struct TeleEntry { String key; String value; bool used; };
TeleEntry teleSlots[12];

enum OtaPhase : uint8_t { OTA_IDLE = 0, OTA_DOWNLOADING = 1 };
OtaPhase otaPhase = OTA_IDLE;
String otaVersion = "";
String otaSha = "";
long otaSize = 0;

bool configured() {
  return String(CHIP_SERVER_HOST).length() > 0 && String(CHIP_DEVICE_TOKEN).length() > 0;
}

void sendJson(String payload) {
  if (wsConnected) ws.sendTXT(payload);
}

String helloPayload() {
  JsonDocument doc;
  doc["type"] = "hello";
  doc["deviceId"] = CHIP_DEVICE_ID;
  doc["token"] = CHIP_DEVICE_TOKEN;
  doc["chip"] = CHIP_BOARD_NAME;
  doc["firmwareVersion"] = CHIP_FIRMWARE_VERSION;
  String out;
  serializeJson(doc, out);
  return out;
}

void sendOtaStatus(const String &status, const String &version, const String &error = "") {
  JsonDocument doc;
  doc["type"] = "ota_status";
  doc["deviceId"] = CHIP_DEVICE_ID;
  doc["status"] = status;
  doc["version"] = version;
  if (error.length() > 0) doc["error"] = error;
  String out;
  serializeJson(doc, out);
  sendJson(out);
}

void sendCmdAck(const String &cmdId, bool ok, const String &result = "") {
  JsonDocument doc;
  doc["type"] = "cmd_ack";
  doc["deviceId"] = CHIP_DEVICE_ID;
  doc["cmdId"] = cmdId;
  doc["ok"] = ok;
  if (result.length() > 0) doc["result"] = result;
  String out;
  serializeJson(doc, out);
  sendJson(out);
}

String serverBase() {
  String base = (CHIP_SERVER_PORT == 443) ? "https://" : "http://";
  base += CHIP_SERVER_HOST;
  if (!((CHIP_SERVER_PORT == 443) || (CHIP_SERVER_PORT == 80))) {
    base += ":";
    base += String(CHIP_SERVER_PORT);
  }
  return base;
}

// Blocking OTA download+flash. Called from chipAgentLoop when an ota_update
// frame arrives; reboots on success, reports failed/rolled_back otherwise.
void runOta(const String &version, String path, const String &sha, long size) {
  otaPhase = OTA_DOWNLOADING;
  sendOtaStatus("downloading", version);
  path.replace("__DEVICE_TOKEN__", String(CHIP_DEVICE_TOKEN));
  const String url = serverBase() + path;

  HTTPClient http;
  http.setTimeout(15000);
  if (!http.begin(url)) {
    sendOtaStatus("failed", version, "http.begin failed");
    otaPhase = OTA_IDLE;
    return;
  }
  const int code = http.GET();
  if (code != HTTP_CODE_OK) {
    sendOtaStatus("failed", version, String("http status ") + code);
    http.end();
    otaPhase = OTA_IDLE;
    return;
  }
  const long total = size > 0 ? size : (long) http.getSize();
  if (total <= 0 || !Update.begin((size_t) total, U_FLASH)) {
    sendOtaStatus("failed", version, "not enough space for OTA");
    http.end();
    otaPhase = OTA_IDLE;
    return;
  }
  WiFiClient *stream = http.getStreamPtr();
  String actualHex = "";
  // Drain + hash the body ourselves first; Update writes the same bytes.
  // (Two passes over one stream is impossible, so hash while writing.)
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts_ret(&ctx, 0);
  uint8_t buf[1024];
  long remaining = total;
  size_t written = 0;
  bool streamError = false;
  while (remaining > 0) {
    size_t avail = stream->available();
    if (avail == 0) {
      if (!http.connected()) break;
      delay(5);
      continue;
    }
    size_t n = stream->readBytes(buf, (size_t) (avail > sizeof(buf) ? sizeof(buf) : avail));
    if (n == 0) {
      if (!http.connected()) break;
      delay(5);
      continue;
    }
    mbedtls_sha256_update_ret(&ctx, buf, n);
    if (Update.write(buf, n) != n) {
      streamError = true;
      break;
    }
    written += n;
    remaining -= (long) n;
    yield();
  }
  uint8_t hash[32];
  mbedtls_sha256_finish_ret(&ctx, hash);
  mbedtls_sha256_free(&ctx);
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", hash[i]);
  hex[64] = 0;
  String exp = sha;
  exp.toLowerCase();
  http.end();

  if (streamError || written != (size_t) total || String(hex) != exp) {
    Update.abort();
    sendOtaStatus("failed", version, streamError ? "flash write failed" : "sha256 mismatch");
    otaPhase = OTA_IDLE;
    return;
  }
  if (!Update.end(true)) {
    sendOtaStatus("failed", version, "Update.end failed");
    otaPhase = OTA_IDLE;
    return;
  }
  sendOtaStatus("applied", version);
  delay(500);  // let the frame flush before rebooting into the new slot
  otaPhase = OTA_IDLE;
  ESP.restart();
}

void handleCommand(const char *cmdId, const char *command, JsonDocument &doc) {
  const String cmd = String(command || "");
  if (cmd == "reboot") {
    sendCmdAck(cmdId, true, "rebooting");
    delay(300);
    ESP.restart();
  } else if (cmd == "status") {
    sendCmdAck(cmdId, true, String("fw=") + CHIP_FIRMWARE_VERSION + " uptime=" + millis());
  } else if (cmd == "ota_check") {
    // No-op ack: any release published while offline is pushed on next hello.
    sendCmdAck(cmdId, true, "no pending check; server pushes ota_update when a release exists");
  } else {
    sendCmdAck(cmdId, false, String("unknown command: ") + cmd);
  }
  (void) doc;
}

void onWsEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      wsConnected = true;
      lastHeartbeat = millis();
      sendJson(helloPayload());
      break;
    case WStype_DISCONNECTED:
      wsConnected = false;
      break;
    case WStype_TEXT: {
      JsonDocument doc;
      if (deserializeJson(doc, payload, length)) break;
      const char *msgType = doc["type"];
      if (!msgType) break;
      if (strcmp(msgType, "cmd") == 0) {
        handleCommand(doc["cmdId"] | "n/a", doc["command"] | "", doc);
      } else if (strcmp(msgType, "ota_update") == 0) {
        const char *v = doc["version"] | "";
        String path = String((const char *) (doc["path"] | ""));
        const char *sha = doc["sha256"] | "";
        long size = (long) (doc["size"] | 0);
        if (String(v) == CHIP_FIRMWARE_VERSION) {
          sendOtaStatus(String(v), "healthy");
          break;
        }
        runOta(String(v), path, String(sha), size);
      }
      break;
    }
    default:
      break;
  }
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiFailStreak = 0;
    return;
  }
  WiFi.mode(WIFI_STA);
  WiFi.begin(CHIP_WIFI_SSID, CHIP_WIFI_PASS);
  const unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < CHIP_WIFI_TIMEOUT_MS) {
    delay(250);
  }
  if (WiFi.status() != WL_CONNECTED) {
    wifiFailStreak += 1;
    // Self-detected fault after a fresh OTA with no rollback possible yet:
    // mark this app bad so the bootloader (when rollback-enabled) reverts.
    if (rollbackPending && wifiFailStreak >= 3) {
      esp_ota_mark_app_invalid_rollback_and_reboot();
    }
  } else {
    wifiFailStreak = 0;
  }
}

void ensureWs() {
  if (wsConnected) return;
  if (millis() - lastWsAttempt < 5000) return;
  lastWsAttempt = millis();
  String url = String("/?role=device&deviceId=") + CHIP_DEVICE_ID + "&token=" + CHIP_DEVICE_TOKEN;
  if (CHIP_SERVER_PORT == 443) {
    ws.beginSSL(CHIP_SERVER_HOST, CHIP_SERVER_PORT, url);
  } else {
    ws.begin(CHIP_SERVER_HOST, CHIP_SERVER_PORT, url);
  }
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(5000);
}

void flushTelemetry() {
  if (!wsConnected) return;
  if (millis() - lastTelemetry < CHIP_TELEMETRY_INTERVAL_MS) return;
  lastTelemetry = millis();
  JsonDocument doc;
  doc["type"] = "telemetry";
  doc["deviceId"] = CHIP_DEVICE_ID;
  JsonObject data = doc["data"].to<JsonObject>();
  bool any = false;
  for (auto &slot : teleSlots) {
    if (slot.used) {
      data[slot.key] = slot.value;
      any = true;
    }
  }
  data["uptime"] = (long) (millis() / 1000);
  data["rssi"] = WiFi.RSSI();
  data["fw"] = CHIP_FIRMWARE_VERSION;
  (void) any;
  String out;
  serializeJson(doc, out);
  sendJson(out);
}

}  // namespace

inline void chipTelemetry(const char *key, const String &value) {
  for (auto &slot : teleSlots) {
    if (slot.used && slot.key == key) {
      slot.value = value;
      return;
    }
  }
  for (auto &slot : teleSlots) {
    if (!slot.used) {
      slot.used = true;
      slot.key = key;
      slot.value = value;
      return;
    }
  }
}

inline void chipTelemetry(const char *key, float value) {
  chipTelemetry(key, String(value, 2));
}

inline void chipTelemetry(const char *key, long value) {
  chipTelemetry(key, String(value));
}

inline void chipLog(const char *msg) {
  chipTelemetry("log", String(msg));
}

/// Call once at the END of setup().
inline void chipAgentBegin() {
  // Rollback discipline: if the previous boot never validated, this boot
  // gets 30 s to prove itself before we mark it good.
  if (esp_ota_check_rollback_is_possible()) {
    rollbackPending = true;
    bootValidateAt = millis() + CHIP_VALIDATE_AFTER_MS;
  }
  ensureWifi();
}

/// Call on EVERY loop() iteration (non-blocking except during OTA download).
inline void chipAgentLoop() {
  if (rollbackPending && (long) (millis() - bootValidateAt) >= 0) {
    rollbackPending = false;
    esp_ota_mark_app_valid_cancel_rollback();
  }
  if (WiFi.status() != WL_CONNECTED) {
    ensureWifi();
    if (WiFi.status() != WL_CONNECTED) return;
  }
  ensureWs();
  ws.loop();
  if (!wsConnected) return;
  if (millis() - lastHeartbeat >= CHIP_HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = millis();
    JsonDocument doc;
    doc["type"] = "heartbeat";
    doc["deviceId"] = CHIP_DEVICE_ID;
    doc["firmwareVersion"] = CHIP_FIRMWARE_VERSION;
    String out;
    serializeJson(doc, out);
    sendJson(out);
  }
  flushTelemetry();
}

}  // namespace chip_agent

using chip_agent::chipAgentBegin;
using chip_agent::chipAgentLoop;
using chip_agent::chipTelemetry;
using chip_agent::chipLog;
