// Reading scans, photos and handwriting with Gemini (the calls are in gemini.js): cutting a sheet
// into close-ups small print stays readable in, and turning Gemini's answers into openings.
// No browser APIs here, so it runs in the Node tests too.
import { parseDim } from './dims.js';

export const TEMPLATE_ID = 'takeoff-read-v1';

// Close-ups covering a w x h picture, each at most `max` pixels on a side. Neighbours overlap by
// `overlap` pixels, so a tag cut by one close-up's edge is whole in the next.
export function planTiles(w, h, { max = 1536, overlap = 160 } = {}) {
  const count = (len) => (len <= max ? 1 : Math.ceil((len - overlap) / (max - overlap)));
  const cols = count(w), rows = count(h);
  const tw = Math.min(w, Math.ceil((w + overlap * (cols - 1)) / cols));
  const th = Math.min(h, Math.ceil((h + overlap * (rows - 1)) / rows));
  const at = (i, n, len, size) => (n === 1 ? 0 : Math.round((i * (len - size)) / (n - 1)));
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) tiles.push({ x: at(c, cols, w, tw), y: at(r, rows, h, th), w: tw, h: th, row: r, col: c });
  }
  return { cols, rows, tiles };
}

// How a page is sent: the whole page first, then its close-ups (none when the page is small
// enough to read whole). Each image gets a caption saying what part of the page it shows.
export function captions(plan) {
  const out = ['Image 1: the whole page.'];
  if (plan.tiles.length < 2) return out;
  const where = (t) => {
    const v = plan.rows === 1 ? '' : t.row === 0 ? 'top' : t.row === plan.rows - 1 ? 'bottom' : 'middle';
    const h = plan.cols === 1 ? '' : t.col === 0 ? 'left' : t.col === plan.cols - 1 ? 'right' : 'center';
    return [v, h].filter(Boolean).join(' ') || 'all';
  };
  plan.tiles.forEach((t, i) => out.push(`Image ${i + 2}: close-up, row ${t.row + 1} of ${plan.rows}, column ${t.col + 1} of ${plan.cols} (${where(t)} of the page).`));
  return out;
}

// A tag's box from Gemini ([ymin, xmin, ymax, xmax], 0-1000 on the image it was seen in) in page
// pixels. Image 1 is the whole page; image k (k >= 2) is close-up k - 1.
export function toPage(tag, plan, w, h) {
  const b = tag.box;
  if (!Array.isArray(b) || b.length !== 4 || b.some((v) => !Number.isFinite(v))) return null;
  const img = Math.round(Number(tag.image) || 1);
  const t = img >= 2 ? plan.tiles[img - 2] : { x: 0, y: 0, w, h };
  if (!t) return null;
  const [y0, x0, y1, x1] = b.map((v) => Math.min(1000, Math.max(0, v)) / 1000);
  const box = [t.x + Math.min(x0, x1) * t.w, t.y + Math.min(y0, y1) * t.h, t.x + Math.max(x0, x1) * t.w, t.y + Math.max(y0, y1) * t.h];
  // How far the tag sits inside its image (0 at an edge): a tag cut by an edge is the worse copy.
  const inside = Math.min(Math.min(x0, x1), Math.min(y0, y1), 1 - Math.max(x0, x1), 1 - Math.max(y0, y1));
  return { box, x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2, size: Math.max(box[2] - box[0], box[3] - box[1]), inside, closeUp: img >= 2 };
}

const cleanLabel = (s) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, '').replace(/[‐-―]/g, '-');

// Tags seen on one page, each counted once. A tag shows up in every close-up that overlaps it (and
// in the whole page); copies whose centres are within a tag's size of each other are one tag, and
// the copy seen furthest from an image edge (a close-up over the whole page) names it.
export function pageTags(answer, plan, w, h) {
  const seen = [];
  for (const t of answer?.tags || []) {
    const label = cleanLabel(t.label);
    const at = label && toPage(t, plan, w, h);
    if (!at || at.size <= 0) continue;
    seen.push({ label, shape: String(t.shape ?? 'other').trim().toLowerCase() || 'other', where: String(t.where ?? 'other').trim().toLowerCase() || 'other', ...at });
  }
  // Close-ups read small print better than the whole page, so their copies come first.
  const hasCloseUps = plan.tiles.length > 1;
  seen.sort((a, b) => (hasCloseUps ? Number(b.closeUp) - Number(a.closeUp) : 0) || b.inside - a.inside);
  const kept = [];
  for (const s of seen) {
    const near = kept.find((k) => Math.hypot(k.x - s.x, k.y - s.y) < Math.max(k.size, s.size) * 0.9);
    if (!near) kept.push(s);
  }
  return kept;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
// A size as written ("8'-0\"", "95 3/4", "54") in inches; bare numbers are inches.
export const sizeIn = (v) => (v == null || v === '' ? null : typeof v === 'number' ? num(v) : parseDim(String(v), { bare: 'in' }));

// Tags that mark openings on plans and elevations, grouped by shape: the window tags are one shape
// (diamonds, say) and the door tags another. Tags on type elevations, schedules and legends only
// name a type, so they aren't counted; families with only numbers are keynotes.
export function tagFamilies(pages) {
  const byShape = new Map();
  for (const p of pages) {
    for (const t of p.tags || []) {
      if (/type|schedule|legend/.test(t.where || '')) continue;
      if (!byShape.has(t.shape)) byShape.set(t.shape, new Map());
      const counts = byShape.get(t.shape);
      counts.set(t.label, (counts.get(t.label) || 0) + 1);
    }
  }
  const fams = [];
  for (const [shape, counts] of byShape) {
    if (![...counts.keys()].some((l) => /[A-Z]/.test(l))) continue;
    fams.push({ shape, counts: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))), total: [...counts.values()].reduce((s, v) => s + v, 0) });
  }
  return fams;
}

// What Gemini read off a set of pages, as openings for the takeoff table.
// pages: [{ answer, tags }] where tags came from pageTags(). The tag family whose labels match the
// type sizes read (else the biggest) is counted on every page it's on; the other families are
// returned too, in case the person wants those instead. Sizes come from type sheets or schedules
// (types), else from items with the same label. Openings written out with a count (field notes,
// markups, sketches) are added as they're written.
export function openingsFrom(pages) {
  const sizes = new Map();
  const items = [];
  const notes = [];
  const families = tagFamilies(pages);
  const typeLabels = new Set(pages.flatMap((p) => (p.answer?.types || []).map((t) => cleanLabel(t.label))));
  const matches = (f) => Object.keys(f.counts).filter((l) => typeLabels.has(l)).length;
  families.sort((a, b) => matches(b) - matches(a) || b.total - a.total);
  const main = families[0] || null;
  const counts = new Map(Object.entries(main?.counts || {}));
  // Sizes read off a type sheet or a schedule beat sizes the model worked out from an elevation.
  const typeSheet = (p) => (p.tags || []).some((t) => /type|schedule/.test(t.where || '')) || /type|schedule/i.test(p.answer?.kind || '');
  for (const p of [...pages].sort((a, b) => Number(typeSheet(b)) - Number(typeSheet(a)))) {
    for (const t of p.answer?.types || []) {
      const label = cleanLabel(t.label);
      const shape = String(t.shape ?? '').trim().toLowerCase();
      // A door type can share a letter with a window type; the tag shape tells them apart.
      if (main && shape && shape !== 'other' && shape !== main.shape) continue;
      const widthIn = sizeIn(t.width), heightIn = sizeIn(t.height);
      if (label && (widthIn || heightIn) && !sizes.has(label)) sizes.set(label, { widthIn, heightIn });
    }
    for (const it of p.answer?.items || []) {
      const label = String(it.label ?? '').trim();
      const widthIn = sizeIn(it.width), heightIn = sizeIn(it.height);
      if (!widthIn && !heightIn && !label) continue;
      items.push({ label, qty: Math.max(1, Math.round(num(it.qty) || 1)), widthIn, heightIn, note: String(it.note ?? '').trim() });
    }
    for (const n of p.answer?.notes || []) {
      const s = String(n ?? '').trim();
      if (s && !notes.includes(s)) notes.push(s);
    }
  }
  // An item named for a type gives that type its size when no type sheet did, and the other way round.
  for (const it of items) {
    const label = cleanLabel(it.label);
    if ((it.widthIn || it.heightIn) && !sizes.has(label)) sizes.set(label, { widthIn: it.widthIn, heightIn: it.heightIn });
    if (!it.widthIn && !it.heightIn && sizes.has(label)) Object.assign(it, sizes.get(label));
  }
  const tagsHow = `counted the ${main?.shape || ''} tags`.replace(/\s+/g, ' ');
  const openings = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((label) => ({
    label,
    qty: counts.get(label),
    widthIn: sizes.get(label)?.widthIn ?? null,
    heightIn: sizes.get(label)?.heightIn ?? null,
    how: sizes.has(label) ? `Gemini: ${tagsHow}, size from the drawings` : `Gemini: ${tagsHow}`,
  }));
  // Types with a size but no tags counted (a type sheet read on its own, or a type the pages read
  // don't show) are listed with no count, so the sizes aren't lost.
  for (const [label, s] of sizes) {
    if (!counts.has(label) && !items.some((it) => cleanLabel(it.label) === label)) openings.push({ label, qty: 0, ...s, how: 'Gemini: size from the drawings, not counted' });
  }
  for (const it of items) {
    if (counts.has(cleanLabel(it.label))) continue;
    openings.push({ label: it.label, qty: it.qty, widthIn: it.widthIn, heightIn: it.heightIn, how: `Gemini: written${it.note ? `, ${it.note}` : ''}` });
  }
  return { openings, notes, families, main };
}
