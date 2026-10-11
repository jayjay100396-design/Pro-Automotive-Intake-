import assert from 'node:assert/strict';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseDim, findDims, parseSize, fmtFtIn, fmtIn, parseScale } from '../public/js/takeoff/dims.js';
import { loadPage, findViews, findTags, gridRows, sheetInfo } from '../public/js/takeoff/reader.js';
import { analyze, scopeLine, estimateLines, scaleFromDims } from '../public/js/takeoff/takeoff.js';
import { parseOpeningText, readMarkups, markupOpenings, withMarkups } from '../public/js/takeoff/markups.js';
import { ptsPerInchFromScale, calibrate, measure, snap, snapScale, scaleLabel } from '../public/js/takeoff/measure.js';
import { drawingSet, shopDrawing, markedUpSheet } from './fixtures/drawings.mjs';

async function read(bytes) {
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) pages.push(await loadPage(await doc.getPage(n), OPS));
  return pages;
}

describe('takeoff: dimensions', () => {
  it('reads sizes the ways drawings write them', () => {
    assert.equal(parseDim(`8'-0"`), 96);
    assert.equal(parseDim(`8' - 8"`), 104);
    assert.equal(parseDim(`4'-6 1/2"`), 54.5);
    assert.equal(parseDim('103⅝"'), 103.625);
    assert.equal(parseDim('8 ft 6 in'), 102);
    assert.equal(parseDim(`54" [4'-6"]`), 54);
    assert.equal(parseDim('54" V.I.F.'), 54);
    assert.equal(parseDim(`12'`), 144);
    // A bare number is a size only where inches (or feet) are expected.
    assert.equal(parseDim('54'), null);
    assert.equal(parseDim('54', { bare: 'in' }), 54);
    assert.deepEqual(findDims(`A 4'-6" x 8'-8" opening, 36" door`).map((d) => d.inches), [54, 104, 36]);
    assert.deepEqual(parseSize('48 x 96'), { widthIn: 48, heightIn: 96 });
    assert.deepEqual(parseSize(`4'-0" x 8'-0"`), { widthIn: 48, heightIn: 96 });
    assert.equal(parseSize('hello'), null);
  });

  it('writes sizes back out and reads printed scales', () => {
    assert.equal(fmtFtIn(96), `8'-0"`);
    assert.equal(fmtFtIn(103.625), `8'-7 5/8"`);
    assert.equal(fmtIn(103.625), '103 5/8"');
    assert.equal(parseScale(`1/4" = 1'-0"`), 48);
    assert.equal(parseScale(`SCALE: 1/8"=1'-0"`), 96);
    assert.equal(parseScale(`1" = 20'-0"`), 240);
    assert.equal(parseScale('NTS'), null);
  });
});

describe('takeoff: measuring', () => {
  it('turns clicks into real sizes with a printed or calibrated scale', () => {
    const ppi = ptsPerInchFromScale(48); // 1/4" = 1'-0"
    assert.equal(ppi, 1.5);
    assert.deepEqual(measure([100, 50], [244, 52], ppi), { inches: 96, dir: 'across' }); // squared up
    assert.deepEqual(measure([10, 10], [10, 130], ppi), { inches: 80, dir: 'up' });
    assert.equal(measure([0, 0], [30, 40], 1).dir, 'angled');
    assert.equal(measure([0, 0], [1, 1], 0), null);
    // A photo: a 36" door is 300 pixels wide, so a 150 pixel line is 18".
    const perPx = calibrate([0, 0], [300, 0], 36);
    assert.equal(measure([5, 5], [155, 5], perPx).inches, 18);
  });

  it('snaps a click onto where a dimension line meets its witness line', () => {
    const segs = [
      { x1: 0, y1: 10, x2: 100, y2: 10 }, // dimension line
      { x1: 20, y1: 0, x2: 20, y2: 30 }, // witness line
      { x1: 20, y1: 10, x2: 15.5, y2: 14.5 }, { x1: 20, y1: 10, x2: 24.5, y2: 5.5 }, // tick
      { x1: 200, y1: 0, x2: 200, y2: 100 }, // a lone line
      { x1: 40, y1: 40, x2: 60, y2: 40, mask: true }, // white box behind text
    ];
    assert.deepEqual(snap(segs, [22.5, 12], 6), [20, 10]);
    assert.deepEqual(snap(segs, [202, 50], 6), [200, 50]); // onto the line
    assert.deepEqual(snap(segs, [61, 41], 6), [61, 41]); // masks are ignored
  });

  it('names standard scales', () => {
    assert.equal(snapScale(47.6), 48);
    assert.equal(snapScale(50), null);
    assert.equal(scaleLabel(48), `1/4" = 1'-0"`);
    assert.equal(scaleLabel(8), `1 1/2" = 1'-0"`);
    assert.equal(scaleLabel(240), `1" = 20'-0"`);
  });
});

describe('takeoff: reading a drawing set', function () {
  this.timeout(20000);
  let pages;
  let result;
  before(async () => {
    pages = await read(await drawingSet());
    result = analyze(pages);
  });

  it('finds sheets, views, scales and grid lines', () => {
    assert.deepEqual(pages.map((p) => sheetInfo(p).sheet), ['A-601', 'A-201', 'A-202']);
    const views = findViews(pages[1]);
    assert.deepEqual(views.map((v) => [v.face, v.kind, v.scale]), [['NORTH', 'ELEVATION', 96], ['NORTH', 'ELEVATION', 48]]);
    // Both elevations' grid bubbles sit at one height: one row, split by view when counting.
    assert.deepEqual(gridRows(pages[1]).map((r) => r.bubbles.map((b) => b.label).join('')), ['1234123']);
    assert.deepEqual(findTags(pages[0]).map((t) => [t.label, t.shape]), [['A', 'diamond'], ['B', 'diamond'], ['C', 'diamond']]);
  });

  it('reads each type size from the type sheet', () => {
    const { types, typeSheet } = result.main;
    assert.equal(typeSheet, 'A-601');
    assert.deepEqual(Object.fromEntries(Object.entries(types).map(([k, t]) => [k, [t.widthIn, t.heightIn]])), { A: [54, 104], B: [72, 80], C: [96, 80] });
  });

  it('counts each opening once, even when an enlarged elevation shows it again', () => {
    assert.equal(result.main.shape, 'diamond');
    assert.equal(result.main.basis, 'elevations');
    assert.equal(result.main.duplicates, 3);
    assert.deepEqual(result.openings.map((o) => [o.label, o.qty, o.widthIn, o.heightIn]), [['A', 3, 54, 104], ['B', 1, 72, 80], ['C', 3, 96, 80]]);
    assert.deepEqual(result.openings[0].places.map((p) => [p.sheet, p.grid]), [['A-201', 1.5], ['A-201', 3.5], ['A-202', 1.5]]);
  });

  it('works out a sheet\'s scale from its dimensions when none is printed', () => {
    assert.deepEqual(scaleFromDims(pages[0], [770, 420]), { ppi: 1.5, count: 5, realPerPaper: 48 });
    assert.equal(scaleFromDims(pages[1], [400, 300]), null); // no dimensions there
  });

  it('turns the openings into a scope line and proposal lines', () => {
    assert.equal(scopeLine(result.openings), '(3) A; (1) B; (3) C');
    const lines = estimateLines(result.openings);
    // Framing: 3 x 2(54 + 104) + 2(72 + 80) + 3 x 2(96 + 80) = 2308" = 192.3 ft, rounded up.
    assert.deepEqual(lines.map((l) => [l.kind, l.unit, l.qty]), [['Glass', 'sqft', 3], ['Glass', 'sqft', 1], ['Glass', 'sqft', 3], ['Framing', 'lf', 193]]);
    assert.equal(lines[0].desc, `Type A storefront 4'-6" x 8'-8"`);
    // Unsized openings are counted, priced each, and left out of the framing.
    assert.deepEqual(estimateLines([{ label: 'X', qty: 2 }]).map((l) => [l.unit, l.qty]), [['each', 2]]);
  });
});

describe('takeoff: shop drawings and markups', function () {
  this.timeout(20000);

  it('reads mark and quantity boxes with the rough opening sizes', async () => {
    const result = analyze(await read(await shopDrawing()));
    assert.equal(result.source, 'mark and quantity boxes');
    assert.deepEqual(result.openings.map((o) => [o.label, o.qty, o.widthIn, o.heightIn, o.how]), [['SF-1', 4, 54, 104, 'rough opening written on the drawing']]);
  });

  it('reads sizes and counts people write in markups', async () => {
    const pages = await read(await markedUpSheet());
    const marks = readMarkups(pages, ['A1', 'B', 'C', 'D']);
    assert.deepEqual(marks.map((k) => k.subtype), ['FreeText', 'FreeText', 'Text', 'Line', 'Polygon', 'Square', 'Ink', 'Written']);
    assert.equal(marks[3].lengthIn, 240);
    assert.equal(marks[4].areaSqft, 37.3);
    assert.deepEqual(markupOpenings(marks).map((o) => [o.label, o.qty, o.widthIn, o.heightIn]),
      [['A1', 7, 54, 104], ['C', 15, 96, 80], ['B', 4, 72, 80], ['D', 18, 48, 48], ['SF-2', 3, 36, 84]]);
    // Tags counted on an elevation with no type sheet get their sizes from the markups.
    const counted = [{ label: 'A1', qty: 5, widthIn: null, heightIn: null }, { label: 'E', qty: 2, widthIn: null, heightIn: null }];
    assert.deepEqual(withMarkups(counted, marks).map((o) => [o.label, o.qty, o.widthIn, o.heightIn]), [['A1', 5, 54, 104], ['E', 2, null, null]]);
    assert.equal(withMarkups([], marks).length, 5);
  });

  it('parses the usual ways of writing an opening', () => {
    assert.deepEqual(parseOpeningText('Type C: 8\'-0" x 6\'-8" qty 15'), { widthIn: 96, heightIn: 80, qty: 15, label: 'C' });
    assert.deepEqual(parseOpeningText('(2) SF-3 36 x 84'), { widthIn: 36, heightIn: 84, qty: 2, label: 'SF-3' });
    assert.deepEqual(parseOpeningText('48 x 96 @ 6'), { widthIn: 48, heightIn: 96, qty: 6 });
    assert.deepEqual(parseOpeningText('12\'-6"'), { lengthIn: 150 });
    assert.deepEqual(parseOpeningText('1/4" x 3/4" S.S.'), { widthIn: 0.25, heightIn: 0.75 });
    assert.deepEqual(parseOpeningText('see note'), {});
  });
});
