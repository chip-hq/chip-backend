import { Router } from 'express';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();
const FIRMWARE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'firmware');

async function readFirmware(name) {
  return readFile(join(FIRMWARE_DIR, name), 'utf8');
}

/**
 * Serves the canonical Chip Agent firmware (header + example + OTA
 * partition tables) so the dashboard, MCP tools, and Claude all bake
 * the SAME realtime/OTA client into every build. Linking this agent is
 * what keeps a board updatable after its first flash.
 */
router.get('/api/agent/firmware', asyncRoute(async (_req, res) => {
  const [header, example, partitions4mb, partitions8mb] = await Promise.all([
    readFirmware('chip-agent.h'),
    readFirmware('chip-agent-example.ino'),
    readFirmware('partitions-chip-ota-4mb.csv'),
    readFirmware('partitions-chip-ota-8mb.csv'),
  ]);
  res.json({
    header,
    example,
    partitions4mb,
    partitions8mb,
    libraries: ['links2004/WebSockets', 'bblanchon/ArduinoJson'],
    usage: [
      '1. Claim the board: POST /api/devices/claim { deviceId, chip } → device token.',
      '2. compile_firmware with components: ["chip-agent"] and paste the header below into the project as chip_agent.h (the backend does this automatically when the component is requested).',
      '3. In the sketch: #include "chip_agent.h", set CHIP_WIFI_SSID/CHIP_WIFI_PASS/CHIP_SERVER_HOST/CHIP_SERVER_PORT/CHIP_DEVICE_ID/CHIP_DEVICE_TOKEN/CHIP_FIRMWARE_VERSION, call chipAgentBegin() at the end of setup() and chipAgentLoop() every loop().',
      '4. First flash stays over USB (merged image). Every later build can go OTA: publish_ota / POST /api/ota/publish.',
    ],
  });
}));

/**
 * Connection templates. The backend never knows its public host, so the
 * board builds full URLs from the host it was configured with at flash time.
 */
router.get('/api/agent/config', asyncRoute(async (_req, res) => {
  res.json({
    wsPathTemplate: '/?role=device&deviceId={deviceId}&token={token}',
    wsPathExample: '/?role=device&deviceId=bench-01&token=<deviceToken>',
    otaPathTemplate: '/api/ota/firmware?deviceId={deviceId}&token=__DEVICE_TOKEN__',
    note: 'The board substitutes its own CHIP_DEVICE_TOKEN for __DEVICE_TOKEN__ and prefixes the server host/port it was flashed with (wss:// on 443, ws:// otherwise).',
  });
}));

export default router;
