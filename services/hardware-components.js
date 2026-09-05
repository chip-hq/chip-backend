/**
 * Chip hardware component catalog.
 * Each component that needs third-party libs declares them here so:
 * - plain-English → AI picks the component
 * - compile can resolve lib_deps from `components` and/or #includes
 */

export const HARDWARE_COMPONENTS = [
  {
    id: 'oled-sh1106',
    name: 'GME12864 / SH1106 OLED 128x64',
    aliases: ['gme12864', 'sh1106', 'sh110x', '1.3 oled'],
    libraries: [
      'adafruit/Adafruit SH110X',
      'adafruit/Adafruit GFX Library',
      'adafruit/Adafruit BusIO',
    ],
    headers: ['Adafruit_SH110X.h', 'Adafruit_SH1106.h'],
    notes: 'Use this for GME12864. SSD1306 driver causes snow on these panels.',
  },
  {
    id: 'oled-ssd1306',
    name: 'SSD1306 OLED 128x64 / 128x32',
    aliases: ['ssd1306', '0.96 oled', 'ssd1306 oled'],
    libraries: [
      'adafruit/Adafruit SSD1306',
      'adafruit/Adafruit GFX Library',
      'adafruit/Adafruit BusIO',
    ],
    headers: ['Adafruit_SSD1306.h'],
    notes: 'Only for true SSD1306 modules. Prefer oled-sh1106 for GME12864.',
  },
  {
    id: 'tm1637-4digit',
    name: 'TM1637 4-digit 88:88 display',
    aliases: ['tm1637', '7 segment', 'seven segment', '88:88', '4 digit'],
    libraries: ['avishorp/TM1637'],
    headers: ['TM1637Display.h', 'TM1637.h'],
    notes: 'CLK/DIO style clock display.',
  },
  {
    id: 'max7219-8digit',
    name: 'MAX7219 8-digit LED matrix/display',
    aliases: ['max7219', 'led control'],
    libraries: ['wayoda/LedControl'],
    headers: ['LedControl.h'],
    notes: '',
  },
  {
    id: 'neopixel',
    name: 'Adafruit NeoPixel / WS2812',
    aliases: ['neopixel', 'ws2812', 'addressable led'],
    libraries: ['adafruit/Adafruit NeoPixel'],
    headers: ['Adafruit_NeoPixel.h'],
    notes: '',
  },
  {
    id: 'fastled',
    name: 'FastLED strip',
    aliases: ['fastled'],
    libraries: ['fastled/FastLED'],
    headers: ['FastLED.h'],
    notes: '',
  },
  {
    id: 'dht11-dht22',
    name: 'DHT11 / DHT22 temperature humidity',
    aliases: ['dht11', 'dht22', 'dht'],
    libraries: [
      'adafruit/DHT sensor library',
      'adafruit/Adafruit Unified Sensor',
    ],
    headers: ['DHT.h'],
    notes: '',
  },
  {
    id: 'bme280',
    name: 'BME280 environmental sensor',
    aliases: ['bme280'],
    libraries: [
      'adafruit/Adafruit BME280 Library',
      'adafruit/Adafruit BusIO',
      'adafruit/Adafruit Unified Sensor',
    ],
    headers: ['Adafruit_BME280.h'],
    notes: '',
  },
  {
    id: 'bmp280',
    name: 'BMP280 pressure sensor',
    aliases: ['bmp280'],
    libraries: [
      'adafruit/Adafruit BMP280 Library',
      'adafruit/Adafruit BusIO',
      'adafruit/Adafruit Unified Sensor',
    ],
    headers: ['Adafruit_BMP280.h'],
    notes: '',
  },
  {
    id: 'ds18b20',
    name: 'DS18B20 OneWire temperature',
    aliases: ['ds18b20', 'dallas temperature'],
    libraries: [
      'milesburton/DallasTemperature',
      'paulstoffregen/OneWire',
    ],
    headers: ['DallasTemperature.h', 'OneWire.h'],
    notes: '',
  },
  {
    id: 'servo',
    name: 'Hobby servo motor',
    aliases: ['servo'],
    libraries: ['arduino-libraries/Servo'],
    headers: ['Servo.h'],
    notes: '',
  },
  {
    id: 'arduino-json',
    name: 'ArduinoJson',
    aliases: ['arduinojson', 'json'],
    libraries: ['bblanchon/ArduinoJson'],
    headers: ['ArduinoJson.h'],
    notes: 'Software helper, not a physical part.',
  },
  {
    id: 'mqtt-pubsub',
    name: 'MQTT PubSubClient',
    aliases: ['mqtt', 'pubsubclient'],
    libraries: ['knolleary/PubSubClient'],
    headers: ['PubSubClient.h'],
    notes: 'Software helper.',
  },
];

export function listHardwareComponents() {
  return HARDWARE_COMPONENTS.map(({ id, name, aliases, libraries, notes }) => ({
    id,
    name,
    aliases,
    libraries,
    notes,
  }));
}

/** Resolve catalog entries from component ids or alias strings. */
export function resolveComponents(componentIds = []) {
  if (!Array.isArray(componentIds)) return [];
  const out = [];
  const seen = new Set();

  for (const raw of componentIds) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const key = raw.trim().toLowerCase();
    const match = HARDWARE_COMPONENTS.find(
      (c) => c.id === key || c.aliases.some((a) => a === key || key.includes(a)),
    );
    if (match && !seen.has(match.id)) {
      seen.add(match.id);
      out.push(match);
    }
  }
  return out;
}

/** Libraries declared by the given component ids/aliases. */
export function librariesForComponents(componentIds = []) {
  const libs = [];
  for (const c of resolveComponents(componentIds)) {
    libs.push(...c.libraries);
  }
  return libs;
}

/** Infer component libraries from #include lines in source. */
export function inferLibrariesFromSource(source) {
  if (!source || typeof source !== 'string') return [];
  const found = new Set();

  for (const c of HARDWARE_COMPONENTS) {
    for (const header of c.headers) {
      const re = new RegExp(`["<]${header.replace('.', '\\.')}[">]`, 'i');
      if (re.test(source)) {
        for (const lib of c.libraries) found.add(lib);
        break;
      }
    }
  }

  // GFX alone (no display driver header) still needs BusIO stack
  if (/["<]Adafruit_GFX\.h[">]/i.test(source)) {
    found.add('adafruit/Adafruit GFX Library');
    found.add('adafruit/Adafruit BusIO');
  }

  return [...found];
}
