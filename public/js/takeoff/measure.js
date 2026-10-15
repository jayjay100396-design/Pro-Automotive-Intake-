// Click-to-measure math for drawings and photos. Points are in page points for PDFs (1/72 inch on
// the printed sheet) or pixels for images. Pure functions, shared by the browser and the Node tests.

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// Page points per real inch for a printed scale given as real inches per paper inch
// (1/4" = 1'-0" is 48, so 1.5 points per real inch).
export const ptsPerInchFromScale = (realPerPaper) => (realPerPaper > 0 ? 72 / realPerPaper : null);

// Common drawing scales as real inches per paper inch: architects' (3" = 1'-0" down to 1/16" = 1'-0")
// and engineers' (1" = 10' to 1" = 100').
const STANDARD = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 120, 240, 360, 480, 600, 720, 1200];

// A scale worked out from a drawing, moved onto the standard scale it is within 1.5% of.
export function snapScale(realPerPaper) {
  const s = STANDARD.find((v) => Math.abs(v - realPerPaper) <= v * 0.015);
  return s ?? null;
}

// How a scale is written on a drawing: 48 -> 1/4" = 1'-0", 96 -> 1/8" = 1'-0", 240 -> 1" = 20'-0".
export function scaleLabel(realPerPaper) {
  const paper = 12 / realPerPaper; // paper inches to the foot
  const named = [[3, '3'], [1.5, '1 1/2'], [1, '1'], [0.75, '3/4'], [0.5, '1/2'], [0.375, '3/8'], [0.25, '1/4'],
    [0.1875, '3/16'], [0.125, '1/8'], [0.09375, '3/32'], [0.0625, '1/16']].find(([v]) => Math.abs(v - paper) < 1e-6);
  if (named) return `${named[1]}" = 1'-0"`;
  const ft = realPerPaper / 12;
  return Number.isInteger(ft) ? `1" = ${ft}'-0"` : `1" = ${Math.round(realPerPaper * 100) / 100}"`;
}

// Calibrating: two points a known real length apart.
export function calibrate(a, b, inches) {
  const d = dist(a, b);
  return d > 0 && inches > 0 ? d / inches : null;
}

// A measurement between two points. Nearly level or plumb lines are squared up, since a click is
// rarely exact: a width measured a little off level still reads as the width.
export function measure(a, b, unitsPerInch, { square = true } = {}) {
  if (!(unitsPerInch > 0)) return null;
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  let d = Math.hypot(dx, dy);
  let dir = 'angled';
  if (square && dx >= dy * 8) { d = dx; dir = 'across'; } else if (square && dy >= dx * 8) { d = dy; dir = 'up'; }
  return { inches: Math.round((d / unitsPerInch) * 16) / 16, dir };
}

// 2-click rectangle measurement: opposite corners of a window, storefront bay, or curtain-wall opening.
export function measureRect(a, b, unitsPerInch) {
  if (!a || !b || !(unitsPerInch > 0)) return null;
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const widthIn = Math.round(((x1 - x0) / unitsPerInch) * 16) / 16;
  const heightIn = Math.round(((y1 - y0) / unitsPerInch) * 16) / 16;
  if (!(widthIn > 0 && heightIn > 0)) return null;
  const perimeterLf = Math.round(((2 * (widthIn + heightIn)) / 12) * 100) / 100;
  const areaSqft = Math.round(((widthIn * heightIn) / 144) * 100) / 100;
  return { widthIn, heightIn, perimeterLf, areaSqft, x0, y0, x1, y1 };
}

// Multi-point polyline measurement: linear footage along a storefront plan run, sill flashing, or caulking perimeter.
export function measurePolyline(points, unitsPerInch) {
  if (!Array.isArray(points) || points.length < 2 || !(unitsPerInch > 0)) return null;
  const segments = [];
  let totalInches = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const m = measure(a, b, unitsPerInch);
    if (!m) continue;
    segments.push({ a, b, inches: m.inches, dir: m.dir });
    totalInches += m.inches;
  }
  totalInches = Math.round(totalInches * 16) / 16;
  const linearFeet = Math.round((totalInches / 12) * 100) / 100;
  return { totalInches, linearFeet, segments };
}

// Where two lines cross, or null (near-parallel lines don't count).
function crossing(g, h) {
  const ax = g.x2 - g.x1, ay = g.y2 - g.y1, bx = h.x2 - h.x1, by = h.y2 - h.y1;
  const den = ax * by - ay * bx;
  if (Math.abs(den) < 0.17 * Math.hypot(ax, ay) * Math.hypot(bx, by) || den === 0) return null;
  const t = ((h.x1 - g.x1) * by - (h.y1 - g.y1) * bx) / den;
  const u = ((h.x1 - g.x1) * ay - (h.y1 - g.y1) * ax) / den;
  const e = 1e-6;
  return t >= -e && t <= 1 + e && u >= -e && u <= 1 + e ? [g.x1 + t * ax, g.y1 + t * ay] : null;
}

// The point on a line closest to p.
function nearestOn(g, p) {
  const ax = g.x2 - g.x1, ay = g.y2 - g.y1;
  const len = ax * ax + ay * ay;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - g.x1) * ax + (p[1] - g.y1) * ay) / len)) : 0;
  return [g.x1 + t * ax, g.y1 + t * ay];
}

// Moves a click onto the drawing's lines (vector drawings only): where two lines cross (a
// dimension line and its witness line, a frame corner) first, then a line end, and with neither
// in reach, the nearest point on a line.
export function snap(segs, p, reach) {
  const near = [];
  for (const g of segs || []) {
    if (g.mask) continue;
    if (Math.min(g.x1, g.x2) > p[0] + reach || Math.max(g.x1, g.x2) < p[0] - reach
      || Math.min(g.y1, g.y2) > p[1] + reach || Math.max(g.y1, g.y2) < p[1] - reach) continue;
    near.push(g);
    if (near.length >= 400) break;
  }
  let best = null;
  let bestScore = Infinity;
  const consider = (q, weight) => {
    const d = dist(p, q);
    if (d <= reach && d * weight < bestScore) { bestScore = d * weight; best = q; }
  };
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      const x = crossing(near[i], near[j]);
      if (x) consider(x, 0.6);
    }
  }
  for (const g of near) { consider([g.x1, g.y1], 1); consider([g.x2, g.y2], 1); }
  if (best) return [best[0], best[1]];
  for (const g of near) {
    const q = nearestOn(g, p);
    const d = dist(p, q);
    if (d <= reach / 2 && d < bestScore) { bestScore = d; best = q; }
  }
  return best ? [best[0], best[1]] : p;
}
