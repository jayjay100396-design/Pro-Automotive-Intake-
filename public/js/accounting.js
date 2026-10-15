// Accounting & Notary Hub for the accountant and the owners.
// Provides:
//  1. AIA G702/G703 Notary & Florida Statutory Lien Waiver (§ 713.20) Queue
//  2. Signed & Notarized Document Vault (view & upload directly to job 'documents' / 'forms')
//  3. Accounting Software Sync & Reconciliation Center (QuickBooks Online CSV, QuickBooks Desktop .IIF, Xero CSV, JSON)
//  4. Notary profile (typed onto printed notary blocks) & Chart of Accounts Mapping
import { db } from './firebase.js';
import {
  doc, collection, query, orderBy, limit, onSnapshot, setDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { state, get, can, onChange } from './data.js';
import { payAppSummary } from './views.js';
import { money, pctFmt } from './calc.js';
import { esc, fmtDate, badge, toast, options } from './ui.js';
import { safeUrl, problem, uploadOne, copyToDrive } from './files.js';
import * as drive from './drive.js';
import {
  DEFAULT_NOTARY,
  DEFAULT_ACCOUNTS,
  buildAccountingLedger,
  exportQuickBooksOnlineCsv,
  exportQuickBooksDesktopIif,
  exportXeroCsv,
  exportAccountingPackageJson,
} from './accounting-calc.js';

// This device's copies of the business's accounting settings, one set per business (someone can belong to two).
const notaryStorageKey = () => `stellar-notary-profile:${state.companyId || ''}`;
const accountsStorageKey = () => `stellar-chart-of-accounts:${state.companyId || ''}`;
const syncStorageKey = () => `stellar-accounting-sync-map:${state.companyId || ''}`;

function loadLocalJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...fallback, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...fallback };
}

function saveLocalJson(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
}

function downloadBlob(filename, content, mimeType = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function accountingPage() {
  let notary = loadLocalJson(notaryStorageKey(), DEFAULT_NOTARY);
  let accounts = loadLocalJson(accountsStorageKey(), DEFAULT_ACCOUNTS);
  let syncStatus = loadLocalJson(syncStorageKey(), {});
  let docFiles = [];
  let dateFrom = '';
  let dateTo = '';
  let statusFilter = 'all';
  let uploadJobId = '';
  let uploadCategory = 'documents';
  let uploadingMsg = '';
  let rootEl = null;
  let unsubConfig = null;
  let unsubFiles = null;
  let offData = null;

  const canWriteBilling = () => can.bill();

  const persistBillingState = async (patch) => {
    if (patch.notary) {
      notary = { ...notary, ...patch.notary };
      saveLocalJson(notaryStorageKey(), notary);
    }
    if (patch.accounts) {
      accounts = { ...accounts, ...patch.accounts };
      saveLocalJson(accountsStorageKey(), accounts);
    }
    if (patch.syncStatus) {
      syncStatus = { ...syncStatus, ...patch.syncStatus };
      saveLocalJson(syncStorageKey(), syncStatus);
    }
    if (!state.companyId || !canWriteBilling()) return;
    try {
      // Only what changed, so this device's older copy of the rest can't undo someone else's changes.
      await setDoc(
        doc(db, 'companies', state.companyId, 'billing', 'accountingSync'),
        {
          ...(patch.notary ? { notary } : {}),
          ...(patch.accounts ? { accounts } : {}),
          ...(patch.syncStatus ? { syncStatus: patch.syncStatus } : {}),
          updatedAt: serverTimestamp(),
          updatedBy: state.user?.uid || '',
        },
        { merge: true },
      );
    } catch (e) {
      console.warn('Could not sync accounting config to Firestore:', e);
    }
  };

  const computeSummaries = () => {
    const map = {};
    for (const pa of (state.data.payApps || [])) {
      try { map[pa.id] = payAppSummary(pa); } catch { /* ignore */ }
    }
    return map;
  };

  const currentLedger = () => buildAccountingLedger({
    invoices: state.data.invoices || [],
    payApps: state.data.payApps || [],
    payAppSummaries: computeSummaries(),
    contracts: state.data.contracts || [],
    changeOrders: state.data.changeOrders || [],
    customers: state.data.customers || [],
    jobs: state.data.jobs || [],
    partsRequests: state.data.partsRequests || [],
    suppliers: state.data.suppliers || [],
    accounts,
    syncStatus,
    dateFrom,
    dateTo,
    statusFilter,
  });

  const render = () => {
    if (!rootEl) return;
    const d = state.data;
    const paMap = computeSummaries();
    const ledger = currentLedger();
    const t = ledger.totals;
    const payAppsSorted = [...(d.payApps || [])].sort((a, b) => (Number(b.number) || 0) - (Number(a.number) || 0));
    const jobsList = [...(d.jobs || [])].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    if (!uploadJobId && jobsList.length) uploadJobId = jobsList[0].id;

    rootEl.innerHTML = `
      <div class="page-head">
        <div class="page-title">
          <h1>Accounting &amp; Notary Hub</h1>
          <p>AIA G702/G703 notarization, Florida § 713.20 lien waivers, the document vault &amp; QuickBooks / Xero exports.</p>
        </div>
        <div class="actions">
          <a class="btn" href="#/accounting/waiver/print?kind=progress">⚖️ Florida Lien Waiver (§ 713.20)</a>
          <button type="button" class="btn" data-export="qbo">⬇ QuickBooks Online (.CSV)</button>
          <button type="button" class="btn" data-export="iif">⬇ QuickBooks Desktop (.IIF)</button>
          <button type="button" class="btn" data-export="xero">⬇ Xero / Sage (.CSV)</button>
        </div>
      </div>

      <div class="tiles">
        <div class="tile"><span class="t-label">Total Billed</span><span class="t-value">${money(t.totalBilled)}</span><span class="t-sub">${ledger.receivables.length} billing record${ledger.receivables.length === 1 ? '' : 's'}</span></div>
        <div class="tile"><span class="t-label">Total Collected</span><span class="t-value">${money(t.totalCollected)}</span><span class="t-sub">${ledger.payments.length} payment${ledger.payments.length === 1 ? '' : 's'} recorded</span></div>
        <div class="tile"><span class="t-label">Open AR Balance</span><span class="t-value">${money(t.totalOpenAR)}</span><span class="t-sub">${esc(accounts.arAccount)}</span></div>
        <div class="tile"><span class="t-label">Retainage Held</span><span class="t-value">${money(t.totalRetainageHeld)}</span><span class="t-sub">${esc(accounts.retainageAccount)}</span></div>
        <div class="tile"><span class="t-label">FL Sales Tax</span><span class="t-value">${money(t.totalSalesTax)}</span><span class="t-sub">${esc(accounts.salesTaxAccount)}</span></div>
        <div class="tile"><span class="t-label">Ready to Sync</span><span class="t-value">${t.unsyncedCount}</span><span class="t-sub">${t.pendingNotaryCount} pay app${t.pendingNotaryCount === 1 ? '' : 's'} awaiting notary check</span></div>
      </div>

      <div class="card">
        <div class="row between">
          <div>
            <h2>1. Notary &amp; Florida Statutory Lien Waiver Queue (F.S. § 713.20)</h2>
            <p class="small muted">${notary.name ? `Notary typed onto printed notary blocks: <b>${esc(notary.name)}</b>${notary.commissionNumber ? ` · Commission #${esc(notary.commissionNumber)}` : ''}${notary.commissionExpiresText ? ` (expires ${esc(notary.commissionExpiresText)})` : ''}` : 'Printed notary blocks are blank for the notary to fill in. Add the notary\'s details in section 4 to have them typed in.'}</p>
          </div>
          <a class="btn small" href="#/payapps">Open Pay Apps List</a>
        </div>
        ${payAppsSorted.length ? `
          <div class="scroll top-gap">
            <table class="list">
              <thead>
                <tr>
                  <th>App #</th>
                  <th>Job &amp; Contract</th>
                  <th>Customer / GC</th>
                  <th>Period To</th>
                  <th>Status</th>
                  <th class="num">Completed</th>
                  <th class="num">Retainage</th>
                  <th class="num">Current Due</th>
                  <th>Notarized</th>
                  <th>Waiver Signed</th>
                  <th>Actions (Print / PDF)</th>
                </tr>
              </thead>
              <tbody>
                ${payAppsSorted.map((pa) => {
                  const s = paMap[pa.id] || { totalCompleted: 0, totalRetainage: 0, currentDue: 0 };
                  const j = get('jobs', pa.jobId) || {};
                  const c = get('contracts', pa.contractId) || {};
                  const cu = get('customers', pa.customerId || c.customerId || j.customerId) || {};
                  const sk = `pa:${pa.id}`;
                  const st = syncStatus[sk] || {};
                  return `<tr>
                    <td><a href="#/payapps/${esc(pa.id)}"><b>PA #${esc(pa.number)}</b></a></td>
                    <td><a href="#/jobs/${esc(j.id || '')}">${esc(j.name || '(no job)')}</a>${c.number ? `<br><span class="small muted">Contract #${esc(c.number)}</span>` : ''}</td>
                    <td>${esc(cu.company || cu.name || '—')}</td>
                    <td>${fmtDate(pa.periodTo)}</td>
                    <td>${badge(pa.status)}</td>
                    <td class="num">${money(s.totalCompleted)}</td>
                    <td class="num">${money(s.totalRetainage)}</td>
                    <td class="num"><b>${money(s.currentDue)}</b></td>
                    <td class="c"><input type="checkbox" data-flag-key="${esc(sk)}" data-flag-field="notarized" ${st.notarized ? 'checked' : ''} aria-label="Mark Pay App ${esc(pa.number)} notarized"></td>
                    <td class="c"><input type="checkbox" data-flag-key="${esc(sk)}" data-flag-field="waiverSigned" ${st.waiverSigned ? 'checked' : ''} aria-label="Mark Lien Waiver signed for Pay App ${esc(pa.number)}"></td>
                    <td class="actions-cell">
                      <a class="btn small primary" href="#/payapps/${esc(pa.id)}/print" title="Print AIA G702/G703 with a notary block">G702 + Notary</a>
                      <a class="btn small" href="#/accounting/waiver/print?payApp=${esc(pa.id)}&amp;kind=progress" title="Print Florida § 713.20(4) Partial Lien Waiver Upon Progress Payment">Partial Waiver</a>
                      <a class="btn small" href="#/accounting/waiver/print?payApp=${esc(pa.id)}&amp;kind=final" title="Print Florida § 713.20(5) Final Lien Waiver">Final Waiver</a>
                      <a class="btn small" href="#/accounting/waiver/print?payApp=${esc(pa.id)}&amp;kind=sworn" title="Print NTO Vendor Sworn Statement">Sworn Stmt</a>
                    </td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : '<p class="muted top-gap">No AIA G702 Pay Applications yet. Open a Contract to start a Pay App.</p>'}
      </div>

      <div class="card">
        <div class="row between">
          <div>
            <h2>2. Signed &amp; Notarized Document Vault (Contracts, Pay Apps, Waivers &amp; Forms)</h2>
            <p class="small muted">All job documents in <b>Contracts &amp; documents</b> and <b>Permits &amp; forms</b>. Upload signed &amp; notarized PDF scans here so the whole team has them in one place.</p>
          </div>
          <a class="btn small" href="#/files">Open Full File Browser</a>
        </div>

        ${canWriteBilling() && jobsList.length ? `
          <form class="grid4 top-gap acct-upload-bar" id="acctUploadForm">
            <label>Job
              <select name="jobId" required>${options(jobsList.map((j) => [j.id, `${j.name}${j.poNumber ? ' (#' + j.poNumber + ')' : ''}`]), uploadJobId)}</select>
            </label>
            <label>Folder Category
              <select name="category">
                <option value="documents" ${uploadCategory === 'documents' ? 'selected' : ''}>Contracts &amp; documents</option>
                <option value="forms" ${uploadCategory === 'forms' ? 'selected' : ''}>Permits &amp; forms (Waivers / W-9 / COI)</option>
              </select>
            </label>
            <label>Document Note (optional)
              <input name="note" placeholder="e.g. Notarized PA #3 &amp; Partial Waiver thru 04/25/2026">
            </label>
            <label>&nbsp;
              <button type="button" class="btn primary" id="acctPickBtn">${uploadingMsg ? esc(uploadingMsg) : '＋ Upload Notarized PDF / Scan'}</button>
              <input type="file" id="acctFileInput" accept="application/pdf,image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv" multiple hidden>
            </label>
          </form>
        ` : ''}

        ${docFiles.length ? `
          <div class="scroll top-gap">
            <table class="list">
              <thead>
                <tr>
                  <th>Document Name</th>
                  <th>Job</th>
                  <th>Category</th>
                  <th>Added By</th>
                  <th>Date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${docFiles.map((f) => {
                  const j = get('jobs', f.jobId) || {};
                  const url = safeUrl(f.url);
                  const catName = f.category === 'forms' ? 'Permits & forms' : 'Contracts & documents';
                  const dt = f.createdAt?.toDate ? f.createdAt.toDate().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
                  return `<tr>
                    <td><b>${esc(f.name)}</b>${f.note ? `<br><span class="small muted">${esc(f.note)}</span>` : ''}</td>
                    <td><a href="#/jobs/${esc(f.jobId)}">${esc(j.name || 'Job')}</a></td>
                    <td>${badge(catName)}</td>
                    <td>${esc(f.createdByName || 'Team')}</td>
                    <td>${esc(dt)}</td>
                    <td class="actions-cell">
                      ${url ? `<a class="btn small primary" href="${esc(url)}" target="_blank" rel="noopener">View / Download</a>` : ''}
                      <a class="btn small" href="#/files?job=${esc(f.jobId)}">In Job Files</a>
                    </td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : '<p class="muted top-gap">No documents or forms uploaded yet.</p>'}
      </div>

      <div class="card">
        <div class="row between">
          <div>
            <h2>3. Accounting Software Sync &amp; Reconciliation Ledger</h2>
            <p class="small muted">Export Invoices, AIA G702 Pay Apps, Retainage Receivable, and Check / Stripe Payments into QuickBooks Online (.CSV), QuickBooks Desktop (.IIF), Xero (.CSV), or JSON.</p>
          </div>
          <div class="row">
            <button type="button" class="btn small primary" data-mark-all-synced>✓ Mark Visible Synced</button>
            <button type="button" class="btn small" data-export="json">⬇ JSON Sync Feed</button>
          </div>
        </div>

        <div class="grid4 top-gap" id="acctFilterBar">
          <label>From Date
            <input type="date" name="dateFrom" value="${esc(dateFrom)}">
          </label>
          <label>To Date
            <input type="date" name="dateTo" value="${esc(dateTo)}">
          </label>
          <label>Filter Status
            <select name="statusFilter">
              <option value="all" ${statusFilter === 'all' ? 'selected' : ''}>All Billing Records (${ledger.receivables.length})</option>
              <option value="unsynced" ${statusFilter === 'unsynced' ? 'selected' : ''}>Unsynced Only (${t.unsyncedCount})</option>
              <option value="synced" ${statusFilter === 'synced' ? 'selected' : ''}>Synced Only</option>
              <option value="open" ${statusFilter === 'open' ? 'selected' : ''}>Open AR Balance Only</option>
            </select>
          </label>
          <label>&nbsp;
            <button type="button" class="btn" id="acctResetFilter">Reset Filters</button>
          </label>
        </div>

        ${ledger.receivables.length ? `
          <div class="scroll top-gap">
            <table class="list">
              <thead>
                <tr>
                  <th>Synced</th>
                  <th>Doc #</th>
                  <th>Type</th>
                  <th>Date</th>
                  <th>Customer / GC</th>
                  <th>Job</th>
                  <th class="num">Total</th>
                  <th class="num">Retainage</th>
                  <th class="num">Paid</th>
                  <th class="num">Balance Due</th>
                  <th>Check / Payment Ref</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${ledger.receivables.map((r) => {
                  const openHref = r.recordType === 'AIA G702 Pay App' ? `#/payapps/${esc(r.id)}` : `#/invoices/${esc(r.id)}`;
                  const printHref = r.recordType === 'AIA G702 Pay App' ? `#/payapps/${esc(r.id)}/print` : `#/invoices/${esc(r.id)}/print`;
                  const waiverHref = r.payAppId
                    ? `#/accounting/waiver/print?payApp=${esc(r.payAppId)}&amp;kind=progress`
                    : `#/accounting/waiver/print?invoice=${esc(r.id)}&amp;kind=progress`;
                  return `<tr>
                    <td class="c"><input type="checkbox" data-flag-key="${esc(r.key)}" data-flag-field="synced" ${r.synced ? 'checked' : ''} aria-label="Mark ${esc(r.recordType)} ${esc(r.number)} synced to accounting software"></td>
                    <td><a href="${openHref}"><b>${esc(r.number)}</b></a></td>
                    <td>${esc(r.recordType)}</td>
                    <td>${fmtDate(r.date)}</td>
                    <td>${esc(r.customerName)}</td>
                    <td>${esc(r.jobName)}</td>
                    <td class="num">${money(r.total)}</td>
                    <td class="num">${r.retainageHeld ? money(r.retainageHeld) : '—'}</td>
                    <td class="num">${money(r.paid)}</td>
                    <td class="num"><b>${money(r.balanceDue)}</b></td>
                    <td>${r.recordType === 'AIA G702 Pay App'
                      ? `<input class="acct-ref-in" data-check-key="${esc(r.key)}" value="${esc(r.checkNumber || '')}" placeholder="Check #" aria-label="Check number for ${esc(r.number)}">`
                      : esc(r.paymentRefs || '—')}</td>
                    <td class="actions-cell">
                      <a class="btn small" href="${printHref}">Print</a>
                      <a class="btn small" href="${waiverHref}">Waiver</a>
                    </td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : '<p class="muted top-gap">No billing records match the selected filters.</p>'}

        <h3 class="top-gap">Payments Received &amp; Check Register</h3>
        ${ledger.payments.length ? `
          <div class="scroll">
            <table class="list">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Method</th>
                  <th>Check / Ref #</th>
                  <th>Customer / GC</th>
                  <th>Job</th>
                  <th>Invoice / Pay App</th>
                  <th>Deposit Account</th>
                  <th class="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                ${ledger.payments.map((p) => `<tr>
                  <td>${fmtDate(p.date)}</td>
                  <td>${badge(p.method)}</td>
                  <td><b>${esc(p.reference || '—')}</b></td>
                  <td>${esc(p.customerName)}</td>
                  <td>${esc(p.jobName)}</td>
                  <td><a href="${p.invoiceId ? `#/invoices/${esc(p.invoiceId)}` : `#/payapps/${esc(p.payAppId)}`}">#${esc(p.invoiceNumber)}</a></td>
                  <td class="small muted">${esc(p.depositAccount)}</td>
                  <td class="num"><b>${money(p.amount)}</b></td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        ` : '<p class="muted small">No payments recorded in this date range. Open any Invoice to record a GC check, ACH, cash, or Stripe payment.</p>'}

        <h3 class="top-gap">NTO Supplier &amp; Parts Commitments (Sworn Statement Verification)</h3>
        ${ledger.vendorCommitments.length ? `
          <div class="scroll">
            <table class="list">
              <thead>
                <tr>
                  <th>Supplier / NTO Vendor</th>
                  <th>Job</th>
                  <th>Order Status</th>
                  <th>Items</th>
                  <th class="num">Quote Total</th>
                  <th>Account</th>
                  <th>Sworn Statement</th>
                </tr>
              </thead>
              <tbody>
                ${ledger.vendorCommitments.map((v) => `<tr>
                  <td><b>${esc(v.supplierName)}</b></td>
                  <td><a href="#/jobs/${esc(v.jobId)}">${esc(v.jobName || 'Job')}</a></td>
                  <td>${badge(v.status)}</td>
                  <td>${v.itemCount} item${v.itemCount === 1 ? '' : 's'}</td>
                  <td class="num"><b>${v.amount ? money(v.amount) : '—'}</b></td>
                  <td class="small muted">${esc(v.account)}</td>
                  <td><a class="btn small" href="#/accounting/waiver/print?job=${esc(v.jobId)}&amp;kind=sworn&amp;vendor=${encodeURIComponent(v.supplierName)}&amp;vendorBalanceCurrent=${encodeURIComponent(v.amount || 0)}">Print Sworn Statement</a></td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        ` : '<p class="muted small">No active supplier parts orders yet.</p>'}
      </div>

      <div class="cols">
        <form class="card stack" id="notarySettingsForm">
          <h2>4. Notary profile</h2>
          <p class="small muted">Typed onto the notary block of printed pay apps and lien waivers. The county, the date, how the signer appeared, their ID, the signature and the seal stay blank for the notary to complete at the signing. Saved with the business, so only its members see it.</p>
          <div class="grid2">
            <label>Notary's commissioned name <input name="name" value="${esc(notary.name)}"></label>
            <label>State <input name="state" value="${esc(notary.state)}"></label>
            <label>Commission # <input name="commissionNumber" value="${esc(notary.commissionNumber)}"></label>
            <label>Commission expires <input name="commissionExpiresText" value="${esc(notary.commissionExpiresText)}" placeholder="e.g. June 30, 2028"></label>
          </div>
          <div class="row"><button class="btn primary">Save Notary Profile</button></div>
        </form>

        <form class="card stack" id="coaSettingsForm">
          <h2>5. Accounting Software Chart of Accounts</h2>
          <p class="small muted">Account names &amp; codes mapped onto QuickBooks Online (.CSV), QuickBooks Desktop (.IIF), and Xero exports.</p>
          <div class="grid2">
            <label>Accounts Receivable <input name="arAccount" value="${esc(accounts.arAccount)}" required></label>
            <label>Retainage Receivable <input name="retainageAccount" value="${esc(accounts.retainageAccount)}" required></label>
            <label>Checking / Undeposited Funds <input name="undepositedAccount" value="${esc(accounts.undepositedAccount)}" required></label>
            <label>Customer Deposits Liability <input name="depositLiabilityAccount" value="${esc(accounts.depositLiabilityAccount)}" required></label>
            <label>Commercial Glazing Income <input name="glazingIncomeAccount" value="${esc(accounts.glazingIncomeAccount)}" required></label>
            <label>Shower &amp; Interior Glass Income <input name="showerIncomeAccount" value="${esc(accounts.showerIncomeAccount)}" required></label>
            <label>Florida Sales Tax Payable <input name="salesTaxAccount" value="${esc(accounts.salesTaxAccount)}" required></label>
            <label>COGS - Glass &amp; Aluminum <input name="cogsAccount" value="${esc(accounts.cogsAccount)}" required></label>
          </div>
          <div class="row"><button class="btn primary">Save Chart of Accounts</button></div>
        </form>
      </div>
    `;

    bindEvents();
  };

  function bindEvents() {
    if (!rootEl) return;

    rootEl.querySelectorAll('[data-export]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fmt = btn.dataset.export;
        const ledger = currentLedger();
        const stamp = new Date().toISOString().slice(0, 10);
        if (fmt === 'qbo') {
          downloadBlob(`Stellar-Glass-QuickBooks-Online-${stamp}.csv`, exportQuickBooksOnlineCsv(ledger), 'text/csv;charset=utf-8');
          toast('Downloaded QuickBooks Online (.CSV) sync file');
        } else if (fmt === 'iif') {
          downloadBlob(`Stellar-Glass-QuickBooks-Desktop-${stamp}.iif`, exportQuickBooksDesktopIif(ledger), 'text/plain;charset=utf-8');
          toast('Downloaded QuickBooks Desktop (.IIF) general ledger file');
        } else if (fmt === 'xero') {
          downloadBlob(`Stellar-Glass-Xero-Sage-Ledger-${stamp}.csv`, exportXeroCsv(ledger), 'text/csv;charset=utf-8');
          toast('Downloaded Xero / Sage (.CSV) accounting ledger');
        } else if (fmt === 'json') {
          downloadBlob(`Stellar-Glass-Accounting-Package-${stamp}.json`, exportAccountingPackageJson(ledger, { company: state.company || {}, notary }), 'application/json;charset=utf-8');
          toast('Downloaded JSON Accounting Sync Package');
        }
      });
    });

    rootEl.querySelectorAll('[data-flag-key]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const key = cb.dataset.flagKey;
        const field = cb.dataset.flagField;
        const prev = syncStatus[key] || {};
        const nextEntry = {
          ...prev,
          [field]: cb.checked,
          ...(field === 'synced' ? { syncedAt: cb.checked ? new Date().toISOString() : '' } : {}),
        };
        await persistBillingState({ syncStatus: { [key]: nextEntry } });
        toast(cb.checked ? 'Marked complete' : 'Unmarked');
        render();
      });
    });

    rootEl.querySelectorAll('[data-check-key]').forEach((inp) => {
      inp.addEventListener('change', async () => {
        const key = inp.dataset.checkKey;
        const prev = syncStatus[key] || {};
        const nextEntry = {
          ...prev,
          checkNumber: inp.value.trim(),
        };
        if (key && key.startsWith('pa:')) {
          const paId = key.slice(3);
          const paRec = (state.data.payApps || []).find((p) => p.id === paId);
          if (paRec) paRec.checkNumber = nextEntry.checkNumber;
        }
        await persistBillingState({ syncStatus: { [key]: nextEntry } });
        toast(nextEntry.checkNumber ? `Saved Check #${nextEntry.checkNumber}` : 'Cleared check reference');
        render();
      });
    });

    rootEl.querySelector('[data-mark-all-synced]')?.addEventListener('click', async () => {
      const ledger = currentLedger();
      const patch = {};
      const nowIso = new Date().toISOString();
      for (const r of ledger.receivables) {
        patch[r.key] = { ...(syncStatus[r.key] || {}), synced: true, syncedAt: nowIso };
      }
      await persistBillingState({ syncStatus: patch });
      toast(`Marked ${ledger.receivables.length} record(s) synced with accounting software`);
      render();
    });

    const filterBar = rootEl.querySelector('#acctFilterBar');
    if (filterBar) {
      filterBar.addEventListener('change', () => {
        dateFrom = filterBar.querySelector('[name="dateFrom"]')?.value || '';
        dateTo = filterBar.querySelector('[name="dateTo"]')?.value || '';
        statusFilter = filterBar.querySelector('[name="statusFilter"]')?.value || 'all';
        render();
      });
      rootEl.querySelector('#acctResetFilter')?.addEventListener('click', () => {
        dateFrom = '';
        dateTo = '';
        statusFilter = 'all';
        render();
      });
    }

    const upForm = rootEl.querySelector('#acctUploadForm');
    const pickBtn = rootEl.querySelector('#acctPickBtn');
    const fileInput = rootEl.querySelector('#acctFileInput');
    if (upForm && pickBtn && fileInput) {
      upForm.addEventListener('change', () => {
        uploadJobId = upForm.elements.jobId.value;
        uploadCategory = upForm.elements.category.value;
      });
      pickBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const picked = [...(fileInput.files || [])];
        fileInput.value = '';
        if (!picked.length) return;
        const job = get('jobs', upForm.elements.jobId.value);
        if (!job) return toast('Select a job first.', true);
        const cat = upForm.elements.category.value || 'documents';
        const noteText = upForm.elements.note.value.trim();

        for (const f of picked) {
          const err = problem(f);
          if (err) return toast(err, true);
        }

        try {
          for (let i = 0; i < picked.length; i++) {
            const f = picked[i];
            uploadingMsg = `Uploading ${i + 1}/${picked.length}…`;
            pickBtn.textContent = uploadingMsg;
            pickBtn.disabled = true;
            const rec = await uploadOne(f, job, cat);
            if (noteText) {
              const { update } = await import('./data.js');
              await update('files', rec.id, { note: noteText }).catch(() => {});
            }
            if (state.profile?.driveAutoCopy && drive.driveAccount()) {
              await copyToDrive({ ...rec, note: noteText }, f).catch((e) => console.warn('Drive auto-copy:', e));
            }
          }
          uploadingMsg = '';
          toast(`Uploaded ${picked.length} document${picked.length === 1 ? '' : 's'} to ${job.name}`);
          render();
        } catch (e) {
          console.error(e);
          uploadingMsg = '';
          toast(e.message || 'Upload failed', true);
          render();
        }
      });
    }

    rootEl.querySelector('#notarySettingsForm')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(ev.target));
      await persistBillingState({
        notary: {
          name: String(fd.name || '').trim(),
          state: String(fd.state || '').trim() || 'Florida',
          commissionNumber: String(fd.commissionNumber || '').trim(),
          commissionExpiresText: String(fd.commissionExpiresText || '').trim(),
        },
      });
      toast('Saved the notary profile');
      render();
    });

    rootEl.querySelector('#coaSettingsForm')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(ev.target));
      await persistBillingState({ accounts: fd });
      toast('Saved Chart of Accounts mapping');
      render();
    });
  }

  return {
    live: false,
    html: '<div data-accounting-root><p class="muted">Loading Accounting &amp; Notary Hub…</p></div>',
    mount(root) {
      rootEl = root.querySelector('[data-accounting-root]') || root;
      render();

      if (state.companyId) {
        unsubConfig = onSnapshot(
          doc(db, 'companies', state.companyId, 'billing', 'accountingSync'),
          (snap) => {
            if (!snap.exists()) return;
            const data = snap.data() || {};
            if (data.notary) {
              notary = { ...DEFAULT_NOTARY, ...data.notary };
              saveLocalJson(notaryStorageKey(), notary);
            }
            if (data.accounts) {
              accounts = { ...DEFAULT_ACCOUNTS, ...data.accounts };
              saveLocalJson(accountsStorageKey(), accounts);
            }
            if (data.syncStatus) {
              syncStatus = { ...syncStatus, ...data.syncStatus };
              saveLocalJson(syncStorageKey(), syncStatus);
            }
            render();
          },
          () => {},
        );

        const filesCol = collection(db, 'companies', state.companyId, 'files');
        unsubFiles = onSnapshot(
          query(filesCol, orderBy('createdAt', 'desc'), limit(250)),
          (snap) => {
            docFiles = snap.docs
              .map((d) => ({ id: d.id, ...d.data() }))
              .filter((f) => ['documents', 'forms'].includes(f.category));
            render();
          },
          () => {},
        );
      }

      offData = onChange(() => render());
    },
    unmount() {
      unsubConfig?.();
      unsubFiles?.();
      offData?.();
      rootEl = null;
    },
  };
}
