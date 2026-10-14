import assert from 'node:assert/strict';
import {
  DEFAULT_NOTARY,
  ADMIN_SIGNERS,
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

describe('Accounting, Notary & Florida Statutory Lien Waiver (§ 713.20) Calculations', () => {
  it('verifies Melina S. Arias notary commission and Wesley Stel / Jason Vergara admin defaults', () => {
    assert.equal(DEFAULT_NOTARY.name, 'Melina S. Arias');
    assert.equal(DEFAULT_NOTARY.email, 'melinasarias@gmail.com');
    assert.equal(DEFAULT_NOTARY.state, 'Florida');
    assert.equal(DEFAULT_NOTARY.county, 'Hillsborough');
    assert.equal(DEFAULT_NOTARY.commissionNumber, 'HH 427582');
    assert.equal(DEFAULT_NOTARY.commissionExpiresText, 'October 21, 2027');
    assert.equal(ADMIN_SIGNERS[0].name, 'Wesley Stel');
    assert.equal(ADMIN_SIGNERS[1].name, 'Jason Vergara');
  });

  it('formats ordinal dates for Florida notary and statutory lien waiver certificates', () => {
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

  it('builds Florida Statutory Lien Waiver (§ 713.20) from Pay Application 003 (Ruthven 3955 Anchuca Dr)', () => {
    const payApp = {
      id: 'pa3',
      number: 3,
      date: '2026-04-20',
      periodTo: '2026-04-25',
      currentDue: 18477,
    };
    const job = {
      id: 'job1',
      name: '24-889-00 Ruthven',
      siteAddress: '3955 Anchuca Drive, Lakeland, FL 33811',
      poNumber: '24-889',
      ownerName: 'Ruthven Green LLC',
    };
    const customer = {
      id: 'cust1',
      name: 'Tammy Brend',
      company: 'Marcobay Construction, Inc.',
    };
    const company = {
      name: 'Stellar Glass, LLC',
      address: '2850 Mine and Mill Road Bays 3 & 4, Lakeland, FL 33801',
      contactName: 'Wesley Stel',
      contactTitle: 'President',
    };

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
    assert.equal(w.customerName, 'Marcobay Construction, Inc.');
    assert.equal(w.ownerName, 'Ruthven Green LLC');
    assert.ok(w.propertyDesc.includes('3955 Anchuca Drive'));
    assert.equal(w.signerName, 'Wesley Stel');
    assert.equal(w.notary.name, 'Melina S. Arias');
    assert.equal(w.notary.commissionNumber, 'HH 427582');
  });

  it('builds balanced QuickBooks Online CSV, QuickBooks Desktop .IIF, Xero CSV, and JSON sync exports', () => {
    const customers = [
      { id: 'c1', name: 'Tammy Brend', company: 'Marcobay Construction, Inc.', email: 'bills@marcobay.com' },
    ];
    const jobs = [
      { id: 'j1', name: '3955 Anchuca Shell', customerId: 'c1', type: 'storefront', poNumber: '24-889' },
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

    assert.equal(ledger.receivables.length, 2); // inv1 (for pa2) + pa3 (uninvoiced pay app)
    assert.equal(ledger.totals.totalBilled, 73125 + 18477);
    assert.equal(ledger.totals.totalCollected, 73125);
    assert.equal(ledger.totals.totalOpenAR, 18477);
    assert.equal(ledger.totals.totalRetainageHeld, 16303);
    assert.equal(ledger.payments.length, 1);
    assert.equal(ledger.payments[0].reference, '31927');
    assert.equal(ledger.vendorCommitments.length, 1);
    assert.equal(ledger.vendorCommitments[0].supplierName, 'Trulite Glass and Aluminum');

    // Verify every double-entry journal entry in .IIF balances to 0.00
    for (const je of ledger.journalEntries) {
      const splitSum = je.splits.reduce((s, sp) => s + sp.amount, 0);
      assert.equal(Math.round((je.amount + splitSum) * 100), 0, `Journal entry ${je.docNum} must balance to 0`);
    }

    const qboCsv = exportQuickBooksOnlineCsv(ledger);
    assert.ok(qboCsv.includes('*InvoiceNo,*Customer'));
    assert.ok(qboCsv.includes('Marcobay Construction, Inc.'));
    assert.ok(qboCsv.includes('Check #31927'));

    const iif = exportQuickBooksDesktopIif(ledger);
    assert.ok(iif.includes('!TRNS\tTRNSID\tTRNSTYPE'));
    assert.ok(iif.includes('ENDTRNS'));
    assert.ok(iif.includes('31927'));

    const xero = exportXeroCsv(ledger);
    assert.ok(xero.includes('*ContactName,EmailAddress,*InvoiceNumber'));
    assert.ok(xero.includes('16303.00'));

    const jsonStr = exportAccountingPackageJson(ledger, { company: { name: 'Stellar Glass, LLC' } });
    const parsed = JSON.parse(jsonStr);
    assert.equal(parsed.accountantAndNotary.name, 'Melina S. Arias');
    assert.equal(parsed.admins[0].name, 'Wesley Stel');
    assert.equal(parsed.admins[1].name, 'Jason Vergara');
  });
});
