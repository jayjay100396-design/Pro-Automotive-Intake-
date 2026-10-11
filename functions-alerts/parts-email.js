// Parts from suppliers: the parts list, sizes in inches and fractions, where an order stands, and the emails that go
// to the supplier (the quote request or order, placing the order from a quote, and asking for an update).
// Plain functions with no Firebase, so the app (public/js/parts.js) and the server that sends the emails
// (functions-alerts/parts-request.js) build exactly the same email. functions-alerts/parts-email.js is a copy of
// this file: after changing it, run `npm run sync:email` (npm test fails while the two differ).

export const LIST_TYPES = [
  ['parts', 'Part numbers'],
  ['glass', 'Glass sizes'],
  ['general', 'Description and quantity'],
];
export const REQUEST_KINDS = [['quote', 'Price quote'], ['order', 'Order']];
export const DELIVERY = [['site', 'Deliver to the job site'], ['shop', 'Deliver to our shop'], ['pickup', 'We\'ll pick it up']];
// Units for the Unit column. Anything else typed there is kept as typed.
export const UNITS = ['ea', 'pcs', 'pkg', 'box', 'S/L', 'roll', 'lf', 'pr', 'set', 'tube', 'gal', 'lot', 'sq ft'];

// The columns of the parts list for each list type: [field, heading, kind of input].
export const COLUMNS = {
  glass: [['qty', 'Qty', 'qty'], ['width', 'Width', 'inches'], ['height', 'Height', 'inches'], ['desc', 'Glass', 'text'], ['edge', 'Edges, holes, notes', 'text'], ['mark', 'Mark', 'short']],
  parts: [['qty', 'Qty', 'qty'], ['unit', 'Unit', 'unit'], ['partNo', 'Part #', 'short'], ['desc', 'Description', 'text']],
  general: [['qty', 'Qty', 'qty'], ['unit', 'Unit', 'unit'], ['desc', 'Description', 'text']],
};

// What the email says first and last, unless the request says otherwise. The quote wording is Wes's own.
export const INTRO = { quote: 'Kindly quote the following for us.', order: 'Please enter the following order for us.' };
export const CLOSING = { quote: 'Please send pricing and lead time.', order: 'Please confirm the order, pricing and delivery date.' };

export const MAX_ITEMS = 200;
export const MAX_EMAILS = 5;
export const MAX_ATTACHMENTS = 10;
// Job files sent along with the email, in all. Gmail takes 25 MB per email once the files are encoded.
export const MAX_ATTACH_BYTES = 15 * 1024 * 1024;
// A note added to one email (placing the order, asking for an update).
export const MAX_NOTE = 1000;

// ---------- Where an order stands ----------
export const PARTS_STATUS = ['draft', 'sent', 'quoted', 'ordered', 'confirmed', 'shipped', 'partial', 'received', 'cancelled'];
export const STATUS_LABEL = {
  draft: 'Draft', sent: 'Quote requested', quoted: 'Quoted', ordered: 'Ordered', confirmed: 'Confirmed', shipped: 'Shipped or ready',
  partial: 'Partly received', received: 'Received', cancelled: 'Cancelled',
};
// The steps, in order. A quote request starts at 'sent'; parts ordered straight away start at 'ordered'.
export const STAGES = ['sent', 'quoted', 'ordered', 'confirmed', 'shipped', 'received'];
export const STAGE_LABEL = { sent: 'Requested', quoted: 'Quoted', ordered: 'Ordered', confirmed: 'Confirmed', shipped: 'Shipped', received: 'Received' };
// Sent and not all in yet: what the tracker watches.
export const OPEN_STATUS = ['sent', 'quoted', 'ordered', 'confirmed', 'shipped', 'partial'];

export const stageOf = (status) => (status === 'partial' ? 'received' : status);
// The steps this request goes through: all of them for a quote request, from 'ordered' on for a straight order.
export function stagesFor(r = {}) {
  const quoted = r.kind !== 'order' || r.requestedOn || r.quotedOn || ['sent', 'quoted'].includes(r.status);
  return quoted ? STAGES : STAGES.slice(STAGES.indexOf('ordered'));
}
export const isOpen = (r = {}) => OPEN_STATUS.includes(r.status);
// Expected by a date that has passed (dates are "YYYY-MM-DD", so they compare as text).
export const isLate = (r = {}, today = '') => isOpen(r) && !!r.expectedOn && !!today && r.expectedOn < today;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayNumber = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5;
export const daysBetween = (from, to) => (DAY.test(String(from)) && DAY.test(String(to)) ? Math.round(dayNumber(to) - dayNumber(from)) : null);
// "2026-11-14" → "Nov 14".
export function fmtShort(iso) {
  if (!DAY.test(String(iso ?? ''))) return '';
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

// A line about where the request stands, for the list and the job: { text, level } where level is 'late', 'warn'
// or ''.
export function trackingNote(r = {}, today = '') {
  const st = r.status;
  if (st === 'draft') return { text: 'Not sent yet', level: '' };
  if (st === 'cancelled') return { text: 'Cancelled', level: '' };
  if (st === 'received') return { text: r.receivedOn ? `All in ${fmtShort(r.receivedOn)}` : 'All in', level: '' };
  if (isLate(r, today)) return { text: `Late: expected ${fmtShort(r.expectedOn)}`, level: 'late' };
  const afterNeeded = r.expectedOn && r.neededBy && r.expectedOn > r.neededBy;
  if (r.expectedOn) {
    return {
      text: `${st === 'partial' ? 'Rest expected' : 'Expected'} ${fmtShort(r.expectedOn)}${afterNeeded ? `, after the ${fmtShort(r.neededBy)} need date` : ''}`,
      level: afterNeeded ? 'warn' : '',
    };
  }
  if (st === 'partial') return { text: 'Some parts still to come', level: 'warn' };
  if (st === 'sent') {
    const days = daysBetween(r.requestedOn, today);
    if (days == null || days < 1) return { text: 'Waiting for the quote', level: '' };
    return { text: `Waiting ${days} day${days === 1 ? '' : 's'} for the quote`, level: days >= 3 ? 'warn' : '' };
  }
  if (st === 'quoted') return { text: `Quote in${r.quotedOn ? ` ${fmtShort(r.quotedOn)}` : ''}, not ordered yet`, level: '' };
  return { text: 'No delivery date yet', level: st === 'ordered' ? '' : 'warn' };
}

// ---------- Small text helpers ----------
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// One line of text: no line breaks (a subject can't carry extra email headers), trimmed, at most `max` long.
const text = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// A few lines of text as typed: line breaks kept, no runs of blank lines.
const paragraph = (v, max = 3000) => String(v ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n')
  .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const listTypeOf = (t) => (COLUMNS[t] ? t : 'general');
const kindOf = (k) => (k === 'order' ? 'order' : 'quote');
const ref = (v) => text(v, 40).replace(/^#/, '');

const EMAIL = /^[^\s@,;<>"()[\]]+@[^\s@,;<>"()[\]]+\.[a-z]{2,}$/i;
export const isEmail = (s) => EMAIL.test(String(s ?? '').trim());
// Plain addresses only go in mailto: and Gmail links, where ? & # % would break the link.
const LINKABLE = /^[A-Za-z0-9._+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

// Email addresses from a list or from text ("a@x.com, b@y.com"): valid ones only, each once, at most `max`.
export function emailList(value, max = MAX_EMAILS) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
  const seen = new Set();
  return parts.map((e) => String(e ?? '').trim()).filter((e) => {
    const key = e.toLowerCase();
    if (!isEmail(e) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, max);
}

// ---------- Sizes ----------
// Inches as a glazier writes them: 35 7/8, 35-7/8, 35.875, 7/8, 36", 3' 4-1/2". A number, or null when it's blank
// or isn't a size.
export function parseInches(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  let s = String(value ?? '').trim().replace(/["”″]|\s*in(ch|ches)?\.?$/gi, '').trim();
  if (!s) return null;
  let feet = 0;
  const ft = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|’|′|ft\.?|feet)\s*-?\s*(.*)$/i);
  if (ft) {
    feet = Number(ft[1]) * 12;
    s = ft[2].trim();
    if (!s) return feet;
  }
  const frac = s.match(/^(?:(\d+(?:\.\d+)?)(?:\s+|\s*-\s*))?(\d+)\s*\/\s*(\d+)$/);
  if (frac) return Number(frac[3]) ? feet + (frac[1] ? Number(frac[1]) : 0) + Number(frac[2]) / Number(frac[3]) : null;
  return /^(\d+(\.\d*)?|\.\d+)$/.test(s) ? feet + Number(s) : null;
}

// 35.875 → "35-7/8", to the nearest 1/16 inch, the way Wes writes sizes ("1-3/4" X 4-1/2"").
export function fmtInches(value) {
  const n = parseInches(value);
  if (n == null) return '';
  const sixteenths = Math.round(n * 16);
  const whole = Math.floor(sixteenths / 16);
  let part = sixteenths % 16;
  if (!part) return String(whole);
  let den = 16;
  while (part % 2 === 0) { part /= 2; den /= 2; }
  return whole ? `${whole}-${part}/${den}` : `${part}/${den}`;
}

const fmtQty = (q) => String(Math.round(num(q) * 100) / 100);
// "15 rolls", "2 boxes", "5 S/L", "10 pkg": word units take an s.
const PLURAL = { roll: 'rolls', box: 'boxes', set: 'sets', tube: 'tubes', lot: 'lots' };
const qtyUnit = (q, unit) => [q, q === '1' ? unit : PLURAL[unit] || unit].filter(Boolean).join(' ');
const size = (it) => (it.width && it.height ? `${fmtInches(it.width)}" x ${fmtInches(it.height)}"` : '');

// ---------- The parts list ----------
// The list as it's saved and sent: headings, and lines that say what's wanted; blank rows dropped.
// A line keeps every field, so switching the list type never loses anything. `got` is how many have come in.
export function cleanItems(items) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object') continue;
    if ('heading' in it) {
      const heading = text(it.heading, 200);
      if (heading) out.push({ heading });
      continue;
    }
    const line = {
      qty: Math.max(0, num(it.qty)), unit: text(it.unit, 20), partNo: text(it.partNo, 60), desc: text(it.desc, 300),
      width: parseInches(it.width), height: parseInches(it.height), edge: text(it.edge, 200), mark: text(it.mark, 40),
      got: Math.max(0, num(it.got)),
    };
    if (line.desc || line.partNo || line.width || line.height) out.push(line);
  }
  return out.slice(0, MAX_ITEMS);
}

// What's wrong with one line of the list, in words, or '' when it's fine.
export function lineProblem(it, listType) {
  if (!it || 'heading' in it) return '';
  const blank = (v) => String(v ?? '').trim() === '';
  if (blank(it.desc) && blank(it.partNo) && blank(it.width) && blank(it.height) && blank(it.edge) && blank(it.mark)) return '';
  if (!(num(it.qty) > 0)) return 'needs a quantity';
  for (const k of ['width', 'height']) if (!blank(it[k]) && !parseInches(it[k])) return `${k} "${text(it[k], 20)}" isn't a size in inches`;
  if (listTypeOf(listType) === 'glass' && (!parseInches(it.width) || !parseInches(it.height))) return 'needs a width and a height';
  return '';
}

// Everything that stops a request from going out, in words. Empty when it's ready.
export function requestProblems(r = {}) {
  const listType = listTypeOf(r.listType);
  const rows = Array.isArray(r.items) ? r.items : [];
  const out = [];
  rows.forEach((it, i) => { const p = lineProblem(it, listType); if (p) out.push(`Line ${i + 1} ${p}.`); });
  if (!cleanItems(rows).some((it) => !('heading' in it))) out.unshift('Add at least one line to the parts list.');
  if (rows.length > MAX_ITEMS) out.push(`A request can have up to ${MAX_ITEMS} lines.`);
  return out;
}

// How much of the list has come in: 'none', 'some' or 'all'.
export function receivedState(items) {
  const lines = cleanItems(items).filter((it) => !('heading' in it) && it.qty > 0);
  if (lines.length && lines.every((it) => it.got >= it.qty)) return 'all';
  return lines.some((it) => it.got > 0) ? 'some' : 'none';
}

// What hasn't come in yet: each line with the quantity still to come, under its heading.
export function outstanding(items) {
  const out = [];
  let heading = null;
  for (const it of cleanItems(items)) {
    if ('heading' in it) { heading = it; continue; }
    const left = Math.round((it.qty - it.got) * 100) / 100;
    if (left <= 0) continue;
    if (heading) { out.push(heading); heading = null; }
    out.push({ ...it, qty: left, got: 0 });
  }
  return out;
}

// One line of the list in the plain-text email, e.g. "4 pcs @ 35-7/8" x 83-3/4" – 1" grey low-E insulated – mark GL1"
// or "5 S/L – CG451-1 – Head/jamb/vert mull".
export function itemText(it, listType) {
  if ('heading' in it) return it.heading;
  const q = fmtQty(it.qty);
  const mark = it.mark && `mark ${it.mark}`;
  if (listTypeOf(listType) === 'glass') {
    const pcs = `${q} ${q === '1' ? 'pc' : 'pcs'}`;
    return [size(it) ? `${pcs} @ ${size(it)}` : pcs, it.partNo, it.desc, it.edge, mark].filter(Boolean).join(' – ');
  }
  return [qtyUnit(q, it.unit), it.partNo, [it.desc, size(it)].filter(Boolean).join(', '), it.edge, mark].filter(Boolean).join(' – ');
}

// The same line as table cells for the HTML email, matching the headings below.
const HEADINGS = { glass: ['Qty', 'Size (W x H)', 'Glass', 'Edges, holes, notes', 'Mark'], parts: ['Qty', 'Unit', 'Part #', 'Description'], general: ['Qty', 'Unit', 'Description'] };
function itemCells(it, listType) {
  const q = fmtQty(it.qty);
  const extra = [it.edge, it.mark && `mark ${it.mark}`];
  if (listType === 'glass') return [q, size(it), [it.partNo, it.desc].filter(Boolean).join(' – '), it.edge, it.mark];
  if (listType === 'parts') return [q, it.unit, it.partNo, [it.desc, size(it), ...extra].filter(Boolean).join(', ')];
  return [q, it.unit, [it.partNo, it.desc, size(it), ...extra].filter(Boolean).join(', ')];
}

// Estimate units in supplier words.
const ESTIMATE_UNITS = { each: 'ea', lf: 'lf', lot: 'lot', sqft: 'sq ft' };

// The materials on a proposal as a parts list (labor left out, and never any prices). Glass lines bring their
// size and number of lites; for a glass list, only the glass comes over.
export function itemsFromEstimate(est = {}, listType = 'general') {
  const lines = (Array.isArray(est.lines) ? est.lines : []).filter((l) => l && text(l.desc) && l.kind !== 'Labor' && l.unit !== 'hour');
  const sized = (l) => l.unit === 'sqft';
  if (listTypeOf(listType) === 'glass') {
    return lines.filter((l) => sized(l) || l.kind === 'Glass').map((l) => ({
      qty: num(l.qty) || 1, width: sized(l) ? parseInches(l.widthIn) : null, height: sized(l) ? parseInches(l.heightIn) : null, desc: text(l.desc), edge: '', mark: '',
    }));
  }
  return lines.map((l) => ({
    qty: num(l.qty) || 1, unit: sized(l) ? 'pcs' : ESTIMATE_UNITS[l.unit] || text(l.unit, 20) || 'ea', partNo: '', desc: text(l.desc),
    width: sized(l) ? parseInches(l.widthIn) : null, height: sized(l) ? parseInches(l.heightIn) : null,
  }));
}

// ---------- Pasting a list ----------
const UNIT_WORDS = [
  [/^(s\/l|sl|stock lengths?)$/i, 'S/L'], [/^(pcs?|pieces?)$/i, 'pcs'], [/^(ea|each)$/i, 'ea'], [/^(pkgs?|packages?|pk)$/i, 'pkg'],
  [/^(rolls?|rl)$/i, 'roll'], [/^(box(es)?|bx)$/i, 'box'], [/^(lf|ft|feet|lin ft)$/i, 'lf'], [/^(pr|pairs?)$/i, 'pr'],
  [/^sets?$/i, 'set'], [/^tubes?$/i, 'tube'], [/^gal(lons?)?$/i, 'gal'], [/^lots?$/i, 'lot'], [/^(sq ?ft|sf)$/i, 'sq ft'],
];
const UNIT_RE = '(?:s\\/l|sl|stock lengths?|pcs?|pieces?|ea|each|pkgs?|packages?|pk|rolls?|rl|box(?:es)?|bx|lf|ft|feet|pr|pairs?|sets?|tubes?|gal(?:lons?)?|lots?|sq ?ft|sf)';
const unitOf = (u) => UNIT_WORDS.find(([re]) => re.test(String(u || '').trim()))?.[1] || '';
const SIZE = '(\\d+(?:\\.\\d+)?(?:[ -]\\d+\\/\\d+)?|\\d+\\/\\d+)\\s*(?:"|\'\'|in\\.?)?';
const GLASS_LINE = new RegExp(`^\\(?(\\d+)\\)?\\s*(?:pcs?\\.?|pieces?|ea\\.?)?\\s*(?:@|x(?=\\s)|\\s)\\s*@?\\s*${SIZE}\\s*[xX×*]\\s*${SIZE}\\s*[,–-]?\\s*(.*)$`);
// "5 S/L CG451-1 Head", "(2) Door closers", "10 pkg FAS 14-2": a quantity, maybe a unit, then what it is. Not
// "2 1/4" glass stop" (a size) or "1-3/4" X 4-1/2"" (a frame size, used as a heading).
const LEADING_QTY = new RegExp(`^\\(?(\\d+(?:\\.\\d+)?)\\)?\\s*(?:(${UNIT_RE})\\.?)?\\s+(?!\\d+\\s*\\/)(.+)$`, 'i');
// "ED450-2 End dam. 2pkg.", "RG-1 Glazing gasket 15 rolls": the quantity and unit at the end.
const TRAILING_QTY = new RegExp(`^(.+?)[\\s.,;:-]+(\\d+(?:\\.\\d+)?)\\s*(${UNIT_RE})\\.?$`, 'i');

// "CG451-1 Head/jamb" → part number and description. A part number has a digit in it ("RSB-3", "ED 450-1").
function splitPart(rest) {
  const s = rest.trim().replace(/\.$/, '');
  const m = s.match(/^([A-Za-z]{1,5}\s\d+[-.]\w[\w\-./#]*|[A-Za-z#]{0,6}-?\d[\w\-./#]*)[\s.,:;-]+(.*)$/) || s.match(/^([A-Za-z#]{0,6}-?\d[\w\-./#]*)$/);
  if (!m || m[1].length > 20) return { partNo: '', desc: s };
  return { partNo: m[1].replace(/[.,;:]+$/, ''), desc: (m[2] || '').replace(/^[\s.,;:–-]+/, '').replace(/\.$/, '').trim() };
}

// One typed line. Lines that don't have a quantity (like "Stock lengths" or "Metal CG451 #04 clear anodized") are
// headings.
function fromLine(row, listType) {
  const s = row.replace(/^[-*•·]\s+/, '').trim();
  const g = listType === 'glass' && s.match(GLASS_LINE);
  if (g) return { qty: Number(g[1]), width: g[2], height: g[3], desc: g[4].replace(/\.$/, '') };
  const lead = s.match(LEADING_QTY);
  if (lead) {
    const { partNo, desc } = listType === 'parts' ? splitPart(lead[3]) : { partNo: '', desc: lead[3].replace(/\.$/, '') };
    return { qty: Number(lead[1]), unit: unitOf(lead[2]) || (listType === 'glass' ? '' : 'ea'), partNo, desc };
  }
  const trail = s.match(TRAILING_QTY);
  if (trail) {
    const { partNo, desc } = listType === 'parts' ? splitPart(trail[1]) : { partNo: '', desc: trail[1] };
    return { qty: Number(trail[2]), unit: unitOf(trail[3]), partNo, desc };
  }
  return { heading: s.replace(/\.$/, '') };
}

// A list pasted from a spreadsheet (cells separated by tabs, in the order of the list's columns) or typed one per
// line, like "4 @ 35 7/8 x 83 3/4 1/4" clear tempered", "5 S/L CG451-1 Head/jamb" or "ED450-2 End dam. 2 pkg".
export function parsePasted(value, listType = 'general') {
  const type = listTypeOf(listType);
  const cols = COLUMNS[type];
  const rows = String(value ?? '').split(/\r?\n/).filter((l) => l.trim());
  return cleanItems(rows.map((row) => {
    if (!row.includes('\t')) return fromLine(row, type);
    const cells = row.split('\t').map((c) => c.trim());
    if (/^(qty|quantity|#)$/i.test(cells[0])) return null; // the spreadsheet's own heading row
    if (cells[0] && !(Number(cells[0]) > 0)) return { heading: cells.filter(Boolean).join(' ') };
    const it = {};
    cols.forEach(([key], i) => { it[key] = cells[i] ?? ''; });
    it.qty = Number(it.qty) || 0;
    if (it.unit) it.unit = unitOf(it.unit) || it.unit;
    return it;
  }).filter(Boolean));
}

// ---------- The emails ----------
const firstName = (s) => text(s, 80).split(' ')[0] || '';
const shortName = (name) => text(name, 80).replace(/,?\s+(LLC|L\.L\.C\.|Inc\.?|Corp\.?|Co\.?)$/i, '') || 'Stellar Glass';

// A date picked in the app ("2026-11-14") the way people write it: "Sat, Nov 14, 2026".
export function fmtDay(iso) {
  if (!DAY.test(String(iso ?? ''))) return '';
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function deliveryText(r = {}, s = {}) {
  const to = text(r.deliverTo, 200);
  if (r.delivery === 'pickup') return `We'll pick it up${text(s.branch, 60) ? ` at your ${text(s.branch, 60)} branch` : ''}`;
  if (r.delivery === 'shop') return `Deliver to our shop${to ? `: ${to}` : ''}`;
  if (r.delivery === 'site') return `Deliver to the job site${to ? `: ${to}` : ''}`;
  return '';
}

// The kinds of email about a request: the request itself (a quote request or an order), placing the order a
// supplier quoted, and asking for an update.
export const MESSAGES = ['request', 'order', 'followup'];

export function defaultSubject({ request: r = {}, job: j = {}, company: c = {} }, what = 'request') {
  const order = what === 'order' || kindOf(r.kind) === 'order' || (what === 'followup' && ['ordered', 'confirmed', 'shipped', 'partial'].includes(r.status));
  const lead = what === 'followup' ? `Checking on our ${order ? 'order' : 'quote request'}` : order ? 'Order' : 'Quote request';
  return text(`${lead}: ${text(j.name, 100) || 'parts'}${text(r.po, 30) ? `, PO ${text(r.po, 30)}` : ''} (${shortName(c.name)})`, 200);
}

// The signature under the email: the person sending it, then the business.
export function defaultSignature(person = {}, c = {}) {
  const contact = [person.phone || c.phone, person.email || c.email].map((v) => text(v, 120)).filter(Boolean).join(' · ');
  return [text(person.name, 80), text(person.title, 80), text(c.name, 120), text(c.address, 200), contact].filter(Boolean).join('\n');
}

// The name the email shows as coming from: "Wes Stel at Stellar Glass".
export const fromName = (person, c = {}) => (text(person, 60) ? `${text(person, 60)} at ${shortName(c.name)}` : shortName(c.name));

// Who the email goes to: the supplier's saved addresses, with copies to the supplier's other saved addresses,
// the person sending it (unless they untick it) and the office if they tick it. The server emails these and
// nobody else, so a parts request can only ever reach a supplier on the Suppliers page.
export function recipients({ request: r = {}, supplier: s = {}, company: c = {}, senderEmail = '' }) {
  const to = emailList(s.emails);
  const taken = new Set(to.map((e) => e.toLowerCase()));
  const cc = emailList([...emailList(s.cc), r.ccMe === false ? '' : senderEmail, r.ccOffice ? c.email : ''], MAX_EMAILS + 2)
    .filter((e) => !taken.has(e.toLowerCase()));
  return { to, cc };
}

// The opening line of the email that places the order a supplier quoted.
export const orderIntro = (r = {}) => `Please enter the following order${ref(r.quoteRef) ? ` per your quote #${ref(r.quoteRef)}` : ' per your quote'}.`;

// The first lines of the email asking for an update.
function followUpLines(r, j) {
  const order = kindOf(r.kind) === 'order' || ['ordered', 'confirmed', 'shipped', 'partial'].includes(r.status);
  const refs = [text(r.po, 30) && `PO ${text(r.po, 30)}`, order && ref(r.orderRef) && `your order #${ref(r.orderRef)}`,
    !order && ref(r.quoteRef) && `your quote #${ref(r.quoteRef)}`].filter(Boolean);
  const what = `our ${order ? 'order' : 'quote request'}${text(j.name, 100) ? ` for ${text(j.name, 100)}` : ''}${refs.length ? ` (${refs.join(', ')})` : ''}`;
  const sentOn = order ? r.orderedOn || r.requestedOn : r.requestedOn;
  const first = `Checking on ${what}${sentOn ? `, ${order ? 'ordered' : 'sent'} ${fmtDay(sentOn)}` : ''}.`;
  if (!order) return [first, 'Can you send pricing and lead time when you have it?'];
  const need = r.neededBy ? ` We need it by ${fmtDay(r.neededBy)}.` : '';
  if (r.status === 'partial') return [`${first} We got part of it.${need}`, 'Can you let us know when the rest will ship?'];
  if (r.expectedOn) return [`${first} The last date we had was ${fmtDay(r.expectedOn)}.${need}`, 'Is it still on track?'];
  return [`${first}${need}`, 'Can you let us know when it will ship?'];
}

// The email for a parts request: subject, plain text (also used for Open in Gmail, Open in email app and Copy)
// and HTML (what the app sends). `what` is 'request' (the request itself), 'order' (placing the order the
// supplier quoted) or 'followup' (asking for an update). Everything anyone typed is escaped. `attachments` are
// the names of the files sent along, listed in the email when there are any.
export function buildPartsEmail({ request: r = {}, supplier: s = {}, job: j = {}, company: c = {}, attachments = [], note = '' }, what = 'request') {
  const listType = listTypeOf(r.listType);
  const followUp = what === 'followup';
  const kind = what === 'order' ? 'order' : kindOf(r.kind);
  const items = followUp ? outstanding(r.items) : cleanItems(r.items);
  const first = firstName(s.contactName);
  const greeting = first ? `Hi ${first},` : 'Hello,';
  let opening;
  if (followUp) opening = followUpLines(r, j);
  else if (what === 'order') opening = [orderIntro(r)];
  else opening = [paragraph(r.intro) || INTRO[kind]];
  // The request's notes go with the request; placing the order or asking for an update takes a note of its own.
  const notes = what === 'request' ? paragraph(r.notes) : paragraph(note, MAX_NOTE);
  const signature = paragraph(r.signature, 600) || defaultSignature({}, c);
  const details = followUp ? [] : [
    ['Job', text(j.name, 120)],
    ['Job site', text(j.siteAddress, 200)],
    ['PO #', text(r.po, 30)],
    ['Account #', text(s.account, 40)],
    ['Needed by', fmtDay(r.neededBy)],
    ['Delivery', deliveryText(r, s)],
  ].filter(([, v]) => v);
  const listTitle = followUp && items.length ? (r.status === 'partial' ? 'Still to come:' : 'The list:') : '';
  const files = followUp ? [] : attachments.map((a) => text(a, 150)).filter(Boolean);
  const closing = followUp ? '' : CLOSING[kind];
  const subject = (what === 'request' && text(r.subject, 200)) || defaultSubject({ request: r, job: j, company: c }, what);

  const listLines = items.map((it, i) => ('heading' in it ? `${i ? '\n' : ''}${it.heading}` : itemText(it, listType)));
  const plain = [
    greeting, '', ...opening.flatMap((o) => [o, '']),
    ...details.map(([k, v]) => `${k}: ${v}`), ...(details.length ? [''] : []),
    ...(listTitle ? [listTitle] : []), ...listLines, ...(listLines.length ? [''] : []),
    ...(notes ? [notes, ''] : []),
    ...(files.length ? [`Attached: ${files.join(', ')}`, ''] : []),
    ...(closing ? [closing, ''] : []),
    'Thank you,', signature,
  ].join('\n') + '\n';

  // HTML: inline styles and tables, which is what email apps (Gmail, Outlook, iPhone Mail) show reliably.
  const lines = (v) => esc(v).replace(/\n/g, '<br>');
  const p = (body) => `<p style="margin:0 0 14px">${body}</p>`;
  const muted = 'color:#5b6b7d';
  const cell = 'padding:6px 10px 6px 0;border-bottom:1px solid #e3e8ee;vertical-align:top;text-align:left';
  const head = HEADINGS[listType];
  const table = items.length ? `${listTitle ? p(esc(listTitle)) : ''}<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px;line-height:1.4;margin:0 0 16px">
  <tr>${head.map((h) => `<th style="${cell};${muted};font-size:12px;font-weight:bold;border-bottom:2px solid #c9d3de;white-space:nowrap">${esc(h)}</th>`).join('')}</tr>
  ${items.map((it) => ('heading' in it
    ? `<tr><td colspan="${head.length}" style="padding:12px 0 6px;font-weight:bold;color:#123764;border-bottom:1px solid #c9d3de">${esc(it.heading)}</td></tr>`
    : `<tr>${itemCells(it, listType).map((v, i) => `<td style="${cell}${i === 0 ? ';white-space:nowrap;font-weight:bold' : ''}${i === 1 && listType === 'glass' ? ';white-space:nowrap' : ''}">${esc(v)}</td>`).join('')}</tr>`)).join('\n  ')}
</table>` : '';
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff">
<div style="max-width:680px;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1d2733">
${p(esc(greeting))}
${opening.map((o) => p(lines(o))).join('\n')}
${details.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px;line-height:1.45;margin:0 0 16px">
  ${details.map(([k, v]) => `<tr><td style="${muted};padding:2px 16px 2px 0;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:2px 0;vertical-align:top;font-weight:bold">${esc(v)}</td></tr>`).join('\n  ')}
</table>` : ''}
${table}
${notes ? p(lines(notes)) : ''}
${files.length ? p(`<span style="${muted}">Attached:</span> ${esc(files.join(', '))}`) : ''}
${closing ? p(esc(closing)) : ''}
${p(`Thank you,<br>${lines(signature)}`)}
</div>
</body></html>`;

  return { subject, text: plain, html };
}

// ---------- Handing the email to the person's own email ----------
const enc = (s) => encodeURIComponent(s).replace(/'/g, '%27');
const linkList = (list) => list.filter((e) => LINKABLE.test(e)).join(',');

// A mailto: link that opens the person's email app with everything filled in.
export function mailtoLink({ to = [], cc = [], subject = '', text: body = '' }) {
  const query = [linkList(cc) && `cc=${linkList(cc)}`, `subject=${enc(subject)}`, `body=${enc(body.replace(/\r?\n/g, '\r\n'))}`].filter(Boolean).join('&');
  return `mailto:${linkList(to)}?${query}`;
}

// A link that opens a new Gmail message with everything filled in, in the given Google account when there is one.
export function gmailLink({ to = [], cc = [], subject = '', text: body = '', account = '' }) {
  const params = [['view', 'cm'], ['fs', '1'], ['to', linkList(to)], ['cc', linkList(cc)], ['su', subject], ['body', body], ['authuser', LINKABLE.test(account) ? account : '']];
  return `https://mail.google.com/mail/?${params.filter(([, v]) => v).map(([k, v]) => `${k}=${enc(v)}`).join('&')}`;
}
