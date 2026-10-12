// Parts orders: quote requests and orders to suppliers, the email that goes with each, and tracking every order
// until it's all in. Each one is companies/{company}/partsRequests/{id}:
//   number, jobId, customerId, estimateId, supplierId, kind ('quote' | 'order'), listType ('parts' | 'glass' |
//   'general'), items [{ heading } or { qty, unit, partNo, desc, width, height, edge, mark, got }], po, neededBy,
//   delivery, deliverTo, subject, intro, notes, signature, ccMe, ccOffice, attachments (job file ids),
//   status (PARTS_STATUS in parts-email.js), requestedOn, quotedOn, quoteRef, quoteTotal, orderedOn, orderRef,
//   confirmedOn, expectedOn, shippedOn, tracking, receivedOn, lastEmail { what, via, at },
//   events [{ at, status, note, by }] (the history), and appEmail, which only the server writes when the app sends
//   an email (functions-parts/parts-request.js). Suppliers: suppliers.js. The emails: parts-email.js.
import { db, callFunction } from './firebase.js';
import { collection, query, where as fwhere, getDocs, arrayUnion } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { state, add, update, remove, get, where, nextNumber, can, onChange } from './data.js';
import * as PE from './parts-email.js';
import { pluginFor } from './supplier-plugins.js';
import { codeOf, sentenceOf, noAnswer } from './call-errors.js';
import { esc, options, toast, empty, fmtDate, formData } from './ui.js';
import { money } from './calc.js';

const go = (hash) => { location.hash = hash; };
const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
const D = () => state.data;
// Today on this device, as "YYYY-MM-DD".
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const me = () => state.user?.displayName || state.user?.email || 'Someone';
const event = (status, note = '') => ({ at: new Date().toISOString(), status, note: String(note).slice(0, 300), by: me() });
const jobName = (id) => get('jobs', id)?.name || '';
const supplierName = (id) => get('suppliers', id)?.name || '';
const MB = 1024 * 1024;
const fmtSize = (n) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const fmtWhen = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const WHAT = { request: 'Request', order: 'Order', followup: 'Update request' };
const VIA = { app: 'from the app', gmail: 'from Gmail', email: 'from the email app', copy: 'by copying it into an email' };
const sizeText = (it) => (it.width && it.height ? `${PE.fmtInches(it.width)}" x ${PE.fmtInches(it.height)}"` : '');
const itemLabel = (it) => [it.partNo, it.desc, sizeText(it), it.edge, it.mark && `mark ${it.mark}`].filter(Boolean).join(' – ');

async function attempt(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { console.error(e); toast(e.code === 'permission-denied' ? 'Your role can\'t make that change.' : e.message, true); return null; }
}

// Waits, up to `ms`, until the app's copy of the data passes `test` (a change the server made reaches it a moment later).
const waitFor = (test, ms = 5000) => new Promise((resolve) => {
  if (test()) { resolve(true); return; }
  let timer;
  const stop = onChange(() => { if (test()) { stop(); clearTimeout(timer); resolve(true); } });
  timer = setTimeout(() => { stop(); resolve(false); }, ms);
});

export const statusBadge = (r, today = localDay()) => `<span class="badge s-${esc(r.status)}">${esc(PE.STATUS_LABEL[r.status] || r.status || '')}</span>${PE.isLate(r, today) ? ' <span class="badge s-late">Late</span>' : ''}`;
const standing = (r, today) => { const n = PE.trackingNote(r, today); return `<span class="${n.level}">${esc(n.text)}</span>`; };
export const openPartsCount = () => D().partsRequests.filter(PE.isOpen).length;
export const latePartsCount = () => { const t = localDay(); return D().partsRequests.filter((r) => PE.isLate(r, t)).length; };
// Open orders expected in the next 7 days.
export const dueSoonCount = () => { const t = localDay(); return D().partsRequests.filter((r) => PE.isOpen(r) && r.expectedOn >= t && PE.daysBetween(t, r.expectedOn) <= 7).length; };

// The person sending, for the signature: what they put on proposals (Prepared by), else their sign-in.
function person() {
  const p = state.profile?.preparedBy || {};
  return { name: p.name || state.user?.displayName || '', title: p.title || '', phone: p.phone || '', email: p.email || state.user?.email || '' };
}
// The Google account to open Gmail in, when they signed in with Google.
const googleAccount = () => state.user?.providerData?.find((p) => p.providerId === 'google.com')?.email || '';

// The email about a request, and who it goes to. Copies to yourself are left out when it goes from your own email.
function emailFor(r, what, { attachments = [], fromOwnEmail = false, note = '' } = {}) {
  const supplier = get('suppliers', r.supplierId) || {};
  const company = state.company || {};
  const mail = PE.buildPartsEmail({ request: r, supplier, job: get('jobs', r.jobId) || {}, company, attachments, note }, what);
  const mine = String(state.user?.email || '').toLowerCase();
  const { to, cc } = PE.recipients({ request: r, supplier, company, senderEmail: state.user?.email || '' });
  return { ...mail, to, cc: fromOwnEmail ? cc.filter((e) => e.toLowerCase() !== mine) : cc, supplier };
}

// What the server says when it can't send, in words for the person (call-errors.js drops the status Firebase adds).
// waited: how long the call took. No answer after a long wait means the server may have sent it before it was cut off.
function sendProblem(e, waited = 0) {
  const code = codeOf(e);
  if (code === 'deadline-exceeded' || (noAnswer(e) && waited > 60000)) {
    return 'The app didn\'t hear back, so the email may have gone out. Check the request\'s History before you send it again.';
  }
  // With no code the call never started: the library that makes it didn't load.
  if ((!code || noAnswer(e)) && navigator.onLine === false) return 'You\'re offline. Send it once you\'re connected.';
  // Online but no answer: not deployed yet, or the connection to it is down (DNS, a hotel Wi-Fi sign-in page). The
  // browser can't tell which, so the words cover both.
  if (noAnswer(e)) return 'The app couldn\'t reach its email sender: it isn\'t set up yet (EMAIL_ALERTS.md), or the connection is down. Try again, or use Open in Gmail.';
  if (code === 'unauthenticated') return 'Sign in again, then send it.';
  return (code && sentenceOf(e)) || 'The email didn\'t go out. Try again, or use Open in Gmail.';
}

// Notes on the request that it went out by Gmail, the email app or a copy (the server does this when the app
// sends it). Sending the request moves a draft along; placing the order makes it an order.
async function markSent(id, what, via) {
  const r = get('partsRequests', id);
  if (!r) return;
  const today = localDay();
  const fields = { lastEmail: { what, via, at: new Date().toISOString() } };
  if (what === 'request' && r.status === 'draft') {
    fields.status = r.kind === 'order' ? 'ordered' : 'sent';
    fields[r.kind === 'order' ? 'orderedOn' : 'requestedOn'] = today;
  }
  if (what === 'order' && ['draft', 'sent', 'quoted'].includes(r.status)) {
    Object.assign(fields, { status: 'ordered', kind: 'order', orderedOn: today });
  }
  fields.events = arrayUnion(event(fields.status || r.status, `${WHAT[what]} emailed ${VIA[via]}`));
  if (await attempt(() => update('partsRequests', id, fields), 'Noted') !== null) go(`#/parts/${id}`);
}

// Asks the server to email the supplier (functions-parts/parts-request.js). It sends to the supplier's saved
// addresses only, and notes it on the request.
async function sendFromApp(id, what, button, note = '') {
  const r = get('partsRequests', id);
  const supplier = get('suppliers', r?.supplierId);
  if (!supplier) return toast('Pick the supplier first.', true);
  const { to } = emailFor(r, what);
  if (!to.length) return toast(`There's no email saved for ${supplier.name}. Add it under Suppliers, or use Open in Gmail.`, true);
  if (what !== 'followup') {
    const problems = PE.requestProblems(r);
    if (problems.length) return toast(problems[0], true);
  }
  if (!confirm(`Email ${what === 'followup' ? 'an update request' : `this ${what === 'order' || r.kind === 'order' ? 'order' : 'quote request'}`} to ${to.join(', ')}?`)) return;
  const sendId = crypto.randomUUID();
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Sending…';
  const started = Date.now();
  let res;
  try {
    res = await callFunction('sendPartsEmail', { companyId: state.companyId, requestId: id, what, sendId, note });
  } catch (e) {
    console.error(e);
    toast(sendProblem(e, Date.now() - started), true);
    button.disabled = false;
    button.textContent = label;
    return;
  }
  toast(`Emailed to ${(res.to || to).join(', ')}`);
  // Shows it once the server's note that it went is here.
  await waitFor(() => get('partsRequests', id)?.appEmail?.sendId === sendId);
  go(`#/parts/${id}`);
  rerender();
}

// ---------- The list: every request and where it stands ----------
const SHOW = [['open', 'Open'], ['late', 'Late'], ['draft', 'Drafts'], ['done', 'Received'], ['all', 'All']];

export function partsList(params) {
  const today = localDay();
  const show = SHOW.some(([k]) => k === params.get('show')) ? params.get('show') : 'open';
  const sup = params.get('supplier') || '';
  const all = [...D().partsRequests].sort((a, b) => (Number(b.number) || 0) - (Number(a.number) || 0));
  const pick = {
    open: PE.isOpen, late: (r) => PE.isLate(r, today), draft: (r) => r.status === 'draft', done: (r) => ['received', 'cancelled'].includes(r.status), all: () => true,
  };
  let rows = all.filter(pick[show]).filter((r) => !sup || r.supplierId === sup);
  // Open orders soonest first: late ones, then by expected date, then the ones with no date.
  if (show === 'open' || show === 'late') rows = rows.sort((a, b) => (a.expectedOn || '9999').localeCompare(b.expectedOn || '9999'));
  const open = all.filter(PE.isOpen);
  const late = open.filter((r) => PE.isLate(r, today));
  const tile = (key, label, n, sub, cls = '') => `<a class="tile" href="#/parts?show=${key}"><span class="t-label">${label}</span><span class="t-value ${cls}">${n}</span><span class="t-sub">${sub}</span></a>`;
  const suppliers = [...D().suppliers].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const link = (k) => `#/parts?show=${k}${sup ? `&supplier=${encodeURIComponent(sup)}` : ''}`;

  return {
    live: true,
    html: `<div class="page-head"><div class="page-title"><h1>Parts orders</h1></div><div class="actions"><a class="btn" href="#/suppliers">Suppliers</a>
      ${can.edit() ? '<a class="btn primary" href="#/parts/new">New parts request</a>' : ''}</div></div>
    <div class="tiles small">
      ${tile('late', 'Late', late.length, 'past the expected date', late.length ? 'late' : '')}
      ${tile('open', 'On order', open.filter((r) => r.status !== 'sent' && r.status !== 'quoted').length, `${dueSoonCount()} due in the next 7 days`)}
      ${tile('open', 'Waiting on quotes', open.filter((r) => r.status === 'sent').length, `${open.filter((r) => r.status === 'quoted').length} quoted, not ordered`)}
      ${tile('draft', 'Drafts', all.filter((r) => r.status === 'draft').length, 'not sent yet')}
    </div>
    <div class="row between parts-filter">
      <div class="chips">${SHOW.map(([k, l]) => `<a class="chip ${show === k ? 'on' : ''}" href="${link(k)}">${l}</a>`).join('')}</div>
      ${suppliers.length > 1 ? `<select id="supfilter" class="sup-filter" aria-label="Supplier">${options([['', 'All suppliers'], ...suppliers.map((s) => [s.id, s.name])], sup)}</select>` : ''}
    </div>
    <div class="card">${rows.length ? `<table class="list"><thead><tr><th>Request</th><th>Job</th><th>Status</th><th>Supplier</th><th>Where it stands</th><th>Needed by</th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-href="#/parts/${esc(r.id)}"><td><b>${esc(r.number)}</b> <span class="muted small">${r.kind === 'order' ? 'Order' : 'Quote'}</span></td>
        <td>${esc(jobName(r.jobId) || 'No job')}</td><td>${statusBadge(r, today)}<div class="small phone-only">${standing(r, today)}</div></td><td>${esc(supplierName(r.supplierId))}</td>
        <td class="small">${standing(r, today)}</td><td>${fmtDate(r.neededBy)}</td></tr>`).join('')}
    </tbody></table>` : empty(all.length ? 'Nothing here. Try All.' : 'No parts requests yet. Start one from a job or a proposal, or with New parts request.')}</div>`,
    mount(root) {
      root.querySelector('#supfilter')?.addEventListener('change', (e) => go(`#/parts?show=${show}${e.target.value ? `&supplier=${encodeURIComponent(e.target.value)}` : ''}`));
    },
  };
}

// ---------- One job's parts (the job's Parts tab) ----------
export function jobParts(jobId) {
  const today = localDay();
  const rows = where('partsRequests', 'jobId', jobId).sort((a, b) => (Number(b.number) || 0) - (Number(a.number) || 0));
  const ests = where('estimates', 'jobId', jobId).sort((a, b) => (Number(b.number) || 0) - (Number(a.number) || 0));
  return `<div class="card"><div class="row between"><h2>Parts from suppliers</h2>
      ${can.edit() ? `<div class="row">${ests.map((e) => `<a class="btn small" href="#/parts/new?job=${esc(jobId)}&estimate=${esc(e.id)}">From proposal ${esc(e.number)}</a>`).join('')}
      <a class="btn small primary" href="#/parts/new?job=${esc(jobId)}">New parts request</a></div>` : ''}</div>
    ${rows.length ? `<table class="list"><thead><tr><th>Request</th><th>Supplier</th><th>Status</th><th>Where it stands</th><th>Needed by</th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-href="#/parts/${esc(r.id)}"><td><b>${esc(r.number)}</b> <span class="muted small">${r.kind === 'order' ? 'Order' : 'Quote'}</span></td><td>${esc(supplierName(r.supplierId))}</td>
        <td>${statusBadge(r, today)}<div class="small phone-only">${standing(r, today)}</div></td><td class="small">${standing(r, today)}</td><td>${fmtDate(r.neededBy)}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">No parts requested for this job yet. Start from the proposal to bring its materials over.</p>'}</div>`;
}

// ---------- The parts list editor ----------
const COLS = PE.COLUMNS;
const tools = '<td class="row-tools"><button type="button" class="icon" data-up title="Move up" aria-label="Move up">↑</button><button type="button" class="icon" data-down title="Move down" aria-label="Move down">↓</button><button type="button" class="icon" data-del title="Remove" aria-label="Remove">✕</button></td>';

function cellInput(key, type, it) {
  const v = it[key] ?? '';
  if (type === 'qty') return `<input name="qty" type="number" step="any" min="0" class="n qty" value="${esc(v === 0 ? '' : v)}" aria-label="Quantity">`;
  if (type === 'inches') return `<input name="${key}" class="n inches" value="${esc(typeof v === 'number' ? PE.fmtInches(v) : v)}" placeholder="in" aria-label="${key === 'width' ? 'Width' : 'Height'} in inches">`;
  if (type === 'unit') return `<input name="unit" class="unit" value="${esc(v)}" list="part-units" aria-label="Unit">`;
  if (type === 'short') return `<input name="${key}" class="short" value="${esc(v)}" aria-label="${key === 'mark' ? 'Mark' : 'Part number'}">`;
  return `<input name="${key}" value="${esc(v)}" aria-label="${key === 'edge' ? 'Edges, holes, notes' : 'Description'}">`;
}

// Each row keeps the whole line (data-full), so fields the list type doesn't show aren't lost.
function itemRow(it, listType) {
  const full = esc(JSON.stringify(it));
  if ('heading' in it) {
    return `<tr data-item data-full="${full}" class="heading-row"><td colspan="${COLS[listType].length}"><input name="heading" value="${esc(it.heading)}" placeholder="Heading, like Stock lengths or CG451 #04 clear anodized 1&quot; infill" aria-label="Heading"></td>${tools}</tr>`;
  }
  // A size the list doesn't show (a glass line from a proposal in a parts list) still goes in the email, so it shows here.
  const hidden = listType !== 'glass' && sizeText(it) ? `<small class="size-hint muted" title="Change the list to Glass sizes to edit the size">${esc(sizeText(it))}</small>` : '';
  return `<tr data-item data-full="${full}">${COLS[listType].map(([key, , type]) => `<td>${cellInput(key, type, it)}${key === 'desc' ? hidden : ''}</td>`).join('')}${tools}</tr>`;
}

function readItems(tbody) {
  return [...tbody.querySelectorAll('tr[data-item]')].map((tr) => {
    let it;
    try { it = JSON.parse(tr.dataset.full || '{}'); } catch { it = {}; }
    tr.querySelectorAll('[name]').forEach((el) => { it[el.name] = el.type === 'number' ? (el.value === '' ? 0 : Number(el.value)) : el.value; });
    return it;
  });
}

const head = (listType) => `<tr>${COLS[listType].map(([, h]) => `<th>${esc(h)}</th>`).join('')}<th></th></tr>`;

// A request to start from: the job, the proposal's materials and the supplier's defaults.
function newRequest(params) {
  const est = get('estimates', params.get('estimate'));
  const job = get('jobs', params.get('job')) || get('jobs', est?.jobId);
  const supplier = get('suppliers', params.get('supplier')) || (D().suppliers.length === 1 ? D().suppliers[0] : null);
  const plugin = pluginFor(supplier?.plugin);
  const listType = supplier?.listType || plugin.listType;
  const r = {
    number: nextNumber('partsRequests', 1), status: 'draft', kind: supplier?.kind || 'quote', listType, jobId: job?.id || '', supplierId: supplier?.id || '',
    estimateId: est?.id || '', items: est ? PE.itemsFromEstimate(est, listType) : [], delivery: supplier?.delivery || plugin.delivery || 'site',
    po: '', neededBy: '', subject: '', intro: '', notes: '', ccMe: true, ccOffice: false, attachments: [], signature: PE.defaultSignature(person(), state.company || {}),
  };
  r.deliverTo = r.delivery === 'site' ? job?.siteAddress || '' : r.delivery === 'shop' ? state.company?.address || '' : '';
  return r;
}

// ---------- One request: tracking it, emailing the supplier, and the request itself ----------
export function partsEdit(id, params) {
  const isNew = id === 'new';
  const r = isNew ? newRequest(params) : get('partsRequests', id);
  if (!r) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const today = localDay();
  const edit = can.edit();
  const ro = edit ? '' : 'disabled';
  const draft = r.status === 'draft';
  const supplier = get('suppliers', r.supplierId);
  const listType = COLS[r.listType] ? r.listType : 'parts';
  const suppliers = [...D().suppliers].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const jobs = [...D().jobs].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const ask = VIA[params.get('ask')] ? params.get('ask') : '';
  const askWhat = WHAT[params.get('what')] ? params.get('what') : 'request';

  const requestForm = `
    <form id="f" class="stack">
      ${suppliers.length ? '' : `<div class="card warn-card"><p><b>No suppliers yet.</b> ${can.suppliers() ? 'Add the ones you buy from first: <a href="#/suppliers">Suppliers</a>.' : 'Ask the owner to add them under Suppliers.'} You can still write the list and copy the email.</p></div>`}
      <fieldset class="card grid4" ${ro}>
        <label class="span2">Supplier <select name="supplierId" id="supplier">${options([['', 'Choose a supplier…'], ...suppliers.map((s) => [s.id, `${s.name}${s.branch ? ` (${s.branch})` : ''}`])], r.supplierId)}</select></label>
        <label class="span2">Job <select name="jobId" id="job">${options([['', 'No job (shop stock)'], ...jobs.map((j) => [j.id, j.name])], r.jobId)}</select></label>
        <label>Request <select name="kind">${options(PE.REQUEST_KINDS, r.kind)}</select></label>
        <label>List <select name="listType" id="listType">${options(PE.LIST_TYPES, listType)}</select></label>
        <label>PO # <input name="po" value="${esc(r.po)}" maxlength="30" placeholder="Your PO or job reference"></label>
        <label>Needed by <input name="neededBy" type="date" value="${esc(r.neededBy)}"></label>
        <label>Delivery <select name="delivery" id="delivery">${options(PE.DELIVERY, r.delivery)}</select></label>
        <label class="span3" id="deliverToLabel">Deliver to <input name="deliverTo" id="deliverTo" value="${esc(r.deliverTo)}" maxlength="200"></label>
        <div class="span4 supplier-tip hidden" id="tip"></div>
      </fieldset>
      <fieldset class="card" ${ro}>
        <div class="row between"><h2>Parts list</h2>
          <div class="row">
            <select id="fromEst" class="from-est" aria-label="Add the materials from a proposal"></select>
            <button type="button" class="btn small" id="pasteToggle">Paste a list</button>
          </div></div>
        <div class="chips common hidden" id="common"></div>
        <div class="paste-box hidden" id="pasteBox">
          <label>Paste from a spreadsheet, an email or a takeoff, one item per line
            <textarea id="paste" rows="7" placeholder="5 S/L CG451-1 Head/jamb/vert mull&#10;ED450-2 End dam. 2 pkg&#10;4 @ 35 7/8 x 83 3/4 1/4&quot; clear tempered&#10;Lines without a quantity become headings."></textarea></label>
          <div class="row"><button type="button" class="btn small primary" id="pasteAdd">Add these lines</button><span class="hint" id="pasteCount"></span></div>
        </div>
        <datalist id="part-units">${PE.UNITS.map((u) => `<option value="${esc(u)}">`).join('')}</datalist>
        <div class="scroll"><table class="lines parts-lines" data-lines><thead id="ihead">${head(listType)}</thead>
          <tbody id="items">${r.items.map((it) => itemRow(it, listType)).join('')}</tbody></table></div>
        <div class="row"><button type="button" class="btn small" id="addLine">+ Line</button><button type="button" class="btn small" id="addHeading">+ Heading</button></div>
        <ul class="problems" id="problems"></ul>
      </fieldset>
      <fieldset class="card grid2" ${ro}>
        <h2 class="span2">The email</h2>
        <p class="span2 small recips" id="recips"></p>
        <label class="span2">Subject <input name="subject" id="subject" value="${esc(r.subject)}" maxlength="200"></label>
        <label class="span2">Opening line <textarea name="intro" id="intro" rows="2" maxlength="1000">${esc(r.intro)}</textarea></label>
        <label class="span2">Notes for the supplier <textarea name="notes" rows="3" maxlength="3000" placeholder="e.g. Can you quote the doors separately? We'll need those first.">${esc(r.notes)}</textarea></label>
        <label class="span2">Signature <textarea name="signature" rows="4" maxlength="600">${esc(r.signature)}</textarea></label>
        <label class="inline"><span><input type="checkbox" name="ccMe" ${r.ccMe === false ? '' : 'checked'}> Copy me</span></label>
        <label class="inline"><span><input type="checkbox" name="ccOffice" ${r.ccOffice ? 'checked' : ''}> Copy the office${state.company?.email ? ` (${esc(state.company.email)})` : ''}</span></label>
        <div class="span2" data-lines><h3 class="sub-h">Attach job files</h3><div id="files" class="file-picks"><p class="muted small">Pick a job to see its files.</p></div>
          <p class="hint" id="filesNote">Up to ${PE.MAX_ATTACHMENTS} files, ${PE.MAX_ATTACH_BYTES / MB} MB in all. They go with the email when the app sends it; with Gmail or your email app, attach them there.</p></div>
      </fieldset>
      <div class="card"><div class="row between"><h2>Preview</h2><span class="small muted" id="previewNote"></span></div>
        <iframe id="preview" class="email-preview" sandbox title="Email preview"></iframe></div>
      ${edit ? `<div class="card send-bar">
        <button class="btn" id="save">Save${draft ? ' draft' : ''}</button>
        <button type="button" class="btn primary" id="sendApp">${draft ? 'Send from the app' : 'Send again from the app'}</button>
        <button type="button" class="btn" id="gmail">Open in Gmail</button>
        <button type="button" class="btn" id="mailApp">Open in email app</button>
        <button type="button" class="btn" id="copy">Copy email</button>
      </div>` : ''}
    </form>`;

  const tracker = draft || isNew ? '' : trackerHtml(r, today, edit);
  const title = isNew ? 'New parts request' : `Parts request ${esc(r.number)}`;

  return {
    html: `<div class="page-head"><div class="page-title"><h1>${title} ${isNew ? '' : statusBadge(r, today)}</h1>
        <p>${[supplier && esc(supplier.name), r.jobId && `<a href="#/jobs/${esc(r.jobId)}?tab=parts">${esc(jobName(r.jobId))}</a>`].filter(Boolean).join(' · ')}</p></div>
      <div class="actions"><a class="btn" href="#/parts">All parts orders</a>
      ${!isNew && can.remove() ? '<button class="btn danger" id="del">Delete</button>' : ''}</div></div>
    <div class="card ask-bar ${ask ? '' : 'hidden'}" id="ask"><p><b>Did the email go out?</b> Mark it sent so the order is tracked.</p>
      <div class="row"><button type="button" class="btn primary" id="askYes">Yes, mark it sent</button><button type="button" class="btn" id="askNo">Not yet</button></div></div>
    ${tracker}
    ${draft || isNew ? requestForm : `<details class="request-box" id="requestBox"><summary><span><b>The request</b> · ${PE.cleanItems(r.items).filter((x) => !('heading' in x)).length} lines${r.requestedOn || r.orderedOn ? `, sent ${fmtDate(r.requestedOn || r.orderedOn)}` : ''}</span><span class="small muted">See it, change it or send it again</span></summary>${requestForm}</details>`}`,
    mount(root) {
      root.querySelector('#askYes')?.addEventListener('click', () => markSent(id, askWhat, ask));
      root.querySelector('#askNo')?.addEventListener('click', () => go(`#/parts/${id}`));
      root.querySelector('#del')?.addEventListener('click', async () => {
        if (!confirm(`Delete parts request ${r.number}? Its history goes with it. This can't be undone.`)) return;
        if (await attempt(() => remove('partsRequests', id), 'Parts request deleted') !== null) go('#/parts');
      });
      if (tracker) mountTracker(root, id, today);
      mountRequest(root, { id, isNew, r, edit });
    },
  };
}

// ---------- Tracking: where it stands, what's come in, emailing the supplier, the history ----------
const STATUS_CHOICES = PE.PARTS_STATUS.filter((s) => s !== 'draft').map((s) => [s, PE.STATUS_LABEL[s]]);
// The fields each update asks for. The date of the step itself is filled in as today.
const TRACK_FIELDS = {
  sent: ['requestedOn'], quoted: ['quoteRef', 'quoteTotal', 'quotedOn'], ordered: ['orderRef', 'orderedOn', 'expectedOn'],
  confirmed: ['orderRef', 'expectedOn'], shipped: ['shippedOn', 'expectedOn', 'tracking'], partial: ['expectedOn'], received: ['receivedOn'], cancelled: [],
};
const DATE_OF = { sent: 'requestedOn', quoted: 'quotedOn', ordered: 'orderedOn', confirmed: 'confirmedOn', shipped: 'shippedOn', received: 'receivedOn' };

function nextStatus(r) {
  if (r.status === 'partial') return 'received';
  const stages = PE.stagesFor(r);
  const i = stages.indexOf(PE.stageOf(r.status));
  return i < 0 ? 'ordered' : stages[Math.min(i + 1, stages.length - 1)];
}

function stepper(r) {
  const stages = PE.stagesFor(r);
  const idx = r.status === 'cancelled' ? -1 : stages.indexOf(PE.stageOf(r.status));
  return `<ol class="stepper">${stages.map((s, i) => {
    const cls = i < idx || (i === idx && r.status !== 'partial') ? 'done' : i === idx ? 'part' : '';
    const date = r[DATE_OF[s]];
    return `<li class="${cls}${i === idx ? ' now' : ''}"><span class="dot" aria-hidden="true"></span><span class="lbl">${esc(PE.STAGE_LABEL[s])}</span><small>${date ? esc(PE.fmtShort(date)) : s === 'received' && r.status === 'partial' ? 'Partly' : '&nbsp;'}</small></li>`;
  }).join('')}</ol>`;
}

function trackerHtml(r, today, edit) {
  const note = PE.trackingNote(r, today);
  const facts = [
    ['Needed by', r.neededBy && fmtDate(r.neededBy)],
    ['Quote', [r.quoteRef && `#${esc(r.quoteRef)}`, r.quoteTotal != null && r.quoteTotal !== '' && money(r.quoteTotal)].filter(Boolean).join(', ')],
    ['Their order #', r.orderRef && esc(r.orderRef)],
    ['Expected', r.expectedOn && fmtDate(r.expectedOn)],
    ['Shipping', r.tracking && esc(r.tracking)],
    ['All in', r.receivedOn && fmtDate(r.receivedOn)],
  ].filter(([, v]) => v);
  const next = nextStatus(r);
  const a = r.appEmail;
  const appNote = a?.status === 'failed' ? `<p class="warn small">The app couldn't send the last email: ${esc(a.error || '')}</p>`
    : a?.status === 'sending' ? '<p class="small muted">Sending the email…</p>' : '';
  const last = r.lastEmail ? `<p class="small muted">Last email: ${esc(WHAT[r.lastEmail.what] || 'Email')} ${esc(VIA[r.lastEmail.via] || '')}, ${esc(fmtWhen(r.lastEmail.at))}.</p>` : '';
  const items = PE.cleanItems(r.items);
  const lines = items.filter((it) => !('heading' in it));
  const gotLines = lines.filter((it) => it.got >= it.qty).length;
  const field = (name, label, type = 'text', extra = '') => `<label data-for="${Object.keys(TRACK_FIELDS).filter((s) => TRACK_FIELDS[s].includes(name)).join(' ')}">${label}
    <input name="${name}" type="${type}" value="${esc(r[name] ?? '')}" ${extra}></label>`;
  const evs = [...(r.events || [])].sort((x, y) => String(y.at).localeCompare(String(x.at)));
  // Once the quote is in, placing the order comes first; before that, asking how it's going.
  const placing = ['order', 'Place the order (per their quote)'];
  const whats = [...(r.status === 'quoted' ? [placing] : []), ['followup', 'Ask for an update'], ...(r.status === 'sent' ? [placing] : []), ['request', 'Send the request again']];

  return `
    <div class="card tracker">
      <div class="row between"><h2>Where it stands</h2><span class="${note.level} small">${esc(note.text)}</span></div>
      ${r.status === 'cancelled' ? '<p class="muted">Cancelled.</p>' : stepper(r)}
      ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` : ''}
      ${edit ? `<form id="track" class="grid4 track-form">
        <label>Update to <select name="status" id="tstatus">${options(STATUS_CHOICES, next)}</select></label>
        ${field('requestedOn', 'Requested on', 'date')}
        ${field('quoteRef', 'Their quote #', 'text', 'maxlength="40"')}
        ${field('quoteTotal', 'Quote total', 'number', 'step="0.01" min="0"')}
        ${field('quotedOn', 'Quoted on', 'date')}
        ${field('orderRef', 'Their order #', 'text', 'maxlength="40"')}
        ${field('orderedOn', 'Ordered on', 'date')}
        ${field('expectedOn', 'Expected delivery or pickup', 'date')}
        ${field('shippedOn', 'Shipped or ready on', 'date')}
        ${field('tracking', 'Tracking, or how it\'s coming', 'text', 'maxlength="200" placeholder="e.g. Trulite truck, Tuesday route"')}
        ${field('receivedOn', 'All in on', 'date')}
        <label class="span4">Note <input name="note" maxlength="300" placeholder="e.g. Spoke with Pat: glass ships Tuesday"></label>
        <div class="span4 row"><button class="btn primary">Save update</button></div>
      </form>` : ''}
    </div>
    <div class="cols">
      <div class="card"><div class="row between"><h2>What's come in</h2><span class="small muted">${gotLines} of ${lines.length} lines in</span></div>
        ${lines.length ? `<div class="scroll"><table class="lines receive"><thead><tr><th>Ordered</th><th>Item</th><th>In</th><th class="num">Still to come</th></tr></thead><tbody>
        ${items.map((it, i) => ('heading' in it ? `<tr class="heading-row"><td colspan="4"><b>${esc(it.heading)}</b></td></tr>`
          : `<tr><td class="num">${esc(String(it.qty))} ${esc(it.unit)}</td><td>${esc(itemLabel(it))}</td>
            <td><input type="number" class="n" min="0" step="any" data-got="${i}" data-qty="${it.qty}" value="${it.got || ''}" ${edit ? '' : 'disabled'} aria-label="How many came in"></td>
            <td class="num" data-left="${i}">${Math.max(0, Math.round((it.qty - it.got) * 100) / 100) || '✓'}</td></tr>`)).join('')}
        </tbody></table></div>
        ${edit ? '<div class="row"><button type="button" class="btn small" id="allIn">Everything came in</button><button type="button" class="btn small primary" id="saveIn">Save what came in</button></div>' : ''}`
    : '<p class="muted">The list is empty.</p>'}
      </div>
      <div class="card email-card"><h2>Email ${esc(supplierName(r.supplierId) || 'the supplier')}</h2>
        ${appNote}${last}
        <label>Email <select id="what">${options(whats, whats[0][0])}</select></label>
        <label>Note for this email (optional) <textarea id="mnote" rows="2" maxlength="${PE.MAX_NOTE}" placeholder="e.g. Deliver before 10 AM, and call Mike at the site when you're close." ${edit ? '' : 'disabled'}></textarea></label>
        <p class="small recips" id="mrecips"></p>
        <iframe id="mpreview" class="email-preview short" sandbox title="Email preview"></iframe>
        ${edit ? `<div class="row top-gap"><button type="button" class="btn primary" id="msendApp">Send from the app</button>
          <button type="button" class="btn" id="mgmail">Open in Gmail</button><button type="button" class="btn" id="mmailApp">Open in email app</button>
          <button type="button" class="btn" id="mcopy">Copy</button></div>` : ''}
      </div>
    </div>
    <div class="card"><h2>History</h2>
      ${evs.length ? `<ol class="timeline">${evs.map((e) => `<li><span class="when">${esc(fmtWhen(e.at))}</span><span><b>${esc(PE.STATUS_LABEL[e.status] || e.status || '')}</b>${e.note ? `: ${esc(e.note)}` : ''} <span class="muted small">${esc(e.by || '')}</span></span></li>`).join('')}</ol>` : '<p class="muted small">Nothing yet.</p>'}
    </div>`;
}

function mountTracker(root, id, today) {
  const track = root.querySelector('#track');
  if (track) {
    const sel = track.querySelector('#tstatus');
    const showFields = () => {
      const st = sel.value;
      track.querySelectorAll('[data-for]').forEach((l) => l.classList.toggle('hidden', !l.dataset.for.split(' ').includes(st)));
      // The step's own date starts as today.
      const own = track.querySelector(`[name="${DATE_OF[st]}"]`);
      if (own && !own.value) own.value = today;
    };
    sel.addEventListener('change', showFields);
    showFields();
    track.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = get('partsRequests', id);
      const f = formData(track);
      const st = f.status;
      const fields = { status: st };
      for (const k of TRACK_FIELDS[st] || []) if (f[k] !== '' && f[k] != null) fields[k] = f[k];
      if (DATE_OF[st] && !fields[DATE_OF[st]]) fields[DATE_OF[st]] = r[DATE_OF[st]] || today;
      if (st === 'received') fields.items = PE.cleanItems(r.items).map((it) => ('heading' in it ? it : { ...it, got: Math.max(it.got, it.qty) }));
      const bits = [fields.quoteRef && `Quote #${fields.quoteRef}`, fields.quoteTotal != null && money(fields.quoteTotal), fields.orderRef && `Order #${fields.orderRef}`,
        fields.expectedOn && `Expected ${PE.fmtShort(fields.expectedOn)}`, fields.tracking, f.note].filter(Boolean);
      fields.events = arrayUnion(event(st, bits.join('. ')));
      if (await attempt(() => update('partsRequests', id, fields), 'Updated') !== null) rerender();
    });
  }

  // What's come in.
  const leftOf = (input) => Math.max(0, Math.round((Number(input.dataset.qty) - (Number(input.value) || 0)) * 100) / 100);
  root.querySelectorAll('[data-got]').forEach((input) => input.addEventListener('input', () => {
    root.querySelector(`[data-left="${input.dataset.got}"]`).textContent = leftOf(input) || '✓';
  }));
  root.querySelector('#allIn')?.addEventListener('click', () => root.querySelectorAll('[data-got]').forEach((input) => {
    input.value = input.dataset.qty;
    input.dispatchEvent(new Event('input'));
  }));
  root.querySelector('#saveIn')?.addEventListener('click', async () => {
    const r = get('partsRequests', id);
    const items = PE.cleanItems(r.items);
    root.querySelectorAll('[data-got]').forEach((input) => { items[Number(input.dataset.got)].got = Math.max(0, Number(input.value) || 0); });
    const got = PE.receivedState(items);
    const fields = { items };
    if (got === 'all') Object.assign(fields, { status: 'received', receivedOn: r.receivedOn || today });
    else if (got === 'some') fields.status = 'partial';
    else if (['partial', 'received'].includes(r.status)) fields.status = r.shippedOn ? 'shipped' : 'ordered';
    const lines = items.filter((it) => !('heading' in it));
    fields.events = arrayUnion(event(fields.status || r.status, `${lines.filter((it) => it.got >= it.qty).length} of ${lines.length} lines in`));
    if (await attempt(() => update('partsRequests', id, fields), 'Saved') !== null) rerender();
  });

  // Emailing the supplier about it.
  const whatSel = root.querySelector('#what');
  const noteBox = root.querySelector('#mnote');
  // The note is for placing the order or asking for an update; sending the request again uses the request's own notes.
  const note = () => (whatSel.value === 'request' ? '' : noteBox.value);
  let timer;
  const show = () => {
    const r = get('partsRequests', id);
    const m = emailFor(r, whatSel.value, { note: note() });
    root.querySelector('#mpreview').srcdoc = m.html;
    root.querySelector('#mrecips').innerHTML = recipsHtml(m);
    noteBox.closest('label').classList.toggle('hidden', whatSel.value === 'request');
  };
  whatSel.addEventListener('change', show);
  noteBox.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(show, 200); });
  show();
  wireSend(root, { prefix: 'm', id: () => id, what: () => whatSel.value, note, current: () => get('partsRequests', id), beforeSend: async () => true });
}

function recipsHtml(m) {
  if (!m.supplier?.name) return '<span class="warn">Pick the supplier to see who it goes to.</span>';
  if (!m.to.length) return `<span class="warn">There's no email saved for ${esc(m.supplier.name)}.</span> ${can.suppliers() ? `<a href="#/suppliers/${esc(m.supplier.id)}">Add it</a>, or` : 'Ask the owner to add it, or'} use Open in Gmail and type it there.`;
  return `To <b>${esc(m.to.join(', '))}</b>${m.cc.length ? ` · Copy to ${esc(m.cc.join(', '))}` : ''}`;
}

// The four ways to send: from the app (the server), Gmail, the email app, or copying it.
// `beforeSend` saves the request first (the editor); it returns the request's id, or null to stop.
function wireSend(root, { prefix = '', id, what, current, beforeSend, attachments = () => [], note = () => '' }) {
  const btn = (name) => root.querySelector(`#${prefix}${name}`);
  const ask = (via, rid) => go(`#/parts/${rid}?ask=${via}&what=${what()}`);
  btn('sendApp')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const rid = await beforeSend();
    if (rid) await sendFromApp(rid === true ? id() : rid, what(), button, note());
  });
  btn('gmail')?.addEventListener('click', async () => {
    const r = current();
    const m = emailFor(r, what(), { fromOwnEmail: true, note: note() });
    // Opened straight away, while the click still counts, so the browser doesn't block the new tab.
    window.open(PE.gmailLink({ ...m, account: googleAccount() }), '_blank', 'noopener');
    const rid = await beforeSend();
    if (rid) ask('gmail', rid === true ? id() : rid);
    if (attachments().length) toast('Attach the files in Gmail: the app can\'t add them there.');
  });
  btn('mailApp')?.addEventListener('click', async () => {
    const r = current();
    const m = emailFor(r, what(), { fromOwnEmail: true, note: note() });
    location.href = PE.mailtoLink(m);
    const rid = await beforeSend();
    if (rid) setTimeout(() => ask('email', rid === true ? id() : rid), 300);
  });
  btn('copy')?.addEventListener('click', async () => {
    const r = current();
    const m = emailFor(r, what(), { fromOwnEmail: true, note: note() });
    const all = `To: ${m.to.join(', ')}${m.cc.length ? `\nCc: ${m.cc.join(', ')}` : ''}\nSubject: ${m.subject}\n\n${m.text}`;
    try { await navigator.clipboard.writeText(all); toast('Email copied. Paste it into a new email.'); } catch { prompt('Copy this email:', all); }
    const rid = await beforeSend();
    if (rid) ask('copy', rid === true ? id() : rid);
  });
}

// ---------- The request editor ----------
function mountRequest(root, { id, isNew, r, edit }) {
  const form = root.querySelector('#f');
  if (!form) return;
  const tbody = form.querySelector('#items');
  const thead = form.querySelector('#ihead');
  const listSel = form.querySelector('#listType');
  const supSel = form.querySelector('#supplier');
  const jobSel = form.querySelector('#job');
  const delSel = form.querySelector('#delivery');
  const deliverTo = form.querySelector('#deliverTo');
  const filesBox = form.querySelector('#files');
  let listType = listSel.value;
  let jobFiles = [];
  const chosen = new Set(r.attachments || []);
  let estimateId = r.estimateId || '';

  const picked = () => [...filesBox.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
  const pickedFiles = () => jobFiles.filter((f) => picked().includes(f.id));
  // The request as it stands in the form.
  const current = () => {
    const f = formData(form);
    return {
      ...(isNew ? r : get('partsRequests', id) || r),
      supplierId: f.supplierId, jobId: f.jobId, kind: f.kind, listType, po: f.po, neededBy: f.neededBy, delivery: f.delivery, deliverTo: f.delivery === 'pickup' ? '' : f.deliverTo,
      subject: f.subject, intro: f.intro, notes: f.notes, signature: f.signature, ccMe: f.ccMe, ccOffice: f.ccOffice,
      items: readItems(tbody), attachments: picked(), estimateId,
    };
  };

  // Placeholders show what the email says unless something's typed.
  const placeholders = (cur) => {
    form.querySelector('#subject').placeholder = PE.defaultSubject({ request: { ...cur, subject: '' }, job: get('jobs', cur.jobId) || {}, company: state.company || {} });
    form.querySelector('#intro').placeholder = PE.INTRO[cur.kind === 'order' ? 'order' : 'quote'];
  };

  let timer;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const cur = current();
      placeholders(cur);
      const m = emailFor(cur, 'request', { attachments: pickedFiles().map((f) => f.name) });
      form.querySelector('#preview').srcdoc = m.html;
      form.querySelector('#recips').innerHTML = recipsHtml(m);
      form.querySelector('#problems').innerHTML = PE.requestProblems(cur).map((p) => `<li>${esc(p)}</li>`).join('');
      const files = pickedFiles();
      const bytes = files.reduce((s, f) => s + (Number(f.size) || 0), 0);
      const over = files.length > PE.MAX_ATTACHMENTS || bytes > PE.MAX_ATTACH_BYTES;
      form.querySelector('#filesNote').classList.toggle('warn', over);
      form.querySelector('#previewNote').textContent = files.length ? `${files.length} file${files.length === 1 ? '' : 's'}, ${fmtSize(bytes)}${over ? ': too much to send' : ''}` : '';
    }, 150);
  };

  // The supplier's tip and common parts.
  const supplierBits = () => {
    const s = get('suppliers', supSel.value);
    const p = pluginFor(s?.plugin);
    const tip = form.querySelector('#tip');
    tip.textContent = s?.notes || '';
    tip.classList.toggle('hidden', !s?.notes);
    const common = form.querySelector('#common');
    const list = s ? p.common : [];
    common.innerHTML = list.length ? `<span class="small muted">Add:</span>${list.map((c, i) => `<button type="button" class="chip" data-common="${i}">+ ${esc([c.partNo, c.desc].filter(Boolean).join(' '))}</button>`).join('')}` : '';
    common.classList.toggle('hidden', !list.length || !edit);
    common.onclick = (e) => {
      const b = e.target.closest('[data-common]');
      if (!b) return;
      const c = list[Number(b.dataset.common)];
      tbody.insertAdjacentHTML('beforeend', itemRow({ qty: c.qty || 1, unit: c.unit || '', partNo: c.partNo || '', desc: c.desc || '' }, listType));
      refresh();
    };
  };

  // The job's proposals, to bring their materials over.
  const estOptions = () => {
    const ests = where('estimates', 'jobId', jobSel.value);
    const sel = form.querySelector('#fromEst');
    sel.innerHTML = options([['', ests.length ? 'Add from a proposal…' : 'No proposals for this job'], ...ests.map((e) => [e.id, `Proposal ${e.number}`])], '');
    sel.disabled = !ests.length || !edit;
  };

  const loadFiles = async () => {
    const jobId = jobSel.value;
    jobFiles = [];
    if (!jobId) { filesBox.innerHTML = '<p class="muted small">Pick a job to see its files.</p>'; refresh(); return; }
    filesBox.innerHTML = '<p class="muted small">Loading…</p>';
    try {
      const snap = await getDocs(query(collection(db, 'companies', state.companyId, 'files'), fwhere('jobId', '==', jobId)));
      if (jobSel.value !== jobId) return;
      jobFiles = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      filesBox.innerHTML = jobFiles.length ? jobFiles.map((f) => `<label class="inline file-pick"><span><input type="checkbox" value="${esc(f.id)}" ${chosen.has(f.id) ? 'checked' : ''} ${edit ? '' : 'disabled'}>
        ${esc(f.name)} <span class="muted small">${fmtSize(f.size)}</span></span></label>`).join('')
        : `<p class="muted small">This job has no files yet. Add plans or order forms under the job's <a href="#/jobs/${esc(jobId)}?tab=files">Files</a>.</p>`;
    } catch (e) {
      console.error(e);
      filesBox.innerHTML = `<p class="muted small">Couldn't load the job's files: ${esc(e.message)}</p>`;
    }
    refresh();
  };
  filesBox.addEventListener('change', (e) => {
    if (e.target.type === 'checkbox') { if (e.target.checked) chosen.add(e.target.value); else chosen.delete(e.target.value); }
    refresh();
  });

  const deliveryDefault = () => (delSel.value === 'site' ? get('jobs', jobSel.value)?.siteAddress || '' : delSel.value === 'shop' ? state.company?.address || '' : '');
  let lastDefault = deliveryDefault();
  const syncDelivery = () => {
    const d = deliveryDefault();
    if (!deliverTo.value.trim() || deliverTo.value === lastDefault) deliverTo.value = d;
    lastDefault = d;
    form.querySelector('#deliverToLabel').classList.toggle('hidden', delSel.value === 'pickup');
  };

  listSel.addEventListener('change', () => {
    const items = readItems(tbody);
    listType = listSel.value;
    thead.innerHTML = head(listType);
    tbody.innerHTML = items.map((it) => itemRow(it, listType)).join('');
    refresh();
  });
  supSel.addEventListener('change', () => {
    const s = get('suppliers', supSel.value);
    // A fresh list takes the supplier's way of working.
    if (s && !PE.cleanItems(readItems(tbody)).length) {
      if (s.listType && s.listType !== listType) { listSel.value = s.listType; listSel.dispatchEvent(new Event('change')); }
      if (s.kind) form.kind.value = s.kind;
      if (s.delivery) { delSel.value = s.delivery; syncDelivery(); }
    }
    supplierBits();
    refresh();
  });
  jobSel.addEventListener('change', () => { syncDelivery(); estOptions(); loadFiles(); });
  delSel.addEventListener('change', syncDelivery);
  form.querySelector('#fromEst').addEventListener('change', (e) => {
    const est = get('estimates', e.target.value);
    e.target.value = '';
    if (!est) return;
    const items = PE.itemsFromEstimate(est, listType);
    if (!items.length) return toast(`Proposal ${est.number} has no materials for a ${listType === 'glass' ? 'glass list' : 'parts list'}.`, true);
    tbody.insertAdjacentHTML('beforeend', items.map((it) => itemRow(it, listType)).join(''));
    estimateId = est.id;
    toast(`Added ${items.length} line${items.length === 1 ? '' : 's'} from proposal ${est.number}. Check the quantities and add part numbers.`);
    refresh();
  });
  form.querySelector('#pasteToggle').addEventListener('click', () => {
    form.querySelector('#pasteBox').classList.toggle('hidden');
    form.querySelector('#paste').focus();
  });
  const pasteArea = form.querySelector('#paste');
  pasteArea.addEventListener('input', () => {
    const got = PE.parsePasted(pasteArea.value, listType);
    const lines = got.filter((it) => !('heading' in it)).length;
    form.querySelector('#pasteCount').textContent = pasteArea.value.trim() ? `${lines} line${lines === 1 ? '' : 's'}${got.length > lines ? ` and ${got.length - lines} heading${got.length - lines === 1 ? '' : 's'}` : ''}` : '';
  });
  form.querySelector('#pasteAdd').addEventListener('click', () => {
    const got = PE.parsePasted(pasteArea.value, listType);
    if (!got.length) return toast('Nothing to add. Put one item per line.', true);
    tbody.insertAdjacentHTML('beforeend', got.map((it) => itemRow(it, listType)).join(''));
    pasteArea.value = '';
    form.querySelector('#pasteCount').textContent = '';
    form.querySelector('#pasteBox').classList.add('hidden');
    refresh();
  });
  form.querySelector('#addLine').addEventListener('click', () => {
    tbody.insertAdjacentHTML('beforeend', itemRow({ qty: 1, unit: listType === 'glass' ? '' : 'ea' }, listType));
    tbody.lastElementChild.querySelector('input:not([name=qty])')?.focus();
    refresh();
  });
  form.querySelector('#addHeading').addEventListener('click', () => {
    tbody.insertAdjacentHTML('beforeend', itemRow({ heading: '' }, listType));
    tbody.lastElementChild.querySelector('input')?.focus();
  });
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (e.target.closest('[data-del]')) tr.remove();
    else if (e.target.closest('[data-up]') && tr.previousElementSibling) tr.previousElementSibling.before(tr);
    else if (e.target.closest('[data-down]') && tr.nextElementSibling) tr.nextElementSibling.after(tr);
    else return;
    refresh();
  });
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);

  // Saves the request. Returns its id, or null if it didn't save.
  const save = async (quiet) => {
    const cur = current();
    const files = pickedFiles();
    if (files.length > PE.MAX_ATTACHMENTS) { toast(`Attach up to ${PE.MAX_ATTACHMENTS} files.`, true); return null; }
    if (files.reduce((s, f) => s + (Number(f.size) || 0), 0) > PE.MAX_ATTACH_BYTES) { toast(`The files come to more than ${PE.MAX_ATTACH_BYTES / MB} MB. Leave some out.`, true); return null; }
    const data = {
      supplierId: cur.supplierId, jobId: cur.jobId, customerId: get('jobs', cur.jobId)?.customerId || '', estimateId: cur.estimateId || '',
      kind: cur.kind === 'order' ? 'order' : 'quote', listType: cur.listType, items: PE.cleanItems(cur.items), po: cur.po, neededBy: cur.neededBy,
      delivery: cur.delivery, deliverTo: cur.deliverTo, subject: cur.subject, intro: cur.intro, notes: cur.notes, signature: cur.signature,
      ccMe: cur.ccMe, ccOffice: cur.ccOffice, attachments: cur.attachments,
    };
    if (!isNew) return (await attempt(() => update('partsRequests', id, data), quiet ? null : 'Saved') !== null) ? id : null;
    const created = await attempt(() => add('partsRequests', { ...data, number: r.number, status: 'draft', events: [event('draft', 'Started')] }), quiet ? null : 'Saved');
    return created ? created.id : null;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rid = await save(false);
    if (rid && isNew) go(`#/parts/${rid}`);
  });
  if (edit) {
    wireSend(root, {
      id: () => id,
      what: () => 'request',
      current,
      attachments: () => picked(),
      beforeSend: () => save(true),
    });
  }

  supplierBits();
  estOptions();
  syncDelivery();
  loadFiles();
  refresh();
}
