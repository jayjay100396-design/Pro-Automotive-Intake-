// Reads a drawing page into plain data: positioned text, line segments and markups, all in
// display space (points, origin top-left, y down, the page's rotation applied). Then finds what a
// glazing takeoff needs on it: dimension text, type tags (the diamond, hexagon or circle marks that
// name each window type), view titles with their scales, and grid bubbles.
// Pure functions over plain objects, so the same code runs in the browser (pdf.js from the CDN)
// and in the Node tests. pdf.js 4.x operator lists are assumed (constructPath = [ops, coords]).
import { parseDim, parseScale } from './dims.js';

const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const CURVE_STEPS = 6;
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
};

// ---------- Loading a page ----------

// page: a pdf.js PDFPageProxy. OPS: pdf.js's OPS table (pdfjsLib.OPS).
export async function loadPage(page, OPS) {
  const vp = page.getViewport({ scale: 1 });
  const vt = vp.transform;
  const [tc, opList, annots] = await Promise.all([
    page.getTextContent(),
    page.getOperatorList(),
    page.getAnnotations().catch(() => []),
  ]);
  return {
    page: page.pageNumber,
    width: vp.width,
    height: vp.height,
    text: tc.items.filter((i) => i.str && i.str.trim()).map((i) => textItem(i, vt)),
    ...readPaths(opList, OPS, vt),
    annots: annots.map((a) => annotItem(a, vt)).filter(Boolean),
  };
}

function textItem(i, vt) {
  const m = mul(i.transform, vt);
  const size = Math.hypot(m[2], m[3]) || 1;
  const dl = Math.hypot(m[0], m[1]) || 1;
  const dir = [m[0] / dl, m[1] / dl];
  const up = [m[2] / size, m[3] / size];
  const w = i.width || 0;
  const ox = m[4], oy = m[5];
  const x = ox + dir[0] * w / 2 + up[0] * size * 0.35;
  const y = oy + dir[1] * w / 2 + up[1] * size * 0.35;
  return { str: i.str, x, y, ox, oy, w, size, angle: Math.round(Math.atan2(dir[1], dir[0]) * 180 / Math.PI), dir, up };
}

function annotItem(a, vt) {
  if (!a || ['Link', 'Widget', 'Popup'].includes(a.subtype)) return null;
  const pts = (arr) => {
    const out = [];
    for (let k = 0; k + 1 < (arr?.length || 0); k += 2) out.push(apply(vt, arr[k], arr[k + 1]));
    return out;
  };
  const vertices = (a.vertices || []).map((v) => (Array.isArray(v) ? apply(vt, v[0], v[1]) : apply(vt, v.x, v.y)));
  const [x1, y1] = apply(vt, a.rect[0], a.rect[1]);
  const [x2, y2] = apply(vt, a.rect[2], a.rect[3]);
  const text = [a.contentsObj?.str, a.richText?.str, Array.isArray(a.textContent) ? a.textContent.join(' ') : '']
    .map((s) => (s || '').trim()).filter(Boolean);
  return {
    id: a.id,
    subtype: a.subtype,
    text: [...new Set(text)].join('\n'),
    author: a.titleObj?.str || '',
    x0: Math.min(x1, x2), y0: Math.min(y1, y2), x1: Math.max(x1, x2), y1: Math.max(y1, y2),
    line: a.lineCoordinates ? pts(a.lineCoordinates) : null,
    vertices: vertices.length ? vertices : null,
    ink: a.inkLists ? a.inkLists.map((l) => (Array.isArray(l) && typeof l[0] === 'number' ? pts(l) : l.map((p) => apply(vt, p.x, p.y)))) : null,
  };
}

// Walks the operator list, tracking the transform, and keeps every stroked or filled path as its
// straight pieces: segments [{ x1, y1, x2, y2, fill, mask }].
function readPaths(opList, OPS, vt) {
  const paths = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let pending = [];
  const P = (x, y) => {
    const u = apply(ctm, x, y);
    return apply(vt, u[0], u[1]);
  };
  const paint = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
    OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(args, ctm);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = mul(Array.from(args[0]), ctm);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.constructPath) {
      const [pops, coords] = args;
      let ci = 0;
      let cur = null;
      for (const op of pops) {
        if (op === OPS.moveTo) {
          cur = { pts: [P(coords[ci], coords[ci + 1])], kinds: ['M'], closed: false, curves: 0, last: [coords[ci], coords[ci + 1]] };
          pending.push(cur);
          ci += 2;
        } else if (op === OPS.lineTo) {
          if (!cur) { cur = { pts: [], kinds: [], closed: false, curves: 0, last: null }; pending.push(cur); }
          cur.pts.push(P(coords[ci], coords[ci + 1]));
          cur.kinds.push('L');
          cur.last = [coords[ci], coords[ci + 1]];
          ci += 2;
        } else if (op === OPS.curveTo || op === OPS.curveTo2 || op === OPS.curveTo3) {
          // Curves are kept as short straight pieces so circles stay round.
          const n = op === OPS.curveTo ? 6 : 4;
          if (cur && cur.last) {
            const [x0, y0] = cur.last;
            const c = coords.slice(ci, ci + n);
            const [c1, c2, end] = op === OPS.curveTo ? [[c[0], c[1]], [c[2], c[3]], [c[4], c[5]]]
              : op === OPS.curveTo2 ? [[x0, y0], [c[0], c[1]], [c[2], c[3]]]
                : [[c[0], c[1]], [c[2], c[3]], [c[2], c[3]]];
            for (let k = 1; k <= CURVE_STEPS; k++) {
              const t = k / CURVE_STEPS, mt = 1 - t;
              const bx = mt * mt * mt * x0 + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * end[0];
              const by = mt * mt * mt * y0 + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * end[1];
              cur.pts.push(P(bx, by));
              cur.kinds.push('C');
            }
            cur.curves++;
            cur.last = end;
          }
          ci += n;
        } else if (op === OPS.closePath) {
          if (cur) cur.closed = true;
        } else if (op === OPS.rectangle) {
          const [x, y, w, h] = [coords[ci], coords[ci + 1], coords[ci + 2], coords[ci + 3]];
          ci += 4;
          pending.push({ pts: [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)], kinds: ['M', 'L', 'L', 'L'], closed: true, curves: 0, rect: true });
          cur = null;
        }
      }
    } else if (paint.has(fn)) {
      for (const p of pending) { p.fill = fn !== OPS.stroke && fn !== OPS.closeStroke; delete p.last; paths.push(p); }
      pending = [];
    } else if (fn === OPS.endPath) pending = [];
  }
  const segs = [];
  paths.forEach((p) => {
    // A filled box is usually the white mask behind a piece of text, not a drawn line.
    const mask = p.fill && p.pts.length <= 5 && p.curves === 0;
    for (let k = 1; k < p.pts.length; k++) {
      segs.push({ x1: p.pts[k - 1][0], y1: p.pts[k - 1][1], x2: p.pts[k][0], y2: p.pts[k][1], fill: p.fill, mask });
    }
    if (p.closed && p.pts.length > 2) {
      const a = p.pts[p.pts.length - 1], b = p.pts[0];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.01) segs.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], fill: p.fill, mask });
    }
  });
  return { segs };
}

// ---------- Text runs ----------

// Joins text pieces that sit on one line next to each other ("8'" "-" "0\"") and rebuilds
// stacked fractions (a raised 1 over a lowered 2 becomes 1/2). Each run keeps its pieces.
export function textRuns(model) {
  if (model._runs) return model._runs;
  const items = model.text.map((t) => {
    // u runs along the text, v across it (down the page for upright text), from the text origin.
    const u = t.ox * t.dir[0] + t.oy * t.dir[1];
    const v = -(t.ox * t.up[0] + t.oy * t.up[1]);
    return { ...t, u, v };
  });
  const groups = new Map();
  for (const t of items) {
    const key = Math.round(t.angle / 5) * 5;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const runs = [];
  for (const list of groups.values()) {
    list.sort((p, q) => p.u - q.u);
    const used = new Set();
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue;
      const run = [list[i]];
      used.add(i);
      let end = list[i].u + list[i].w;
      const base = list[i];
      for (let j = i + 1; j < list.length; j++) {
        if (used.has(j)) continue;
        const t = list[j];
        if (t.u - end > base.size * 0.6) break;
        if (t.u < end - base.size * 0.5) continue;
        // Pieces of a stacked fraction sit higher and lower than the whole number.
        const piece = /^\d{1,2}$/.test(t.str.trim()) && run.some((q) => /^\d{1,3}\s*$/.test(q.str));
        if (Math.min(...run.map((q) => Math.abs(t.v - q.v))) > base.size * (piece ? 0.9 : 0.62)) continue;
        if (t.size / base.size > 1.3 || t.size / base.size < 0.5) continue;
        const prev = run[run.length - 1];
        // Two complete dimensions side by side stay apart: 3' - 0" | 1' - 0".
        if (/["']\s*$/.test(prev.str) && /^\s*\d/.test(t.str) && Math.abs(t.v - prev.v) < base.size * 0.2) break;
        run.push(t);
        used.add(j);
        end = Math.max(end, t.u + t.w);
      }
      runs.push(makeRun(run));
    }
  }
  model._runs = runs;
  return runs;
}

function makeRun(parts) {
  if (parts.length === 1) {
    const t = parts[0];
    return { str: t.str.trim(), x: t.x, y: t.y, size: t.size, angle: t.angle, dir: t.dir, up: t.up, ...bbox(parts), parts };
  }
  const baseV = median(parts.map((p) => p.v));
  const size = Math.max(...parts.map((p) => p.size));
  let str = '';
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    const q = parts[k + 1];
    const s = p.str.trim();
    const raised = p.v < baseV - size * 0.18;
    const qRaised = q && q.v < baseV - size * 0.18;
    const qLowered = q && q.v > baseV + size * 0.18;
    const lowered = p.v > baseV + size * 0.18;
    if (q && /^\d+$/.test(s) && /^\d+$/.test(q.str.trim()) && ((raised && qLowered) || (lowered && qRaised))) {
      const [n, d] = raised ? [s, q.str.trim()] : [q.str.trim(), s];
      str += `${str && !/[\s-]$/.test(str) ? ' ' : ''}${n}/${d}`;
      k++;
      continue;
    }
    const gap = k ? p.u - (parts[k - 1].u + parts[k - 1].w) : 0;
    str += (k && gap > size * 0.12 && !/^["']/.test(s) ? ' ' : '') + s;
  }
  const first = parts[0];
  const b = bbox(parts);
  return { str: str.replace(/\s+/g, ' ').trim(), x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, size, angle: first.angle, dir: first.dir, up: first.up, ...b, parts };
}

// Axis-aligned box around text pieces, in display space.
function bbox(parts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of parts) {
    const corners = [
      [t.ox, t.oy],
      [t.ox + t.dir[0] * t.w, t.oy + t.dir[1] * t.w],
      [t.ox + t.up[0] * t.size * 0.75, t.oy + t.up[1] * t.size * 0.75],
      [t.ox + t.dir[0] * t.w + t.up[0] * t.size * 0.75, t.oy + t.dir[1] * t.w + t.up[1] * t.size * 0.75],
    ];
    for (const [cx, cy] of corners) {
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
    }
  }
  return { x0, y0, x1, y1 };
}

const isHorizontal = (r) => Math.abs(r.angle) <= 5;
const isVertical = (r) => Math.abs(Math.abs(r.angle) - 90) <= 5;

// Dimension text on the page: [{ ...run, inches, horizontal, vertical }].
export function dimensionRuns(model) {
  return textRuns(model)
    .map((r) => ({ ...r, inches: parseDim(r.str) }))
    .filter((r) => r.inches != null && r.inches > 0)
    .map((r) => ({ ...r, horizontal: isHorizontal(r), vertical: isVertical(r) }));
}

// ---------- Sheet number ----------

const SHEET_NO = /^[A-Z]{1,3}[-.]?\d{1,4}(\.\d{1,2})?[A-Z]?$/;

// The sheet number is the biggest sheet-number-looking text in the page's right or bottom edge.
export function sheetInfo(model) {
  const runs = textRuns(model).filter((r) => SHEET_NO.test(r.str)
    && (r.x > model.width * 0.75 || r.y > model.height * 0.75));
  runs.sort((p, q) => q.size - p.size);
  return { page: model.page, sheet: runs[0]?.str || '' };
}

// ---------- Tags ----------

const TAG_LABEL = /^(?=.{1,6}$)[A-Z]{0,3}[-.]?\d{0,4}[A-Z]{0,2}$/;

// Short labels inside a small closed shape around them. Returns
// [{ label, shape: diamond|circle|ellipse|hexagon|square|rect|other, x, y, rx, ry, size }].
// The outline is found by casting rays out from the label: each must hit a nearby line, and the
// distances it hits at give the shape. This works however the outline was drawn (one path, separate
// lines, curves or a many-sided polygon).
export function findTags(model) {
  if (model._tags) return model._tags;
  const runs = textRuns(model).filter((r) => TAG_LABEL.test(r.str) && /[A-Z0-9]/.test(r.str) && isHorizontal(r));
  const index = segIndex(model);
  const tags = [];
  for (const r of runs) {
    const shape = outlineAround(r, index.near(r.x, r.y, r.size * 3.6));
    if (shape) tags.push({ label: r.str, ...shape, size: r.size, run: r });
  }
  model._tags = tags;
  return tags;
}

const RAYS = 24;

function outlineAround(r, near) {
  const s = r.size;
  const halfW = (r.x1 - r.x0) / 2 + s * 0.3;
  const halfH = (r.y1 - r.y0) / 2 + s * 0.3;
  // Lines inside the label's own box (a white mask behind the text) aren't the outline.
  const segs = near.filter((g) => !(Math.abs(g.x1 - r.x) <= halfW && Math.abs(g.x2 - r.x) <= halfW
    && Math.abs(g.y1 - r.y) <= halfH && Math.abs(g.y2 - r.y) <= halfH)
    && Math.hypot(g.x2 - g.x1, g.y2 - g.y1) > s * 0.05);
  if (segs.length < 3) return null;
  // Rays start from the label's centre; the outline must be clear of the text and close around it.
  const first = castRays(r.x, r.y, segs, s);
  if (!first) return null;
  // Text must fit inside: the horizontal rays clear the label's half-width.
  const textHalf = (r.x1 - r.x0) / 2 + s * 0.1;
  if (first[0] < textHalf || first[RAYS / 2] < textHalf || Math.min(...first) < s * 0.55) return null;
  // Cast again from the outline's own centre (labels are rarely dead centre in their tags).
  const cx = r.x + (first[0] - first[RAYS / 2]) / 2;
  const cy = r.y + (first[RAYS / 4] - first[(3 * RAYS) / 4]) / 2;
  const d = castRays(cx, cy, segs, s);
  if (!d) return null;
  const min = Math.min(...d), max = Math.max(...d);
  const rx = (d[0] + d[RAYS / 2]) / 2;
  const ry = (d[RAYS / 4] + d[(3 * RAYS) / 4]) / 2;
  const at = (deg) => d[Math.round((deg / 360) * RAYS) % RAYS];
  const axes = (at(0) + at(90) + at(180) + at(270)) / 4;
  const diags = (at(45) + at(135) + at(225) + at(315)) / 4;
  const base = { x: cx, y: cy, rx, ry };
  if (diags / axes < 0.8) return { shape: 'diamond', ...base };
  if (diags / axes > 1.2) return { shape: Math.abs(rx - ry) < Math.max(rx, ry) * 0.12 ? 'square' : 'rect', ...base };
  if ((max - min) / max < 0.07) return { shape: 'circle', ...base };
  // Six-sided: the same distances repeat every 60 degrees.
  const step = RAYS / 6;
  const sixfold = d.every((v, k) => Math.abs(v - d[(k + step) % RAYS]) < max * 0.05);
  if (sixfold && min / max > 0.8) return { shape: 'hexagon', ...base };
  if (Math.max(rx, ry) / Math.min(rx, ry) > 1.2 && d.every((v, k) => Math.abs(v - d[(k + 1) % RAYS]) < max * 0.2)) {
    return { shape: 'ellipse', ...base };
  }
  return { shape: 'other', ...base };
}

function castRays(x, y, segs, s) {
  const d = [];
  for (let k = 0; k < RAYS; k++) {
    const a = (k * 2 * Math.PI) / RAYS;
    const t = rayHit(x, y, Math.cos(a), Math.sin(a), segs);
    if (t == null || t > s * 3.4) return null;
    d.push(t);
  }
  return d;
}

// Distance along a ray to the first segment it crosses, or null.
function rayHit(x, y, dx, dy, segs) {
  let best = null;
  for (const g of segs) {
    const ex = g.x2 - g.x1, ey = g.y2 - g.y1;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const wx = g.x1 - x, wy = g.y1 - y;
    const t = (wx * ey - wy * ex) / den;
    const u = (wx * dy - wy * dx) / den;
    if (t > 0 && u >= -0.02 && u <= 1.02 && (best == null || t < best)) best = t;
  }
  return best;
}

// A coarse grid over the page's segments for quick "what's near here" lookups.
export function segIndex(model) {
  if (model._index) return model._index;
  const cell = 24;
  const grid = new Map();
  const key = (i, j) => `${i},${j}`;
  model.segs.forEach((g) => {
    const i0 = Math.floor(Math.min(g.x1, g.x2) / cell), i1 = Math.floor(Math.max(g.x1, g.x2) / cell);
    const j0 = Math.floor(Math.min(g.y1, g.y2) / cell), j1 = Math.floor(Math.max(g.y1, g.y2) / cell);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) return; // very long lines aren't needed for local lookups
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = key(i, j);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(g);
    }
  });
  const near = (x, y, rad) => {
    const out = new Set();
    for (let i = Math.floor((x - rad) / cell); i <= Math.floor((x + rad) / cell); i++) {
      for (let j = Math.floor((y - rad) / cell); j <= Math.floor((y + rad) / cell); j++) {
        for (const g of grid.get(key(i, j)) || []) {
          if (Math.hypot(g.x1 - x, g.y1 - y) <= rad && Math.hypot(g.x2 - x, g.y2 - y) <= rad) out.add(g);
        }
      }
    }
    return [...out];
  };
  model._index = { near };
  return model._index;
}

// ---------- Views ----------

const VIEW_WORDS = /\b(ELEVATIONS?|PLANS?|SECTIONS?|DETAILS?|SCHEDULES?|LEGENDS?|VIEWS?|TYPES?)\b/i;
const FACE = /\b(NORTH|SOUTH|EAST|WEST|FRONT|REAR|BACK|LEFT|RIGHT)\b/i;

// View titles: bigger-than-usual horizontal text naming a drawing, with its scale if one is printed under it.
// [{ title, face, kind, scale (real inches per paper inch), x0, y0, x1, y1, size }]
export function findViews(model) {
  if (model._views) return model._views;
  const runs = textRuns(model);
  const typical = median(runs.map((r) => r.size));
  const views = [];
  for (const r of runs) {
    if (!isHorizontal(r) || !VIEW_WORDS.test(r.str) || r.str.length > 80) continue;
    const scaleRun = runs.find((q) => isHorizontal(q) && q !== r && q.y > r.y && q.y - r.y < r.size * 2.6
      && q.x0 >= r.x0 - r.size * 2 && q.x0 <= r.x1 && (parseScale(q.str) || /\b(N\.?T\.?S\.?|NOT TO SCALE)\b/i.test(q.str)));
    if (r.size < typical * 1.4 && !scaleRun) continue;
    const kind = (r.str.match(VIEW_WORDS)?.[1] || '').toUpperCase().replace(/S$/, '');
    views.push({
      title: r.str, face: (r.str.match(FACE)?.[1] || '').toUpperCase(), kind,
      scale: scaleRun ? parseScale(scaleRun.str) : null, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, size: r.size, run: r,
    });
  }
  model._views = views;
  return views;
}

// The view a point belongs to: the nearest title below it that starts left of it.
// Title-above-the-view layouts (a boxed legend with its name on top) aren't matched here.
export function viewAt(model, x, y) {
  let best = null;
  for (const v of findViews(model)) {
    if (v.y0 < y || v.x0 > x + v.size) continue;
    const dy = v.y0 - y;
    if (!best || dy < best.dy - v.size || (Math.abs(dy - best.dy) <= v.size && v.x0 > best.v.x0)) best = { v, dy };
  }
  return best?.v || null;
}

// ---------- Grid bubbles ----------

const GRID_LABEL = /^([A-Z]{1,2}|\d{1,3})(\.\d{1,2})?$/;

// Grid bubbles in a row (circles with grid numbers or letters, a grid line running out of each).
// [{ y, r, bubbles: [{ label, x, y, ord }] }] with bubbles sorted left to right.
export function gridRows(model) {
  if (model._grids) return model._grids;
  const circles = findTags(model).filter((t) => t.shape === 'circle' && GRID_LABEL.test(t.label));
  const withLine = circles.filter((t) => gridLineLength(model, t) > t.rx * 3);
  const rows = [];
  for (const t of withLine.sort((a, b) => a.y - b.y)) {
    const row = rows.find((q) => Math.abs(q.y - t.y) < 2 && Math.abs(q.r - t.rx) < t.rx * 0.25);
    if (row) row.bubbles.push(t);
    else rows.push({ y: t.y, r: t.rx, bubbles: [t] });
  }
  const out = rows.filter((q) => q.bubbles.length >= 2).map((q) => ({
    y: q.y, r: q.r,
    bubbles: q.bubbles.sort((a, b) => a.x - b.x).map((b) => ({ label: b.label, x: b.x, y: b.y, ord: gridOrd(b.label) })),
  }));
  model._grids = out;
  return out;
}

// Total length of vertical line pieces leaving a bubble downward or upward along its centre.
function gridLineLength(model, t) {
  let total = 0;
  for (const g of model.segs) {
    if (Math.abs(g.x1 - t.x) > 0.8 || Math.abs(g.x2 - t.x) > 0.8) continue;
    const top = Math.min(g.y1, g.y2), bot = Math.max(g.y1, g.y2);
    if (bot - top < 0.5) continue;
    if (top >= t.y + t.ry * 0.8 && top < t.y + t.ry * 60) total += bot - top;
    else if (bot <= t.y - t.ry * 0.8 && bot > t.y - t.ry * 60) total += bot - top;
  }
  return total;
}

// Grid labels as numbers: 7 -> 7, 7.5 -> 7.5, C -> 3, AA -> 27.
export function gridOrd(label) {
  const m = /^([A-Z]{1,2}|\d{1,3})(\.\d{1,2})?$/.exec(label);
  if (!m) return null;
  const head = /^\d/.test(m[1]) ? Number(m[1]) : [...m[1]].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);
  return head + (m[2] ? Number(m[2]) : 0);
}

// Position of x along a grid row, in grid units (between bubbles 20 and 21 -> 20.x).
export function gridPosition(row, x) {
  const b = row.bubbles.filter((q) => q.ord != null);
  if (b.length < 2) return null;
  let i = 0;
  while (i < b.length - 2 && x > b[i + 1].x) i++;
  const p = b[i], q = b[i + 1];
  if (q.x === p.x) return null;
  return p.ord + (x - p.x) / (q.x - p.x) * (q.ord - p.ord);
}
