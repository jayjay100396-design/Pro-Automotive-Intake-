// Turns read drawing pages into a glazing takeoff: which tag family marks the window types, each
// type's size from its type elevation, and how many of each appear on the elevations (an opening
// shown twice, e.g. on an overall and an enlarged elevation, is counted once using the grid lines).
// Pure functions; see reader.js for how a page is read.
import { textRuns, findTags, findViews, viewAt, gridRows, gridPosition, dimensionRuns, sheetInfo } from './reader.js';
import { parseDim, parseSize, fmtFtIn } from './dims.js';
import { snapScale } from './measure.js';
import { COMMERCIAL_SYSTEMS, storefrontBayBreakdown, openingLinearFeet } from '../calc.js';

// Where a takeoff hands its openings to a new proposal or parts order (sessionStorage).
export const DRAFT_KEY = 'stellar-takeoff-draft';
export const PARTS_DRAFT_KEY = 'stellar-takeoff-parts-draft';

const SHAPE_ORDER = ['diamond', 'hexagon', 'square', 'rect', 'triangle', 'ellipse', 'circle', 'other'];

// ---------- Type sizes from a type elevation ----------

// For each tag on a type sheet, reads the frame drawn next to it: the overall width dimension gives
// the drawing's scale, the frame's side line gives its height, and the height is matched to the
// written vertical dimensions when one agrees. Returns { label: { widthIn, heightIn, how, page } }.
export function typeSizes(model, tags) {
  const out = {};
  const dims = dimensionRuns(model);
  const row = [...tags].sort((a, b) => a.x - b.x);
  for (const t of row) {
    const sameRow = row.filter((q) => Math.abs(q.y - t.y) < t.size);
    const k = sameRow.indexOf(t);
    const gapL = k > 0 ? t.x - sameRow[k - 1].x : null;
    const gapR = k < sameRow.length - 1 ? sameRow[k + 1].x - t.x : null;
    const half = Math.min(gapL ?? gapR ?? 300, gapR ?? gapL ?? 300) / 2;
    // Look up from the tag, but not past a view title or another row of tags.
    let top = t.y - 700;
    for (const v of findViews(model)) {
      if (v.y1 < t.y && v.y1 > top && v.x0 < t.x + half && v.x1 > t.x - half) top = v.y1;
    }
    for (const q of findTags(model)) {
      if (q.y < t.y - t.size * 2 && q.y > top && Math.abs(q.x - t.x) < half) top = q.y + q.ry;
    }
    const box = { x0: t.x - half, x1: t.x + half, y0: top, y1: t.y };
    const size = sizeAbove(model, dims, t, box) || labelledSize(model, t, box);
    if (size) out[t.label] = { ...size, page: model.page, at: { x: t.x, y: t.y } };
  }
  return out;
}

function sizeAbove(model, dims, t, box) {
  const inBox = (d) => d.x >= box.x0 && d.x <= box.x1 && d.y >= box.y0 && d.y <= box.y1;
  const horiz = dims.filter((d) => d.horizontal && inBox(d));
  if (!horiz.length) return null;
  // The overall width is the biggest horizontal dimension over the frame.
  const overall = horiz.reduce((a, b) => (b.inches > a.inches ? b : a));
  const ext = dimExtent(model, overall);
  if (!ext) return { widthIn: overall.inches, heightIn: null, how: 'width from dimension; no height found' };
  const scale = (ext.x1 - ext.x0) / overall.inches; // page points per real inch
  const verts = dims.filter((d) => d.vertical && d.y > ext.y && d.y < t.y && d.x > ext.x0 - 90 && d.x < ext.x1 + 90);
  // The frame's two sides; a side light with a panel under it can stop short, so the taller side wins.
  const sides = [jambRun(model, ext.x0, ext.y), jambRun(model, ext.x1, ext.y)].filter(Boolean);
  if (!sides.length) {
    const tallest = verts.reduce((a, b) => (!a || b.inches > a.inches ? b : a), null);
    return { widthIn: overall.inches, heightIn: tallest?.inches ?? null, how: 'height is the tallest vertical dimension (frame line not found)' };
  }
  const measured = Math.max(...sides.map((j) => j.y1 - j.y0)) / scale;
  const written = chainValues(verts);
  const match = written.reduce((a, v) => (Math.abs(v - measured) < Math.abs(a - measured) ? v : a), Infinity);
  const tol = Math.max(1, measured * 0.02);
  if (Math.abs(match - measured) <= tol) {
    return { widthIn: overall.inches, heightIn: match, how: 'width and height from the written dimensions' };
  }
  return { widthIn: overall.inches, heightIn: Math.round(measured * 4) / 4, how: 'height measured from the drawing (no written dimension matched)' };
}

// The dimension line under a dimension's text, and the witness lines it runs between.
// Returns { x0, x1, y } in page points, or null.
export function dimExtent(model, d) {
  const s = d.size;
  let line = null;
  for (const g of model.segs) {
    if (g.mask || Math.abs(g.y1 - g.y2) > 0.3) continue;
    const y = g.y1;
    if (y < d.y + s * 0.1 || y > d.y + s * 1.6) continue;
    const lo = Math.min(g.x1, g.x2), hi = Math.max(g.x1, g.x2);
    if (lo > d.x || hi < d.x) continue;
    if (!line || y < line.y) line = { x0: lo, x1: hi, y };
  }
  if (!line) return null;
  // Witness lines (or tick marks) crossing the dimension line; the text sits between two of them.
  const marks = [];
  for (const g of model.segs) {
    if (g.mask) continue;
    const lo = Math.min(g.y1, g.y2), hi = Math.max(g.y1, g.y2);
    if (hi < line.y - 0.6 || lo > line.y + 0.6) continue;
    const mx = Math.abs(g.y1 - line.y) < 0.6 ? g.x1 : Math.abs(g.y2 - line.y) < 0.6 ? g.x2 : (g.x1 + g.x2) / 2;
    if (Math.abs(g.x1 - g.x2) < 0.3 || Math.abs(Math.abs(g.x1 - g.x2) - Math.abs(g.y1 - g.y2)) < 0.5) {
      if (mx >= line.x0 - 1 && mx <= line.x1 + 1) marks.push(mx);
    }
  }
  const left = marks.filter((x) => x < d.x - 0.5).reduce((a, x) => Math.max(a, x), -Infinity);
  const right = marks.filter((x) => x > d.x + 0.5).reduce((a, x) => Math.min(a, x), Infinity);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return { x0: line.x0, x1: line.x1, y: line.y, rough: true };
  return { x0: left, x1: right, y: line.y, ends: endMarks(model, [left, right], line.y) };
}

// How many of a dimension line's ends carry a tick, an arrowhead or a dot. A schedule's table
// cells have lines like a dimension's but plain corners.
function endMarks(model, xs, y) {
  let n = 0;
  for (const x of xs) {
    const hit = model.segs.some((g) => {
      if (Math.abs(g.x1 - x) > 12 && Math.abs(g.x2 - x) > 12) return false;
      const dx = g.x2 - g.x1, dy = g.y2 - g.y1;
      const len = Math.hypot(dx, dy);
      if (Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.5 && len > 1.5 && len < 25) {
        // a tick is a short 45-degree stroke through the end (often drawn as two halves from it)
        const t = Math.max(0, Math.min(1, ((x - g.x1) * dx + (y - g.y1) * dy) / (len * len)));
        if (Math.hypot(g.x1 + t * dx - x, g.y1 + t * dy - y) < 0.8) return true;
      }
      return g.fill && (Math.hypot(g.x1 - x, g.y1 - y) < 1.5 || Math.hypot(g.x2 - x, g.y2 - y) < 1.5);
    });
    if (hit) n++;
  }
  return n;
}

// The drawing's scale near a point, worked out from its own dimensions (for sheets with no scale
// printed under the view, like most type and detail sheets). Each written dimension over its
// dimension line gives page points per real inch; the nearby ones have to agree.
// Returns { ppi, count, realPerPaper } (realPerPaper only when it is a standard scale) or null.
export function scaleFromDims(model, p) {
  if (!model._dimScales) {
    model._dimScales = [];
    for (const d of dimensionRuns(model)) {
      if (!d.horizontal || !(d.inches >= 6)) continue;
      const ext = dimExtent(model, d);
      if (!ext || ext.rough || !ext.ends || ext.x1 - ext.x0 < 12) continue;
      model._dimScales.push({ x: d.x, y: d.y, ppi: (ext.x1 - ext.x0) / d.inches });
    }
  }
  const near = model._dimScales
    .map((s) => ({ ...s, dist: p ? Math.hypot(s.x - p[0], s.y - p[1]) : 0 }))
    .filter((s) => s.dist < 900)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 8);
  let best = null;
  for (const s of near) {
    const agree = near.filter((q) => Math.abs(q.ppi - s.ppi) <= s.ppi * 0.03);
    if (agree.length >= 2 && (!best || agree.length > best.length)) best = agree;
  }
  if (!best) return null;
  const ppi = best.reduce((a, q) => a + q.ppi, 0) / best.length;
  const realPerPaper = snapScale(72 / ppi);
  return { ppi: realPerPaper ? 72 / realPerPaper : ppi, count: best.length, realPerPaper };
}

// The longest continuous vertical line at x below y (a frame's side), as { y0, y1 }.
function jambRun(model, x, y) {
  const pieces = model.segs
    .filter((g) => !g.mask && Math.abs(g.x1 - x) < 0.6 && Math.abs(g.x2 - x) < 0.6 && Math.min(g.y1, g.y2) > y + 0.5)
    .map((g) => [Math.min(g.y1, g.y2), Math.max(g.y1, g.y2)])
    .filter(([a, b]) => b - a > 0.5)
    .sort((a, b) => a[0] - b[0]);
  let best = null, cur = null;
  for (const [a, b] of pieces) {
    if (cur && a <= cur[1] + 0.8) cur[1] = Math.max(cur[1], b);
    else {
      if (cur && (!best || cur[1] - cur[0] > best[1] - best[0])) best = cur;
      cur = [a, b];
    }
  }
  if (cur && (!best || cur[1] - cur[0] > best[1] - best[0])) best = cur;
  return best && best[1] - best[0] > 6 ? { y0: best[0], y1: best[1] } : null;
}

// Written vertical dimensions and the sums of neighbours in each dimension string.
function chainValues(verts) {
  const values = new Set(verts.map((v) => v.inches));
  const columns = new Map();
  for (const v of verts) {
    const key = Math.round(v.x / 3);
    if (!columns.has(key)) columns.set(key, []);
    columns.get(key).push(v);
  }
  for (const col of columns.values()) {
    col.sort((a, b) => a.y - b.y);
    for (let i = 0; i < col.length; i++) {
      let sum = 0;
      for (let j = i; j < col.length; j++) { sum += col[j].inches; values.add(Math.round(sum * 1000) / 1000); }
    }
  }
  return [...values];
}

// A size written out next to a tag: "4'-0\" x 8'-0\"", "48 x 96".
function labelledSize(model, t, box) {
  for (const r of textRuns(model)) {
    if (r.x < box.x0 || r.x > box.x1 || Math.abs(r.y - t.y) > 120) continue;
    const s = parseSize(r.str);
    if (s) return { ...s, how: 'size written by the tag' };
  }
  return null;
}

// ---------- Mark boxes and labelled dimensions (shop drawings, cut sheets) ----------

const LABELS = [
  ['rough', /\b(ROUGH\s+OPENING|R\.\s?O\.)/i],
  ['frame', /\bFRAME\s+(SIZE|WIDTH|HEIGHT)\b/i],
  ['dlo', /\bD\.?\s?L\.?\s?O\.?(?![A-Z])/i],
  ['glass', /\bGLASS\s+SIZE\b/i],
];

// Dimensions with a word label written under them: 54" [4'-6"] over ROUGH OPENING.
// [{ kind: rough|frame|dlo|glass, inches, horizontal, vertical, x, y, label }]
export function labelledDims(model) {
  const runs = textRuns(model);
  const dims = dimensionRuns(model);
  const out = [];
  for (const r of runs) {
    const kind = LABELS.find(([, re]) => re.test(r.str))?.[0];
    if (!kind) continue;
    // A dimension written in the label itself ("ROUGH OPENING 54\"").
    const own = dims.find((d) => d === r || (d.parts === r.parts));
    let best = own || null;
    if (!best) {
      let bestScore = Infinity;
      for (const d of dims) {
        if (Math.abs(d.angle - r.angle) > 5) continue;
        const dx = d.x - r.x, dy = d.y - r.y;
        const along = dx * r.dir[0] + dy * r.dir[1];
        const across = dx * r.up[0] + dy * r.up[1];
        const halfW = (Math.hypot(r.x1 - r.x0, r.y1 - r.y0) + Math.hypot(d.x1 - d.x0, d.y1 - d.y0)) / 2;
        if (across < r.size * 0.4 || across > r.size * 2.2 || Math.abs(along) > halfW) continue;
        const sc = across + Math.abs(along) * 0.2;
        if (sc < bestScore) { bestScore = sc; best = d; }
      }
    }
    if (best) out.push({ kind, inches: best.inches, horizontal: best.horizontal, vertical: best.vertical, x: best.x, y: best.y, label: r.str, text: best.str });
  }
  return out;
}

// Boxes headed MARK and QTY (or TYPE and QUANTITY) with the values under them, each matched to
// the rough opening (or frame) sizes drawn nearest to it. [{ label, qty, widthIn, heightIn, how }]
export function markBoxes(model) {
  const runs = textRuns(model);
  const heads = runs.filter((r) => /^(MARK|TYPE|TAG)$/i.test(r.str));
  const out = [];
  for (const h of heads) {
    const qtyHead = runs.find((r) => /^(QTY|QUANTITY|COUNT|NO\.? REQ'?D)$/i.test(r.str) && Math.abs(r.angle - h.angle) <= 5
      && Math.abs((r.x - h.x) * h.up[0] + (r.y - h.y) * h.up[1]) < h.size && Math.hypot(r.x - h.x, r.y - h.y) < h.size * 20);
    if (!qtyHead) continue;
    const below = (head) => runs
      .filter((r) => r !== head && Math.abs(r.angle - head.angle) <= 5)
      .map((r) => ({ r, across: -((r.x - head.x) * head.up[0] + (r.y - head.y) * head.up[1]), along: (r.x - head.x) * head.dir[0] + (r.y - head.y) * head.dir[1] }))
      .filter((q) => q.across > head.size * 0.5 && q.across < head.size * 4 && Math.abs(q.along) < head.size * 4)
      .sort((a, b) => a.across - b.across)[0]?.r;
    const mark = below(h);
    const qty = below(qtyHead);
    if (!mark || !qty || !/^\d{1,4}$/.test(qty.str)) continue;
    out.push({ label: mark.str, qty: Number(qty.str), x: (h.x + qtyHead.x) / 2, y: h.y, page: model.page });
  }
  if (!out.length) return out;
  // Each size goes to the nearest box.
  const sized = labelledDims(model).filter((d) => d.kind === 'rough' || d.kind === 'frame');
  for (const b of out) {
    const mine = sized.filter((d) => out.reduce((n, o) => (Math.hypot(d.x - o.x, d.y - o.y) < Math.hypot(d.x - n.x, d.y - n.y) ? o : n)) === b);
    const pick = (dir) => {
      for (const kind of ['rough', 'frame']) {
        const list = mine.filter((d) => d.kind === kind && d[dir]);
        if (list.length) return { ...list.reduce((a, c) => (c.inches > a.inches ? c : a)), kind };
      }
      return null;
    };
    const w = pick('horizontal');
    const hgt = pick('vertical');
    b.widthIn = w?.inches ?? null;
    b.heightIn = hgt?.inches ?? null;
    b.how = w || hgt ? `${(w || hgt).kind === 'rough' ? 'rough opening' : 'frame size'} written on the drawing` : 'no size found';
  }
  return out;
}

// ---------- Whole document ----------

// models: pages from reader.loadPage. Returns the takeoff:
//   families: tag shapes found, with labels and counts, best guess first
//   types: { label: { widthIn, heightIn, how, page } } from the type sheet
//   openings: [{ label, qty, widthIn, heightIn, places: [{ page, sheet, view }] }]
//   sheets, notes
export function analyze(models) {
  const sheets = models.map((m) => ({ ...sheetInfo(m), views: findViews(m).map((v) => v.title) }));
  const sheetOf = (page) => sheets.find((s) => s.page === page)?.sheet || `page ${page}`;

  // Tag families by shape, with every occurrence.
  const byShape = new Map();
  for (const m of models) {
    for (const t of findTags(m)) {
      if (!byShape.has(t.shape)) byShape.set(t.shape, []);
      byShape.get(t.shape).push({ ...t, page: m.page, model: m });
    }
  }
  // Grid bubbles are circles too; leave them out of the circle family.
  for (const m of models) {
    const grid = new Set(gridRows(m).flatMap((r) => r.bubbles.map((b) => `${Math.round(b.x)},${Math.round(b.y)}`)));
    if (!byShape.has('circle')) continue;
    byShape.set('circle', byShape.get('circle').filter((t) => t.page !== m.page || !grid.has(`${Math.round(t.x)},${Math.round(t.y)}`)));
  }

  const families = [];
  for (const [shape, all] of byShape) {
    const labels = [...new Set(all.map((t) => t.label))];
    // Keynote-style families (only plain numbers) and one-offs aren't window types.
    if (!labels.some((l) => /[A-Z]/.test(l))) continue;
    const types = {};
    let typePage = null;
    for (const m of models) {
      const here = all.filter((t) => t.page === m.page && /[A-Z]/.test(t.label));
      const distinct = new Set(here.map((t) => t.label));
      if (distinct.size < 2 || distinct.size !== here.length) continue;
      const sizes = typeSizes(m, here);
      if (Object.keys(sizes).length >= 2 && Object.keys(sizes).length > Object.keys(types).length) {
        Object.keys(types).forEach((k) => delete types[k]);
        Object.assign(types, sizes);
        typePage = m.page;
      }
    }
    const counted = countFamily(models, all.filter((t) => t.page !== typePage), sheetOf);
    families.push({ shape, labels: labels.sort(byLabel), types, typePage, typeSheet: typePage ? sheetOf(typePage) : null, ...counted });
  }
  families.sort((a, b) => score(b) - score(a) || SHAPE_ORDER.indexOf(a.shape) - SHAPE_ORDER.indexOf(b.shape));
  const marks = models.flatMap((m) => markBoxes(m)).map((b) => ({ ...b, sheet: sheetOf(b.page) }));
  const main = families.find((f) => Object.keys(f.types).length) || (marks.length ? null : families[0] || null);
  let openings = main ? openingsFor(main) : [];
  let source = main ? `${main.shape} tags counted on the ${main.basis}${main.typeSheet ? `, sizes from ${main.typeSheet}` : ''}` : '';
  if (!openings.length && marks.length) {
    openings = marks.map((b) => ({ label: b.label, qty: b.qty, widthIn: b.widthIn, heightIn: b.heightIn, how: b.how, places: [{ page: b.page, sheet: b.sheet }] }));
    source = 'mark and quantity boxes';
  }
  return { sheets, families, main, marks, openings, source };
}

function score(f) {
  return Object.keys(f.types).length * 10 + (f.total ? 1 : 0);
}

function byLabel(a, b) {
  return a.localeCompare(b, 'en', { numeric: true });
}

// Counts a family's tags on elevation views (plans if no elevation shows them), once per opening.
function countFamily(models, tags, sheetOf) {
  const withView = tags.map((t) => {
    const v = viewAt(t.model, t.x, t.y);
    return { ...t, view: v };
  });
  const onElev = withView.filter((t) => t.view?.kind === 'ELEVATION');
  const onPlan = withView.filter((t) => t.view?.kind === 'PLAN');
  const use = onElev.length ? onElev : onPlan.length ? onPlan : withView;
  const basis = onElev.length ? 'elevations' : onPlan.length ? 'plans' : 'all sheets';

  // Where each tag sits along the building: its view's face and its grid position.
  const placed = use.map((t) => {
    const rows = gridRows(t.model).filter((r) => !t.view || r.bubbles.some((b) => viewAt(t.model, b.x, b.y) === t.view));
    const row = rows.filter((r) => r.y < t.y).sort((a, b) => b.y - a.y)[0];
    const sub = row ? splitRow(t.model, row, t.view) : null;
    const grid = sub ? gridPosition(sub, t.x) : null;
    return { ...t, grid, face: t.view?.face || '' };
  });
  // The same opening drawn on two views (overlapping or enlarged elevations) is counted once.
  const counts = {};
  const places = {};
  const repeats = [];
  const seen = [];
  for (const t of placed) {
    const dup = t.grid != null && seen.find((q) => q.label === t.label && q.face === t.face && q.grid != null
      && Math.abs(q.grid - t.grid) < 0.12 && !(q.page === t.page && q.view === t.view));
    if (dup) { repeats.push({ label: t.label, ...where(t, sheetOf) }); continue; }
    seen.push(t);
    counts[t.label] = (counts[t.label] || 0) + 1;
    (places[t.label] ||= []).push(where(t, sheetOf));
  }
  return { counts, places, repeats, total: Object.values(counts).reduce((a, b) => a + b, 0), basis, duplicates: repeats.length };
}

// Bubbles of a grid row that belong to the given view (two views can share one row's height).
function splitRow(model, row, view) {
  if (!view) return row;
  const bubbles = row.bubbles.filter((b) => viewAt(model, b.x, b.y) === view);
  return bubbles.length >= 2 ? { ...row, bubbles } : null;
}

function where(t, sheetOf) {
  return { page: t.page, sheet: sheetOf(t.page), view: t.view?.title || '', x: Math.round(t.x), y: Math.round(t.y), grid: t.grid != null ? Math.round(t.grid * 100) / 100 : null };
}

function openingsFor(f) {
  const labels = [...new Set([...Object.keys(f.types), ...Object.keys(f.counts)])].sort(byLabel);
  return labels.map((label) => ({
    label,
    qty: f.counts[label] || 0,
    widthIn: f.types[label]?.widthIn ?? null,
    heightIn: f.types[label]?.heightIn ?? null,
    how: f.types[label]?.how || 'no type elevation found',
    places: f.places[label] || [],
  }));
}

// "(7) A1; (7) A2; (4) B" for a proposal's openings line.
export function scopeLine(openings) {
  return openings.filter((o) => o.qty > 0).map((o) => `(${o.qty}) ${o.label}`).join('; ');
}

// Estimate lines from openings: a glass line per type (sized and counted, priced from the proposal
// template), and the storefront framing in linear feet. Only when `useCutSize` is on (the "exact glass
// cut sizes" box on the Takeoff page) are the lines priced on glass cut sizes and full mullion/transom
// footage; otherwise on the openings' size and outside perimeter, so a proposal's price doesn't change
// unless that box is ticked.
export function estimateLines(openings, { desc = 'storefront', system = null, useCutSize = false } = {}) {
  const list = openings.filter((o) => o.qty > 0);
  if (!useCutSize) {
    const lines = list.map((o) => ({
      desc: `Type ${o.label || '?'} ${desc}${o.widthIn && o.heightIn ? ` ${fmtFtIn(o.widthIn)} x ${fmtFtIn(o.heightIn)}` : ''}`,
      kind: 'Glass', unit: o.widthIn && o.heightIn ? 'sqft' : 'each', qty: o.qty,
      widthIn: o.widthIn || null, heightIn: o.heightIn || null,
    }));
    const lf = list.reduce((s, o) => s + (o.widthIn && o.heightIn ? (2 * (o.widthIn + o.heightIn) / 12) * o.qty : 0), 0);
    if (lf > 0) lines.push({ desc: 'Storefront framing (outside perimeter of the openings above)', kind: 'Framing', unit: 'lf', qty: Math.ceil(lf) });
    return lines;
  }

  const lines = [];
  let totalFramingLf = 0;
  for (const o of list) {
    const bd = storefrontBayBreakdown(o, { system: o.system || system || 'sf175' });
    if (!bd) {
      lines.push({
        desc: `Type ${o.label || '?'} ${desc}`,
        kind: 'Glass', unit: 'each', qty: o.qty, widthIn: null, heightIn: null,
      });
      continue;
    }
    totalFramingLf += bd.totalFramingLf;
    for (const lite of bd.lites) {
      const roleNote = lite.role === 'transom' ? ' (transom lite)' : bd.bays > 1 ? ` (${bd.bays} bays/opening)` : '';
      lines.push({
        desc: `Type ${lite.mark || o.label || '?'} ${desc}${roleNote} — cut ${fmtFtIn(lite.width)} x ${fmtFtIn(lite.height)} (RO ${fmtFtIn(bd.roWidthIn)} x ${fmtFtIn(bd.roHeightIn)})`,
        kind: 'Glass',
        unit: 'sqft',
        qty: lite.qty,
        widthIn: lite.width,
        heightIn: lite.height,
      });
    }
  }
  if (totalFramingLf > 0) {
    const sysName = COMMERCIAL_SYSTEMS[system || list[0]?.system || 'sf175']?.short || 'Storefront';
    lines.push({
      desc: `${sysName} framing (head, sill, jambs, mullions & transoms)`,
      kind: 'Framing',
      unit: 'lf',
      qty: Math.ceil(totalFramingLf),
    });
  }
  // Sealant stays with the template's own caulking line (and the parts order's sealant count), not a
  // made-up price here.
  return lines;
}

// Builds supplier parts-order items from takeoff openings:
// - listType === 'glass': cut-to-size glass lites with exact DLO + bite dimensions and mark labels.
// - listType === 'parts': Trulite / aluminum framing 24' stock lengths, gaskets, setting blocks, and glass cut list.
export function partsFromTakeoff(openings, { system = 'sf175', listType = 'glass', finish = '#04 clear anodized' } = {}) {
  const active = (openings || []).filter((o) => o.qty > 0 && o.widthIn > 0 && o.heightIn > 0);
  if (!active.length) return [];
  const sys = COMMERCIAL_SYSTEMS[system] || COMMERCIAL_SYSTEMS.sf175;
  const breakdowns = active.map((o) => storefrontBayBreakdown(o, { system: o.system || sys.id })).filter(Boolean);
  const totals = openingLinearFeet(active, { system: sys.id });

  const glassRows = breakdowns.flatMap((bd) => bd.lites.map((l) => ({
    qty: l.qty,
    unit: 'ea',
    width: l.width,
    height: l.height,
    desc: l.desc,
    edge: `DLO ${fmtFtIn(l.dloWidth)} × ${fmtFtIn(l.dloHeight)} (${bd.systemName})`,
    mark: l.mark || '?',
  })));

  if (listType === 'glass') return glassRows;

  const items = [
    { heading: `${sys.partSeries} ${finish} — ${sys.short} (${totals.framingLf} LF total)` },
    {
      qty: totals.stockLengths24Ft,
      unit: 'S/L',
      partNo: `${sys.partSeries}-1`,
      desc: `${sys.short} head / sill / jamb / mullion (24' stock lengths, incl. 8% waste)`,
    },
    {
      qty: Math.max(1, Math.ceil((totals.framingLf * 2) / 250)),
      unit: 'roll',
      partNo: 'RG-1',
      desc: 'Glazing gasket (250\' roll)',
    },
    {
      qty: Math.max(1, Math.ceil((totals.totalLites * 2) / 50)),
      unit: 'pkg',
      partNo: 'RSB-3',
      desc: 'Setting blocks (2 per lite)',
    },
    {
      qty: Math.max(1, Math.ceil((active.reduce((s, o) => s + Number(o.qty || 0), 0) * 2) / 10)),
      unit: 'pkg',
      partNo: 'ED450-2',
      desc: 'Sill flashing end dams',
    },
    {
      qty: totals.sealantTubes,
      unit: 'tube',
      partNo: 'SIL-CLR',
      desc: `Perimeter silicone sealant (${totals.sealantLf} LF int/ext joints)`,
    },
    { heading: `Cut-to-size glass (${totals.totalLites} lites, ${totals.totalSqft} sq ft)` },
    ...glassRows,
  ];
  return items;
}

export { parseDim };
