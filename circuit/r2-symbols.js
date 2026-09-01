/**
 * Chip Backend — Cloudflare R2 On-Demand KiCad Symbol Loader
 * 
 * Fetches required KiCad symbol libraries and parts on-demand from
 * Cloudflare R2 into temporary memory (/tmp) without filling backend disk storage.
 */

import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const DEFAULT_R2_BASE = 'https://pub-a4f1a10b0b2a43bc8d00e99351737b28.r2.dev/Symbols';

// Core essential parts mapped to their library directories on Cloudflare R2
const CORE_PARTS = [
  { dir: 'Device.kicad_symdir', part: 'R.kicad_sym' },
  { dir: 'Device.kicad_symdir', part: 'C.kicad_sym' },
  { dir: 'Device.kicad_symdir', part: 'LED.kicad_sym' },
  { dir: 'Device.kicad_symdir', part: 'Buzzer.kicad_sym' },
  { dir: 'Device.kicad_symdir', part: 'Q_NPN_BCE.kicad_sym' },
  { dir: 'Device.kicad_symdir', part: 'Q_NPN_CBE.kicad_sym' },
  { dir: 'Device.kicad_symdir', part: 'D.kicad_sym' },
  { dir: 'MCU_Espressif.kicad_symdir', part: 'ESP32-PICO-D4.kicad_sym' },
  { dir: 'MCU_Espressif.kicad_symdir', part: 'ESP32-C3.kicad_sym' },
  { dir: 'MCU_Espressif.kicad_symdir', part: 'ESP32-S2.kicad_sym' },
  { dir: 'MCU_Module.kicad_symdir', part: 'Arduino_Nano_v3.x.kicad_sym' },
  { dir: 'MCU_RaspberryPi.kicad_symdir', part: 'RP2040.kicad_sym' },
  { dir: 'Connector_Generic.kicad_symdir', part: 'Conn_01x04.kicad_sym' },
  { dir: 'Connector_Generic.kicad_symdir', part: 'Conn_01x06.kicad_sym' },
  { dir: 'Switch.kicad_symdir', part: 'SW_Push.kicad_sym' },
  { dir: 'Regulator_Linear.kicad_symdir', part: 'AMS1117-3.3.kicad_sym' },
  { dir: 'Sensor.kicad_symdir', part: 'DHT11.kicad_sym' },
  { dir: 'Sensor_Optical.kicad_symdir', part: 'LDR07.kicad_sym' },
];

/**
 * Returns the directory path containing KiCad symbols.
 * If running locally with KICAD_SYMBOL_DIR present, returns local path.
 * If running in production / cloud (or testing R2), downloads required symbols on-demand from Cloudflare R2.
 */
export async function getOrFetchSymbolDir(partsToFetch = CORE_PARTS) {
  // 1. Check local environment override first (if explicitly enabled)
  const localEnvDir = process.env.KICAD_SYMBOL_DIR;
  if (localEnvDir && !localEnvDir.startsWith('#') && existsSync(localEnvDir)) {
    return localEnvDir;
  }

  // 2. Prepare temp cache directory
  const r2BaseUrl = (process.env.R2_SYMBOL_BASE_URL || DEFAULT_R2_BASE).replace(/\/+$/, '');
  const tempSymbolDir = join(tmpdir(), 'chip-kicad-symbols');
  await mkdir(tempSymbolDir, { recursive: true });

  // 3. Download requested parts into their symdir folders
  const fetchPromises = partsToFetch.map(async (item) => {
    const symdirPath = join(tempSymbolDir, item.dir);
    const targetFilePath = join(symdirPath, item.part);

    if (existsSync(targetFilePath)) {
      return targetFilePath;
    }

    await mkdir(symdirPath, { recursive: true });
    const r2Url = `${r2BaseUrl}/${item.dir}/${item.part}`;

    try {
      const res = await fetch(r2Url);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        await writeFile(targetFilePath, buf);
        console.log(`[R2 CDN] Downloaded ${item.dir}/${item.part} (${(buf.length / 1024).toFixed(1)} KB)`);
        return targetFilePath;
      } else {
        console.warn(`[R2 CDN] ${item.dir}/${item.part} returned HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn(`[R2 CDN] Failed to fetch ${item.dir}/${item.part}:`, err.message);
    }
    return null;
  });

  await Promise.all(fetchPromises);
  return tempSymbolDir;
}
