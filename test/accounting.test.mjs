import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as accountingCalc from '../public/js/accounting-calc.js';
import {
  DEFAULT_NOTARY,
  DEFAULT_ACCOUNTS,
  ordinal,
  formatOrdinalDate,
  buildLienWaiverData,
  buildAccountingLedger,
  exportQuickBooksOnlineCsv,
  exportQuickBooksDesktopIif,
  exportXeroCsv,
  exportAccountingPackageJson,
} from '../public/js/accounting-calc.js';
import { detectInstallEnvironment } from '../public/js/pwa.js';

// Made-up people, businesses and addresses: this repository is public.
const NOTARY = { name: 'Sample Notary', state: 'Florida', commissionNumber: 'XX 000000', commissionExpiresText: 'January 1, 2030' };
const company = {
  name: 'Stellar Glass LLC',
  address: '100 Sample Rd, Lakeland, FL 33801',
  contactName: 'Pat Owner',
  contactTitle: 'President',
};

// Splits one CSV line into its cells (quoted cells may hold commas and doubled quotes).
function csvCells(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
// A cell Excel or Google Sheets would run as a formula.
const isFormula = (cell) => /^[=+\-@]/.test(cell) && !/^[-+]?\d+(\.\d+)?$/.test(cell);

describe('Accounting, notary blocks & Florida statutory lien waivers (§ 713.20)', () => {
  it('keeps no notary or signer details in the code, since the repository and the site code are public', () => {
    assert.deepEqual(DEFAULT_NOTARY, { name: '', state: 'Florida', commissionNumber: '', commissionExpiresText: '' });
    assert.equal(accountingCalc.ADMIN_SIGNERS, undefined);
    for (const dir of ['public/js', 'public/js/takeoff']) {
      for (const f of fs.readdirSync(new URL(`../${dir}/`, import.meta.url))) {
        if (!f.endsWith('.js')) continue;
        const src = fs.readFileSync(new URL(`../${dir}/${f}`, import.meta.url), 'utf8');
        assert.doesNotMatch(src, /@gmail\.com/i, `${dir}/${f} has a personal Gmail address`);
        assert.doesNotMatch(src, /\b[A-Z]{2} ?\d{6}\b/, `${dir}/${f} looks like it has a notary commission number`);
      }
    }
  });

  it('formats ordinal dates for notary blocks and statutory lien waivers', () => {
    assert.equal(ordinal(1), '1st');
    assert.equal(ordinal(2), '2nd');
    assert.equal(ordinal(3), '3rd');
    assert.equal(ordinal(5), '5th');
    assert.equal(ordinal(11), '11th');
    assert.equal(ordinal(20), '20th');
    assert.equal(ordinal(21), '21st');

    const d = formatOrdinalDate('2026-04-20');
    assert.equal(d.usDate, '04/20/2026');
    assert.equal(d.dayOrdinal, '20th');
    assert.equal(d.monthName, 'April');
    assert.equal(d.year, '2026');
    assert.equal(d.yearShort, '26');
  });

  it('builds a progress payment waiver (§ 713.20(4)) from a pay app, signed by the contact in Settings', () => {
    const payApp = { id: 'pa3', number: 3, date: '2026-04-20', periodTo: '2026-04-25', currentDue: 18477 };
    const job = {
      id: 'job1',
      name: 'Sample Plaza',
      siteAddress: '300 Main St, Lakeland, FL 33811',
      poNumber: '24-100',
      ownerName: 'Sample Plaza Owner LLC',
    };
    const customer = { id: 'cust1', name: 'Pat Builder', company: 'Sample Builders, Inc.' };

    const w = buildLienWaiverData({
      kind: 'progress',
      payApp,
      payAppSummaryData: { currentDue: 18477 },
      job,
      customer,
      company,
      overrides: { signedDate: '2026-06-05' },
    });

    assert.equal(w.kind, 'progress');
    assert.equal(w.amount, 18477);
    assert.equal(w.amountFormatted, '$18,477.00');
    assert.equal(w.throughUsDate, '04/25/2026');
    assert.equal(w.signedOrd.dayOrdinal, '5th');
    assert.equal(w.signedOrd.monthName, 'June');
    assert.equal(w.signedOrd.yearShort, '26');
    assert.equal(w.customerName, 'Sample Builders, Inc.');
    assert.equal(w.ownerName, 'Sample Plaza Owner LLC');
    assert.ok(w.propertyDesc.includes('300 Main St'));
    assert.equal(w.lienorName, 'Stellar Glass LLC');
    assert.equal(w.signerName, 'Pat Owner');
    assert.equal(w.signerTitle, 'President');
    // The notary block stays blank until the notary's own details are saved on the Accounting page.
    assert.equal(w.notary.name, '');
    assert.equal(w.notary.commissionNumber, '');

    const withNotary = buildLienWaiverData({ kind: 'final', payApp, job, customer, company, notary: NOTARY });
    assert.equal(withNotary.amount, 18477);
    assert.deepEqual(withNotary.notary, NOTARY);

    // Someone else signing doesn't get the contact's title.
    const other = buildLienWaiverData({ kind: 'progress', payApp, job, customer, company, overrides: { signerName: 'Sam Partner' } });
    assert.equal(other.signerName, 'Sam Partner');
    assert.equal(other.signerTitle, '');
    const titled = buildLienWaiverData({
      kind: 'progress', payApp, job, customer, company, overrides: { signerName: 'Sam Partner', signerTitle: 'Owner' },
    });
    assert.equal(titled.signerTitle, 'Owner');
  });

  it('waives what is still owed on an unpaid bill, and what was received on a paid one', () => {
    const unpaid = {
      id: 'i1',
      number: 2001,
      date: '2026-05-01',
      status: 'unpaid',
      taxPct: 0,
      lines: [{ desc: 'Mirror', qty: 1, price: 1000 }],
      payments: [{ date: '2026-05-03', amount: 400, method: 'check', reference: '101' }],
    };
    assert.equal(buildLienWaiverData({ invoice: unpaid, company }).amount, 600);

    const paid = { ...unpaid, status: 'paid', paidDate: '2026-05-10', payments: [{ date: '2026-05-10', amount: 1000, method: 'check', reference: '102' }] };
    const w = buildLienWaiverData({ invoice: paid, company });
    assert.equal(w.amount, 1000);
    assert.equal(w.signedDate, '2026-05-10');
  });

  it('builds balanced QuickBooks Online CSV, QuickBooks Desktop .IIF, Xero CSV, and JSON exports', () => {
    const customers = [
      { id: 'c1', name: 'Pat Builder', company: 'Sample Builders, Inc.', email: 'billing@example.com' },
    ];
    const jobs = [
      { id: 'j1', name: 'Sample Plaza Shell', customerId: 'c1', type: 'storefront', poNumber: '24-100' },
    ];
    const contracts = [
      { id: 'con1', number: 1001, jobId: 'j1', customerId: 'c1', amount: 163030, retainagePct: 10 },
    ];
    const payApps = [
      { id: 'pa2', number: 2, contractId: 'con1', jobId: 'j1', customerId: 'c1', date: '2026-03-20', periodTo: '2026-03-25', status: 'paid', currentDue: 73125 },
      { id: 'pa3', number: 3, contractId: 'con1', jobId: 'j1', customerId: 'c1', date: '2026-04-20', periodTo: '2026-04-25', status: 'submitted', currentDue: 18477 },
    ];
    const payAppSummaries = {
      pa2: { currentDue: 73125, totalCompleted: 142500, totalRetainage: 14250 },
      pa3: { currentDue: 18477, totalCompleted: 163030, totalRetainage: 16303 },
    };
    const invoices = [
      {
        id: 'inv1',
        number: 2001,
        jobId: 'j1',
        customerId: 'c1',
        payAppId: 'pa2',
        date: '2026-03-25',
        dueDate: '2026-04-24',
        status: 'paid',
        paidDate: '2026-05-04',
        taxPct: 0,
        lines: [{ desc: 'Pay App #2 thru 03/25/2026', qty: 1, price: 73125, taxable: false }],
        payments: [{ date: '2026-05-04', amount: 73125, method: 'check', reference: '31927' }],
      },
    ];
    const suppliers = [
      { id: 'sup1', name: 'Trulite Glass and Aluminum' },
    ];
    const partsRequests = [
      { id: 'pr1', jobId: 'j1', supplierId: 'sup1', status: 'ordered', kind: 'order', items: [{ desc: '1" Clear IGU' }, { desc: 'CG451 Jambs' }] },
    ];

    const ledger = buildAccountingLedger({
      invoices,
      payApps,
      payAppSummaries,
      contracts,
      customers,
      jobs,
      partsRequests,
      suppliers,
      accounts: DEFAULT_ACCOUNTS,
      syncStatus: { 'pa:pa2': { notarized: true, waiverSigned: true, synced: true } },
    });

    assert.equal(ledger.receivables.length, 2); // inv1 (for pa2) + pa3 (pay app not billed on an invoice)
    assert.equal(ledger.totals.totalBilled, 73125 + 18477);
    assert.equal(ledger.totals.totalCollected, 73125);
    assert.equal(ledger.totals.totalOpenAR, 18477);
    assert.equal(ledger.totals.totalRetainageHeld, 16303);
    assert.equal(ledger.payments.length, 1);
    assert.equal(ledger.payments[0].reference, '31927');
    assert.equal(ledger.vendorCommitments.length, 1);
    assert.equal(ledger.vendorCommitments[0].supplierName, 'Trulite Glass and Aluminum');

    // Every double-entry journal entry balances to 0.00
    for (const je of ledger.journalEntries) {
      const splitSum = je.splits.reduce((s, sp) => s + sp.amount, 0);
      assert.equal(Math.round((je.amount + splitSum) * 100), 0, `Journal entry ${je.docNum} must balance to 0`);
    }

    const qboCsv = exportQuickBooksOnlineCsv(ledger);
    assert.ok(qboCsv.includes('*InvoiceNo,*Customer'));
    assert.ok(qboCsv.includes('"Sample Builders, Inc."'));
    assert.ok(qboCsv.includes('Check #31927'));

    const iif = exportQuickBooksDesktopIif(ledger);
    assert.ok(iif.includes('!TRNS\tTRNSID\tTRNSTYPE'));
    assert.ok(iif.includes('ENDTRNS'));
    assert.ok(iif.includes('31927'));

    const xero = exportXeroCsv(ledger);
    assert.ok(xero.includes('*ContactName,EmailAddress,*InvoiceNumber'));
    assert.ok(xero.includes('16303.00'));

    const parsed = JSON.parse(exportAccountingPackageJson(ledger, { company: { name: 'Stellar Glass LLC' }, notary: NOTARY }));
    assert.deepEqual(parsed.notary, NOTARY);
    assert.equal(parsed.admins, undefined);
    assert.equal(parsed.summary.totalBilled, 73125 + 18477);
    // Without a saved notary profile the export carries blanks, not someone's commission.
    assert.equal(JSON.parse(exportAccountingPackageJson(ledger)).notary.commissionNumber, '');
  });

  it('keeps spreadsheet formulas out of the CSV and IIF exports', () => {
    const ledger = buildAccountingLedger({
      invoices: [{
        id: 'i1',
        number: 7,
        customerId: 'c1',
        jobId: 'j1',
        date: '2026-05-01',
        status: 'unpaid',
        taxPct: 0,
        lines: [{ desc: '+SUM(A1:A9)', qty: 1, price: 100 }, { desc: 'Credit', qty: 1, price: -25 }],
      }],
      customers: [{ id: 'c1', name: 'x', company: '=HYPERLINK("http://example.com","Click")', email: '@example' }],
      jobs: [{ id: 'j1', name: '-2+3', customerId: 'c1' }],
    });
    const qbo = exportQuickBooksOnlineCsv(ledger);
    const xero = exportXeroCsv(ledger);
    const iif = exportQuickBooksDesktopIif(ledger);

    // The text is kept, with an apostrophe in front so it opens as text.
    assert.ok(qbo.includes(`"'=HYPERLINK(""http://example.com"",""Click"")"`));
    assert.ok(qbo.includes(",'@example,"));
    assert.ok(qbo.includes(",'-2+3,"));
    assert.ok(qbo.includes(",'+SUM(A1:A9),"));
    // Plain negative numbers stay numbers.
    assert.ok(qbo.includes(',-25.00,-25.00,'));
    assert.ok(iif.includes(`\t'=HYPERLINK("http://example.com","Click")\t`));

    for (const text of [qbo, xero]) {
      for (const line of text.trim().split('\r\n')) {
        for (const cell of csvCells(line)) assert.ok(!isFormula(cell), `CSV cell would run as a formula: ${cell}`);
      }
    }
    for (const line of iif.trim().split('\r\n')) {
      for (const cell of line.split('\t')) assert.ok(!isFormula(cell), `IIF cell would run as a formula: ${cell}`);
    }
  });

  it('counts payments received within the dates picked, even on a bill dated before them', () => {
    const ledger = buildAccountingLedger({
      invoices: [{
        id: 'i1',
        number: 9,
        customerId: 'c1',
        date: '2026-09-20',
        status: 'paid',
        paidDate: '2026-10-05',
        taxPct: 0,
        lines: [{ desc: 'Shower door', qty: 1, price: 1200 }],
        payments: [
          { date: '2026-09-25', amount: 200, method: 'check', reference: '501' },
          { date: '2026-10-05', amount: 1000, method: 'check', reference: '502' },
        ],
      }],
      customers: [{ id: 'c1', name: 'Sample Customer' }],
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
    });
    assert.equal(ledger.receivables.length, 0); // billed in September
    assert.equal(ledger.totals.totalBilled, 0);
    assert.deepEqual(ledger.payments.map((p) => p.reference), ['502']);
    assert.equal(ledger.totals.totalCollected, 1000);
    assert.deepEqual(ledger.journalEntries.map((j) => [j.trnsType, j.amount]), [['PAYMENT', 1000]]);
  });

  it('books paid pay apps to the deposit account, and tells Stripe payments from bills marked paid', () => {
    const ledger = buildAccountingLedger({
      payApps: [{ id: 'pa1', number: 1, contractId: 'k1', jobId: 'j1', customerId: 'c1', date: '2026-05-01', periodTo: '2026-04-30', status: 'paid', currentDue: 5000 }],
      invoices: [
        { id: 'i1', number: 11, customerId: 'c1', date: '2026-05-02', status: 'paid', taxPct: 0, lines: [{ desc: 'Mirror', qty: 1, price: 300 }] },
        {
          id: 'i2',
          number: 12,
          customerId: 'c1',
          date: '2026-05-03',
          status: 'paid',
          taxPct: 0,
          lines: [{ desc: 'Shower', qty: 1, price: 900 }],
          stripe: { status: 'paid', amountPaid: 900, invoiceNumber: 'SG-0012' },
        },
      ],
      customers: [{ id: 'c1', name: 'Sample Customer' }],
    });
    const paPayment = ledger.journalEntries.find((j) => j.trnsType === 'PAYMENT' && j.docNum === 'PA-1');
    assert.equal(paPayment.account, DEFAULT_ACCOUNTS.undepositedAccount);
    assert.equal(ledger.payments.find((p) => p.payAppId === 'pa1').depositAccount, DEFAULT_ACCOUNTS.undepositedAccount);

    const marked = ledger.payments.find((p) => p.invoiceNumber === '11');
    assert.equal(marked.method, 'Marked paid');
    assert.equal(marked.amount, 300);
    const online = ledger.payments.find((p) => p.invoiceNumber === '12');
    assert.equal(online.method, 'Stripe Online');
    assert.equal(online.reference, 'SG-0012');
    assert.equal(ledger.totals.totalCollected, 5000 + 300 + 900);
  });

  it('exports the quantities the bill counts, so a 0 quantity line is $0', () => {
    const ledger = buildAccountingLedger({
      invoices: [{
        id: 'i1',
        number: 21,
        customerId: 'c1',
        date: '2026-05-02',
        status: 'unpaid',
        taxPct: 7,
        lines: [
          { desc: 'Glass', qty: 2, price: 100, taxable: true },
          { desc: 'Not needed after all', qty: 0, price: 450, taxable: true },
          { desc: 'Labor', qty: 1, price: 200, taxable: false },
        ],
      }],
      customers: [{ id: 'c1', name: 'Sample Customer' }],
    });
    const rows = exportQuickBooksOnlineCsv(ledger).trim().split('\r\n').map(csvCells);
    const col = (name) => rows[0].indexOf(name);
    assert.deepEqual(
      rows.slice(1).map((r) => [r[col('ItemQuantity')], r[col('*ItemAmount')], r[col('Taxable')]]),
      [['2', '200.00', 'Y'], ['0', '0.00', 'Y'], ['1', '200.00', 'N']],
    );
    const lineSum = rows.slice(1).reduce((s, r) => s + Number(r[col('*ItemAmount')]), 0);
    assert.equal(lineSum, ledger.receivables[0].subtotal);
  });

  it('detects Windows and Mac desktop web app (PWA) environments and validates manifest.webmanifest', () => {
    const winEdge = detectInstallEnvironment(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      'Win32',
      false,
    );
    assert.equal(winEdge.os, 'windows');
    assert.equal(winEdge.browser, 'edge');
    assert.equal(winEdge.supportsNativePrompt, true);

    const macSafari = detectInstallEnvironment(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      'MacIntel',
      false,
    );
    assert.equal(macSafari.os, 'mac');
    assert.equal(macSafari.browser, 'safari');
    assert.equal(macSafari.supportsNativePrompt, false);

    const macChrome = detectInstallEnvironment(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'MacIntel',
      true,
    );
    assert.equal(macChrome.os, 'mac');
    assert.equal(macChrome.browser, 'chrome');
    assert.equal(macChrome.isStandalone, true);

    const manifest = JSON.parse(fs.readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
    assert.ok(manifest.icons.some((i) => i.sizes === '192x192'));
    assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any'));
    assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
    assert.ok(manifest.shortcuts.length >= 4);
  });
});
