/**
 * Chip — hardware platform registry.
 *
 * Every chip family flashes with its OWN package, the way ESP32 uses
 * Espressif's esptool. This registry is the single source of truth (backend
 * and dashboard mirror it) for:
 *  - which platforms exist and their support status,
 *  - which flashing package/protocol each supported platform uses,
 *  - how to recognise a plugged-in board (esptool chip name, USB VID/PID),
 *  - which PlatformIO target each board slug compiles to.
 *
 * Support ladder per platform: 'supported' (compile + flash in Chip today)
 * → 'coming-soon' (recognised, roadmap). Nothing here claims support that
 * doesn't exist yet.
 */

export const PLATFORMS = [
  {
    id: 'esp32',
    vendor: 'Espressif',
    label: 'ESP32',
    boardCount: 601,
    status: 'supported',
    ota: true,
    artifact: 'merged-bin',
    flash: {
      tool: 'esptool',
      package: 'esptool-js',
      protocol: 'SLIP ROM bootloader over Web Serial',
      notes: 'Auto-reset into bootloader via DTR/RTS on common dev boards.',
    },
    pio: { platform: 'espressif32', framework: 'arduino' },
    boards: [
      { slug: 'esp32', pioBoard: 'esp32dev', label: 'ESP32 (generic)' },
      { slug: 'esp32dev', pioBoard: 'esp32dev', label: 'ESP32 DevKit' },
      { slug: 'esp32s2', pioBoard: 'esp32-s2-saola-1', label: 'ESP32-S2' },
      { slug: 'esp32s3', pioBoard: 'esp32-s3-devkitm-1', label: 'ESP32-S3' },
      { slug: 'esp32c3', pioBoard: 'esp32-c3-devkitm-1', label: 'ESP32-C3' },
    ],
    // esptool-js ROM-bootloader chip names (upper-cased for matching).
    chipMatch: ['ESP32', 'ESP32-S2', 'ESP32-S3', 'ESP32-C3', 'ESP32-C6', 'ESP32-H2'],
    // Common USB-serial bridges on ESP32 devkits. NOTE: CH340/FTDI/CP210x are
    // shared with Arduino clones, so VID/PID alone never identifies ESP32 —
    // the esptool sync probe decides. These only rank candidates.
    vidPid: [[0x10c4, 0xea60], [0x1a86, 0x7523], [0x0403, 0x6001], [0x303a, null]],
  },
  {
    id: 'esp8266',
    vendor: 'Espressif',
    label: 'ESP8266',
    boardCount: 158,
    status: 'supported',
    ota: false,
    artifact: 'bin',
    flash: {
      tool: 'esptool',
      package: 'esptool-js',
      protocol: 'SLIP ROM bootloader over Web Serial',
      notes: 'Same esptool package as ESP32. Plain app binary flashed at 0x0.',
    },
    pio: { platform: 'espressif8266', framework: 'arduino' },
    boards: [
      { slug: 'esp8266', pioBoard: 'nodemcuv2', label: 'ESP8266 (generic)' },
      { slug: 'nodemcuv2', pioBoard: 'nodemcuv2', label: 'NodeMCU v2' },
      { slug: 'esp01', pioBoard: 'esp01', label: 'ESP-01' },
    ],
    chipMatch: ['ESP8266'],
    vidPid: [[0x10c4, 0xea60], [0x1a86, 0x7523], [0x0403, 0x6001]],
  },
  {
    id: 'arduino-avr',
    vendor: 'Arduino',
    label: 'Arduino / AVR',
    boardCount: 724,
    status: 'supported',
    ota: false,
    artifact: 'hex',
    flash: {
      tool: 'stk500v1',
      package: 'chip-stk500 (built in — STK500v1 over Web Serial)',
      protocol: 'STK500v1 bootloader (optiboot) over Web Serial, DTR auto-reset',
      notes: 'Uno / Nano (ATmega328P, 128-byte pages). Mega2560 needs STK500v2 — coming soon.',
    },
    pio: { platform: 'atmelavr', framework: 'arduino' },
    boards: [
      { slug: 'uno', pioBoard: 'uno', label: 'Arduino Uno', mcu: 'atmega328p', pageSize: 128, baud: 115200 },
      { slug: 'nano', pioBoard: 'nanoatmega328', label: 'Arduino Nano', mcu: 'atmega328p', pageSize: 128, baud: 115200 },
      { slug: 'nano-old', pioBoard: 'nanoatmega328', label: 'Arduino Nano (old bootloader)', mcu: 'atmega328p', pageSize: 128, baud: 57600 },
    ],
    chipMatch: [],
    // Genuine Uno/Mega (CDC-ACM) + FTDI Nano + CH340 clones (shared with ESP32).
    vidPid: [[0x2341, 0x0043], [0x2341, 0x0001], [0x2341, 0x0010], [0x0403, 0x6001], [0x1a86, 0x7523]],
  },
  {
    id: 'rp2040',
    vendor: 'Raspberry Pi',
    label: 'RP2040',
    boardCount: 344,
    status: 'supported',
    ota: false,
    artifact: 'uf2',
    flash: {
      tool: 'uf2',
      package: 'guided UF2 export (BOOTSEL mass-storage)',
      protocol: 'Hold BOOTSEL, plug in, drop the .uf2 onto the RPI-RP2 drive',
      notes: 'Browsers cannot write USB mass storage, so Pico flashing is a guided UF2 drop for now — no cable-driver magic, no fake progress.',
    },
    pio: { platform: 'raspberrypi', framework: 'arduino' },
    boards: [
      { slug: 'pico', pioBoard: 'pico', label: 'Raspberry Pi Pico' },
    ],
    chipMatch: [],
    vidPid: [[0x2e8a, 0x0003], [0x2e8a, 0x000a]],
  },
  {
    id: 'stm32',
    vendor: 'ST',
    label: 'STM32',
    boardCount: 339,
    status: 'coming-soon',
    ota: false,
    artifact: 'bin',
    flash: {
      tool: 'stm32serial',
      package: 'planned — STM32 system-memory bootloader (AN3155) over Web Serial',
      protocol: 'UART bootloader via BOOT0 pin',
      notes: 'Compile target lands before the flasher. Blue Pill / Nucleo first.',
    },
    pio: { platform: 'ststm32', framework: 'arduino' },
    boards: [
      { slug: 'bluepill', pioBoard: 'bluepill_f103c8', label: 'Blue Pill (F103C8)' },
      { slug: 'nucleo-f401re', pioBoard: 'nucleo_f401re', label: 'Nucleo-F401RE' },
    ],
    chipMatch: [],
    vidPid: [[0x0483, 0x374b]],
  },
  {
    id: 'raspberry-pi',
    vendor: 'Raspberry Pi',
    label: 'Raspberry Pi',
    boardCount: 257,
    status: 'coming-soon',
    ota: false,
    artifact: 'img',
    flash: null,
    pio: null,
    boards: [],
    chipMatch: [],
    vidPid: [],
  },
  {
    id: 'fpga',
    vendor: 'Generic',
    label: 'FPGA',
    boardCount: 178,
    status: 'coming-soon',
    ota: false,
    artifact: 'bit',
    flash: null,
    pio: null,
    boards: [],
    chipMatch: [],
    vidPid: [],
  },
  {
    id: 'nrf52',
    vendor: 'Nordic',
    label: 'nRF52',
    boardCount: 95,
    status: 'coming-soon',
    ota: false,
    artifact: 'hex',
    flash: {
      tool: 'adafruit-uf2',
      package: 'planned — UF2 / CDC bootloader where fitted',
      protocol: 'Board-dependent (UF2 or J-Link)',
      notes: null,
    },
    pio: { platform: 'nordicnrf52', framework: 'arduino' },
    boards: [
      { slug: 'nano33ble', pioBoard: 'nano33ble', label: 'Nano 33 BLE' },
    ],
    chipMatch: [],
    vidPid: [[0x2341, 0x005a]],
  },
  {
    id: 'riscv',
    vendor: 'Generic',
    label: 'RISC-V',
    boardCount: 93,
    status: 'coming-soon',
    ota: false,
    artifact: 'bin',
    flash: null,
    pio: null,
    boards: [],
    chipMatch: [],
    vidPid: [],
  },
  {
    id: 'teensy',
    vendor: 'PJRC',
    label: 'Teensy',
    boardCount: 41,
    status: 'coming-soon',
    ota: false,
    artifact: 'hex',
    flash: {
      tool: 'teensy-loader',
      package: 'planned — Teensy Loader (HalfKay) desktop helper',
      protocol: 'HalfKay over USB',
      notes: 'Needs the PJRC loader integration; not a Web Serial protocol.',
    },
    pio: { platform: 'teensy', framework: 'arduino' },
    boards: [
      { slug: 'teensy41', pioBoard: 'teensy41', label: 'Teensy 4.1' },
    ],
    chipMatch: [],
    vidPid: [[0x16c0, 0x0483]],
  },
  {
    id: 'pic',
    vendor: 'Microchip',
    label: 'PIC',
    boardCount: 44,
    status: 'coming-soon',
    ota: false,
    artifact: 'hex',
    flash: null,
    pio: null,
    boards: [],
    chipMatch: [],
    vidPid: [],
  },
  {
    id: 'samd',
    vendor: 'Microchip',
    label: 'SAMD',
    boardCount: 26,
    status: 'coming-soon',
    ota: false,
    artifact: 'bin',
    flash: {
      tool: 'bossac-uf2',
      package: 'planned — BOSSA / UF2 where fitted',
      protocol: 'Board-dependent',
      notes: null,
    },
    pio: { platform: 'atmelsam', framework: 'arduino' },
    boards: [
      { slug: 'zero', pioBoard: 'zeroUSB', label: 'Arduino Zero' },
      { slug: 'mkr1000', pioBoard: 'mkr1000USB', label: 'MKR1000' },
    ],
    chipMatch: [],
    vidPid: [[0x2341, 0x804d]],
  },
  {
    id: 'ch32',
    vendor: 'WCH',
    label: 'CH32',
    boardCount: 30,
    status: 'coming-soon',
    ota: false,
    artifact: 'bin',
    flash: {
      tool: 'wch-isp',
      package: 'planned — WCH ISP bootloader over USB/serial',
      protocol: 'WCH ISP',
      notes: null,
    },
    pio: null,
    boards: [],
    chipMatch: [],
    vidPid: [[0x4348, 0x55e0]],
  },
  {
    id: 'msp430',
    vendor: 'TI',
    label: 'MSP430',
    boardCount: 11,
    status: 'coming-soon',
    ota: false,
    artifact: 'hex',
    flash: null,
    pio: { platform: 'timsp430', framework: 'arduino' },
    boards: [
      { slug: 'launchpad', pioBoard: 'lpmsp430g2553', label: 'LaunchPad G2553' },
    ],
    chipMatch: [],
    vidPid: [],
  },
];

const slugToBoard = new Map();
const slugToPlatform = new Map();
for (const p of PLATFORMS) {
  for (const b of p.boards) {
    slugToBoard.set(b.slug.toLowerCase(), { ...b, platformId: p.id });
    slugToPlatform.set(b.slug.toLowerCase(), p);
  }
}

/** Resolve a compile board slug → { platform, board } or null if unknown. */
export function resolveBoard(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const key = slug.toLowerCase();
  const board = slugToBoard.get(key);
  if (!board) return null;
  return { platform: slugToPlatform.get(key), board };
}

/** All compilable board slugs (supported platforms with a pio target). */
export function compilableBoardSlugs() {
  return PLATFORMS.flatMap((p) =>
    p.status === 'supported' && p.pio ? p.boards.map((b) => b.slug) : [],
  );
}

/** Match an esptool chip name (e.g. "ESP32-S3") to its platform, or null. */
export function getPlatformForChip(chip) {
  if (!chip || typeof chip !== 'string') return null;
  const upper = chip.toUpperCase().replace(/[_\s]+/g, '-');
  for (const p of PLATFORMS) {
    if ((p.chipMatch || []).some((c) => upper === c || upper.startsWith(`${c}-`) || upper.startsWith(c))) {
      return p;
    }
  }
  // Last-resort substring match for esptool variants ("ESP32D0WD", "ESP32-S3", …).
  if (/ESP32/.test(upper)) return PLATFORMS.find((p) => p.id === 'esp32');
  if (/ESP8266/.test(upper)) return PLATFORMS.find((p) => p.id === 'esp8266');
  return null;
}

/** Rank platform candidates from a Web Serial USB VID/PID pair. */
export function getPlatformsForVidPid(vendorId, productId) {
  const out = [];
  for (const p of PLATFORMS) {
    for (const [vid, pid] of p.vidPid || []) {
      if (vendorId === vid && (pid == null || productId === pid)) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}

export function listPlatforms() {
  return PLATFORMS.map((p) => ({
    id: p.id,
    vendor: p.vendor,
    label: p.label,
    boardCount: p.boardCount,
    status: p.status,
    ota: p.ota,
    artifact: p.artifact,
    flash: p.flash,
    boards: p.boards.map((b) => ({ slug: b.slug, label: b.label })),
  }));
}
