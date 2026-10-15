// Architectural dimensions: parse "8' - 0\"", "103 5/8\"", "2'-10 1/4\"", "96\" [8'-0\"]" into inches,
// and print inches back as feet-inches. Pure functions, shared by the browser and the Node tests.

const UNICODE_FRACTIONS = { '¼': '1/4', '½': '1/2', '¾': '3/4', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8', '⅓': '1/3', '⅔': '2/3', '⅙': '1/6', '⅚': '5/6', '⅕': '1/5' };

function clean(s) {
  return String(s ?? '')
    .replace(/[¼½¾⅛⅜⅝⅞⅓⅔⅙⅚⅕]/g, (c) => ` ${UNICODE_FRACTIONS[c]}`)
    .replace(/[‘’′´`]/g, "'")
    .replace(/[“”″]|''/g, '"')
    .replace(/–|—|−/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// "5/8" -> 0.625, "5" -> 5
function num(s) {
  if (s == null || s === '') return 0;
  const m = /^(\d+)\/(\d+)$/.exec(s);
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : NaN;
  return Number(s);
}

// Inches part: "10", "10 1/4", "10-1/4", "1/4", "10.5"
function inchesPart(s) {
  const t = s.trim();
  if (!t) return 0;
  let m = /^(\d+(?:\.\d+)?)(?:[ -]+(\d+\/\d+))?$/.exec(t);
  if (m) return Number(m[1]) + num(m[2]);
  m = /^(\d+\/\d+)$/.exec(t);
  if (m) return num(m[1]);
  return NaN;
}

// Returns inches, or null when the text isn't a dimension.
// Accepts feet-inches (8'-0", 8' 0", 8'0", 8'), inches (96", 103 5/8", 103-5/8"), "8 ft 6 in",
// and a bare number with unit hint ("in" or "ft"). Ignores bracketed alternates: 96" [8'-0"] -> 96.
export function parseDim(text, { bare = null } = {}) {
  let s = clean(text);
  if (!s) return null;
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\b(?:V\.?I\.?F|A\.?F\.?F|R\.?O|TYP|NOM|CLR|MIN|MAX)\b\.?/gi, '').trim();
  let m = /^(\d+(?:\.\d+)?)\s*(?:'|ft\.?|feet|foot)\s*-?\s*(?:(\d+(?:\.\d+)?(?:[ -]+\d+\/\d+)?|\d+\/\d+)\s*(?:"|in\.?|inches|inch)?)?$/i.exec(s);
  if (m) {
    const inch = m[2] ? inchesPart(m[2]) : 0;
    if (Number.isNaN(inch) || inch >= 12.0001) return null;
    return round(Number(m[1]) * 12 + inch);
  }
  m = /^(\d+(?:\.\d+)?(?:[ -]+\d+\/\d+)?|\d+\/\d+)\s*(?:"|in\.?|inches|inch)$/i.exec(s);
  if (m) {
    const inch = inchesPart(m[1]);
    return Number.isNaN(inch) ? null : round(inch);
  }
  if (bare && /^\d+(?:\.\d+)?(?:[ -]+\d+\/\d+)?$/.test(s)) {
    const v = inchesPart(s);
    if (Number.isNaN(v)) return null;
    return round(bare === 'ft' ? v * 12 : v);
  }
  return null;
}

const round = (n) => Math.round(n * 10000) / 10000;

// Finds every dimension inside a longer string ("48\" x 48\"", "8'-0\" W x 6'-8\" H").
export function findDims(text) {
  const s = clean(text);
  const re = /(\d+(?:\.\d+)?\s*'\s*-?\s*(?:\d+(?:\.\d+)?(?:[ -]+\d+\/\d+)?|\d+\/\d+)?\s*"?)|(\d+(?:\.\d+)?(?:[ -]+\d+\/\d+)?\s*")/g;
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    const v = parseDim(m[0]);
    if (v != null) out.push({ text: m[0].trim(), inches: v, index: m.index });
  }
  return out;
}

// Width x height in one string: "48 x 48", "48\" x 96\"", "4'-0\" x 8'-0\"", "36 1/2 x 72".
// Bare numbers are read as inches. Returns { widthIn, heightIn } or null.
export function parseSize(text) {
  const s = clean(text).replace(/×/g, 'x');
  const parts = s.split(/\s*(?:\bx\b|\bby\b|X|\*)\s*/i);
  if (parts.length !== 2) return null;
  const w = parseDim(parts[0], { bare: 'in' });
  const h = parseDim(parts[1], { bare: 'in' });
  return w && h ? { widthIn: w, heightIn: h } : null;
}

// 96 -> 8'-0", 103.625 -> 8'-7 5/8", 20 -> 1'-8". Rounds to the nearest 1/16".
export function fmtFtIn(inches) {
  if (inches == null || Number.isNaN(Number(inches))) return '';
  let sixteenths = Math.round(Number(inches) * 16);
  const neg = sixteenths < 0;
  sixteenths = Math.abs(sixteenths);
  const ft = Math.floor(sixteenths / 192);
  const rem = sixteenths - ft * 192;
  const whole = Math.floor(rem / 16);
  const frac = rem % 16;
  return `${neg ? '-' : ''}${ft}'-${whole}${frac ? ` ${fracText(frac)}` : ''}"`;
}

// 103.625 -> 103 5/8"
export function fmtIn(inches) {
  if (inches == null || Number.isNaN(Number(inches))) return '';
  const sixteenths = Math.round(Number(inches) * 16);
  const whole = Math.trunc(sixteenths / 16);
  const frac = Math.abs(sixteenths % 16);
  return `${whole}${frac ? ` ${fracText(frac)}` : ''}"`;
}

function fracText(sixteenths) {
  let n = sixteenths, d = 16;
  while (n % 2 === 0 && d > 1) { n /= 2; d /= 2; }
  return `${n}/${d}`;
}

// Drawing scales: "1/4\" = 1'-0\"" -> 48 (real inches per paper inch), "1\" = 20'-0\"" -> 240.
export function parseScale(text) {
  const s = clean(text);
  const m = /(\d+(?:\/\d+)?|\d+\s+\d+\/\d+)\s*"\s*=\s*(\d+\s*'\s*-?\s*\d*\s*"?|\d+\s*")/.exec(s);
  if (!m) return null;
  const paper = m[1].includes(' ') ? m[1].split(/\s+/).reduce((a, b) => a + num(b), 0) : num(m[1]);
  const real = parseDim(m[2]);
  return paper > 0 && real ? round(real / paper) : null;
}
