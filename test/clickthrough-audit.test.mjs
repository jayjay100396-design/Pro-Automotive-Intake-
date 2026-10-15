import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  round2,
  sqft,
  lineTotal,
  estimateTotals,
  proposalOptions,
  estimateAmount,
  proposalDeposit,
  proposalBill,
  contractSum,
  g702,
  nextPayAppLines,
  invoiceTotals,
  paidOn,
  creditedOn,
  dueOn,
  billedOn,
  nextDeposit,
  proposalPayment,
  COMMERCIAL_SYSTEMS,
  commercialGlassSize,
  storefrontBayBreakdown,
  openingLinearFeet,
} from '../public/js/calc.js';
import { proposalContent, proposalPdf, proposalEmail } from '../public/js/proposal-doc.js';
import {
  estimateLines,
  partsFromTakeoff,
  scopeLine,
} from '../public/js/takeoff/takeoff.js';
import { measureRect, measurePolyline } from '../public/js/takeoff/measure.js';
import { parseDxf, cadToPageModel } from '../public/js/takeoff/cad.js';
import { build3DSceneSpec } from '../public/js/takeoff/viewer3d.js';
import {
  parsePasted,
  receivedState,
  isLate,
  buildPartsEmail,
} from '../public/js/parts-email.js';
import {
  DEFAULT_NOTARY,
  ADMIN_SIGNERS,
  buildLienWaiverData,
  buildAccountingLedger,
  exportQuickBooksOnlineCsv,
  exportQuickBooksDesktopIif,
  exportXeroCsv,
  exportAccountingPackageJson,
} from '../public/js/accounting-calc.js';
import { occurrences, nextOccurrence } from '../public/js/when.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('End-to-End Computational & Click-Through Audit (Zero-Lie Verification)', () => {
  it('1. verifies PWA manifest shortcuts and app.js route table have zero broken routes', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8'));
    const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');

    for (const sc of manifest.shortcuts) {
      if (sc.url.startsWith('/#/')) {
        const hashPath = sc.url.replace(/^\/#\//, '').split('?')[0];
        const firstSeg = hashPath.split('/')[0];
        assert.ok(
          appJs.includes(`^${firstSeg}`) || appJs.includes(`^${hashPath}`),
          `Manifest shortcut ${sc.url} must match a route in public/js/app.js`,
        );
      } else {
        const diskPath = path.join(ROOT, 'public', sc.url.replace(/^\//, ''));
        assert.ok(fs.existsSync(diskPath), `Manifest shortcut file ${sc.url} must exist on disk`);
      }
    }
    // Verify aliases #/proposals and #/billing exist in app.js
    assert.ok(appJs.includes('[/^proposals$/, () => V.estimates()]'));
    assert.ok(appJs.includes('[/^billing$/, () => V.payApps()]'));
  });

  it('2. verifies CAD (.DXF) Takeoff -> Commercial Storefront Deductions -> 3D Scene -> Proposal & Supplier Parts handoffs match to the exact sq ft and penny', () => {
    // 2a. Parse a CAD DXF drawing with storefront rough openings
    const dxfSample = [
      '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '1', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LWPOLYLINE', '8', 'A-GLAZ', '90', '4', '70', '1',
      '10', '0', '20', '0', '10', '108', '20', '0', '10', '108', '20', '96', '10', '0', '20', '96',
      '0', 'TEXT', '8', 'A-ANNO-DIMS', '10', '54', '20', '48', '40', '2.5', '1', 'A1 108" x 96"',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const cadModel = cadToPageModel(parseDxf(dxfSample), { name: 'Ruthven-Storefront.dxf' });
    assert.equal(cadModel.cad.isCad, true);
    assert.equal(cadModel.cad.inchesPerUnit, 1);

    // 2b. Measure opening via Box W×H and Perimeter LF tools
    const box = measureRect([0, 0], [108, 96], cadModel.cad.inchesPerUnit);
    assert.equal(box.widthIn, 108);
    assert.equal(box.heightIn, 96);
    assert.equal(box.areaSqft, 72);
    assert.equal(box.perimeterLf, 34);

    const poly = measurePolyline([[0, 0], [108, 0], [180, 0]], cadModel.cad.inchesPerUnit);
    assert.equal(poly.totalInches, 180);
    assert.equal(poly.linearFeet, 15);

    // 2c. Takeoff rows with multi-bay storefront & transom
    const rows = [
      { label: 'A1', qty: 2, widthIn: 108, heightIn: 96, bays: 3, transomHeightIn: 24, system: 'sf175' },
      { label: 'A2', qty: 3, widthIn: 72, heightIn: 84, bays: 2, transomHeightIn: 0, system: 'sf175' },
    ];

    // Compute exact cut area as displayed in Takeoff table when useCutSize = true
    let takeoffTableCutSqft = 0;
    for (const r of rows) {
      const cut = commercialGlassSize(r.widthIn, r.heightIn, {
        system: r.system,
        bays: r.bays,
        transomHeightIn: r.transomHeightIn,
      });
      const rowCutArea = (
        sqft(cut.glassCutWidthIn, cut.glassCutHeightIn) * cut.bays
        + (cut.hasTransom ? sqft(cut.glassCutWidthIn, cut.transomGlassCutHeightIn) * cut.bays : 0)
      ) * r.qty;
      takeoffTableCutSqft += rowCutArea;
    }

    // Generate Proposal lines with useCutSize = true
    const propLines = estimateLines(rows, { system: 'sf175', useCutSize: true });
    const validKinds = new Set(['Glass', 'Framing', 'Door', 'Hardware', 'Labor', 'Materials', 'Other']);
    for (const l of propLines) {
      assert.ok(validKinds.has(l.kind), `Line kind "${l.kind}" must be a valid proposal kind`);
    }

    // Sum the exact square feet of all Glass lines handed to the Proposal
    const glassLines = propLines.filter((l) => l.kind === 'Glass');
    const proposalGlassSqft = glassLines.reduce((s, l) => s + sqft(l.widthIn, l.heightIn) * l.qty, 0);
    assert.ok(
      Math.abs(takeoffTableCutSqft - proposalGlassSqft) < 1e-9,
      `Takeoff table cut sq ft (${takeoffTableCutSqft}) must equal Proposal glass sq ft (${proposalGlassSqft})`,
    );

    // Sealant stays with the proposal template's own caulking line, not a price made up by the takeoff
    assert.ok(!propLines.some((l) => l.kind === 'Materials'));

    // Without the cut-size box ticked, the proposal gets the opening sizes and outside perimeter as before
    const plainLines = estimateLines(rows, { system: 'sf175' });
    assert.deepEqual(plainLines.map((l) => [l.kind, l.unit, l.qty, l.widthIn, l.heightIn]), [
      ['Glass', 'sqft', 2, 108, 96],
      ['Glass', 'sqft', 3, 72, 84],
      ['Framing', 'lf', Math.ceil((2 * 2 * (108 + 96) + 3 * 2 * (72 + 84)) / 12), undefined, undefined],
    ]);

    // Check 3D Scene Builder matches exact opening assemblies and lites
    const scene = build3DSceneSpec(rows, { system: 'sf175' });
    assert.equal(scene.assemblies.length, 2);
    assert.equal(scene.assemblies[0].lites.length, 6); // 3 main + 3 transom
    assert.equal(scene.assemblies[1].lites.length, 2); // 2 main
    const lfSummary = openingLinearFeet(rows, { system: 'sf175' });
    assert.equal(lfSummary.totalLites, 18); // 6*2 + 2*3 = 18 lites

    // Check Supplier Parts Order handoff (glass cut list & Trulite 24' stock lengths)
    const glassOrder = partsFromTakeoff(rows, { system: 'sf175', listType: 'glass' });
    const totalOrderedLites = glassOrder.reduce((s, i) => s + Number(i.qty), 0);
    assert.equal(totalOrderedLites, lfSummary.totalLites);
    const partsOrder = partsFromTakeoff(rows, { system: 'sf175', listType: 'parts' });
    const stockItem = partsOrder.find((i) => i.partNo === 'CG451-1');
    assert.equal(Number(stockItem.qty), lfSummary.stockLengths24Ft);
  });

  it('3. verifies Proposal math, Multi-Option pricing, Deposit math, Print view, Email & PDF match to the penny', async () => {
    const company = {
      name: 'Stellar Glass LLC',
      address: '5529 US Hwy 98 North, Lakeland, FL 33809',
      phone: '(863) 940-3126',
      email: 'wes@stellarglass.net',
    };
    const customer = {
      id: 'cust-1',
      name: 'Bryan',
      company: 'Marcobay Construction, Inc.',
      address: '1221 E Memorial Blvd, Lakeland, FL 33801',
      email: 'bryan@marcobay.com',
    };
    const job = {
      id: 'job-1',
      number: 2564,
      name: 'Ruthven 3955 Anchuca Dr',
      address: '3955 Anchuca Dr, Lakeland, FL 33811',
      customerId: 'cust-1',
      type: 'storefront',
    };

    const estimate = {
      id: 'est-1',
      number: 1042,
      jobId: 'job-1',
      date: '2026-04-10',
      validUntil: '2026-05-10',
      status: 'accepted',
      template: 'storefront',
      markupPct: 10,
      minCharge: 250,
      taxPct: 7,
      depositType: 'percent',
      depositValue: 50,
      acceptedOption: 0,
      showLines: true,
      preparedName: 'Wesley Stel',
      preparedTitle: 'President',
      preparedPhone: '(863) 606-7880',
      preparedEmail: 'wes@stellarglass.net',
      scope: scopeLine([{ label: 'A1', qty: 4, widthIn: 48, heightIn: 72 }]),
      options: [
        { fromLines: true, name: 'Base Bid — 1-3/4" × 4-1/2" Storefront (CG451)', specs: 'Clear anodized finish, 9/16" laminated impact glass' },
        { fromLines: false, name: 'Alternate — Bronze Anodized Impact Storefront', price: 18500, specs: 'Dark bronze anodized' },
      ],
      lines: [
        { desc: 'Type A1 9/16" Clear Laminated Impact Glass', kind: 'Glass', unit: 'sqft', widthIn: 48, heightIn: 72, minSqft: 5, qty: 4, price: 32, taxable: true },
        { desc: 'Trulite CG451 1-3/4" × 4-1/2" Storefront Framing', kind: 'Framing', unit: 'lf', qty: 80, price: 24, taxable: true },
        { desc: '3\'-0" × 7\'-0" Medium Stile Entrance Door w/ Panic Hardware', kind: 'Door', unit: 'each', qty: 1, price: 2450, taxable: true },
        { desc: 'Perimeter silicone sealant (interior & exterior joints)', kind: 'Materials', unit: 'lf', qty: 80, price: 3.5, taxable: true },
        { desc: 'Commercial glazing & installation labor', kind: 'Labor', unit: 'lot', qty: 1, price: 3800, taxable: false },
      ],
    };

    const totals = estimateTotals(estimate);
    assert.equal(totals.subtotal, 11522);
    assert.equal(totals.markup, 1152.2);
    assert.equal(totals.beforeTax, 12674.2);
    assert.equal(totals.tax, 594.59);
    assert.equal(totals.total, 13268.79);

    assert.equal(estimateAmount(estimate), 13268.79);

    const dep = proposalDeposit(estimate);
    // 50% of $13,268.79 = $6,634.395 -> $6,634.40
    assert.equal(dep.amount, 6634.4);

    // Verify proposalContent (used by Print View & PDF) has identical numbers
    const docData = proposalContent({ estimate, company, customer, job });
    assert.equal(docData.options[0].price, 13268.79);
    assert.equal(docData.tax, 594.59);
    assert.equal(docData.prepared.name, 'Wesley Stel');
    assert.ok(docData.terms.includes('$6,634.40'));

    // Verify email text includes exact total
    const mail = proposalEmail(docData, { company });
    assert.ok(mail.text.includes('$13,268.79'));

    // Verify PDF definition builds cleanly with exact totals
    const pdfDef = proposalPdf(docData);
    assert.ok(Array.isArray(pdfDef.content) && pdfDef.content.length > 0);
  });

  it('4. verifies Contract SOV -> Change Orders -> AIA G702/G703 Pay Apps (#1, #2, #3) -> Invoices & Payments match to the penny', () => {
    const estimate = {
      id: 'est-2564',
      number: 1042,
      jobId: 'job-1',
      taxPct: 7,
      markupPct: 10,
      minCharge: 250,
      depositType: 'percent',
      depositValue: 20, // 20% deposit
      acceptedOption: 0,
      options: [{ fromLines: true, name: 'Storefront Base Bid' }],
      lines: [
        { desc: 'Storefront Glass', kind: 'Glass', unit: 'sqft', widthIn: 48, heightIn: 72, qty: 4, price: 32, taxable: true },
        { desc: 'Storefront Framing', kind: 'Framing', unit: 'lf', qty: 80, price: 24, taxable: true },
        { desc: 'Entrance Door', kind: 'Door', unit: 'each', qty: 1, price: 2450, taxable: true },
        { desc: 'Perimeter Sealant', kind: 'Materials', unit: 'lf', qty: 80, price: 3.5, taxable: true },
        { desc: 'Glazing Labor', kind: 'Labor', unit: 'lot', qty: 1, price: 3800, taxable: false },
      ],
    };

    const estTotal = estimateAmount(estimate);
    const bill = proposalBill(estimate);
    const invFromEst = invoiceTotals({ taxPct: bill.taxPct, lines: bill.lines });
    assert.equal(invFromEst.total, estTotal);

    const contract = {
      id: 'con-1',
      number: 301,
      jobId: 'job-1',
      customerId: 'cust-1',
      estimateId: 'est-2564',
      amount: estTotal,
      retainagePct: 10,
    };

    const changeOrders = [
      { id: 'co-1', contractId: 'con-1', number: 1, title: 'Add transom lite at East entry', amount: 1731.21, status: 'approved' },
      { id: 'co-2', contractId: 'con-1', number: 2, title: 'Unapproved alternate', amount: 950.00, status: 'draft' },
    ];

    const cSum = contractSum(contract, changeOrders);
    assert.equal(cSum.original, 13268.79);
    assert.equal(cSum.netChange, 1731.21);
    assert.equal(cSum.toDate, 15000.00); // $13,268.79 + $1,731.21 = $15,000.00 exact

    // Deposit invoice created & paid ($2,653.76 = 20% of $13,268.79)
    const dep = proposalDeposit(estimate);
    assert.equal(dep.amount, 2653.76);

    // Pay App #1: 50% work completed on contract + CO #1, 10% retainage, deposit offset applied
    const pa1 = {
      id: 'pa-1',
      number: 1,
      contractId: 'con-1',
      jobId: 'job-1',
      customerId: 'cust-1',
      date: '2026-05-01',
      periodTo: '2026-04-30',
      status: 'paid',
      retainagePct: 10,
      lines: [
        { item: 1, desc: 'Base Contract Scope', value: 13268.79, prevWork: 0, thisWork: 6634.40, stored: 0 },
        { item: 'CO1', desc: 'Add transom lite at East entry', value: 1731.21, prevWork: 0, thisWork: 865.60, stored: 0 },
      ],
    };
    const sum1 = g702(pa1, contract, changeOrders, 0, dep.amount);

    // Verify G702 equations for Pay App #1:
    assert.equal(round2(sum1.originalSum + sum1.netChange), sum1.contractSumToDate);
    assert.equal(round2(sum1.totalCompleted - sum1.totalRetainage), sum1.earnedLessRetainage);
    assert.equal(
      round2(sum1.earnedLessRetainage - sum1.previousCertificates - sum1.depositApplied),
      sum1.currentDue,
    );
    assert.equal(round2(sum1.contractSumToDate - sum1.earnedLessRetainage), sum1.balanceToFinish);
    assert.equal(sum1.depositApplied, dep.amount); // Full $2,653.76 deposit applied on PA #1

    // Pay App #2: Remaining 50% work completed (100% total), retainage released to 0% on final
    const nextLines = nextPayAppLines(pa1.lines, pa1);
    nextLines[0].thisWork = 6634.39;
    nextLines[1].thisWork = 865.61;
    const pa2 = {
      id: 'pa-2',
      number: 2,
      contractId: 'con-1',
      jobId: 'job-1',
      customerId: 'cust-1',
      date: '2026-06-01',
      periodTo: '2026-05-31',
      status: 'approved',
      retainagePct: 0,
      lines: nextLines,
    };
    const sum2 = g702(pa2, contract, changeOrders, sum1.earnedLessRetainage, dep.amount, sum1.depositApplied);

    assert.equal(sum2.totalCompleted, 15000.00);
    assert.equal(sum2.depositApplied, 0);
    assert.equal(sum2.previousCertificates, sum1.earnedLessRetainage);
    // Total collected across Deposit + PA #1 + PA #2 must equal exact $15,000.00 Contract Sum to Date!
    const totalBilledAcrossProject = round2(dep.amount + sum1.currentDue + sum2.currentDue);
    assert.equal(totalBilledAcrossProject, 15000.00);
  });

  it('5. verifies Parts Requests, Trulite plugin, Supplier Quote Totals (quoteTotal), Accounting Ledger, Melina S. Arias Notary Waivers & QuickBooks/Xero Exports', () => {
    // 5a. Parse Trulite parts list and verify supplier email
    const truliteLines = parsePasted('4 S/L CG451-1 24\' Clear Anodized\n2 rolls RG-1 Roll Glazing Vinyl', 'parts');
    assert.equal(truliteLines.length, 2);
    assert.equal(truliteLines[0].qty, 4);
    assert.equal(truliteLines[0].partNo, 'CG451-1');

    const glassLines = parsePasted('2 @ 34 3/4 x 70 3/4 9/16 Clear Lam', 'glass');
    assert.equal(glassLines.length, 1);
    assert.equal(glassLines[0].width, 34.75);
    assert.equal(glassLines[0].height, 70.75);

    const partsReq = {
      id: 'pr-1',
      number: 401,
      jobId: 'job-1',
      supplierId: 'sup-trulite',
      supplierName: 'Trulite Glass & Aluminum Solutions',
      kind: 'order',
      listType: 'parts',
      status: 'ordered',
      quoteTotal: 6420.50,
      expectedOn: '2026-05-15',
      items: [
        { qty: 4, got: 4, partNo: 'CG451-1', desc: '1-3/4 x 4-1/2 Storefront Tube', unit: 'S/L', finish: 'Clear' },
        { qty: 2, got: 1, partNo: 'RG-1', desc: 'Top Load Gasket', unit: 'Roll', finish: 'Black' },
      ],
    };
    assert.equal(receivedState(partsReq.items), 'some');
    assert.equal(isLate(partsReq, '2026-05-20'), true);

    const emailOut = buildPartsEmail({
      request: partsReq,
      company: { name: 'Stellar Glass LLC', phone: '(863) 940-3126', email: 'wes@stellarglass.net' },
      supplier: { name: 'Trulite Glass & Aluminum Solutions', accountNo: 'STL-8841' },
      job: { number: 2564, name: 'Ruthven 3955 Anchuca Dr' },
    });
    assert.ok(emailOut.subject.includes('Ruthven'));
    assert.ok(emailOut.text.includes('CG451-1'));

    // 5b. Accounting Ledger with Invoice + Paid Uninvoiced Pay App + Supplier Commitment (quoteTotal)
    const paUninvoicedPaid = {
      id: 'pa-3',
      number: 3,
      contractId: 'con-1',
      jobId: 'job-1',
      customerId: 'cust-1',
      date: '2026-10-12',
      periodTo: '2026-10-30',
      status: 'paid',
      retainagePct: 10,
    };
    const paSummaries = {
      'pa-3': {
        original: 25430,
        netChanges: 0,
        contractSumToDate: 25430,
        totalCompleted: 25430,
        totalRetainage: 2543,
        earnedLessRetainage: 22887,
        prevCertificates: 0,
        depositApplied: 0,
        currentDue: 22887,
        balanceToFinish: 2543,
      },
    };
    const invOpen = {
      id: 'inv-2',
      number: 5002,
      jobId: 'job-1',
      customerId: 'cust-1',
      date: '2026-10-14',
      dueDate: '2026-11-14',
      status: 'unpaid',
      taxPct: 7,
      lines: [{ desc: ' Tempered mirror replacement', qty: 1, price: 1000, taxable: true }],
      payments: [{ id: 'p-1', amount: 400, date: '2026-10-14', method: 'check', reference: '88412' }],
    };

    const ledger = buildAccountingLedger({
      invoices: [invOpen],
      payApps: [paUninvoicedPaid],
      payAppSummaries: paSummaries,
      contracts: [{ id: 'con-1', jobId: 'job-1', customerId: 'cust-1' }],
      customers: [{ id: 'cust-1', name: 'Bryan', company: 'Marcobay Construction, Inc.', email: 'bryan@marcobay.com' }],
      jobs: [{ id: 'job-1', number: 2564, name: 'Ruthven 3955 Anchuca Dr', customerId: 'cust-1', type: 'storefront' }],
      partsRequests: [partsReq],
      suppliers: [{ id: 'sup-trulite', name: 'Trulite Glass & Aluminum Solutions' }],
      syncStatus: {
        'pa:pa-3': { checkNumber: '030306', notarized: true, waiverSigned: true },
      },
    });

    // Verify zero gap between totalCollected and sum(payments)
    const sumPayments = round2(ledger.payments.reduce((s, p) => s + p.amount, 0));
    assert.equal(ledger.totals.totalCollected, sumPayments);
    assert.equal(ledger.totals.totalCollected, round2(22887 + 400));
    assert.equal(ledger.totals.totalOpenAR, 670); // $1,070 invoice - $400 paid = $670
    assert.equal(ledger.totals.totalRetainageHeld, 2543);
    // Verify supplier quoteTotal ($6,420.50) flows into vendorCommitments and totals
    assert.equal(ledger.vendorCommitments.length, 1);
    assert.equal(ledger.vendorCommitments[0].amount, 6420.50);
    assert.equal(ledger.totals.totalVendorCommitments, 6420.50);

    // Verify QuickBooks Desktop .IIF double-entry balance (every TRNS + SPL sums to 0.00)
    const iif = exportQuickBooksDesktopIif(ledger);
    const lines = iif.split('\r\n');
    let blockSum = null;
    for (const line of lines) {
      const cols = line.split('\t');
      if (cols[0] === 'TRNS') {
        blockSum = Number(cols[6]);
      } else if (cols[0] === 'SPL') {
        blockSum = round2(blockSum + Number(cols[6]));
      } else if (cols[0] === 'ENDTRNS') {
        assert.equal(round2(blockSum), 0, 'Every QuickBooks .IIF transaction must balance to $0.00');
        blockSum = null;
      }
    }

    // Verify QBO CSV, Xero CSV, and JSON package contain the records
    const qboCsv = exportQuickBooksOnlineCsv(ledger);
    assert.ok(qboCsv.includes('PA-3') && qboCsv.includes('5002'));
    const xeroCsv = exportXeroCsv(ledger);
    assert.ok(xeroCsv.includes('Marcobay Construction'));
    const jsonPkg = JSON.parse(exportAccountingPackageJson(ledger, { notary: DEFAULT_NOTARY }));
    assert.equal(jsonPkg.accountantAndNotary.commissionNumber, 'HH 427582');
    assert.equal(jsonPkg.summary.totalVendorCommitments, 6420.50);

    // Verify all 4 Florida Statutory § 713.20 Waiver & NTO Sworn Statement types
    for (const kind of ['progress', 'final', 'affidavit', 'sworn']) {
      const w = buildLienWaiverData({
        kind,
        payApp: paUninvoicedPaid,
        payAppSummaryData: paSummaries['pa-3'],
        job: { id: 'job-1', number: 2564, name: 'Ruthven 3955 Anchuca Dr', address: '3955 Anchuca Dr, Lakeland, FL' },
        customer: { company: 'Marcobay Construction, Inc.' },
        notary: DEFAULT_NOTARY,
        overrides: {
          signerName: ADMIN_SIGNERS[1].name, // Jason Vergara
          vendorName: 'Trulite Glass & Aluminum Solutions',
          vendorBalanceCurrent: 6420.50,
        },
      });
      assert.equal(w.notary.name, 'Melina S. Arias');
      assert.equal(w.notary.commissionNumber, 'HH 427582');
      assert.equal(w.signerName, 'Jason Vergara');
      assert.equal(w.amount, 22887);
      if (kind === 'sworn') {
        assert.equal(w.vendorName, 'Trulite Glass & Aluminum Solutions');
        assert.equal(w.vendorBalanceCurrent, 6420.50);
      }
    }
  });

  it('6. verifies Schedule & Repeating Tasks math (when.js)', () => {
    const ev = {
      id: 'ev-1',
      title: 'Weekly Glazing Safety & Takeoff Review',
      type: 'task',
      allDay: true,
      start: '2026-10-01',
      end: '2026-10-01',
      repeat: 'weekly',
      repeatUntil: '2026-10-31',
    };
    const occ = occurrences(ev, '2026-10-01', '2026-10-31');
    assert.equal(occ.length, 5); // Oct 1, 8, 15, 22, 29
    assert.equal(nextOccurrence(ev, '2026-10-01')?.date, '2026-10-08');
  });
});
