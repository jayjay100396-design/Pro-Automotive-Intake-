// Reads sizes and counts out of markups people add to drawings: Bluebeam or Acrobat text boxes,
// callouts, sticky notes and measurements ("A1 54 x 104 (7)", "Type C: 8'-0\" x 6'-8\" qty 15",
// "12'-6\"", "53.3 sf"), and sizes written as text on the sheet itself, as a markup becomes once
// it's flattened. Pure functions, shared by the browser and the Node tests.
import { parseDim, fmtFtIn } from './dims.js';
import { textRuns } from './reader.js';

// A number: 36 1/2, 36-1/2, 3/4 or 36.5 (fractions first, so 3/4 isn't read as 3)
const NUM = String.raw`\d+(?:\.\d+)?[ -]+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?`;
// One side of a size: 54, 54", 4'-6", 4' 6", 4 ft 6 in, 36 1/2
const SIDE = String.raw`(?:(?:${NUM})\s*(?:'|ft\.?)\s*-?\s*(?:(?:${NUM})\s*(?:"|in\.?)?)?|(?:${NUM})\s*(?:"|in\.?)?)`;
const SIZE_RE = new RegExp(String.raw`(${SIDE})\s*(?:x|X|×|by)\s*(${SIDE})`);
const LABEL_RE = /^(?:type|mark|tag|opening|window|unit)?\s*#?\s*([A-Z]{1,3}[-.]?\d{0,3}[A-Z]?|\d{1,3}[A-Z]{1,2})\b\s*[:=\-–]?\s*/i;
const NOT_LABELS = new Set(['X', 'BY', 'IN', 'FT', 'SF', 'EA', 'QTY', 'SIZE', 'THE', 'AT', 'ADD', 'SEE', 'NEW', 'DEL', 'RO', 'TYP', 'VIF', 'PER']);

function clean(text) {
  return String(text ?? '')
    .replace(/[‘’′]/g, "'").replace(/[“”″]/g, '"')
    .replace(/[¼½¾⅛⅜⅝⅞]/g, (c) => ` ${{ '¼': '1/4', '½': '1/2', '¾': '3/4', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8' }[c]}`)
    .replace(/\s+/g, ' ').trim();
}

// What one markup says about an opening. Any field can be missing:
// { label, qty, widthIn, heightIn, lengthIn, areaSqft }
export function parseOpeningText(text) {
  const s = clean(text);
  const out = {};
  if (!s) return out;
  const size = SIZE_RE.exec(s);
  if (size) {
    const w = parseDim(size[1], { bare: 'in' });
    const h = parseDim(size[2], { bare: 'in' });
    if (w && h) { out.widthIn = w; out.heightIn = h; }
  }
  // Count: (7), qty 7, 7 ea, x 7 / @ 7 after the size, 7 pcs
  const after = size ? s.slice(size.index + size[0].length) : s;
  const q = /\((\d{1,4})\)/.exec(s) || /\b(?:qty|quantity|count)\.?\s*[:=]?\s*(\d{1,4})\b/i.exec(s)
    || /\b(\d{1,4})\s*(?:ea|each|pcs?|pieces|units|total)\b/i.exec(s)
    || (size && /^\s*(?:x|X|×|@)\s*(\d{1,4})\b(?!\s*(?:'|"|ft|in|\/))/.exec(after));
  if (q) out.qty = Number(q[1]);
  // Label: the first word, when it looks like a type mark (A1, SF-2, W3, C)
  const lead = s.replace(/^\(\d{1,4}\)\s*/, '');
  const l = LABEL_RE.exec(lead);
  if (l && /[A-Z]/i.test(l[1]) && !NOT_LABELS.has(l[1].toUpperCase().replace(/[-.]/g, ''))
    && !(size && size.index === lead.indexOf(l[1]))) {
    out.label = l[1].toUpperCase();
  }
  // A lone measurement: a length (12'-6") or an area (53.3 sf)
  if (!size) {
    const area = /(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:sf|sq\.?\s*ft\.?|ft²|square feet)\b/i.exec(s);
    if (area) out.areaSqft = Number(area[1].replace(/,/g, ''));
    else {
      const m = new RegExp(String.raw`(${SIDE})`).exec(s.replace(/\(\d{1,4}\)/, ''));
      const len = m ? parseDim(m[1]) : null;
      if (len && /['"]|ft|in/.test(m[1])) out.lengthIn = len;
    }
  }
  return out;
}

// Sizes written as plain text on a sheet ("A1 54 x 104 (7)" from a flattened markup). Only text
// naming a size of a foot or more with a type or a count, so notes like "2 x 4 blocking" or
// "(5) 3/4\" x 6\" bolts" stay out.
function writtenOnSheet(model) {
  const out = [];
  for (const r of textRuns(model)) {
    const o = parseOpeningText(r.str);
    if (!(o.widthIn >= 12 && o.heightIn >= 12 && (o.qty || o.label))) continue;
    out.push({ page: model.page, subtype: 'Written', text: r.str, author: '', x: r.x, y: r.y, box: [r.x0, r.y0, r.x1, r.y1], ...o });
  }
  return out;
}

// Every markup on the pages with what it says, then sizes written on the sheets as text.
// models: pages from reader.loadPage. labels: type marks already known from the drawings, so
// "Verify B at east elevation" finds B.
// [{ page, subtype, text, author, x, y, box, ...parseOpeningText(text) }]
export function readMarkups(models, labels = []) {
  const known = new Set(labels.map((l) => String(l).toUpperCase()));
  const out = [];
  for (const m of models) {
    for (const a of m.annots || []) {
      if (!a.text && a.subtype !== 'Ink') continue;
      const parsed = parseOpeningText(a.text);
      if (!parsed.label && known.size) {
        const word = clean(a.text).toUpperCase().split(/[^A-Z0-9-]+/).find((w) => known.has(w));
        if (word) parsed.label = word;
      }
      out.push({
        page: m.page, subtype: a.subtype, text: a.text, author: a.author,
        x: (a.x0 + a.x1) / 2, y: (a.y0 + a.y1) / 2, box: [a.x0, a.y0, a.x1, a.y1],
        ...parsed,
      });
    }
  }
  for (const m of models) out.push(...writtenOnSheet(m));
  return out;
}

// Markups that name a size become openings: same label and size add up.
export function markupOpenings(marks) {
  const map = new Map();
  for (const k of marks) {
    if (!k.widthIn || !k.heightIn) continue;
    const key = `${k.label || ''}|${k.widthIn}|${k.heightIn}`;
    const o = map.get(key) || { label: k.label || '', qty: 0, widthIn: k.widthIn, heightIn: k.heightIn, how: 'written in a markup', places: [] };
    o.qty += k.qty || 1;
    o.places.push({ page: k.page, text: k.text });
    map.set(key, o);
  }
  return [...map.values()];
}

// Openings read from the drawing, with missing sizes filled in from markups naming the same type;
// with nothing read from the drawing, the markups' own openings.
export function withMarkups(openings, marks) {
  const fromMarks = markupOpenings(marks);
  if (!openings.length) return fromMarks;
  return openings.map((o) => {
    if (o.widthIn && o.heightIn) return o;
    const k = fromMarks.find((x) => x.label && x.label === o.label);
    return k ? { ...o, widthIn: k.widthIn, heightIn: k.heightIn, how: 'size from a markup' } : o;
  });
}

export const describe = (o) => `${o.label ? `${o.label} ` : ''}${fmtFtIn(o.widthIn)} x ${fmtFtIn(o.heightIn)}${o.qty ? ` (${o.qty})` : ''}`;
