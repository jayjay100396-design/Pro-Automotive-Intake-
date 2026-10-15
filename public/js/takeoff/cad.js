// Client-side CAD (.DXF and .DWG) reader and renderer for glazing takeoffs.
// Turns a DXF or DWG drawing into the same page model that reader.js produces from a PDF page
// ({ page, width, height, text, segs, annots, cad }), with true 1:1 scale (ppi) and layer controls.
import { fmtFtIn } from './dims.js';

// AutoCAD $INSUNITS codes -> real inches per 1 CAD drawing unit.
export const INSUNITS_TO_INCHES = {
  0: 1,            // Unitless (default to architectural inches)
  1: 1,            // Inches
  2: 12,           // Feet
  3: 63360,        // Miles
  4: 1 / 25.4,     // Millimeters
  5: 1 / 2.54,     // Centimeters
  6: 39.37007874,  // Meters
  7: 39370.07874,  // Kilometers
  8: 1e-6,         // Microinches
  9: 0.001,        // Mils
  10: 36,          // Yards
  14: 3.937007874, // Decimeters
};

export const INSUNITS_LABELS = {
  0: 'Inches (assumed)',
  1: 'Inches',
  2: 'Feet',
  4: 'Millimeters',
  5: 'Centimeters',
  6: 'Meters',
  10: 'Yards',
};

// High-contrast colors for AutoCAD Color Index (ACI) on a white drafting sheet.
const ACI_COLORS = {
  1: '#dc2626', // Red
  2: '#ca8a04', // Yellow (darkened for white paper)
  3: '#16a34a', // Green
  4: '#0891b2', // Cyan
  5: '#2563eb', // Blue
  6: '#9333ea', // Magenta
  7: '#1e293b', // White/Black -> dark slate on light sheet
  8: '#64748b', // Dark grey
  9: '#94a3b8', // Light grey
};

export function aciToHex(aci) {
  const n = Math.abs(Number(aci) || 7);
  if (ACI_COLORS[n]) return ACI_COLORS[n];
  if (n >= 10 && n < 50) return '#b91c1c';
  if (n >= 50 && n < 90) return '#a16207';
  if (n >= 90 && n < 130) return '#15803d';
  if (n >= 130 && n < 170) return '#0e7490';
  if (n >= 170 && n < 210) return '#1d4ed8';
  if (n >= 210 && n < 250) return '#7e22ce';
  return '#334155';
}

// Limits on how far a drawing's block references expand: rows or columns in one array insert, and the total
// number of entities visited.
const MAX_ARRAY_SIDE = 500;
const MAX_VISITS = 1500000;

// Detects whether a file or byte buffer is a DXF or DWG drawing.
// Returns 'dxf' | 'dwg' | null.
export function detectCadKind(type = '', name = '', bytes = null) {
  const t = String(type || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (t.includes('dxf') || n.endsWith('.dxf')) return 'dxf';
  if (t.includes('dwg') || t === 'application/acad' || t === 'application/x-acad' || n.endsWith('.dwg')) return 'dwg';
  // A file that says it's a PDF or a picture is opened as one, whatever its first bytes look like.
  const declared = /^(application\/pdf|image\/)/.test(t) || /\.(pdf|png|jpe?g|gif|webp|heic)$/.test(n);
  if (bytes && !declared) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, Math.min(64, bytes.byteLength || 0));
    const head = new TextDecoder('latin1').decode(u8.subarray(0, Math.min(32, u8.length)));
    if (/^AC10(09|12|14|15|18|21|24|27|32)/.test(head)) return 'dwg';
    if (head.startsWith('AutoCAD Binary DXF') || /^\s*0\r?\nSECTION/i.test(head) || /^\s*999\r?\n/.test(head)) return 'dxf';
  }
  return null;
}

// Strips AutoCAD TEXT / MTEXT formatting codes and converts stacked fractions.
export function cleanCadText(raw) {
  if (!raw) return '';
  let s = String(raw);
  // MTEXT stacked fractions: \S1/2; or \S1#2; or \S1^ 2;
  s = s.replace(/(\d)?\\S([^;\\]*?)[/#^]([^;\\]*?);/g, (_, prevDigit, a, b) => {
    const num = a.trim(), den = b.trim();
    const frac = num && den ? `${num}/${den}` : `${num}${den}`;
    return `${prevDigit ? `${prevDigit} ` : ''}${frac}`;
  });
  // Paragraph breaks -> newline
  s = s.replace(/\\P/g, '\n');
  // Non-breaking space
  s = s.replace(/\\~/g, ' ');
  // Unicode escape \U+XXXX
  s = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  // Strip MTEXT control commands like \A1; \fArial|b0|i0; \H1.5x; \W0.8; \C7; \pxqc;
  s = s.replace(/\\[A-Za-z][^;\\]*;/g, '');
  s = s.replace(/\\[LlOoKk]/g, '');
  // Unwrap MTEXT braces
  s = s.replace(/[{}]/g, '');
  // AutoCAD %% codes
  s = s.replace(/%%[cC]/g, '⌀')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[uU]/g, '')
    .replace(/%%[oO]/g, '');
  return s.trim();
}

// Tokenizes an ASCII DXF string into [{ code, value }] pairs.
function tokenizeAsciiDxf(str) {
  const lines = str.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeStr = lines[i].trim();
    if (codeStr === '') continue;
    const code = parseInt(codeStr, 10);
    if (Number.isNaN(code)) continue;
    pairs.push({ code, value: lines[i + 1].trim() });
  }
  return pairs;
}

// Tokenizes an AutoCAD Binary DXF buffer into [{ code, value }] pairs.
function tokenizeBinaryDxf(u8) {
  const pairs = [];
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = 22; // Skip "AutoCAD Binary DXF\r\n\x1a\x00"
  const readStr = () => {
    let end = pos;
    while (end < u8.length && u8[end] !== 0) end++;
    const s = new TextDecoder('utf-8').decode(u8.subarray(pos, end));
    pos = end + 1;
    return s.trim();
  };
  while (pos + 2 <= u8.length) {
    let code = view.getUint16(pos, true);
    pos += 2;
    let value;
    if ((code >= 0 && code <= 9) || (code >= 100 && code <= 105) || (code >= 300 && code <= 369) || (code >= 390 && code <= 399) || (code >= 410 && code <= 419) || (code >= 430 && code <= 439) || (code >= 470 && code <= 481) || code === 999 || code >= 1000 && code <= 1009) {
      value = readStr();
    } else if ((code >= 10 && code <= 59) || (code >= 110 && code <= 149) || (code >= 210 && code <= 239) || (code >= 460 && code <= 469) || (code >= 1010 && code <= 1059)) {
      if (pos + 8 > u8.length) break;
      value = String(view.getFloat64(pos, true));
      pos += 8;
    } else if ((code >= 60 && code <= 79) || (code >= 170 && code <= 179) || (code >= 270 && code <= 289) || (code >= 370 && code <= 389) || (code >= 400 && code <= 409) || (code >= 1060 && code <= 1070)) {
      if (pos + 2 > u8.length) break;
      value = String(view.getInt16(pos, true));
      pos += 2;
    } else if ((code >= 90 && code <= 99) || (code >= 420 && code <= 429) || (code >= 440 && code <= 459) || code === 1071) {
      if (pos + 4 > u8.length) break;
      value = String(view.getInt32(pos, true));
      pos += 4;
    } else if (code >= 290 && code <= 299) {
      if (pos + 1 > u8.length) break;
      value = String(u8[pos]);
      pos += 1;
    } else {
      value = readStr();
    }
    pairs.push({ code, value });
  }
  return pairs;
}

// Bulge (tan(theta / 4)) between two 2D points -> intermediate arc points.
function bulgePoints(p1, p2, bulge, steps = 8) {
  if (!bulge || Math.abs(bulge) < 1e-6) return [p2];
  const [x1, y1] = p1, [x2, y2] = p2;
  const dx = x2 - x1, dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-9) return [p2];
  const theta = 4 * Math.atan(bulge);
  const sinHalf = Math.sin(theta / 2);
  if (Math.abs(sinHalf) < 1e-9) return [p2];
  const radius = Math.abs(chord / (2 * sinHalf));
  const cotHalf = (1 - bulge * bulge) / (2 * bulge);
  const cx = (x1 + x2) / 2 - (dy / 2) * cotHalf;
  const cy = (y1 + y2) / 2 + (dx / 2) * cotHalf;
  const startA = Math.atan2(y1 - cy, x1 - cx);
  const n = Math.max(2, Math.min(24, Math.ceil((Math.abs(theta) / (Math.PI / 2)) * steps)));
  const out = [];
  for (let k = 1; k <= n; k++) {
    const a = startA + (theta * k) / n;
    out.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return out;
}

// Parses a list of DXF group pairs inside ENTITIES or a BLOCK into structured entity records.
function parseEntitySection(pairs, startIdx, endIdx) {
  const entities = [];
  let i = startIdx;

  while (i < endIdx) {
    if (pairs[i].code !== 0) { i++; continue; }
    const type = pairs[i].value.toUpperCase();
    if (type === 'ENDSEC' || type === 'ENDBLK') break;
    i++;

    // Collect all group codes belonging to this entity until the next code 0
    const props = [];
    while (i < endIdx && pairs[i].code !== 0) {
      props.push(pairs[i]);
      i++;
    }

    const getOne = (c, def = null) => {
      const f = props.find((p) => p.code === c);
      return f ? f.value : def;
    };
    const getNum = (c, def = 0) => {
      const v = getOne(c, null);
      if (v === null) return def;
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : def;
    };
    const layer = (getOne(8, '0') || '0').trim();
    const space = parseInt(getOne(67, '0'), 10) || 0; // 0 = model space, 1 = paper space
    const color = parseInt(getOne(62, '256'), 10);

    if (type === 'POLYLINE') {
      // Read subsequent VERTEX entities until SEQEND
      const flags = parseInt(getOne(70, '0'), 10) || 0;
      const closed = (flags & 1) !== 0;
      const pts = [];
      while (i < endIdx && pairs[i].code === 0) {
        const subType = pairs[i].value.toUpperCase();
        i++;
        const subProps = [];
        while (i < endIdx && pairs[i].code !== 0) { subProps.push(pairs[i]); i++; }
        if (subType === 'SEQEND') break;
        if (subType === 'VERTEX') {
          const vx = parseFloat(subProps.find((p) => p.code === 10)?.value ?? '0');
          const vy = parseFloat(subProps.find((p) => p.code === 20)?.value ?? '0');
          const vb = parseFloat(subProps.find((p) => p.code === 42)?.value ?? '0');
          if (Number.isFinite(vx) && Number.isFinite(vy)) pts.push({ x: vx, y: vy, bulge: Number.isFinite(vb) ? vb : 0 });
        }
      }
      if (pts.length >= 2) entities.push({ type: 'LWPOLYLINE', layer, space, color, pts, closed });
      continue;
    }

    if (type === 'LWPOLYLINE') {
      const flags = parseInt(getOne(70, '0'), 10) || 0;
      const closed = (flags & 1) !== 0;
      const pts = [];
      let cur = null;
      for (const p of props) {
        if (p.code === 10) {
          if (cur) pts.push(cur);
          cur = { x: parseFloat(p.value) || 0, y: 0, bulge: 0 };
        } else if (p.code === 20 && cur) {
          cur.y = parseFloat(p.value) || 0;
        } else if (p.code === 42 && cur) {
          cur.bulge = parseFloat(p.value) || 0;
        }
      }
      if (cur) pts.push(cur);
      if (pts.length >= 2) entities.push({ type: 'LWPOLYLINE', layer, space, color, pts, closed });
    } else if (type === 'LINE') {
      entities.push({
        type: 'LINE', layer, space, color,
        x1: getNum(10), y1: getNum(20),
        x2: getNum(11), y2: getNum(21),
      });
    } else if (type === 'CIRCLE') {
      entities.push({
        type: 'CIRCLE', layer, space, color,
        cx: getNum(10), cy: getNum(20), r: getNum(40),
      });
    } else if (type === 'ARC') {
      entities.push({
        type: 'ARC', layer, space, color,
        cx: getNum(10), cy: getNum(20), r: getNum(40),
        startAngle: getNum(50), endAngle: getNum(51),
      });
    } else if (type === 'ELLIPSE') {
      entities.push({
        type: 'ELLIPSE', layer, space, color,
        cx: getNum(10), cy: getNum(20),
        mx: getNum(11), my: getNum(21),
        ratio: getNum(40, 1),
        startParam: getNum(41, 0), endParam: getNum(42, Math.PI * 2),
      });
    } else if (type === 'SPLINE') {
      const pts = [];
      let cur = null;
      for (const p of props) {
        if (p.code === 11 || p.code === 10) {
          if (cur && cur.code === p.code) pts.push({ x: cur.x, y: cur.y, bulge: 0 });
          cur = { code: p.code, x: parseFloat(p.value) || 0, y: 0 };
        } else if ((p.code === 21 || p.code === 20) && cur && cur.code === p.code - 10) {
          cur.y = parseFloat(p.value) || 0;
          pts.push({ x: cur.x, y: cur.y, bulge: 0 });
          cur = null;
        }
      }
      if (pts.length >= 2) entities.push({ type: 'LWPOLYLINE', layer, space, color, pts, closed: (parseInt(getOne(70, '0'), 10) & 1) !== 0 });
    } else if (type === 'SOLID' || type === '3DFACE' || type === 'TRACE') {
      const p1 = { x: getNum(10), y: getNum(20), bulge: 0 };
      const p2 = { x: getNum(11), y: getNum(21), bulge: 0 };
      const p3 = { x: getNum(12), y: getNum(22), bulge: 0 };
      const p4 = { x: getNum(13, p3.x), y: getNum(23, p3.y), bulge: 0 };
      const pts = type === '3DFACE' ? [p1, p2, p3, p4] : [p1, p2, p4, p3];
      entities.push({ type: 'LWPOLYLINE', layer, space, color, pts, closed: true });
    } else if (type === 'TEXT' || type === 'ATTRIB' || type === 'ATTDEF') {
      if (type === 'ATTDEF') continue; // Template tag inside a block definition, not placed text
      const raw = getOne(1, '');
      const str = cleanCadText(raw);
      if (str) {
        const halign = parseInt(getOne(72, '0'), 10) || 0;
        const valign = parseInt(getOne(73, '0'), 10) || 0;
        const hasAlignPt = (halign !== 0 || valign !== 0) && getOne(11) !== null;
        entities.push({
          type: 'TEXT', layer, space, color,
          x: hasAlignPt ? getNum(11) : getNum(10),
          y: hasAlignPt ? getNum(21) : getNum(20),
          height: getNum(40, 6),
          angle: getNum(50, 0),
          halign, valign,
          str,
        });
      }
    } else if (type === 'MTEXT') {
      const chunks = props.filter((p) => p.code === 3 || p.code === 1).map((p) => p.value).join('');
      const str = cleanCadText(chunks);
      if (str) {
        let angle = getNum(50, 0);
        if (getOne(11) !== null && getOne(21) !== null) {
          const dx = getNum(11), dy = getNum(21);
          if (Math.hypot(dx, dy) > 1e-6) angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        }
        entities.push({
          type: 'MTEXT', layer, space, color,
          x: getNum(10), y: getNum(20),
          height: getNum(40, 6),
          angle,
          attachment: parseInt(getOne(71, '1'), 10) || 1,
          str,
        });
      }
    } else if (type === 'DIMENSION') {
      entities.push({
        type: 'DIMENSION', layer, space, color,
        blockName: getOne(2, ''),
        dimType: (parseInt(getOne(70, '0'), 10) || 0) & 0x07,
        defX: getNum(10), defY: getNum(20),
        midX: getNum(11), midY: getNum(21),
        p1X: getNum(13), p1Y: getNum(23),
        p2X: getNum(14), p2Y: getNum(24),
        angle: getNum(50, 0),
        textAngle: getNum(53, 0),
        text: getOne(1, ''),
        measurement: getNum(42, 0),
      });
    } else if (type === 'INSERT') {
      entities.push({
        type: 'INSERT', layer, space, color,
        blockName: getOne(2, ''),
        x: getNum(10), y: getNum(20),
        sx: getNum(41, 1) || 1,
        sy: getNum(42, 1) || 1,
        angle: getNum(50, 0),
        cols: Math.min(MAX_ARRAY_SIDE, Math.max(1, parseInt(getOne(70, '1'), 10) || 1)),
        rows: Math.min(MAX_ARRAY_SIDE, Math.max(1, parseInt(getOne(71, '1'), 10) || 1)),
        colSpacing: getNum(44, 0),
        rowSpacing: getNum(45, 0),
      });
    }
  }
  return entities;
}

// Parses a DXF file (string, ArrayBuffer, or Uint8Array) into raw CAD structures.
export function parseDxf(input) {
  let pairs;
  if (typeof input === 'string') {
    pairs = tokenizeAsciiDxf(input);
  } else {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength);
    const head = new TextDecoder('latin1').decode(u8.subarray(0, Math.min(24, u8.length)));
    if (head.startsWith('AutoCAD Binary DXF')) {
      pairs = tokenizeBinaryDxf(u8);
    } else {
      pairs = tokenizeAsciiDxf(new TextDecoder('utf-8').decode(u8));
    }
  }

  const header = { insunits: 1, measurement: 0, extmin: null, extmax: null };
  const layers = new Map();
  const blocks = new Map();
  let entities = [];

  let i = 0;
  while (i < pairs.length) {
    if (pairs[i].code === 0 && pairs[i].value.toUpperCase() === 'SECTION') {
      const secPair = pairs[i + 1];
      const secName = secPair?.code === 2 ? secPair.value.toUpperCase() : '';
      let endSec = i + 2;
      while (endSec < pairs.length && !(pairs[endSec].code === 0 && pairs[endSec].value.toUpperCase() === 'ENDSEC')) {
        endSec++;
      }

      if (secName === 'HEADER') {
        let curVar = '';
        for (let k = i + 2; k < endSec; k++) {
          const p = pairs[k];
          if (p.code === 9) curVar = p.value.toUpperCase();
          else if (curVar === '$INSUNITS' && p.code === 70) header.insunits = parseInt(p.value, 10) || 0;
          else if (curVar === '$MEASUREMENT' && p.code === 70) header.measurement = parseInt(p.value, 10) || 0;
          else if (curVar === '$EXTMIN' && p.code === 10) header.extmin = { ...(header.extmin || {}), x: parseFloat(p.value) };
          else if (curVar === '$EXTMIN' && p.code === 20) header.extmin = { ...(header.extmin || {}), y: parseFloat(p.value) };
          else if (curVar === '$EXTMAX' && p.code === 10) header.extmax = { ...(header.extmax || {}), x: parseFloat(p.value) };
          else if (curVar === '$EXTMAX' && p.code === 20) header.extmax = { ...(header.extmax || {}), y: parseFloat(p.value) };
        }
      } else if (secName === 'TABLES') {
        let k = i + 2;
        while (k < endSec) {
          if (pairs[k].code === 0 && pairs[k].value.toUpperCase() === 'LAYER') {
            k++;
            let name = '0', color = 7, flags = 0;
            while (k < endSec && pairs[k].code !== 0) {
              if (pairs[k].code === 2) name = pairs[k].value.trim();
              else if (pairs[k].code === 62) color = parseInt(pairs[k].value, 10) || 7;
              else if (pairs[k].code === 70) flags = parseInt(pairs[k].value, 10) || 0;
              k++;
            }
            const frozen = (flags & 1) !== 0;
            const off = color < 0;
            layers.set(name, { name, color: Math.abs(color), hex: aciToHex(color), off: off || frozen });
          } else {
            k++;
          }
        }
      } else if (secName === 'BLOCKS') {
        let k = i + 2;
        while (k < endSec) {
          if (pairs[k].code === 0 && pairs[k].value.toUpperCase() === 'BLOCK') {
            k++;
            let name = '', bx = 0, by = 0;
            while (k < endSec && pairs[k].code !== 0) {
              if (pairs[k].code === 2 || pairs[k].code === 3) name = name || pairs[k].value.trim();
              else if (pairs[k].code === 10) bx = parseFloat(pairs[k].value) || 0;
              else if (pairs[k].code === 20) by = parseFloat(pairs[k].value) || 0;
              k++;
            }
            let endBlk = k;
            while (endBlk < endSec && !(pairs[endBlk].code === 0 && pairs[endBlk].value.toUpperCase() === 'ENDBLK')) {
              endBlk++;
            }
            const blockEntities = parseEntitySection(pairs, k, endBlk);
            if (name) blocks.set(name, { name, bx, by, entities: blockEntities });
            k = endBlk + 1;
          } else {
            k++;
          }
        }
      } else if (secName === 'ENTITIES') {
        entities = parseEntitySection(pairs, i + 2, endSec);
      }
      i = endSec + 1;
    } else {
      i++;
    }
  }

  // Fallback for minimalist DXFs that omit SECTION/ENTITIES wrapper and list entities directly
  if (!entities.length && pairs.some((p) => p.code === 0 && ['LINE', 'LWPOLYLINE', 'TEXT', 'MTEXT', 'CIRCLE', 'ARC', 'DIMENSION'].includes(p.value.toUpperCase()))) {
    entities = parseEntitySection(pairs, 0, pairs.length);
  }

  return { format: 'dxf', header, layers, blocks, entities };
}

// Dynamically loads LibreDWG WASM in the browser to read binary .DWG files.
let libreDwgPromise = null;
async function getLibreDwg() {
  if (!libreDwgPromise) {
    libreDwgPromise = import('https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.1.5/+esm')
      .then((mod) => mod.LibreDwg.create())
      .catch((err) => {
        libreDwgPromise = null;
        throw err;
      });
  }
  return libreDwgPromise;
}

const DWG_VERSIONS = {
  AC1009: 'AutoCAD R11/R12',
  AC1012: 'AutoCAD R13',
  AC1014: 'AutoCAD R14',
  AC1015: 'AutoCAD 2000',
  AC1018: 'AutoCAD 2004',
  AC1021: 'AutoCAD 2007',
  AC1024: 'AutoCAD 2010',
  AC1027: 'AutoCAD 2013',
  AC1032: 'AutoCAD 2018+',
};

export async function parseDwg(bytes, { loader = getLibreDwg } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);
  const verCode = new TextDecoder('latin1').decode(u8.subarray(0, 6));
  const verName = DWG_VERSIONS[verCode] || verCode || 'Unknown DWG';
  try {
    const libredwg = await loader();
    const ptr = libredwg.dwg_read_data(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), 0);
    if (!ptr) throw new Error(`Unsupported ${verName} binary structure`);
    const db = libredwg.convert(ptr);
    libredwg.dwg_free(ptr);
    return convertDwgDbToCadDoc(db, verName);
  } catch (err) {
    throw new Error(`Could not decode ${verName} (.dwg) directly in the browser (${err?.message || 'WASM loader unavailable'}). Export the sheet from AutoCAD/Revit as a .DXF or .PDF file and open it here.`);
  }
}

// Converts a LibreDWG database object into the same structure as parseDxf.
export function convertDwgDbToCadDoc(db, verName = 'DWG') {
  const header = {
    insunits: Number(db?.header?.INSUNITS ?? 1),
    measurement: Number(db?.header?.MEASUREMENT ?? 0),
    version: verName,
  };
  const layers = new Map();
  for (const l of db?.tables?.LAYER?.entries || []) {
    const name = String(l.name || '0').trim();
    const color = Number(l.colorIndex ?? l.color ?? 7);
    layers.set(name, { name, color: Math.abs(color), hex: aciToHex(color), off: !!l.off || !!l.frozen || color < 0 });
  }
  const blocks = new Map();
  for (const b of db?.tables?.BLOCK_RECORD?.entries || []) {
    if (b.name && Array.isArray(b.entities)) {
      blocks.set(b.name, {
        name: b.name,
        bx: Number(b.basePoint?.x || 0),
        by: Number(b.basePoint?.y || 0),
        entities: b.entities.map(normalizeDwgEntity).filter(Boolean),
      });
    }
  }
  const entities = (db?.entities || []).map(normalizeDwgEntity).filter(Boolean);
  return { format: 'dwg', header, layers, blocks, entities };
}

function normalizeDwgEntity(e) {
  if (!e || !e.type) return null;
  const type = String(e.type).toUpperCase();
  const layer = String(e.layer || '0').trim();
  const color = Number(e.colorIndex ?? e.color ?? 256);
  const space = e.inPaperSpace ? 1 : 0;
  if (type === 'LINE') {
    return {
      type: 'LINE', layer, space, color,
      x1: Number(e.startPoint?.x ?? e.x1 ?? 0), y1: Number(e.startPoint?.y ?? e.y1 ?? 0),
      x2: Number(e.endPoint?.x ?? e.x2 ?? 0), y2: Number(e.endPoint?.y ?? e.y2 ?? 0),
    };
  }
  if (type === 'LWPOLYLINE' || type === 'POLYLINE2D' || type === 'POLYLINE') {
    const pts = (e.vertices || []).map((v) => ({
      x: Number(v.x ?? 0), y: Number(v.y ?? 0), bulge: Number(v.bulge ?? 0),
    }));
    return pts.length >= 2 ? { type: 'LWPOLYLINE', layer, space, color, pts, closed: !!(e.shape || e.closed || (e.flag & 1)) } : null;
  }
  if (type === 'CIRCLE') {
    return { type: 'CIRCLE', layer, space, color, cx: Number(e.center?.x ?? 0), cy: Number(e.center?.y ?? 0), r: Number(e.radius ?? 0) };
  }
  if (type === 'ARC') {
    const toDeg = (rad) => (Math.abs(rad) <= Math.PI * 2.01 ? (rad * 180) / Math.PI : rad);
    return {
      type: 'ARC', layer, space, color,
      cx: Number(e.center?.x ?? 0), cy: Number(e.center?.y ?? 0), r: Number(e.radius ?? 0),
      startAngle: toDeg(Number(e.startAngle ?? 0)), endAngle: toDeg(Number(e.endAngle ?? 0)),
    };
  }
  if (type === 'TEXT' || type === 'MTEXT') {
    const str = cleanCadText(e.text || e.string || '');
    if (!str) return null;
    const pt = e.insertionPoint || e.startPoint || { x: e.x || 0, y: e.y || 0 };
    return {
      type, layer, space, color,
      x: Number(pt.x || 0), y: Number(pt.y || 0),
      height: Number(e.textHeight || e.height || 6),
      angle: Number(e.rotation || 0),
      str,
    };
  }
  if (type === 'INSERT') {
    const pt = e.insertionPoint || { x: e.x || 0, y: e.y || 0 };
    return {
      type: 'INSERT', layer, space, color,
      blockName: e.name || e.blockName || '',
      x: Number(pt.x || 0), y: Number(pt.y || 0),
      sx: Number(e.xScale ?? 1) || 1, sy: Number(e.yScale ?? 1) || 1,
      angle: Number(e.rotation ?? 0),
      cols: Math.min(MAX_ARRAY_SIDE, Math.max(1, Math.floor(Number(e.columnCount || 1)) || 1)),
      rows: Math.min(MAX_ARRAY_SIDE, Math.max(1, Math.floor(Number(e.rowCount || 1)) || 1)),
      colSpacing: Number(e.columnSpacing || 0),
      rowSpacing: Number(e.rowSpacing || 0),
    };
  }
  return null;
}

// Expands all entities (including INSERT block references and DIMENSION geometry) into flat world-space primitives:
//   rawSegs: [{ x1, y1, x2, y2, layer, color }]
//   rawText: [{ str, x, y, height, angle, layer, color, halign, attachment }]
function flattenCadEntities(cadDoc) {
  const rawSegs = [];
  const rawText = [];
  // Work done expanding block references, capped so a malformed or hostile drawing can't freeze the page.
  let visits = 0;
  const { blocks, layers } = cadDoc;

  // Prefer model-space entities when present; fall back to all entities if only paper-space exists
  const modelEnts = cadDoc.entities.filter((e) => !e.space);
  const rootEnts = modelEnts.length ? modelEnts : cadDoc.entities;

  // Affine 2D transform: [a, b, c, d, tx, ty] mapping (x, y) -> (a*x + c*y + tx, b*x + d*y + ty)
  const IDENTITY = [1, 0, 0, 1, 0, 0];
  const txPt = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const mulM = (p, c) => [
    p[0] * c[0] + p[2] * c[1],
    p[1] * c[0] + p[3] * c[1],
    p[0] * c[2] + p[2] * c[3],
    p[1] * c[2] + p[3] * c[3],
    p[0] * c[4] + p[2] * c[5] + p[4],
    p[1] * c[4] + p[3] * c[5] + p[5],
  ];

  const ensureLayer = (name) => {
    const key = name || '0';
    if (!layers.has(key)) layers.set(key, { name: key, color: 7, hex: '#1e293b', off: false });
    return key;
  };

  const addSeg = (x1, y1, x2, y2, layer, color) => {
    if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return;
    if (Math.hypot(x2 - x1, y2 - y1) < 1e-6) return;
    rawSegs.push({ x1, y1, x2, y2, layer: ensureLayer(layer), color });
  };

  function visit(ent, m, inheritedLayer, depth) {
    if (depth > 6 || ++visits > MAX_VISITS) return;
    const layer = (ent.layer === '0' && inheritedLayer) ? inheritedLayer : (ent.layer || '0');
    ensureLayer(layer);
    const scaleAvg = (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2 || 1;
    const rotDeg = (Math.atan2(m[1], m[0]) * 180) / Math.PI;

    if (ent.type === 'LINE') {
      const [x1, y1] = txPt(m, ent.x1, ent.y1);
      const [x2, y2] = txPt(m, ent.x2, ent.y2);
      addSeg(x1, y1, x2, y2, layer, ent.color);
    } else if (ent.type === 'LWPOLYLINE') {
      const pts = ent.pts;
      if (pts.length < 2) return;
      const count = ent.closed ? pts.length : pts.length - 1;
      for (let k = 0; k < count; k++) {
        const a = pts[k];
        const b = pts[(k + 1) % pts.length];
        const arcPts = bulgePoints([a.x, a.y], [b.x, b.y], a.bulge);
        let prev = txPt(m, a.x, a.y);
        for (const p of arcPts) {
          const cur = txPt(m, p[0], p[1]);
          addSeg(prev[0], prev[1], cur[0], cur[1], layer, ent.color);
          prev = cur;
        }
      }
    } else if (ent.type === 'CIRCLE') {
      const steps = 24;
      let prev = txPt(m, ent.cx + ent.r, ent.cy);
      for (let k = 1; k <= steps; k++) {
        const a = (k * 2 * Math.PI) / steps;
        const cur = txPt(m, ent.cx + ent.r * Math.cos(a), ent.cy + ent.r * Math.sin(a));
        addSeg(prev[0], prev[1], cur[0], cur[1], layer, ent.color);
        prev = cur;
      }
    } else if (ent.type === 'ARC') {
      const sA = (ent.startAngle * Math.PI) / 180;
      const eA = (ent.endAngle * Math.PI) / 180;
      if (!Number.isFinite(sA) || !Number.isFinite(eA)) return;
      let sweep = (eA - sA) % (Math.PI * 2);
      if (sweep <= 0) sweep += Math.PI * 2;
      const steps = Math.max(6, Math.min(32, Math.ceil((sweep / (Math.PI * 2)) * 24)));
      let prev = txPt(m, ent.cx + ent.r * Math.cos(sA), ent.cy + ent.r * Math.sin(sA));
      for (let k = 1; k <= steps; k++) {
        const a = sA + (sweep * k) / steps;
        const cur = txPt(m, ent.cx + ent.r * Math.cos(a), ent.cy + ent.r * Math.sin(a));
        addSeg(prev[0], prev[1], cur[0], cur[1], layer, ent.color);
        prev = cur;
      }
    } else if (ent.type === 'ELLIPSE') {
      const steps = 24;
      let sP = ent.startParam ?? 0;
      let eP = ent.endParam ?? Math.PI * 2;
      if (eP <= sP) eP += Math.PI * 2;
      const sweep = eP - sP;
      const ux = ent.mx, uy = ent.my;
      const vx = -uy * ent.ratio, vy = ux * ent.ratio;
      const ptAt = (t) => txPt(m, ent.cx + ux * Math.cos(t) + vx * Math.sin(t), ent.cy + uy * Math.cos(t) + vy * Math.sin(t));
      let prev = ptAt(sP);
      for (let k = 1; k <= steps; k++) {
        const cur = ptAt(sP + (sweep * k) / steps);
        addSeg(prev[0], prev[1], cur[0], cur[1], layer, ent.color);
        prev = cur;
      }
    } else if (ent.type === 'TEXT' || ent.type === 'MTEXT') {
      const [wx, wy] = txPt(m, ent.x, ent.y);
      const h = Math.max(0.5, (ent.height || 6) * scaleAvg);
      const lines = ent.str.split('\n').map((s) => s.trim()).filter(Boolean);
      const ang = (ent.angle || 0) + rotDeg;
      const rad = (ang * Math.PI) / 180;
      // Normal pointing "down" to next line in CAD space
      const downX = Math.sin(rad), downY = -Math.cos(rad);
      lines.forEach((lineStr, idx) => {
        rawText.push({
          str: lineStr,
          x: wx + downX * idx * h * 1.35,
          y: wy + downY * idx * h * 1.35,
          height: h,
          angle: ang,
          layer: ensureLayer(layer),
          color: ent.color,
          centered: ent.type === 'MTEXT' ? [2, 5, 8].includes(ent.attachment) : ent.halign === 1 || ent.halign === 4,
        });
      });
    } else if (ent.type === 'DIMENSION') {
      const blk = ent.blockName && blocks.get(ent.blockName);
      if (blk && blk.entities.length) {
        for (const sub of blk.entities) visit(sub, m, layer, depth + 1);
      } else {
        // Synthesize dimension geometry + label when anonymous *D block is omitted
        synthesizeDimension(ent, m, layer, addSeg, rawText, ensureLayer);
      }
    } else if (ent.type === 'INSERT') {
      const blk = blocks.get(ent.blockName);
      if (!blk) return;
      const rad = ((ent.angle || 0) * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      for (let r = 0; r < ent.rows && visits <= MAX_VISITS; r++) {
        for (let c = 0; c < ent.cols && visits <= MAX_VISITS; c++) {
          const ox = c * ent.colSpacing;
          const oy = r * ent.rowSpacing;
          const ix = ent.x + ox * cos - oy * sin;
          const iy = ent.y + ox * sin + oy * cos;
          // Transform block local (x - bx, y - by) -> scaled -> rotated -> translated to (ix, iy)
          const a = ent.sx * cos, b = ent.sx * sin;
          const c2 = -ent.sy * sin, d = ent.sy * cos;
          const tx = ix - (a * blk.bx + c2 * blk.by);
          const ty = iy - (b * blk.bx + d * blk.by);
          const childM = mulM(m, [a, b, c2, d, tx, ty]);
          for (const sub of blk.entities) visit(sub, childM, layer, depth + 1);
        }
      }
    }
  }

  for (const ent of rootEnts) visit(ent, IDENTITY, null, 0);
  return { rawSegs, rawText };
}

// Synthesizes dimension line, witness lines, 45-degree architectural ticks, and dimension text
// when a DXF DIMENSION entity does not carry an expanded *D anonymous block.
function synthesizeDimension(ent, m, layer, addSeg, rawText, ensureLayer) {
  let label = cleanCadText(ent.text);
  const meas = ent.measurement || Math.hypot(ent.p2X - ent.p1X, ent.p2Y - ent.p1Y);
  if (!label || label === '<>') {
    if (meas > 0) label = meas >= 12 && meas % 1 === 0 ? fmtFtIn(meas) : `${Math.round(meas * 16) / 16}"`;
  } else if (label.includes('<>') && meas > 0) {
    label = label.replace('<>', fmtFtIn(meas));
  }
  const horiz = Math.abs(ent.p2X - ent.p1X) >= Math.abs(ent.p2Y - ent.p1Y);
  if (horiz && Math.abs(ent.p2X - ent.p1X) > 1e-3) {
    const y = ent.defY || ent.midY || ent.p1Y;
    const x1 = Math.min(ent.p1X, ent.p2X), x2 = Math.max(ent.p1X, ent.p2X);
    const span = x2 - x1;
    const tick = Math.max(1.5, Math.min(6, span * 0.03));
    // Dimension line
    addSeg(x1, y, x2, y, layer, ent.color);
    // Witness lines + 45-deg architectural ticks (so takeoff.js dimExtent & endMarks recognize it)
    addSeg(x1, y - tick, x1, y + tick, layer, ent.color);
    addSeg(x2, y - tick, x2, y + tick, layer, ent.color);
    addSeg(x1 - tick * 0.7, y - tick * 0.7, x1 + tick * 0.7, y + tick * 0.7, layer, ent.color);
    addSeg(x2 - tick * 0.7, y - tick * 0.7, x2 + tick * 0.7, y + tick * 0.7, layer, ent.color);
    if (label) {
      const h = Math.max(2, Math.min(10, span * 0.06));
      rawText.push({
        str: label,
        x: ent.midX || (x1 + x2) / 2,
        y: y + h * 0.7,
        height: h,
        angle: 0,
        layer: ensureLayer(layer),
        color: ent.color,
        centered: true,
      });
    }
  } else if (!horiz && Math.abs(ent.p2Y - ent.p1Y) > 1e-3) {
    const x = ent.defX || ent.midX || ent.p1X;
    const y1 = Math.min(ent.p1Y, ent.p2Y), y2 = Math.max(ent.p1Y, ent.p2Y);
    const span = y2 - y1;
    const tick = Math.max(1.5, Math.min(6, span * 0.03));
    addSeg(x, y1, x, y2, layer, ent.color);
    addSeg(x - tick, y1, x + tick, y1, layer, ent.color);
    addSeg(x - tick, y2, x + tick, y2, layer, ent.color);
    addSeg(x - tick * 0.7, y1 - tick * 0.7, x + tick * 0.7, y1 + tick * 0.7, layer, ent.color);
    addSeg(x - tick * 0.7, y2 - tick * 0.7, x + tick * 0.7, y2 + tick * 0.7, layer, ent.color);
    if (label) {
      const h = Math.max(2, Math.min(10, span * 0.06));
      rawText.push({
        str: label,
        x: x - h * 0.7,
        y: ent.midY || (y1 + y2) / 2,
        height: h,
        angle: 90,
        layer: ensureLayer(layer),
        color: ent.color,
        centered: true,
      });
    }
  }
}

// Converts a parsed CAD document into a Stellar Glass page model compatible with reader.js and takeoff.js.
export function cadToPageModel(cadDoc, { page = 1, targetSpan = 1800, margin = 72 } = {}) {
  const { rawSegs, rawText } = flattenCadEntities(cadDoc);

  // Compute robust bounding box across all segments and text
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const includePt = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const s of rawSegs) {
    includePt(s.x1, s.y1);
    includePt(s.x2, s.y2);
  }
  for (const t of rawText) {
    includePt(t.x, t.y);
  }
  if (!Number.isFinite(minX)) {
    minX = 0; minY = 0; maxX = 120; maxY = 96;
  }

  const spanX = Math.max(12, maxX - minX);
  const spanY = Math.max(12, maxY - minY);
  const maxSpan = Math.max(spanX, spanY);
  // Display scale: display points per 1 CAD drawing unit
  const cadScale = targetSpan / maxSpan;
  const width = Math.round(spanX * cadScale + margin * 2);
  const height = Math.round(spanY * cadScale + margin * 2);

  // Convert CAD coordinates (Y up) to display coordinates (origin top-left, Y down)
  const toDispX = (cx) => margin + (cx - minX) * cadScale;
  const toDispY = (cy) => margin + (maxY - cy) * cadScale;

  const layerMap = cadDoc.layers;
  const layerColor = (layerName, entColor) => {
    if (entColor && entColor > 0 && entColor < 256) return aciToHex(entColor);
    return layerMap.get(layerName)?.hex || '#1e293b';
  };

  const allSegs = rawSegs.map((s) => ({
    x1: toDispX(s.x1),
    y1: toDispY(s.y1),
    x2: toDispX(s.x2),
    y2: toDispY(s.y2),
    fill: false,
    mask: false,
    layer: s.layer,
    color: layerColor(s.layer, s.color),
  }));

  const allText = rawText.map((t) => {
    const size = Math.max(4, Math.min(72, t.height * cadScale));
    // In CAD (Y up), angle +90 is straight up; in display space (Y down), that's -90.
    const dispAngle = Math.round(-t.angle);
    const rad = (dispAngle * Math.PI) / 180;
    const dir = [Math.cos(rad), Math.sin(rad)];
    // "up" in reader.js points from baseline toward top of glyphs (negative Y for horizontal upright text)
    const up = [Math.sin(rad), -Math.cos(rad)];
    const w = t.str.length * size * 0.58;
    const cx = toDispX(t.x);
    const cy = toDispY(t.y);
    const ox = t.centered ? cx - (dir[0] * w) / 2 : cx;
    const oy = t.centered ? cy - (dir[1] * w) / 2 : cy;
    const x = ox + (dir[0] * w) / 2 + up[0] * size * 0.35;
    const y = oy + (dir[1] * w) / 2 + up[1] * size * 0.35;
    return {
      str: t.str,
      x, y, ox, oy, w, size,
      angle: dispAngle,
      dir, up,
      layer: t.layer,
      color: layerColor(t.layer, t.color),
    };
  });

  // Determine real inches per CAD unit from $INSUNITS (default 1 = inches)
  const insunits = cadDoc.header?.insunits ?? 1;
  const inchesPerUnit = INSUNITS_TO_INCHES[insunits] || 1;
  // Display points per real inch = (display points per CAD unit) / (real inches per CAD unit)
  const ppi = cadScale / inchesPerUnit;
  const unitLabel = INSUNITS_LABELS[insunits] || 'Inches';

  // Summarize layers with entity counts, sorted with glazing/architectural layers first
  const layerCounts = new Map();
  for (const s of allSegs) layerCounts.set(s.layer, (layerCounts.get(s.layer) || 0) + 1);
  for (const t of allText) layerCounts.set(t.layer, (layerCounts.get(t.layer) || 0) + 1);

  const layersList = [...layerCounts.entries()]
    .map(([name, count]) => {
      const info = layerMap.get(name) || { name, color: 7, hex: '#1e293b', off: false };
      return { name, count, hex: info.hex, off: !!info.off };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

  const hiddenLayers = new Set(layersList.filter((l) => l.off).map((l) => l.name));

  const model = {
    page,
    width,
    height,
    text: [],
    segs: [],
    annots: [],
    cad: {
      isCad: true,
      format: cadDoc.format || 'dxf',
      insunits,
      unitLabel,
      inchesPerUnit,
      cadScale,
      ppi,
      minX, minY, maxX, maxY,
      layers: layersList,
      hiddenLayers,
      allSegs,
      allText,
    },
  };

  applyCadLayerFilter(model);
  return model;
}

// Rebuilds model.segs and model.text from visible CAD layers and clears cached reader.js lookups.
export function applyCadLayerFilter(model, hiddenSet = model?.cad?.hiddenLayers) {
  if (!model?.cad) return model;
  const hidden = hiddenSet instanceof Set ? hiddenSet : new Set(hiddenSet || []);
  model.cad.hiddenLayers = hidden;
  model.segs = model.cad.allSegs.filter((s) => !hidden.has(s.layer));
  model.text = model.cad.allText.filter((t) => !hidden.has(t.layer));
  delete model._runs;
  delete model._tags;
  delete model._index;
  delete model._views;
  delete model._grids;
  delete model._dimScales;
  return model;
}

// Renders a CAD page model onto a 2D HTML5 Canvas at zoom scale `zoom`.
export function renderCadToCanvas(ctx, model, zoom = 1) {
  const w = Math.round(model.width * zoom);
  const h = Math.round(model.height * zoom);
  // Crisp drafting sheet background with subtle grid
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  const gridStep = Math.max(24, Math.round(72 * zoom));
  ctx.strokeStyle = '#f1f5f9';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = gridStep; x < w; x += gridStep) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = gridStep; y < h; y += gridStep) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  // Group segments by stroke color for fast batched canvas path drawing
  const byColor = new Map();
  for (const s of model.segs) {
    const c = s.color || '#1e293b';
    if (!byColor.has(c)) byColor.set(c, []);
    byColor.get(c).push(s);
  }
  ctx.lineWidth = Math.max(1, 1.15 * Math.sqrt(zoom));
  ctx.lineCap = 'round';
  for (const [color, segs] of byColor) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (const s of segs) {
      ctx.moveTo(s.x1 * zoom, s.y1 * zoom);
      ctx.lineTo(s.x2 * zoom, s.y2 * zoom);
    }
    ctx.stroke();
  }

  // Draw text items
  ctx.textBaseline = 'alphabetic';
  for (const t of model.text) {
    const px = Math.max(7, t.size * zoom);
    ctx.save();
    ctx.translate(t.ox * zoom, t.oy * zoom);
    if (t.angle) ctx.rotate((t.angle * Math.PI) / 180);
    ctx.font = `600 ${px.toFixed(1)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = t.color || '#0f172a';
    ctx.fillText(t.str, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

// High-level helper: loads a DXF or DWG byte buffer into a ready-to-use Stellar Glass page model.
export async function loadCadBytes(bytes, { type = '', name = '', page = 1 } = {}) {
  const kind = detectCadKind(type, name, bytes) || 'dxf';
  const cadDoc = kind === 'dwg' ? await parseDwg(bytes) : parseDxf(bytes);
  return cadToPageModel(cadDoc, { page });
}
