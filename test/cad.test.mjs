import assert from 'node:assert/strict';
import {
  detectCadKind,
  cleanCadText,
  parseDxf,
  cadToPageModel,
  applyCadLayerFilter,
} from '../public/js/takeoff/cad.js';
import { analyze, estimateLines, partsFromTakeoff } from '../public/js/takeoff/takeoff.js';
import { measure, measureRect, measurePolyline } from '../public/js/takeoff/measure.js';
import { commercialGlassSize, storefrontBayBreakdown, openingLinearFeet } from '../public/js/calc.js';
import { build3DSceneSpec } from '../public/js/takeoff/viewer3d.js';

// Builds a valid ASCII DXF string from section bodies.
function makeDxf({ header = '', tables = '', blocks = '', entities = '' } = {}) {
  return [
    '0\nSECTION\n2\nHEADER',
    header.trim(),
    '0\nENDSEC',
    '0\nSECTION\n2\nTABLES',
    tables.trim(),
    '0\nENDSEC',
    '0\nSECTION\n2\nBLOCKS',
    blocks.trim(),
    '0\nENDSEC',
    '0\nSECTION\n2\nENTITIES',
    entities.trim(),
    '0\nENDSEC\n0\nEOF',
  ].filter(Boolean).join('\n');
}

describe('Phase 1: CAD (.DXF / .DWG) reader (cad.js)', () => {
  it('detects DXF and DWG files by MIME type, extension, or magic bytes', () => {
    assert.equal(detectCadKind('image/vnd.dxf', 'plan.pdf'), 'dxf');
    assert.equal(detectCadKind('application/octet-stream', 'Storefront-Elev.DXF'), 'dxf');
    assert.equal(detectCadKind('image/vnd.dwg', 'drawing'), 'dwg');
    assert.equal(detectCadKind('', 'A201-Elevations.dwg'), 'dwg');

    const dwgBytes = new TextEncoder().encode('AC1032\x00\x00\x00\x00');
    assert.equal(detectCadKind('', 'unknown.bin', dwgBytes), 'dwg');

    const dxfBytes = new TextEncoder().encode('  0\nSECTION\n  2\nHEADER\n');
    assert.equal(detectCadKind('', 'unknown.bin', dxfBytes), 'dxf');
  });

  it('cleans AutoCAD TEXT and MTEXT formatting codes and stacked fractions', () => {
    assert.equal(cleanCadText('{\\fArial|b0|i0;10\'-6 \\S1/2;"}'), '10\'-6 1/2"');
    assert.equal(cleanCadText('\\A1;35\\S7#8;" x 83\\S3/4;"'), '35 7/8" x 83 3/4"');
    assert.equal(cleanCadText('%%c1/2" HOLE\\PTEMPERED'), '⌀1/2" HOLE\nTEMPERED');
  });

  it('parses DXF header units, layers, blocks, polylines, dimensions, and true 1:1 scale', () => {
    const dxf = makeDxf({
      header: [
        '9\n$INSUNITS\n70\n1', // 1 = Inches
      ].join('\n'),
      tables: [
        '0\nTABLE\n2\nLAYER',
        '0\nLAYER\n2\nA-GLAZ\n62\n4\n70\n0',
        '0\nLAYER\n2\nA-DIMS\n62\n1\n70\n0',
        '0\nLAYER\n2\nA-GRID-HIDE\n62\n-8\n70\n0', // negative color = layer OFF
        '0\nENDTAB',
      ].join('\n'),
      blocks: [
        '0\nBLOCK\n2\nWIN_TAG_A1\n10\n0\n20\n0',
        // Diamond outline around (0, 0) with radius 12
        '0\nLWPOLYLINE\n8\n0\n70\n1\n10\n0\n20\n12\n10\n12\n20\n0\n10\n0\n20\n-12\n10\n-12\n20\n0',
        '0\nTEXT\n8\n0\n10\n0\n20\n0\n11\n0\n21\n0\n40\n5\n72\n1\n73\n2\n1\nA1',
        '0\nENDBLK',
      ].join('\n'),
      entities: [
        // Storefront frame 120" wide x 96" tall on A-GLAZ layer: from (0, 0) to (120, 96)
        '0\nLWPOLYLINE\n8\nA-GLAZ\n70\n1\n10\n0\n20\n0\n10\n120\n20\n0\n10\n120\n20\n96\n10\n0\n20\n96',
        // Center vertical mullion at x = 60
        '0\nLINE\n8\nA-GLAZ\n10\n60\n20\n0\n11\n60\n21\n96',
        // Horizontal transom at y = 72
        '0\nLINE\n8\nA-GLAZ\n10\n0\n20\n72\n11\n120\n21\n72',
        // Dimension across top of frame (10'-0" = 120")
        '0\nDIMENSION\n8\nA-DIMS\n10\n120\n20\n108\n11\n60\n21\n108\n13\n0\n23\n96\n14\n120\n24\n96\n42\n120\n1\n10\'-0"',
        // Tag block INSERT below the frame
        '0\nINSERT\n8\nA-GLAZ\n2\nWIN_TAG_A1\n10\n60\n20\n-20\n41\n1\n42\n1\n50\n0',
        // Size callout next to tag
        '0\nMTEXT\n8\nA-DIMS\n10\n60\n20\n-38\n40\n4\n71\n5\n1\n10\'-0" x 8\'-0"',
        // Line on a default-off layer
        '0\nLINE\n8\nA-GRID-HIDE\n10\n-50\n20\n-50\n11\n200\n21\n200',
      ].join('\n'),
    });

    const cadDoc = parseDxf(dxf);
    assert.equal(cadDoc.header.insunits, 1);
    assert.equal(cadDoc.layers.get('A-GLAZ').off, false);
    assert.equal(cadDoc.layers.get('A-GRID-HIDE').off, true);

    const model = cadToPageModel(cadDoc);
    assert.equal(model.cad.isCad, true);
    assert.equal(model.cad.unitLabel, 'Inches');
    assert.ok(model.cad.ppi > 0);

    // Off layer should be filtered out by default
    assert.ok(model.cad.hiddenLayers.has('A-GRID-HIDE'));
    assert.ok(!model.segs.some((s) => s.layer === 'A-GRID-HIDE'));

    // Measure the storefront bottom sill line in display space using model.cad.ppi: must equal 120 inches (10'-0")
    const sillSeg = model.segs.find((s) => Math.abs(s.y1 - s.y2) < 0.01 && Math.abs(Math.abs(s.x2 - s.x1) - 120 * model.cad.ppi) < 0.5);
    assert.ok(sillSeg, 'expected 120" storefront sill segment');
    const measured = measure([sillSeg.x1, sillSeg.y1], [sillSeg.x2, sillSeg.y2], model.cad.ppi);
    assert.equal(measured.inches, 120);

    // Toggling off A-DIMS layer removes dimension text and segments
    const beforeTextCount = model.text.length;
    applyCadLayerFilter(model, new Set(['A-GRID-HIDE', 'A-DIMS']));
    assert.ok(model.text.length < beforeTextCount);

    // Restoring A-DIMS layer brings them back and allows takeoff.js analyze() to extract tag A1
    applyCadLayerFilter(model, new Set(['A-GRID-HIDE']));
    const tk = analyze([model]);
    assert.ok(tk.families.length >= 1, 'expected diamond tag family from INSERT block');
    assert.ok(tk.families[0].labels.includes('A1'));
  });
});

describe('Phase 2: Commercial Glazing Deductions, Box/Polyline Measure & Supplier Parts Export', () => {
  it('computes Rough Opening -> Frame Size -> DLO -> Glass Cut Size for 1-3/4" x 4-1/2" Storefront (CG451)', () => {
    // 10'-0" (120") x 8'-0" (96") Rough Opening, 2 equal bays, 1-3/4" CG451 storefront:
    // Frame W = 120 - 0.5 = 119.5"
    // Frame H = 96 - 0.5 = 95.5"
    // 2 bays -> 2 jambs (1.75" each) + 1 center mullion (1.75") = 5.25" total aluminum width
    // Bay DLO W = (119.5 - 5.25) / 2 = 57.125" (57 1/8")
    // Glass Cut W = 57.125 + 2 * 0.375 = 57.875" (57 7/8")
    // Main DLO H = 95.5 - 1.75 (head) - 1.75 (sill) = 92"
    // Glass Cut H = 92 + 0.75 = 92.75" (92 3/4")
    const res = commercialGlassSize(120, 96, { system: 'sf175', bays: 2 });
    assert.equal(res.frameWidthIn, 119.5);
    assert.equal(res.frameHeightIn, 95.5);
    assert.equal(res.bayDloWidthIn, 57.125);
    assert.equal(res.glassCutWidthIn, 57.875);
    assert.equal(res.mainDloHeightIn, 92);
    assert.equal(res.glassCutHeightIn, 92.75);
    assert.equal(res.litesPerOpening, 2);
  });

  it('computes transom lites, stock lengths (24\' S/L), and sealant tubes across multiple openings', () => {
    const rows = [
      { label: 'A1', qty: 3, widthIn: 120, heightIn: 108, bays: 3, transomHeightIn: 84, system: 'sf175' },
    ];
    const bd = storefrontBayBreakdown(rows[0]);
    assert.equal(bd.hasTransom, true);
    assert.equal(bd.lites.length, 2); // main bay lites + transom lites
    assert.equal(bd.totalLites, 3 * 3 * 2); // 3 openings * 3 bays * 2 (main + transom) = 18 lites

    const totals = openingLinearFeet(rows);
    assert.equal(totals.totalLites, 18);
    assert.equal(totals.stockLengths24Ft, 9);
    assert.ok(totals.sealantTubes >= 5);

    const glassOrder = partsFromTakeoff(rows, { system: 'sf175', listType: 'glass' });
    assert.equal(glassOrder.length, 2);
    assert.equal(glassOrder[0].mark, 'A1-L');
    assert.equal(glassOrder[1].mark, 'A1-T');

    const partsOrder = partsFromTakeoff(rows, { system: 'sf175', listType: 'parts' });
    assert.ok(partsOrder.some((it) => it.partNo === 'CG451-1' && it.unit === 'S/L'));
    assert.ok(partsOrder.some((it) => it.partNo === 'RG-1'));

    const propLines = estimateLines(rows, { system: 'sf175', useCutSize: true });
    assert.ok(propLines.some((l) => l.kind === 'Glass' && l.widthIn === bd.glassCutWidthIn));
    assert.ok(propLines.some((l) => l.kind === 'Framing' && l.unit === 'lf'));
    assert.ok(propLines.some((l) => l.kind === 'Materials' && l.unit === 'lf' && l.price === 3.5));
  });

  it('measures 2-click rectangles (Box W×H) and multi-point polylines (Perimeter LF)', () => {
    const rect = measureRect([10, 20], [130, 116], 2); // 2 units per inch -> 60" x 48"
    assert.equal(rect.widthIn, 60);
    assert.equal(rect.heightIn, 48);
    assert.equal(rect.areaSqft, 20);
    assert.equal(rect.perimeterLf, 18);

    const poly = measurePolyline([[0, 0], [120, 0], [120, 96]], 2); // 60" + 48" = 108" = 9 LF
    assert.equal(poly.totalInches, 108);
    assert.equal(poly.linearFeet, 9);
    assert.equal(poly.segments.length, 2);
  });
});

describe('Phase 3: 3D Storefront & Elevation Scene Builder (viewer3d.js)', () => {
  it('builds 3D aluminum extrusion members and glass lites for storefront openings', () => {
    const spec = build3DSceneSpec([
      { label: 'A1', qty: 2, widthIn: 120, heightIn: 96, bays: 3 },
      { label: 'A2', qty: 1, widthIn: 72, heightIn: 108, bays: 2, transomHeightIn: 84 },
    ], { system: 'sf175', finish: 'bronze', glass: 'lowe' });

    assert.equal(spec.assemblies.length, 2);
    // First assembly: 3 bays, no transom -> sill, head, left-jamb, right-jamb + 2 intermediate mullions = 6 members, 3 lites
    assert.equal(spec.assemblies[0].members.length, 6);
    assert.equal(spec.assemblies[0].lites.length, 3);
    // Second assembly: 2 bays + transom -> sill, head, left-jamb, right-jamb + 1 mullion + 1 transom = 6 members, 4 lites
    assert.equal(spec.assemblies[1].members.length, 6);
    assert.equal(spec.assemblies[1].lites.length, 4);
    assert.ok(spec.totalSpanX > 190);
  });
});
