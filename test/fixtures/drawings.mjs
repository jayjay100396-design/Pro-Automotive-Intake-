// Made-up drawings for the takeoff tests, drawn the way CAD exports them: lines, text, dimension
// strings with ticks, diamond window tags, grid bubbles and view titles with their scales. No real
// customer drawings are kept in the repo.
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, rgb } from 'pdf-lib';

const W = 1728; // a 24" x 18" sheet
const H = 1296;
const BLACK = rgb(0, 0, 0);

// Coordinates below are as the sheet is read: x to the right, y down from the top.
function sheet(doc, font) {
  const page = doc.addPage([W, H]);
  const line = (x1, y1, x2, y2, thickness = 0.5) => page.drawLine({ start: { x: x1, y: H - y1 }, end: { x: x2, y: H - y2 }, thickness, color: BLACK });
  const text = (str, x, y, size = 9, rotate = 0) => page.drawText(str, { x, y: H - y, size, font, color: BLACK, rotate: degrees(rotate) });
  const centered = (str, cx, cy, size = 9) => text(str, cx - font.widthOfTextAtSize(str, size) / 2, cy + size * 0.35, size);
  const rect = (x0, y0, x1, y1) => { line(x0, y0, x1, y0); line(x1, y0, x1, y1); line(x1, y1, x0, y1); line(x0, y1, x0, y0); };
  const tick = (x, y) => { line(x, y, x - 4.5, y + 4.5); line(x, y, x + 4.5, y - 4.5); };
  return {
    page, line, text, centered, rect,
    // A horizontal dimension: witness lines from the object (objY) to just past the dimension
    // line, ticks where they cross, the size written above the line.
    hdim(x0, x1, y, label, objY) {
      line(x0 - 6, y, x1 + 6, y);
      for (const x of [x0, x1]) { line(x, objY > y ? y - 5 : objY + 3, x, objY > y ? objY - 3 : y + 5); tick(x, y); }
      centered(label, (x0 + x1) / 2, y - 7);
    },
    // A vertical dimension, the size written along it reading upward.
    vdim(x, y0, y1, label, objX) {
      line(x, y0 - 6, x, y1 + 6);
      for (const y of [y0, y1]) { line(objX < x ? objX + 3 : x - 5, y, objX < x ? x + 5 : objX - 3, y); tick(x, y); }
      const w = font.widthOfTextAtSize(label, 9);
      text(label, x - 3, (y0 + y1) / 2 + w / 2, 9, 90);
    },
    diamond(cx, cy, label, r = 12) {
      line(cx, cy - r, cx + r, cy); line(cx + r, cy, cx, cy + r); line(cx, cy + r, cx - r, cy); line(cx - r, cy, cx, cy - r);
      centered(label, cx, cy, 10);
    },
    bubble(cx, cy, label, lineTo, r = 12) {
      page.drawCircle({ x: cx, y: H - cy, size: r, borderWidth: 0.5, borderColor: BLACK });
      centered(label, cx, cy, 11);
      for (let y = cy + r; y < lineTo; y += 18) line(cx, y, cx, Math.min(y + 12, lineTo)); // dashed grid line
    },
    title(str, x, y, scale) {
      text(str, x, y, 14);
      line(x, y + 4, x + font.widthOfTextAtSize(str, 14), y + 4, 1);
      if (scale) text(scale, x, y + 20, 10);
    },
    sheetNo(str) { text(str, W - 150, H - 60, 36); text('3955 Example Drive', W - 150, H - 120, 10); },
  };
}

// A window frame drawn at a scale (page points per inch), standing on y = bottom.
function frame(s, x0, bottom, widthIn, heightIn, ppi, { mullion, transomIn } = {}) {
  const x1 = x0 + widthIn * ppi, top = bottom - heightIn * ppi;
  s.rect(x0, top, x1, bottom);
  s.rect(x0 + 2.5, top + 2.5, x1 - 2.5, bottom - 2.5);
  if (mullion) s.line((x0 + x1) / 2, top + 2.5, (x0 + x1) / 2, bottom - 2.5);
  if (transomIn) s.line(x0 + 2.5, bottom - transomIn * ppi, x1 - 2.5, bottom - transomIn * ppi);
  return { x0, x1, top, bottom };
}

// A drawing set: A-601 with three window types drawn at 1/4" = 1'-0" (no scale printed, like most
// type sheets), A-201 with the north elevation and an enlarged part of it (three windows shown on
// both), and A-202 with the south elevation.
// Expected takeoff: A (3) 54 x 104, B (1) 72 x 80, C (3) 96 x 80, with 3 repeats counted once.
export async function drawingSet() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // A-601: window types
  const t = sheet(doc, font);
  t.sheetNo('A-601');
  const q = 1.5; // 1/4" = 1'-0"
  const a = frame(t, 150, 500, 54, 104, q, { transomIn: 60 });
  t.hdim(a.x0, a.x1, a.top - 30, "4'-6\"", a.top);
  t.vdim(a.x1 + 40, a.top, a.bottom, "8'-8\"", a.x1);
  t.vdim(a.x1 + 22, a.top, a.bottom - 60 * q, "3'-8\"", a.x1);
  t.vdim(a.x1 + 22, a.bottom - 60 * q, a.bottom, "5'-0\"", a.x1);
  t.diamond((a.x0 + a.x1) / 2, a.bottom + 40, 'A');
  const b = frame(t, 420, 500, 72, 80, q);
  t.hdim(b.x0, b.x1, b.top - 30, "6'-0\"", b.top);
  t.vdim(b.x1 + 30, b.top, b.bottom, "6'-8\"", b.x1);
  t.diamond((b.x0 + b.x1) / 2, b.bottom + 40, 'B');
  const c = frame(t, 700, 500, 96, 80, q, { mullion: true });
  t.hdim(c.x0, c.x1, c.top - 44, "8'-0\"", c.top);
  t.hdim(c.x0, (c.x0 + c.x1) / 2, c.top - 22, "4'-0\"", c.top);
  t.hdim((c.x0 + c.x1) / 2, c.x1, c.top - 22, "4'-0\"", c.top);
  t.vdim(c.x1 + 30, c.top, c.bottom, "6'-8\"", c.x1);
  t.diamond((c.x0 + c.x1) / 2, c.bottom + 40, 'C');
  t.title('WINDOW TYPES', 150, 620);

  // A-201: north elevation at 1/8" and part of it enlarged at 1/4"
  const n = sheet(doc, font);
  n.sheetNo('A-201');
  const elevation = (s, gx, bay, ppi, top, ground, grids, windows) => {
    grids.forEach((g, i) => s.bubble(gx + i * bay, top, g, ground + 10));
    s.line(gx - 20, ground, gx + (grids.length - 1) * bay + 20, ground, 1);
    for (const [label, pos, wIn, hIn] of windows) {
      const cx = gx + (pos - Number(grids[0])) * bay;
      const f = frame(s, cx - (wIn * ppi) / 2, ground - 24 * ppi, wIn, hIn, ppi);
      s.diamond(cx, f.top - 20, label);
    }
  };
  const north = [['A', 1.5, 54, 104], ['C', 2.25, 96, 80], ['B', 2.75, 72, 80], ['A', 3.5, 54, 104]];
  elevation(n, 200, 135, 0.75, 180, 480, ['1', '2', '3', '4'], north);
  n.title('EXTERIOR ELEVATION - NORTH', 200, 560, '1/8" = 1\'-0"');
  elevation(n, 900, 270, 1.5, 180, 480, ['1', '2', '3'], north.filter(([, pos]) => pos < 3));
  n.title('EXTERIOR ELEVATION - NORTH ENLARGED', 900, 560, '1/4" = 1\'-0"');

  // A-202: south elevation
  const so = sheet(doc, font);
  so.sheetNo('A-202');
  elevation(so, 200, 135, 0.75, 180, 480, ['1', '2', '3', '4'], [['A', 1.5, 54, 104], ['C', 2.5, 96, 80], ['C', 3.5, 96, 80]]);
  so.title('EXTERIOR ELEVATION - SOUTH', 200, 560, '1/8" = 1\'-0"');
  return doc.save();
}

// A storefront shop drawing: a MARK / QTY box and the rough opening written under each dimension.
// Expected: SF-1, 4 of them, 54 x 104 rough opening.
export async function shopDrawing() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const s = sheet(doc, font);
  s.sheetNo('SD-1');
  s.rect(80, 80, 220, 130);
  s.line(80, 105, 220, 105);
  s.line(150, 80, 150, 130);
  s.centered('MARK', 115, 93, 10);
  s.centered('QTY', 185, 93, 10);
  s.centered('SF-1', 115, 118, 10);
  s.centered('4', 185, 118, 10);
  const f = frame(s, 400, 700, 54, 104, 3); // 1/4" = 1"
  s.hdim(f.x0, f.x1, f.bottom + 40, '54" [4\'-6"]', f.bottom);
  s.centered('ROUGH OPENING', (f.x0 + f.x1) / 2, f.bottom + 48, 9);
  s.hdim(f.x0 + 2.5, f.x1 - 2.5, f.bottom + 90, '53 1/2"', f.bottom);
  s.centered('FRAME SIZE', (f.x0 + f.x1) / 2, f.bottom + 98, 9);
  s.vdim(f.x0 - 40, f.top, f.bottom, '104" [8\'-8"]', f.x0);
  const w = font.widthOfTextAtSize('ROUGH OPENING', 9);
  s.text('ROUGH OPENING', f.x0 - 30, (f.top + f.bottom) / 2 + w / 2, 9, 90);
  return doc.save();
}

// One sheet marked up the way Bluebeam or Acrobat saves it: text boxes, a callout, a sticky note,
// a length and an area measurement, a box with a note and a freehand circle. One more markup was
// flattened into the sheet, so it's plain text now, next to notes that only look like sizes.
export async function markedUpSheet() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const s = sheet(doc, font);
  s.sheetNo('A-201');
  s.rect(200, 300, 800, 480);
  s.text('SF-2 36 x 84 (3)', 300, 900, 12);
  s.text('PROVIDE 2 x 4 BLOCKING', 300, 940, 9);
  s.text('(5) 3/4" x 6" BOLTS', 300, 960, 9);
  const ctx = doc.context;
  const str = (v) => PDFString.of(v);
  const annots = [
    { Subtype: 'FreeText', Rect: [780, 690, 1010, 720], Contents: str('A1 = 54 x 104 (7)'), DA: str('/Helv 14 Tf 1 0 0 rg'), T: str('Wes'), C: [1, 0, 0] },
    { Subtype: 'FreeText', IT: 'FreeTextCallout', Rect: [1180, 700, 1420, 740], CL: [1290, 665, 1260, 700, 1300, 700], Contents: str('C - 96x80 qty 15'), DA: str('/Helv 14 Tf 1 0 0 rg'), T: str('Wes'), C: [1, 0, 0] },
    { Subtype: 'Text', Rect: [1500, 700, 1520, 720], Contents: str('Verify B at east elevation, 72 x 80 (4)'), T: str('GC'), Name: 'Comment', C: [1, 1, 0] },
    { Subtype: 'Line', IT: 'LineDimension', Rect: [255, 540, 445, 580], L: [262, 560, 442, 560], Contents: str('20\'-0"'), T: str('Wes'), C: [0, 0, 1] },
    { Subtype: 'Polygon', IT: 'PolygonDimension', Rect: [820, 580, 880, 680], Vertices: [822, 582, 878, 582, 878, 678, 822, 678], Contents: str('37.3 sf'), T: str('Wes'), C: [0, 0.6, 0] },
    { Subtype: 'Square', Rect: [1060, 560, 1170, 700], Contents: str('D 48x48 (18) - see A-203'), T: str('Wes'), C: [1, 0, 0] },
    { Subtype: 'Ink', Rect: [1610, 620, 1700, 700], InkList: [[1620, 660, 1640, 690, 1670, 695, 1695, 670, 1690, 635, 1660, 625, 1630, 635, 1620, 660]], T: str('Wes'), C: [1, 0, 0] },
  ].map((a) => ctx.register(ctx.obj({ Type: 'Annot', ...a })));
  s.page.node.set(PDFName.of('Annots'), ctx.obj(annots));
  return doc.save();
}
