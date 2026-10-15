// Accounting & Notary Hub for Melina S. Arias (Accountant & Florida Notary Public)
// and admins Wesley Stel & Jason Vergara.
// Provides:
//  1. AIA G702/G703 Notary & Florida Statutory Lien Waiver (§ 713.20) Queue
//  2. Signed & Notarized Document Vault (view & upload directly to job 'documents' / 'forms')
//  3. Accounting Software Sync & Reconciliation Center (QuickBooks Online CSV, QuickBooks Desktop .IIF, Xero CSV, JSON)
//  4. Florida Notary Commission (#HH 427582) & Chart of Accounts Mapping
//  5. Narrated Accountant & Notary Tutorial Video modal
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
  ADMIN_SIGNERS,
  DEFAULT_ACCOUNTS,
  buildAccountingLedger,
  exportQuickBooksOnlineCsv,
  exportQuickBooksDesktopIif,
  exportXeroCsv,
  exportAccountingPackageJson,
} from './accounting-calc.js';

export const ACCOUNTANT_VIDEO_URL = '/media/accountant-walkthrough.mp4';
export const ACCOUNTANT_VTT_URL = '/media/accountant-walkthrough.vtt';

export const ACCOUNTANT_CHAPTERS = [
  {
    step: 1,
    time: 0,
    label: '0:00 · 1. Welcome Melina, Wesley & Jason',
    detail: 'How Melina S. Arias signs in with her Accountant invite from Wesley Stel or Jason Vergara and opens the Accounting & Notary Hub (#/accounting).',
  },
  {
    step: 2,
    time: 26.5,
    label: '0:26 · 2. Contracts & Notarized Document Vault',
    detail: 'Access signed contracts, change orders, W-9s, and GC accounting packages across every job, and upload notarized PDF scans straight into Contracts & documents or Permits & forms.',
  },
  {
    step: 3,
    time: 57.5,
    label: '0:57 · 3. AIA G702/G703 & Notary Seal (#HH 427582)',
    detail: 'Review AIA G702/G703 progress billing, retainage, and deposit offsets, then print with Melina S. Arias’s pre-filled Hillsborough County, Florida Notary Certificate & Commission Seal.',
  },
  {
    step: 4,
    time: 90.5,
    label: '1:30 · 4. Florida § 713.20 Lien Waivers & NTOs',
    detail: 'Generate Partial Waivers upon Progress Payment, Final Waivers, Contractor Affidavits, and NTO Vendor Sworn Statements (e.g. Trulite Glass and Aluminum) with one click.',
  },
  {
    step: 5,
    time: 120,
    label: '2:00 · 5. QuickBooks (.CSV / .IIF) & Xero Sync',
    detail: 'Map your Chart of Accounts, record GC check payments, mark items reconciled, and export balanced QuickBooks Online CSV, QuickBooks Desktop .IIF, or Xero ledger files.',
  },
];

const NOTARY_STORAGE_KEY = 'stellar-notary-profile';
const ACCOUNTS_STORAGE_KEY = 'stellar-chart-of-accounts';
const SYNC_STORAGE_KEY = 'stellar-accounting-sync-map';

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

export function openAccountantTutorialModal(hostEl = document.body) {
  let dlg = hostEl.querySelector('dialog.acct-video-dlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'tk-video-dlg acct-video-dlg';
    dlg.setAttribute('aria-label', 'Accountant and Notary Walkthrough Video for Melina S. Arias, Wesley Stel, and Jason Vergara');
    hostEl.append(dlg);
  }

  dlg.innerHTML = `
    <div class="tk-video-wrap">
      <div class="row between tk-3d-head">
        <div>
          <h2>Stellar Glass — Accountant &amp; Notary Guide (Melina S. Arias, Wesley Stel &amp; Jason Vergara)</h2>
          <p class="small muted">Narrated walkthrough · AIA G702 Notary Certificate, Florida § 713.20 Lien Waivers, Document Vault &amp; QuickBooks Sync</p>
        </div>
        <div class="row">
          <a class="btn small" href="${ACCOUNTANT_VIDEO_URL}" download="Melina-Arias-Stellar-Glass-Accountant-Notary-Guide.mp4">Download MP4</a>
          <button type="button" class="icon" data-vid-close aria-label="Close accountant tutorial video">✕</button>
        </div>
      </div>
      <div class="tk-video-stage">
        <video data-vid-player src="${ACCOUNTANT_VIDEO_URL}" controls playsinline preload="metadata" aria-label="Stellar Glass Accountant and Notary Walkthrough Video">
          <track kind="captions" src="${ACCOUNTANT_VTT_URL}" srclang="en" label="English" default>
        </video>
      </div>
      <div class="chips tk-video-chapters" role="group" aria-label="Video chapters">
        ${ACCOUNTANT_CHAPTERS.map((c, i) => `<button type="button" class="chip ${i === 0 ? 'on' : ''}" data-seek="${c.time}" title="${esc(c.detail)}">${esc(c.label)}</button>`).join('')}
      </div>
      <p class="small muted tk-video-note" data-vid-note aria-live="polite">${esc(ACCOUNTANT_CHAPTERS[0].detail)}</p>
    </div>
  `;

  if (!dlg.open) dlg.showModal();

  const video = dlg.querySelector('[data-vid-player]');
  const noteEl = dlg.querySelector('[data-vid-note]');
  const chips = [...dlg.querySelectorAll('[data-seek]')];

  chips.forEach((btn, idx) => {
    btn.addEventListener('click', () => {
      const sec = Number(btn.dataset.seek) || 0;
      video.currentTime = sec;
      video.play().catch(() => {});
      chips.forEach((c, j) => c.classList.toggle('on', j === idx));
      if (noteEl && ACCOUNTANT_CHAPTERS[idx]) noteEl.textContent = ACCOUNTANT_CHAPTERS[idx].detail;
    });
  });

  video.addEventListener('timeupdate', () => {
    const t = video.currentTime || 0;
    let activeIdx = 0;
    for (let i = 0; i < ACCOUNTANT_CHAPTERS.length; i++) {
      if (t >= ACCOUNTANT_CHAPTERS[i].time) activeIdx = i;
    }
    chips.forEach((c, j) => c.classList.toggle('on', j === activeIdx));
    if (noteEl && ACCOUNTANT_CHAPTERS[activeIdx]) noteEl.textContent = ACCOUNTANT_CHAPTERS[activeIdx].detail;
  });

  dlg.querySelector('[data-vid-close]').onclick = () => {
    video.pause();
    dlg.close();
  };
  dlg.addEventListener('close', () => {
    video.pause();
  }, { once: true });

  video.play().catch(() => {});
}

export function accountingPage() {
  let notary = loadLocalJson(NOTARY_STORAGE_KEY, DEFAULT_NOTARY);
  let accounts = loadLocalJson(ACCOUNTS_STORAGE_KEY, DEFAULT_ACCOUNTS);
  let syncStatus = loadLocalJson(SYNC_STORAGE_KEY, {});
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
      saveLocalJson(NOTARY_STORAGE_KEY, notary);
    }
    if (patch.accounts) {
      accounts = { ...accounts, ...patch.accounts };
      saveLocalJson(ACCOUNTS_STORAGE_KEY, accounts);
    }
    if (patch.syncStatus) {
      syncStatus = { ...syncStatus, ...patch.syncStatus };
      saveLocalJson(SYNC_STORAGE_KEY, syncStatus);
    }
    if (!state.companyId || !canWriteBilling()) return;
    try {
      await setDoc(
        doc(db, 'companies', state.companyId, 'billing', 'accountingSync'),
        {
          notary,
          accounts,
          syncStatus,
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
          <p>AIA G702/G703 notarization, Florida § 713.20 lien waivers, document vault &amp; QuickBooks / Xero sync for ${esc(notary.name)} (${esc(notary.commissionNumber)}), ${esc(ADMIN_SIGNERS[0].name)} &amp; ${esc(ADMIN_SIGNERS[1].name)}.</p>
        </div>
        <div class="actions">
          <button type="button" class="btn primary" data-acct-video>▶ Accountant &amp; Notary Tutorial Video</button>
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

      <div class="card acct-banner">
        <div class="row between">
          <div>
            <h2>🎬 Guided Video Walkthrough for ${esc(notary.name)}</h2>
            <p class="small muted">Covers AIA G702/G703 notarization with Commission #${esc(notary.commissionNumber)}, Florida Statute § 713.20 Progress &amp; Final Lien Waivers, uploading signed scans for ${esc(ADMIN_SIGNERS[0].name)} and ${esc(ADMIN_SIGNERS[1].name)}, and syncing with QuickBooks or Xero.</p>
          </div>
          <div class="row">
            <button type="button" class="btn primary" data-acct-video>▶ Watch Tutorial Video</button>
            <a class="btn" href="${ACCOUNTANT_VIDEO_URL}" download="Melina-Arias-Stellar-Glass-Accountant-Notary-Guide.mp4">Download MP4</a>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="row between">
          <div>
            <h2>1. Notary &amp; Florida Statutory Lien Waiver Queue (F.S. § 713.20)</h2>
            <p class="small muted">Active Notary Public: <b>${esc(notary.name)}</b> · State of ${esc(notary.state)}, County of ${esc(notary.county)} · Commission <b>#${esc(notary.commissionNumber)}</b> (Expires ${esc(notary.commissionExpiresText)})</p>
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
                    <td class="c"><input type="checkbox" data-flag-key="${esc(sk)}" data-flag-field="notarized" ${st.notarized ? 'checked' : ''} aria-label="Mark Pay App ${esc(pa.number)} notarized by ${esc(notary.name)}"></td>
                    <td class="c"><input type="checkbox" data-flag-key="${esc(sk)}" data-flag-field="waiverSigned" ${st.waiverSigned ? 'checked' : ''} aria-label="Mark Lien Waiver signed for Pay App ${esc(pa.number)}"></td>
                    <td class="actions-cell">
                      <a class="btn small primary" href="#/payapps/${esc(pa.id)}/print" title="Print AIA G702/G703 with Melina S. Arias Notary Block">G702 + Notary</a>
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
            <p class="small muted">All job documents in <b>Contracts &amp; documents</b> and <b>Permits &amp; forms</b>. Upload signed &amp; notarized PDF scans here so ${esc(ADMIN_SIGNERS[0].name)}, ${esc(ADMIN_SIGNERS[1].name)}, and ${esc(notary.name)} have them in one place.</p>
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
          <h2>4. Florida Notary Public Profile (${esc(notary.name)})</h2>
          <p class="small muted">Pre-fills the Notary Certificate &amp; Commission Seal on AIA G702 Pay Applications and Florida § 713.20 Lien Waivers.</p>
          <div class="grid2">
            <label>Notary Public Name <input name="name" value="${esc(notary.name)}" required></label>
            <label>Notary Email <input name="email" type="email" value="${esc(notary.email)}"></label>
            <label>State <input name="state" value="${esc(notary.state)}" required></label>
            <label>County <input name="county" value="${esc(notary.county)}" required></label>
            <label>Commission # <input name="commissionNumber" value="${esc(notary.commissionNumber)}" required></label>
            <label>Commission Expires <input name="commissionExpiresText" value="${esc(notary.commissionExpiresText)}" placeholder="October 21, 2027" required></label>
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

    rootEl.querySelectorAll('[data-acct-video]').forEach((btn) => {
      btn.addEventListener('click', () => openAccountantTutorialModal(rootEl));
    });

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
          ...notary,
          ...fd,
          sealName: String(fd.name || 'MELINA ARIAS').toUpperCase(),
        },
      });
      toast(`Saved Florida Notary profile for ${fd.name}`);
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
              saveLocalJson(NOTARY_STORAGE_KEY, notary);
            }
            if (data.accounts) {
              accounts = { ...DEFAULT_ACCOUNTS, ...data.accounts };
              saveLocalJson(ACCOUNTS_STORAGE_KEY, accounts);
            }
            if (data.syncStatus) {
              syncStatus = { ...syncStatus, ...data.syncStatus };
              saveLocalJson(SYNC_STORAGE_KEY, syncStatus);
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
