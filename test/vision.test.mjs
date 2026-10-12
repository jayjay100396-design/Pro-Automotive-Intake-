import assert from 'node:assert/strict';
import { planTiles, captions, toPage, pageTags, openingsFrom, sizeIn } from '../public/js/takeoff/vision.js';

describe('takeoff: reading with Gemini', () => {
  it('cuts a big sheet into overlapping close-ups that cover it', () => {
    const small = planTiles(1200, 900);
    assert.deepEqual([small.cols, small.rows, small.tiles.length], [1, 1, 1]);
    assert.deepEqual(small.tiles[0], { x: 0, y: 0, w: 1200, h: 900, row: 0, col: 0 });
    const big = planTiles(6300, 4500, { max: 1536, overlap: 160 });
    assert.deepEqual([big.cols, big.rows, big.tiles.length], [5, 4, 20]);
    for (const t of big.tiles) {
      assert.ok(t.w <= 1536 && t.h <= 1536);
      assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= 6300 && t.y + t.h <= 4500);
    }
    const last = big.tiles.at(-1);
    assert.deepEqual([last.x + last.w, last.y + last.h], [6300, 4500]);
    // Neighbours overlap by at least the asked amount.
    assert.ok(big.tiles[0].x + big.tiles[0].w - big.tiles[1].x >= 160);
    assert.ok(big.tiles[0].y + big.tiles[0].h - big.tiles[5].y >= 160);
    assert.equal(captions(small).length, 1);
    const caps = captions(big);
    assert.equal(caps.length, 21);
    assert.match(caps[1], /row 1 of 4, column 1 of 5 \(top left/);
    assert.match(caps[20], /row 4 of 4, column 5 of 5 \(bottom right/);
  });

  it('puts a box seen in a close-up back on the page', () => {
    const plan = planTiles(3000, 2000, { max: 1000, overlap: 0 });
    assert.deepEqual([plan.cols, plan.rows], [3, 2]);
    const whole = toPage({ image: 1, box: [500, 500, 600, 600] }, plan, 3000, 2000);
    assert.deepEqual(whole.box, [1500, 1000, 1800, 1200]);
    assert.equal(whole.closeUp, false);
    // Image 6 is close-up 5: row 2, column 2 (x 1000, y 1000).
    const tile = toPage({ image: 6, box: [100, 200, 300, 400] }, plan, 3000, 2000);
    assert.deepEqual(tile.box, [1200, 1100, 1400, 1300]);
    assert.equal(tile.closeUp, true);
    assert.equal(Math.round(tile.inside * 100), 10);
    assert.equal(toPage({ image: 99, box: [0, 0, 10, 10] }, plan, 3000, 2000), null);
    assert.equal(toPage({ image: 1, box: [0, 0, 10] }, plan, 3000, 2000), null);
  });

  it('counts a tag once even when two close-ups both show it', () => {
    const plan = planTiles(3000, 2000, { max: 1600, overlap: 200 });
    assert.deepEqual([plan.cols, plan.rows], [2, 2]);
    const [t0, t1] = plan.tiles; // top left and top right overlap between x 1400 and 1600
    const at = (tile, x, y, s = 40) => [Math.round(((y - tile.y) / tile.h) * 1000), Math.round(((x - tile.x) / tile.w) * 1000), Math.round(((y - tile.y + s) / tile.h) * 1000), Math.round(((x - tile.x + s) / tile.w) * 1000)];
    const answer = { tags: [
      { label: 'A1', image: 1, box: [0, 0, 0, 0] }, // nothing: no size
      { label: 'A1', image: 1, box: at({ x: 0, y: 0, w: 3000, h: 2000 }, 1500, 300) }, // the whole page sees it too
      { label: 'a1', image: 2, box: at(t0, 1500, 300) },
      { label: 'A1', image: 3, box: at(t1, 1502, 298) },
      { label: 'B', image: 2, box: at(t0, 200, 200) },
      { label: 'B', image: 2, box: at(t0, 900, 200) },
      { label: '', image: 2, box: at(t0, 400, 400) },
    ] };
    const tags = pageTags(answer, plan, 3000, 2000);
    const near = (v) => Math.round(v / 10) * 10; // boxes are scaled 0-1000, so a few pixels move
    assert.deepEqual(tags.map((t) => [t.label, near(t.x), near(t.y)]).sort(), [['A1', 1520, 320], ['B', 220, 220], ['B', 920, 220]]);
  });

  it('turns tags, type sizes and written items into openings', () => {
    const page1 = { answer: { types: [{ label: 'A', width: `4'-6"`, height: `8'-8"` }, { label: 'E', width: '36', height: '84' }], items: [], notes: ['Field verify'] }, tags: [] };
    const page2 = { answer: { types: [], items: [{ label: 'B', qty: 1, width: '72', height: '80' }, { label: 'Opening 1', qty: 2, width: '95 3/4', height: '83 1/2', note: 'east wall' }], notes: ['Field verify', ' '] },
      tags: [{ label: 'A' }, { label: 'A' }, { label: 'B' }, { label: 'C' }] };
    const { openings, notes } = openingsFrom([page1, page2]);
    assert.deepEqual(openings.map((o) => [o.label, o.qty, o.widthIn, o.heightIn]), [
      ['A', 2, 54, 104], ['B', 1, 72, 80], ['C', 1, null, null], ['E', 0, 36, 84], ['Opening 1', 2, 95.75, 83.5],
    ]);
    assert.equal(openings[0].how, 'Gemini: counted the tags, size from the drawings');
    assert.equal(openings[2].how, 'Gemini: counted the tags');
    assert.equal(openings[4].how, 'Gemini: written, east wall');
    assert.deepEqual(notes, ['Field verify']);
    // An item with a type's label picks up the type's size.
    const r = openingsFrom([{ answer: { types: [{ label: 'SF-1', width: '120', height: '96' }], items: [{ label: 'SF-1', qty: 3 }] }, tags: [] }]);
    assert.deepEqual(r.openings.map((o) => [o.label, o.qty, o.widthIn, o.heightIn]), [['SF-1', 3, 120, 96]]);
    assert.equal(sizeIn(`8'-0"`), 96);
    assert.equal(sizeIn(54), 54);
    assert.equal(sizeIn('n/a'), null);
  });

  it('counts the window tags, not the door tags or keynotes, and keeps the other families', () => {
    const tag = (label, shape, where = 'elevation') => ({ label, shape, where });
    const elevation = { answer: { kind: 'exterior elevations', types: [{ label: 'C', shape: 'diamond', width: `8'-0"`, height: `7'-0"` }], items: [], notes: [] },
      tags: [tag('D', 'diamond'), tag('D', 'diamond'), tag('C', 'diamond'), tag('D', 'circle'), tag('B', 'circle'), tag('B', 'circle'), tag('12', 'hexagon'), tag('1', 'hexagon')] };
    const typeSheet = { answer: { kind: 'schedules, door and window elevations', types: [
      { label: 'C', shape: 'diamond', width: `8'-0"`, height: `6'-8"` }, { label: 'D', shape: 'diamond', width: `4'-0"`, height: `4'-0"` },
      { label: 'B', shape: 'circle', width: `3'-0"`, height: `7'-0"` }, { label: 'D', shape: 'circle', width: `10'-0"`, height: `10'-0"` }, { label: 'E', shape: 'circle', width: `12'-0"`, height: `14'-0"` },
    ], items: [], notes: [] }, tags: [tag('C', 'diamond', 'type-elevation'), tag('D', 'diamond', 'type-elevation'), tag('B', 'circle', 'type-elevation')] };
    const { openings, families, main } = openingsFrom([elevation, typeSheet]);
    assert.deepEqual(families.map((f) => [f.shape, f.total]), [['diamond', 3], ['circle', 3]]);
    assert.equal(main.shape, 'diamond');
    // C's size comes from the type sheet, not the elevation; the door types (circles) stay out.
    assert.deepEqual(openings.map((o) => [o.label, o.qty, o.widthIn, o.heightIn]), [['C', 1, 96, 80], ['D', 2, 48, 48]]);
    assert.equal(openings[0].how, 'Gemini: counted the diamond tags, size from the drawings');
    // With no tags at all, every type is listed uncounted and the written items stand on their own.
    const r = openingsFrom([{ answer: { types: [{ label: 'D', width: '48', height: '48' }], items: [{ label: 'Opening 2', qty: 1, width: '47 1/4', height: '83 1/2' }], notes: [] }, tags: [] }]);
    assert.equal(r.main, null);
    assert.deepEqual(r.openings.map((o) => [o.label, o.qty]), [['D', 0], ['Opening 2', 1]]);
  });
});
