/**
 * Chip Backend — KiCad S-Expression Symbol to SVG Converter
 * Converts KiCad .kicad_sym symbol definitions into clean, scale-accurate SVG vector graphics.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getOrFetchSymbolDir } from './r2-symbols.js';

// Cache rendered SVGs in memory
const svgCache = new Map();

/**
 * Normalizes library directory and part names with candidate directory search
 */
function resolveLibraryCandidates(lib, part) {
  let cleanLib = String(lib || '').trim();
  let cleanPart = String(part || '').trim();

  // If part was passed inside lib (e.g. lib=ESP32-PICO-D4)
  if (cleanLib.includes('ESP32') && cleanPart.includes('ESP32')) {
    cleanPart = cleanPart.replace(/\.kicad_sym$/, '');
  }

  const cleanPartName = cleanPart.replace(/\.kicad_sym$/, '');
  const symfile = `${cleanPartName}.kicad_sym`;

  const candidates = [];

  // Direct specified library first
  if (cleanLib) {
    candidates.push(cleanLib.endsWith('.kicad_symdir') ? cleanLib : `${cleanLib}.kicad_symdir`);
  }

  // Smart domain-specific directories
  const pUpper = cleanPartName.toUpperCase();
  if (pUpper.includes('ESP32') || pUpper.includes('ESP8266')) {
    candidates.push('MCU_Espressif.kicad_symdir');
    candidates.push('RF_Module.kicad_symdir');
  }
  if (pUpper.includes('RP2040') || pUpper.includes('PICO')) {
    candidates.push('MCU_RaspberryPi.kicad_symdir');
    candidates.push('MCU_Module.kicad_symdir');
  }
  if (pUpper.includes('NANO') || pUpper.includes('ATMEGA') || pUpper.includes('ATTINY')) {
    candidates.push('MCU_Module.kicad_symdir');
    candidates.push('MCU_Microchip_ATmega.kicad_symdir');
  }
  if (pUpper.includes('OLED') || pUpper.includes('SSD1306') || pUpper.includes('SH1106') || pUpper.includes('DISPLAY')) {
    candidates.push('Display_Graphic.kicad_symdir');
  }
  if (pUpper.includes('SENSOR') || pUpper.includes('DHT') || pUpper.includes('BME') || pUpper.includes('BMP') || pUpper.includes('MPU') || pUpper.includes('LDR') || pUpper.includes('TCRT')) {
    candidates.push('Sensor.kicad_symdir');
    candidates.push('Sensor_Optical.kicad_symdir');
    candidates.push('Sensor_Proximity.kicad_symdir');
  }
  if (pUpper.includes('CONN') || pUpper.startsWith('J') || pUpper.startsWith('P')) {
    candidates.push('Connector_Generic.kicad_symdir');
  }
  if (pUpper.includes('AMS1117') || pUpper.includes('7805') || pUpper.includes('REGULATOR')) {
    candidates.push('Regulator_Linear.kicad_symdir');
  }
  if (pUpper.includes('SW') || pUpper.includes('BUTTON')) {
    candidates.push('Switch.kicad_symdir');
  }

  // Universal fallbacks
  candidates.push('Device.kicad_symdir');
  candidates.push('RF_Module.kicad_symdir');
  candidates.push('MCU_Espressif.kicad_symdir');
  candidates.push('Connector_Generic.kicad_symdir');

  // Deduplicate
  const uniqueDirs = Array.from(new Set(candidates));

  return {
    symfile,
    partName: cleanPartName,
    candidateDirs: uniqueDirs,
  };
}

/**
 * Tokenizes S-expression content
 */
function tokenizeSExpr(str) {
  const tokens = [];
  let i = 0;
  const len = str.length;

  while (i < len) {
    const c = str[i];
    if (c === '(' || c === ')') {
      tokens.push(c);
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let val = '';
      while (j < len && str[j] !== '"') {
        if (str[j] === '\\' && j + 1 < len) {
          val += str[j + 1];
          j += 2;
        } else {
          val += str[j];
          j++;
        }
      }
      tokens.push(val);
      i = j + 1;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      let j = i;
      while (j < len && !/[\s()]/.test(str[j])) j++;
      tokens.push(str.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

/**
 * Parses S-expression tokens into a nested array
 */
function parseSExpr(tokens) {
  let idx = 0;

  function parseNode() {
    if (tokens[idx] !== '(') return tokens[idx++];
    idx++; // skip '('
    const list = [];
    while (idx < tokens.length && tokens[idx] !== ')') {
      list.push(parseNode());
    }
    if (tokens[idx] === ')') idx++;
    return list;
  }

  const root = [];
  while (idx < tokens.length) {
    root.push(parseNode());
  }
  return root;
}

/**
 * Converts KiCad S-Expression AST to SVG markup and Pin coordinates
 */
function convertSymbolAstToSvg(ast, partName) {
  let symbolNode = null;

  // Search for the symbol definition matching partName
  function findSymbol(node) {
    if (!Array.isArray(node)) return;
    if (node[0] === 'symbol' && typeof node[1] === 'string') {
      const name = node[1];
      if (name.toUpperCase() === partName.toUpperCase() || name.toUpperCase().includes(partName.toUpperCase())) {
        symbolNode = node;
        return;
      }
    }
    for (const child of node) {
      if (Array.isArray(child)) findSymbol(child);
      if (symbolNode) return;
    }
  }

  for (const item of ast) {
    findSymbol(item);
    if (symbolNode) break;
  }

  // Fallback to first symbol node in AST if exact name match not found
  if (!symbolNode) {
    for (const item of ast) {
      if (Array.isArray(item) && item[0] === 'kicad_symbol_lib') {
        symbolNode = item.find((child) => Array.isArray(child) && child[0] === 'symbol');
        break;
      }
    }
  }

  if (!symbolNode) {
    return null;
  }

  const svgElements = [];
  const pins = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  // Update bounding box coordinates
  function updateBounds(x, y) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  // Traverse graphic elements and pins inside the symbol
  function traverse(node) {
    if (!Array.isArray(node)) return;
    const type = node[0];

    // 1. Rectangle
    if (type === 'rectangle') {
      const start = node.find((c) => Array.isArray(c) && c[0] === 'start');
      const end = node.find((c) => Array.isArray(c) && c[0] === 'end');
      if (start && end) {
        const x1 = parseFloat(start[1]);
        const y1 = -parseFloat(start[2]); // Invert Y
        const x2 = parseFloat(end[1]);
        const y2 = -parseFloat(end[2]);
        const rx = Math.min(x1, x2);
        const ry = Math.min(y1, y2);
        const rw = Math.abs(x2 - x1);
        const rh = Math.abs(y2 - y1);
        updateBounds(rx, ry);
        updateBounds(rx + rw, ry + rh);
        svgElements.push(`<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="#eff6ff" stroke="#334155" stroke-width="0.3" rx="0.5" />`);
      }
    }

    // 2. Polyline / Lines
    if (type === 'polyline') {
      const ptsNode = node.find((c) => Array.isArray(c) && c[0] === 'pts');
      if (ptsNode) {
        const xyList = ptsNode.filter((c) => Array.isArray(c) && c[0] === 'xy');
        const pointsStr = xyList
          .map((xy) => {
            const px = parseFloat(xy[1]);
            const py = -parseFloat(xy[2]);
            updateBounds(px, py);
            return `${px},${py}`;
          })
          .join(' ');
        svgElements.push(`<polyline points="${pointsStr}" fill="none" stroke="#334155" stroke-width="0.3" stroke-linecap="round" stroke-linejoin="round" />`);
      }
    }

    // 3. Circle
    if (type === 'circle') {
      const center = node.find((c) => Array.isArray(c) && c[0] === 'center');
      const radius = parseFloat(node.find((c) => Array.isArray(c) && c[0] === 'radius')?.[1] || '1');
      if (center) {
        const cx = parseFloat(center[1]);
        const cy = -parseFloat(center[2]);
        updateBounds(cx - radius, cy - radius);
        updateBounds(cx + radius, cy + radius);
        svgElements.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#eff6ff" stroke="#334155" stroke-width="0.3" />`);
      }
    }

    // 4. Arc
    if (type === 'arc') {
      const start = node.find((c) => Array.isArray(c) && c[0] === 'start');
      const end = node.find((c) => Array.isArray(c) && c[0] === 'end');
      if (start && end) {
        const x1 = parseFloat(start[1]), y1 = -parseFloat(start[2]);
        const x2 = parseFloat(end[1]), y2 = -parseFloat(end[2]);
        updateBounds(x1, y1);
        updateBounds(x2, y2);
        svgElements.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#334155" stroke-width="0.3" />`);
      }
    }

    // 5. Pin definition
    if (type === 'pin') {
      const atNode = node.find((c) => Array.isArray(c) && c[0] === 'at');
      const nameNode = node.find((c) => Array.isArray(c) && c[0] === 'name');
      const numNode = node.find((c) => Array.isArray(c) && c[0] === 'number');
      const length = parseFloat(node.find((c) => Array.isArray(c) && c[0] === 'length')?.[1] || '2.54');

      if (atNode) {
        const px = parseFloat(atNode[1]);
        const py = -parseFloat(atNode[2]);
        const angle = parseInt(atNode[3] || '0', 10);
        const pinName = nameNode ? nameNode[1] : '';
        const pinNum = numNode ? numNode[1] : '';

        // Calculate pin lead endpoint based on angle
        let endX = px, endY = py, dir = 'left';
        if (angle === 0) { endX = px + length; dir = 'left'; }
        else if (angle === 90) { endY = py - length; dir = 'bottom'; }
        else if (angle === 180) { endX = px - length; dir = 'right'; }
        else if (angle === 270) { endY = py + length; dir = 'top'; }

        updateBounds(px, py);
        updateBounds(endX, endY);

        pins.push({
          num: pinNum,
          name: pinName === '~' ? pinNum : pinName,
          x: px,
          y: py,
          direction: dir,
        });

        // Pin lead line + connection terminal dot
        svgElements.push(`<line x1="${px}" y1="${py}" x2="${endX}" y2="${endY}" stroke="#334155" stroke-width="0.25" />`);
        svgElements.push(`<circle cx="${px}" cy="${py}" r="0.45" fill="#ffffff" stroke="#334155" stroke-width="0.2" />`);

        // Pin Name Label (rendered inside the IC body)
        if (pinName && pinName !== '~') {
          let textAnchor = 'start';
          let textX = endX + 0.5;
          let textY = endY + 0.35;
          if (dir === 'right') {
            textAnchor = 'end';
            textX = endX - 0.5;
          }
          svgElements.push(`<text x="${textX}" y="${textY}" text-anchor="${textAnchor}" font-family="monospace" font-size="0.75" font-weight="600" fill="#475569">${pinName}</text>`);
        }

        // Pin Number Label (rendered above the pin lead)
        if (pinNum) {
          const numX = (px + endX) / 2;
          const numY = py - 0.35;
          svgElements.push(`<text x="${numX}" y="${numY}" text-anchor="middle" font-family="monospace" font-size="0.55" fill="#94a3b8">${pinNum}</text>`);
        }
      }
    }

    for (const child of node) {
      if (Array.isArray(child)) traverse(child);
    }
  }

  traverse(symbolNode);

  if (minX === Infinity) {
    minX = -10; minY = -10; maxX = 10; maxY = 10;
  }

  // Padding
  const pad = 1.5;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const width = Math.max(maxX - minX, 10);
  const height = Math.max(maxY - minY, 10);

  const innerSvg = svgElements.join('\n  ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(2)} ${minY.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}" class="w-full h-full">\n  ${innerSvg}\n</svg>`;

  return {
    svg,
    viewBox: { x: minX, y: minY, width, height },
    pins: pins.map((p) => ({
      ...p,
      relX: ((p.x - minX) / width),
      relY: ((p.y - minY) / height),
    })),
  };
}

/**
 * Primary function: Gets or converts a KiCad symbol from R2 to SVG
 */
export async function getSymbolSvg(lib, part) {
  const { symfile, partName, candidateDirs } = resolveLibraryCandidates(lib, part);
  const cacheKey = `${lib}:${part}`.toLowerCase();

  if (svgCache.has(cacheKey)) {
    return svgCache.get(cacheKey);
  }

  for (const symdir of candidateDirs) {
    try {
      const symbolDir = await getOrFetchSymbolDir([{ dir: symdir, part: symfile }]);
      const fullPath = join(symbolDir, symdir, symfile);

      if (!existsSync(fullPath)) {
        continue;
      }

      const content = await readFile(fullPath, 'utf-8');
      const tokens = tokenizeSExpr(content);
      const ast = parseSExpr(tokens);
      const converted = convertSymbolAstToSvg(ast, partName);

      if (converted) {
        const result = {
          success: true,
          library: symdir.replace(/\.kicad_symdir$/, ''),
          part: partName,
          svg: converted.svg,
          viewBox: converted.viewBox,
          pins: converted.pins,
        };

        svgCache.set(cacheKey, result);
        return result;
      }
    } catch {
      // Try next directory candidate
    }
  }

  return {
    success: false,
    error: `Symbol ${partName} (${symfile}) not found in any candidate KiCad library on R2.`,
  };
}
