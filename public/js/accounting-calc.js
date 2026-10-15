// Pure accounting, notary, Florida Statutory Lien Waiver (§ 713.20), and ledger export calculations
// for Melina S. Arias (Accountant & Notary Public) and admins Wesley Stel & Jason Vergara.
import { invoiceTotals, contractSum, g702, money, round2, paidOn, dueOn, creditedOn } from './calc.js';

export const DEFAULT_NOTARY = {
  name: 'Melina S. Arias',
  email: 'melinasarias@gmail.com',
  state: 'Florida',
  county: 'Hillsborough',
  commissionNumber: 'HH 427582',
  commissionExpires: '2027-10-21',
  commissionExpiresText: 'October 21, 2027',
  sealName: 'MELINA ARIAS',
  presence: 'physical', // 'physical' | 'online'
};

export const ADMIN_SIGNERS = [
  { name: 'Wesley Stel', title: 'President', email: 'wes@stellarglassllc.com' },
  { name: 'Jason Vergara', title: 'Owner', email: 'jayjay100396@gmail.com' },
];

export const DEFAULT_ACCOUNTS = {
  arAccount: '1100 · Accounts Receivable',
  retainageAccount: '1150 · Retainage Receivable',
  undepositedAccount: '1020 · Operating Checking / Undeposited Funds',
  depositLiabilityAccount: '2100 · Customer Deposits / Unearned Revenue',
  salesTaxAccount: '2200 · Florida Sales Tax Payable',
  glazingIncomeAccount: '4000 · Commercial Glazing & Storefront Income',
  showerIncomeAccount: '4010 · Shower Enclosures & Interior Glass Income',
  cogsAccount: '5000 · Cost of Goods Sold - Glass & Aluminum',
  apAccount: '2000 · Accounts Payable',
};

export const WAIVER_TYPES = [
  ['progress', 'Partial Waiver & Release of Lien Upon Progress Payment (§ 713.20(4), F.S.)'],
  ['final', 'Final Waiver & Release of Lien Upon Final Payment (§ 713.20(5), F.S.)'],
  ['affidavit', 'Final Affidavit & Waiver of Lien (Notarized Contractor Affidavit)'],
  ['sworn', 'Request for Sworn Statement (NTO Vendor / Supplier Balance)'],
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function ordinal(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '';
  const mod100 = v % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
  switch (v % 10) {
    case 1: return `${v}st`;
    case 2: return `${v}nd`;
    case 3: return `${v}rd`;
    default: return `${v}th`;
  }
}

export function formatOrdinalDate(isoDate = '') {
  const m = String(isoDate || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) {
    return {
      iso: '',
      usDate: String(isoDate || ''),
      day: '',
      dayOrdinal: '____',
      monthName: '____________',
      year: '20__',
      yearShort: '__',
    };
  }
  const year = m[1];
  const monthIdx = Math.max(0, Math.min(11, Number(m[2]) - 1));
  const dayNum = Number(m[3]);
  return {
    iso: `${m[1]}-${m[2]}-${m[3]}`,
    usDate: `${m[2]}/${m[3]}/${m[1]}`,
    day: String(dayNum),
    dayOrdinal: ordinal(dayNum),
    monthName: MONTHS[monthIdx],
    year,
    yearShort: year.slice(-2),
  };
}

export function buildLienWaiverData({
  kind = 'progress',
  payApp = null,
  payAppSummaryData = null,
  invoice = null,
  contract = null,
  job = null,
  customer = null,
  company = null,
  notary = DEFAULT_NOTARY,
  overrides = {},
} = {}) {
  const co = company || {};
  const j = job || {};
  const cu = customer || {};
  const nt = { ...DEFAULT_NOTARY, ...(notary || {}) };

  let defaultAmount = 0;
  let defaultThroughDate = '';
  let defaultSignedDate = overrides.signedDate || '';

  if (payApp) {
    defaultAmount = Number(payAppSummaryData?.currentDue ?? payApp.currentDue) || 0;
    defaultThroughDate = payApp.periodTo || payApp.date || '';
    if (!defaultSignedDate) defaultSignedDate = payApp.date || payApp.periodTo || '';
  } else if (invoice) {
    const t = invoiceTotals(invoice);
    defaultAmount = t.total;
    defaultThroughDate = invoice.date || '';
    if (!defaultSignedDate) defaultSignedDate = invoice.paidDate || invoice.date || '';
  } else if (contract) {
    defaultAmount = Number(contract.amount) || 0;
    defaultThroughDate = contract.date || '';
  }

  const amount = overrides.amount !== undefined && overrides.amount !== ''
    ? round2(Number(overrides.amount) || 0)
    : round2(defaultAmount);
  const throughIso = overrides.throughDate !== undefined ? overrides.throughDate : defaultThroughDate;
  const signedIso = defaultSignedDate || throughIso || new Date().toISOString().slice(0, 10);

  const throughFmt = formatOrdinalDate(throughIso);
  const signedFmt = formatOrdinalDate(signedIso);

  const customerDisplay = overrides.customerName !== undefined && overrides.customerName !== ''
    ? overrides.customerName
    : (cu.company || cu.name || '');

  // On commercial jobs (like 3955 Anchuca Shell), the Customer is the GC (e.g. Marcobay Construction, Inc.)
  // and the Owner of Property is the developer/owner (e.g. Ruthven Green LLC).
  const ownerDisplay = overrides.ownerName !== undefined && overrides.ownerName !== ''
    ? overrides.ownerName
    : (j.ownerName || (cu.company && cu.name && cu.company !== cu.name ? cu.name : '') || j.name || customerDisplay || '');

  const propParts = [
    j.siteAddress || '',
    j.poNumber ? `Job #${j.poNumber}` : (j.name || ''),
  ].filter(Boolean);
  const propertyDisplay = overrides.propertyDesc !== undefined && overrides.propertyDesc !== ''
    ? overrides.propertyDesc
    : (propParts.join(' · ') || j.name || '');

  const signerName = overrides.signerName || co.contactName || ADMIN_SIGNERS[0].name;
  const matchedAdmin = ADMIN_SIGNERS.find((a) => a.name.toLowerCase() === String(signerName).toLowerCase());
  const signerTitle = overrides.signerTitle || matchedAdmin?.title || co.contactTitle || 'President';

  const lienorName = overrides.lienorName || co.name || 'Stellar Glass, LLC';
  const lienorAddress = overrides.lienorAddress || co.address || '2850 Mine and Mill Road Bays 3 & 4, Lakeland, FL 33801';

  const vendorName = overrides.vendorName || 'Trulite Glass and Aluminum';
  const vendorBalanceThru = overrides.vendorBalanceThru !== undefined && overrides.vendorBalanceThru !== ''
    ? round2(Number(overrides.vendorBalanceThru) || 0)
    : 0;
  const vendorBalanceCurrent = overrides.vendorBalanceCurrent !== undefined && overrides.vendorBalanceCurrent !== ''
    ? round2(Number(overrides.vendorBalanceCurrent) || 0)
    : 0;

  const includeNotary = overrides.includeNotary !== undefined
    ? Boolean(overrides.includeNotary && overrides.includeNotary !== '0' && overrides.includeNotary !== 'false')
    : true;

  return {
    kind: ['progress', 'final', 'affidavit', 'sworn'].includes(kind) ? kind : 'progress',
    amount,
    amountFormatted: money(amount),
    throughDate: throughIso,
    throughUsDate: throughFmt.usDate || throughIso || '____/____/20__',
    signedDate: signedIso,
    signedOrd: signedFmt,
    customerName: customerDisplay,
    ownerName: ownerDisplay,
    propertyDesc: propertyDisplay,
    lienorName,
    lienorAddress,
    signerName,
    signerTitle,
    vendorName,
    vendorBalanceThru,
    vendorBalanceCurrent,
    includeNotary,
    notary: nt,
    docRef: payApp ? `Pay App #${payApp.number}` : invoice ? `Invoice #${invoice.number}` : contract ? `Contract #${contract.number}` : (j.name || 'Job'),
  };
}

function csvCell(val) {
  const s = String(val ?? '').replace(/\r?\n/g, ' ').trim();
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

function iifClean(val) {
  return String(val ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function usDate(iso = '') {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || '');
}

export function buildAccountingLedger({
  invoices = [],
  payApps = [],
  payAppSummaries = {},
  contracts = [],
  changeOrders = [],
  customers = [],
  jobs = [],
  partsRequests = [],
  suppliers = [],
  accounts = DEFAULT_ACCOUNTS,
  syncStatus = {},
  dateFrom = '',
  dateTo = '',
  statusFilter = 'all',
} = {}) {
  const acct = { ...DEFAULT_ACCOUNTS, ...(accounts || {}) };
  const custById = new Map(customers.map((c) => [c.id, c]));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const contractById = new Map(contracts.map((c) => [c.id, c]));
  const payAppById = new Map(payApps.map((p) => [p.id, p]));
  const supById = new Map(suppliers.map((s) => [s.id, s]));

  const inDateRange = (d) => {
    if (!d) return true;
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  };

  const receivables = [];
  const payments = [];
  const journalEntries = [];
  const invoicedPayAppIds = new Set();

  for (const inv of invoices) {
    if (inv.status === 'void') continue;
    if (inv.payAppId) invoicedPayAppIds.add(inv.payAppId);
    if (!inDateRange(inv.date)) continue;

    const job = jobById.get(inv.jobId) || {};
    const cust = custById.get(inv.customerId || job.customerId) || {};
    const customerLabel = cust.company || cust.name || 'Customer';
    const jobLabel = job.name || '';
    const t = invoiceTotals(inv);
    const paid = round2(paidOn(inv));
    const credited = round2(creditedOn(inv));
    const openBalance = inv.status === 'paid' ? 0 : round2(dueOn(inv));
    const incomeAcct = job.type === 'shower' ? acct.showerIncomeAccount : acct.glazingIncomeAccount;

    const linkedPayApp = inv.payAppId ? payAppById.get(inv.payAppId) : null;
    const paSum = linkedPayApp ? (payAppSummaries[linkedPayApp.id] || null) : null;
    const retainageHeld = paSum ? round2(paSum.totalRetainage || 0) : 0;

    const syncKey = `inv:${inv.id}`;
    const syncInfo = syncStatus[syncKey] || {};
    const isSynced = Boolean(syncInfo.synced);

    if (statusFilter === 'unsynced' && isSynced) continue;
    if (statusFilter === 'synced' && !isSynced) continue;
    if (statusFilter === 'open' && openBalance <= 0) continue;

    const checkNums = (inv.payments || [])
      .map((p) => (p.method === 'check' && p.reference ? `Check #${p.reference}` : p.reference || p.method || ''))
      .filter(Boolean)
      .join(', ');

    const rec = {
      key: syncKey,
      recordType: linkedPayApp ? 'Pay App Invoice' : (inv.kind === 'deposit' ? 'Deposit Invoice' : 'Invoice'),
      id: inv.id,
      payAppId: inv.payAppId || '',
      number: String(inv.number || ''),
      date: inv.date || '',
      dueDate: inv.dueDate || '',
      periodTo: linkedPayApp?.periodTo || inv.date || '',
      status: inv.status || 'unpaid',
      customerId: cust.id || inv.customerId || '',
      customerName: customerLabel,
      customerEmail: cust.email || '',
      jobId: job.id || inv.jobId || '',
      jobName: jobLabel,
      poNumber: job.poNumber || '',
      subtotal: t.subtotal,
      tax: t.tax,
      taxPct: Number(inv.taxPct) || 0,
      total: t.total,
      retainageHeld,
      paid,
      credited,
      balanceDue: openBalance,
      paymentRefs: checkNums || (inv.stripe?.status === 'paid' ? 'Stripe Online' : ''),
      incomeAccount: incomeAcct,
      arAccount: acct.arAccount,
      lines: inv.lines || [],
      synced: isSynced,
      syncedAt: syncInfo.syncedAt || '',
      notarized: Boolean(syncInfo.notarized || (linkedPayApp && syncStatus[`pa:${linkedPayApp.id}`]?.notarized)),
      waiverSigned: Boolean(syncInfo.waiverSigned || (linkedPayApp && syncStatus[`pa:${linkedPayApp.id}`]?.waiverSigned)),
    };
    receivables.push(rec);

    // Double-entry Journal Entry for the Invoice
    const splits = [
      { account: incomeAcct, amount: -round2(t.subtotal), memo: `${jobLabel} - Inv #${inv.number}` },
    ];
    if (t.tax > 0) {
      splits.push({ account: acct.salesTaxAccount, amount: -round2(t.tax), memo: `FL Sales Tax (${inv.taxPct || 0}%)` });
    }
    journalEntries.push({
      trnsType: 'INVOICE',
      docNum: String(inv.number || ''),
      date: inv.date || '',
      dueDate: inv.dueDate || inv.date || '',
      name: customerLabel,
      account: acct.arAccount,
      amount: round2(t.total),
      memo: `${rec.recordType} #${inv.number}${jobLabel ? ' · ' + jobLabel : ''}`,
      splits,
    });

    // Payments recorded on this invoice
    for (const p of (inv.payments || [])) {
      if (!inDateRange(p.date || inv.date)) continue;
      const amt = round2(Number(p.amount) || 0);
      if (amt <= 0) continue;
      const methodLabel = p.method === 'check' ? 'Check' : p.method === 'cash' ? 'Cash' : 'ACH / Other';
      const refNum = p.reference || '';
      payments.push({
        invoiceId: inv.id,
        invoiceNumber: String(inv.number || ''),
        jobId: job.id || '',
        jobName: jobLabel,
        customerName: customerLabel,
        date: p.date || inv.paidDate || inv.date || '',
        amount: amt,
        method: methodLabel,
        reference: refNum,
        note: p.note || '',
        depositAccount: acct.undepositedAccount,
        arAccount: acct.arAccount,
      });
      journalEntries.push({
        trnsType: 'PAYMENT',
        docNum: refNum || `PMT-${inv.number}`,
        date: p.date || inv.paidDate || inv.date || '',
        name: customerLabel,
        account: acct.undepositedAccount,
        amount: amt,
        memo: `${methodLabel}${refNum ? ' #' + refNum : ''} for Invoice #${inv.number}`,
        splits: [
          { account: acct.arAccount, amount: -amt, memo: `Payment applied to Invoice #${inv.number}` },
        ],
      });
    }

    // Online payments via Stripe not duplicated in manual payments
    const manualSum = round2((inv.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
    const onlinePaid = round2(paid - manualSum);
    if (onlinePaid > 0 && inDateRange(inv.paidDate || inv.date)) {
      payments.push({
        invoiceId: inv.id,
        invoiceNumber: String(inv.number || ''),
        jobId: job.id || '',
        jobName: jobLabel,
        customerName: customerLabel,
        date: inv.paidDate || inv.date || '',
        amount: onlinePaid,
        method: 'Stripe Online',
        reference: inv.stripe?.invoiceNumber || inv.stripe?.id || 'Stripe',
        note: 'Online payment via Stripe',
        depositAccount: acct.undepositedAccount,
        arAccount: acct.arAccount,
      });
      journalEntries.push({
        trnsType: 'PAYMENT',
        docNum: inv.stripe?.invoiceNumber || `STRIPE-${inv.number}`,
        date: inv.paidDate || inv.date || '',
        name: customerLabel,
        account: acct.undepositedAccount,
        amount: onlinePaid,
        memo: `Stripe online payment for Invoice #${inv.number}`,
        splits: [
          { account: acct.arAccount, amount: -onlinePaid, memo: `Stripe payment applied to Invoice #${inv.number}` },
        ],
      });
    }
  }

  // Also include AIA G702 Pay Applications that haven't been converted to an invoice yet
  // (or track their notarization / lien waiver / retainage receivable directly).
  for (const pa of payApps) {
    if (!inDateRange(pa.periodTo || pa.date)) continue;
    const job = jobById.get(pa.jobId) || {};
    const contract = contractById.get(pa.contractId) || {};
    const cust = custById.get(pa.customerId || contract.customerId || job.customerId) || {};
    const customerLabel = cust.company || cust.name || 'Customer';
    const jobLabel = job.name || '';
    const s = payAppSummaries[pa.id] || (pa.lines?.length
      ? g702(pa, contract, changeOrders.filter((c) => c.contractId === pa.contractId), 0)
      : {
        currentDue: Number(pa.currentDue) || 0,
        totalCompleted: 0,
        totalRetainage: 0,
        depositApplied: Number(pa.depositApplied) || 0,
      });
    const syncKey = `pa:${pa.id}`;
    const syncInfo = syncStatus[syncKey] || {};
    const isSynced = Boolean(syncInfo.synced);
    const hasInvoice = invoicedPayAppIds.has(pa.id);

    if (!hasInvoice) {
      const currentDue = round2(s.currentDue || 0);
      const isPaid = pa.status === 'paid';
      const openBalance = isPaid ? 0 : currentDue;

      if (statusFilter === 'unsynced' && isSynced) continue;
      if (statusFilter === 'synced' && !isSynced) continue;
      if (statusFilter === 'open' && openBalance <= 0) continue;

      const incomeAcct = job.type === 'shower' ? acct.showerIncomeAccount : acct.glazingIncomeAccount;
      receivables.push({
        key: syncKey,
        recordType: 'AIA G702 Pay App',
        id: pa.id,
        payAppId: pa.id,
        number: `PA-${pa.number}`,
        date: pa.date || pa.periodTo || '',
        dueDate: pa.periodTo || pa.date || '',
        periodTo: pa.periodTo || pa.date || '',
        status: pa.status || 'draft',
        customerId: cust.id || '',
        customerName: customerLabel,
        customerEmail: cust.email || '',
        jobId: job.id || pa.jobId || '',
        jobName: jobLabel,
        poNumber: job.poNumber || '',
        subtotal: currentDue,
        tax: 0,
        taxPct: 0,
        total: currentDue,
        retainageHeld: round2(s.totalRetainage || 0),
        paid: isPaid ? currentDue : 0,
        credited: 0,
        balanceDue: openBalance,
        checkNumber: syncInfo.checkNumber || pa.checkNumber || '',
        paymentRefs: (syncInfo.checkNumber || pa.checkNumber) ? `Check #${syncInfo.checkNumber || pa.checkNumber}` : '',
        incomeAccount: incomeAcct,
        arAccount: acct.arAccount,
        lines: [{ desc: `AIA G702 Application #${pa.number} thru ${pa.periodTo || pa.date} (Net of ${pa.retainagePct ?? 10}% retainage)`, qty: 1, price: currentDue }],
        synced: isSynced,
        syncedAt: syncInfo.syncedAt || '',
        notarized: Boolean(syncInfo.notarized),
        waiverSigned: Boolean(syncInfo.waiverSigned),
      });

      if (pa.status !== 'draft' && currentDue > 0) {
        journalEntries.push({
          trnsType: 'INVOICE',
          docNum: `PA-${pa.number}`,
          date: pa.date || pa.periodTo || '',
          dueDate: pa.periodTo || pa.date || '',
          name: customerLabel,
          account: acct.arAccount,
          amount: currentDue,
          memo: `AIA G702 Pay App #${pa.number} (${jobLabel})`,
          splits: [
            { account: incomeAcct, amount: -currentDue, memo: `Progress billing PA #${pa.number} thru ${pa.periodTo || ''}` },
          ],
        });
      }

      if (isPaid && currentDue > 0) {
        const payDate = syncInfo.paidDate || pa.paidDate || pa.date || pa.periodTo || '';
        const refNum = syncInfo.checkNumber || pa.checkNumber || `PA-${pa.number}`;
        payments.push({
          id: `pa-pay-${pa.id}`,
          invoiceId: '',
          payAppId: pa.id,
          invoiceNumber: `PA-${pa.number}`,
          customerName: customerLabel,
          jobName: jobLabel,
          date: payDate,
          amount: currentDue,
          method: 'check',
          reference: refNum,
          checkRef: refNum,
          note: `AIA G702 Pay App #${pa.number} payment`,
          depositAccount: acct.checkingAccount,
          arAccount: acct.arAccount,
        });
        journalEntries.push({
          trnsType: 'PAYMENT',
          docNum: refNum,
          date: payDate,
          dueDate: payDate,
          name: customerLabel,
          account: acct.checkingAccount,
          amount: currentDue,
          memo: `check payment on Pay App #${pa.number} (${refNum})`,
          splits: [
            { account: acct.arAccount, amount: -currentDue, memo: `Apply to Pay App #${pa.number}` },
          ],
        });
      }
    }
  }

  // Supplier / NTO Vendor commitments (e.g. Trulite Glass and Aluminum)
  const vendorCommitments = [];
  for (const pr of partsRequests) {
    if (['cancelled', 'draft'].includes(pr.status)) continue;
    const job = jobById.get(pr.jobId) || {};
    const sup = supById.get(pr.supplierId) || {};
    const quotedAmount = round2(Number(pr.quoteTotal ?? pr.quoteAmount ?? pr.totalAmount ?? 0));
    vendorCommitments.push({
      id: pr.id,
      number: pr.number || '',
      status: pr.status || 'sent',
      kind: pr.kind || 'quote',
      supplierId: pr.supplierId || '',
      supplierName: sup.name || pr.supplierName || 'Supplier',
      jobId: pr.jobId || '',
      jobName: job.name || '',
      poNumber: pr.poNumber || job.poNumber || '',
      itemCount: (pr.items || []).length,
      amount: quotedAmount,
      expectedDate: pr.expectedDate || pr.neededBy || '',
      account: acct.cogsAccount,
    });
  }

  // Retainage summary across active contracts
  let totalRetainageHeld = 0;
  for (const c of contracts) {
    const cPayApps = payApps
      .filter((p) => p.contractId === c.id)
      .sort((a, b) => (Number(b.number) || 0) - (Number(a.number) || 0));
    if (cPayApps.length) {
      const latest = cPayApps[0];
      const s = payAppSummaries[latest.id];
      if (s) totalRetainageHeld = round2(totalRetainageHeld + (Number(s.totalRetainage) || 0));
    }
  }

  const totalBilled = round2(receivables.reduce((s, r) => s + r.total, 0));
  const totalCollected = round2(receivables.reduce((s, r) => s + r.paid, 0));
  const totalOpenAR = round2(receivables.reduce((s, r) => s + r.balanceDue, 0));
  const totalSalesTax = round2(receivables.reduce((s, r) => s + r.tax, 0));
  const totalVendorCommitments = round2(vendorCommitments.reduce((s, v) => s + v.amount, 0));
  const unsyncedCount = receivables.filter((r) => !r.synced).length;
  const pendingNotaryCount = payApps.filter((p) => !syncStatus[`pa:${p.id}`]?.notarized).length;

  return {
    receivables,
    payments,
    vendorCommitments,
    journalEntries,
    accounts: acct,
    totals: {
      totalBilled,
      totalCollected,
      totalOpenAR,
      totalRetainageHeld,
      totalSalesTax,
      totalVendorCommitments,
      unsyncedCount,
      pendingNotaryCount,
    },
  };
}

export function exportQuickBooksOnlineCsv(ledger) {
  const headers = [
    '*InvoiceNo',
    '*Customer',
    'CustomerEmail',
    '*InvoiceDate',
    '*DueDate',
    'Terms',
    'Location',
    'Memo',
    'Item(Product/Service)',
    'ItemDescription',
    'ItemQuantity',
    'ItemRate',
    '*ItemAmount',
    'Taxable',
    'TaxAmount',
    'RetainageHeld',
    'PaidAmount',
    'BalanceDue',
    'PaymentReference',
    'IncomeAccount',
    'ARAccount',
  ];
  const rows = [csvRow(headers)];
  for (const r of (ledger.receivables || [])) {
    const lines = r.lines && r.lines.length
      ? r.lines
      : [{ desc: `${r.recordType} #${r.number}`, qty: 1, price: r.subtotal }];
    lines.forEach((l, idx) => {
      const qty = Number(l.qty) || 1;
      const rate = round2(Number(l.price) || 0);
      const amt = round2(qty * rate);
      rows.push(csvRow([
        r.number,
        r.customerName,
        r.customerEmail,
        usDate(r.date),
        usDate(r.dueDate || r.date),
        'Net 30',
        r.jobName,
        `${r.recordType}${r.poNumber ? ' · Job #' + r.poNumber : ''}`,
        r.recordType === 'AIA G702 Pay App' ? 'Progress Billing (G702)' : 'Glazing & Storefront',
        l.desc || r.jobName || 'Glazing work',
        qty,
        rate.toFixed(2),
        amt.toFixed(2),
        l.taxable === false ? 'N' : 'Y',
        idx === 0 ? r.tax.toFixed(2) : '0.00',
        idx === 0 ? r.retainageHeld.toFixed(2) : '0.00',
        idx === 0 ? r.paid.toFixed(2) : '0.00',
        idx === 0 ? r.balanceDue.toFixed(2) : '0.00',
        idx === 0 ? r.paymentRefs : '',
        r.incomeAccount,
        r.arAccount,
      ]));
    });
  }
  return rows.join('\r\n') + '\r\n';
}

export function exportQuickBooksDesktopIif(ledger) {
  const lines = [
    '!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR',
    '!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR',
    '!ENDTRNS',
  ];
  let idSeq = 1;
  for (const je of (ledger.journalEntries || [])) {
    const trnsId = idSeq++;
    const d = usDate(je.date);
    lines.push([
      'TRNS',
      trnsId,
      iifClean(je.trnsType),
      iifClean(d),
      iifClean(je.account),
      iifClean(je.name),
      round2(je.amount).toFixed(2),
      iifClean(je.docNum),
      iifClean(je.memo),
      'N',
    ].join('\t'));

    for (const sp of (je.splits || [])) {
      const splId = idSeq++;
      lines.push([
        'SPL',
        splId,
        iifClean(je.trnsType),
        iifClean(d),
        iifClean(sp.account),
        iifClean(je.name),
        round2(sp.amount).toFixed(2),
        iifClean(je.docNum),
        iifClean(sp.memo),
        'N',
      ].join('\t'));
    }
    lines.push('ENDTRNS');
  }
  return lines.join('\r\n') + '\r\n';
}

export function exportXeroCsv(ledger) {
  const headers = [
    '*ContactName',
    'EmailAddress',
    '*InvoiceNumber',
    'Reference',
    '*InvoiceDate',
    '*DueDate',
    '*Description',
    '*Quantity',
    '*UnitAmount',
    '*AccountCode',
    '*TaxType',
    'TaxAmount',
    'RetainageHeld',
    'AmountPaid',
    'BalanceDue',
    'PaymentRef',
    'Notarized',
    'LienWaiverSigned',
  ];
  const rows = [csvRow(headers)];
  for (const r of (ledger.receivables || [])) {
    const acctCode = (String(r.incomeAccount || '').match(/^(\d+)/)?.[1]) || '4000';
    rows.push(csvRow([
      r.customerName,
      r.customerEmail,
      r.number,
      r.jobName + (r.poNumber ? ` (${r.poNumber})` : ''),
      usDate(r.date),
      usDate(r.dueDate || r.date),
      `${r.recordType} #${r.number} - ${r.jobName || 'Glazing'}`,
      1,
      r.subtotal.toFixed(2),
      acctCode,
      r.tax > 0 ? 'Tax on Sales' : 'Tax Exempt',
      r.tax.toFixed(2),
      r.retainageHeld.toFixed(2),
      r.paid.toFixed(2),
      r.balanceDue.toFixed(2),
      r.paymentRefs,
      r.notarized ? 'Yes' : 'No',
      r.waiverSigned ? 'Yes' : 'No',
    ]));
  }
  return rows.join('\r\n') + '\r\n';
}

export function exportAccountingPackageJson(ledger, { company = {}, notary = DEFAULT_NOTARY } = {}) {
  return JSON.stringify({
    schema: 'stellar-glass-accounting-sync-v1',
    exportedAt: new Date().toISOString(),
    company: {
      name: company.name || 'Stellar Glass, LLC',
      address: company.address || '2850 Mine and Mill Road Bays 3 & 4, Lakeland, FL 33801',
      phone: company.phone || '',
      email: company.email || '',
    },
    accountantAndNotary: notary,
    admins: ADMIN_SIGNERS,
    chartOfAccounts: ledger.accounts,
    summary: ledger.totals,
    receivables: ledger.receivables,
    payments: ledger.payments,
    vendorCommitments: ledger.vendorCommitments,
    journalEntries: ledger.journalEntries,
  }, null, 2);
}
