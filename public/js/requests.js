// Quote requests from the public page (quote.html): the list, one request, and turning it into a customer and job.
// The request is companies/{company}/requests/{id}; its photos and plans are in Cloud Storage under
// companies/{company}/requests/{id}/ (see storage.rules).
import { storage } from './firebase.js';
import { ref as sref, listAll, getMetadata, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { state, add, update, remove, get, newId, put, can } from './data.js';
import { REQUEST_SERVICES, REQUEST_TIMELINES, REQUEST_CONTACT } from './brand.js';
import { esc, options, badge, toast, empty } from './ui.js';

export const REQUEST_STATUS = ['new', 'contacted', 'converted', 'closed'];
const label = (pairs, key) => pairs.find(([k]) => k === key)?.[1] || key || '';
export const serviceLabel = (key) => label(REQUEST_SERVICES, key);
// Job type on the job form for each service the customer can pick.
const JOB_TYPE = { storefront: 'storefront', shower: 'shower' };

const when = (r) => (r.createdAt?.toDate ? r.createdAt.toDate() : new Date());
const fmtWhen = (r) => when(r).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const phoneLink = (p) => (p ? `<a href="tel:${esc(p.replace(/[^\d+]/g, ''))}">${esc(p)}</a>` : '');
const sorted = () => [...state.data.requests].sort((a, b) => when(b) - when(a));
export const newRequestCount = () => state.data.requests.filter((r) => r.status === 'new').length;

// ---------- Emails about new requests ----------
// The server (functions-alerts/request-alert.js) emails each new request to requestAlertEmails on the company,
// or to the company's email until that's saved, and notes how it went on the request as `alert`.
export const MAX_ALERT_EMAILS = 5;
export const alertEmails = (c) => (Array.isArray(c?.requestAlertEmails) ? c.requestAlertEmails : [c?.email].filter(Boolean));

const isEmail = (s) => /^[^\s@,;<>"()[\]]+@[^\s@,;<>"()[\]]+\.[a-z]{2,}$/i.test(s);
// "a@x.com, b@y.com" (commas, semicolons or spaces) into { emails, bad }, without repeats.
export function parseEmails(text) {
  const parts = String(text || '').split(/[\s,;]+/).filter(Boolean);
  const emails = [...new Map(parts.filter(isEmail).map((e) => [e.toLowerCase(), e])).values()];
  return { emails, bad: parts.filter((p) => !isEmail(p)) };
}

// How the email about a request went, in a sentence (HTML). Empty for requests from before emails started.
export function alertNote(r) {
  const a = r.alert;
  if (!a) return '';
  const files = a.attached ? `, with ${a.attached} file${a.attached === 1 ? '' : 's'}` : '';
  if (a.status === 'sent') return `Emailed to ${esc((a.to || []).join(', '))}${files}.`;
  if (a.status === 'sending') return 'Sending the email about it…';
  if (a.status === 'off') return 'Not emailed: nobody is set to get request emails (Settings).';
  if (a.status === 'held') return 'Not emailed: too many requests came in within an hour.';
  return `<span class="warn">The email about it didn't go out. ${esc(a.error || '')}</span>`;
}

// For Settings: how the latest request's email went.
export function lastAlertNote() {
  const r = sorted().find((x) => x.alert);
  return r ? `Latest request, from ${esc(r.name)} on ${fmtWhen(r)}: ${alertNote(r)}` : '';
}

async function attempt(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { console.error(e); toast(e.code === 'permission-denied' ? 'Your role can\'t make that change.' : e.message, true); return null; }
}

// ---------- List ----------
const FILTERS = [['open', 'Open'], ['new', 'New'], ['all', 'All']];
let filter = 'open';

export function requestList() {
  const all = sorted();
  const rows = all.filter((r) => filter === 'all' || (filter === 'new' ? r.status === 'new' : ['new', 'contacted'].includes(r.status)));
  return {
    live: true,
    html: `<div class="page-head"><div class="page-title"><h1>Requests</h1></div><div class="actions"><a class="btn" href="#/settings">Website form settings</a></div></div>
    <div class="chips">${FILTERS.map(([k, l]) => `<button type="button" class="chip ${filter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('')}</div>
    <div class="card">${rows.length ? `<table class="list"><thead><tr><th>Received</th><th>Name</th><th>Service</th><th>Status</th><th>Site</th><th>Phone</th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-href="#/requests/${esc(r.id)}"><td>${fmtWhen(r)}</td><td>${esc(r.name)}${r.company ? `<br><span class="muted small">${esc(r.company)}</span>` : ''}</td><td>${esc(serviceLabel(r.service))}${r.files ? ` <span class="muted small" title="Photos or plans">📎${r.files}</span>` : ''}</td><td>${badge(r.status)}</td><td>${esc(r.siteAddress)}</td><td>${esc(r.phone)}</td></tr>`).join('')}
    </tbody></table>` : empty(all.length ? 'Nothing here. Try All.' : 'No requests yet. Requests that customers send from the website\'s quote page show up here.')}</div>`,
    mount(root) {
      root.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
        filter = b.dataset.filter;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }));
    },
  };
}

// ---------- One request ----------
// The customer's photos and plans to show, and every file in the request's folder (to clean up).
async function loadAttachments(r) {
  const folder = await listAll(sref(storage, `companies/${state.companyId}/requests/${r.id}`));
  // The customer's files are numbered from 0, one per number, below the count their request gave.
  // Anything else in the folder didn't come from the form, so it's left out.
  const seen = new Set();
  const items = folder.items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).filter((it) => {
    const n = Number(it.name.split('-')[0]);
    if (!(n < (r.files || 0)) || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
  const shown = await Promise.all(items.map(async (it) => {
    const [meta, url] = await Promise.all([getMetadata(it), getDownloadURL(it)]);
    return { path: it.fullPath, name: it.name.replace(/^\d+-/, ''), contentType: meta.contentType || '', size: meta.size || 0, url };
  }));
  return { shown, paths: folder.items.map((it) => it.fullPath) };
}

const attachmentTile = (a) => `<a class="file-tile" href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.name)}">
  <span class="thumb">${a.contentType.startsWith('image/') && !/hei[cf]/.test(a.contentType) ? `<img src="${esc(a.url)}" alt="" loading="lazy">` : `<span class="ext">${a.contentType === 'application/pdf' ? 'PDF' : 'FILE'}</span>`}</span>
  <span class="fname">${esc(a.name)}</span></a>`;

// Existing customers with the same email or phone, best match first.
function matchingCustomers(r) {
  const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
  const email = String(r.email || '').toLowerCase();
  return state.data.customers.filter((c) => (email && String(c.email || '').toLowerCase() === email)
    || (digits(r.phone).length === 10 && digits(c.phone) === digits(r.phone)));
}

export function requestView(id) {
  const r = get('requests', id);
  if (!r) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const customer = r.customerId && get('customers', r.customerId);
  const job = r.jobId && get('jobs', r.jobId);
  const matches = matchingCustomers(r);
  const edit = can.edit();
  const contact = [r.phone && `Phone ${phoneLink(r.phone)}`, r.email && `Email <a href="mailto:${esc(r.email)}">${esc(r.email)}</a>`].filter(Boolean).join('<br>');

  return {
    html: `<div class="page-head"><div class="page-title"><h1>${esc(r.name)} ${badge(r.status)}</h1></div><div class="actions">
      <a class="btn" href="#/requests">All requests</a>
      ${can.remove() ? '<button class="btn danger" id="del">Delete</button>' : ''}</div></div>
    <div class="cols">
      <div class="card"><h2>Contact</h2>
        <p>${esc(r.name)}${r.company ? `<br><b>${esc(r.company)}</b>` : ''}</p>
        <p>${contact}</p>
        <p class="muted small">Prefers ${esc(label(REQUEST_CONTACT, r.contactBy).toLowerCase())} · sent ${fmtWhen(r)} from the website</p>
        ${r.alert ? `<p class="muted small">${alertNote(r)}</p>` : ''}
      </div>
      <div class="card"><h2>Project</h2>
        <p><b>${esc(serviceLabel(r.service))}</b><br>${esc(r.siteAddress || 'No site address given')}<br><span class="muted">${esc(label(REQUEST_TIMELINES, r.timeline || ''))}</span></p>
        <p class="pre">${esc(r.details)}</p>
      </div>
    </div>
    <div class="card"><h2>Photos and plans</h2><div id="atts">${r.files ? '<p class="muted small">Loading…</p>' : '<p class="muted small">None sent.</p>'}</div></div>
    <div class="cols">
      <form class="card stack" id="work"><h2>Follow-up</h2>
        <label>Status <select name="status" ${edit ? '' : 'disabled'}>${options(REQUEST_STATUS.map((s) => [s, s]), r.status)}</select></label>
        <label>Notes <textarea name="notes" rows="4" maxlength="4000" ${edit ? '' : 'readonly'} placeholder="e.g. Called back, measuring Tuesday at 9">${esc(r.notes)}</textarea></label>
        ${edit ? '<div><button class="btn primary">Save</button></div>' : ''}
      </form>
      <div class="card stack"><h2>Customer and job</h2>
        ${job ? `<p>This request became the job <a href="#/jobs/${esc(job.id)}">${esc(job.name)}</a>${customer ? ` for <a href="#/customers/${esc(customer.id)}">${esc(customer.name)}</a>` : ''}.</p>
          ${edit ? `<div class="row"><a class="btn primary" href="#/estimates/new?job=${esc(job.id)}">New estimate</a><a class="btn" href="#/jobs/${esc(job.id)}?tab=files">Job files</a></div>` : ''}`
        : edit ? `<p class="small muted">Adds the customer (or uses one you already have) and a lead job with the site, the details and the photos, ready for an estimate.</p>
          <label>Customer <select id="cust">${options([['__new', `New customer: ${r.company || r.name}`], ...matches.map((c) => [c.id, `${c.name}${c.company ? ` (${c.company})` : ''}, already a customer`]), ...state.data.customers.filter((c) => !matches.includes(c)).sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((c) => [c.id, c.name + (c.company ? ` (${c.company})` : '')])], matches[0]?.id || '__new')}</select></label>
          <div><button class="btn primary" id="convert" type="button">Create customer and job</button></div>`
          : '<p class="muted small">Not turned into a job yet.</p>'}
      </div>
    </div>`,
    mount(root) {
      let atts = [];
      let paths = [];
      const box = root.querySelector('#atts');
      const ready = r.files ? loadAttachments(r).then(({ shown: list, paths: all }) => {
        atts = list;
        paths = all;
        box.innerHTML = list.length ? `<div class="file-grid">${list.map(attachmentTile).join('')}</div>`
          : '<p class="muted small">The customer picked files, but they didn\'t finish uploading.</p>';
      }).catch((e) => { console.error(e); box.innerHTML = `<p class="muted small">Couldn't load the files: ${esc(e.message)}</p>`; }) : Promise.resolve();

      root.querySelector('#work').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        if (await attempt(() => update('requests', id, { status: f.get('status'), notes: String(f.get('notes') || '').trim() }), 'Request saved') !== null) {
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }
      });

      root.querySelector('#convert')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        await ready;
        // Someone may have deleted it, or made it a job, since this page opened. (A request whose job
        // was deleted afterwards can be made into a job again.)
        const now = get('requests', id);
        if (!now) { toast('This request was deleted.', true); location.hash = '#/requests'; return; }
        if (now.jobId && (now.jobId !== r.jobId || get('jobs', now.jobId))) {
          toast('This request is already a job.', true);
          window.dispatchEvent(new HashChangeEvent('hashchange'));
          return;
        }
        const choice = root.querySelector('#cust').value;
        const jobId = await attempt(() => convert(now, choice === '__new' ? null : choice, atts));
        if (jobId) { toast('Customer and job created'); location.hash = `#/jobs/${jobId}`; } else btn.disabled = false;
      });

      root.querySelector('#del')?.addEventListener('click', async () => {
        if (!confirm(`Delete the request from ${r.name}? This can't be undone.${r.jobId ? ' The job and its files stay.' : ''}`)) return;
        await ready;
        const ok = await attempt(async () => {
          // Read it again, since it may have become a job since this page opened.
          const now = get('requests', id);
          await remove('requests', id);
          // Its photos belong to the job once it's converted, so keep them then.
          if (now && !now.jobId) await Promise.all(paths.map((p) => deleteObject(sref(storage, p)).catch((err) => console.warn(err))));
          return true;
        }, 'Request deleted');
        if (ok) location.hash = '#/requests';
      });
    },
  };
}

// Makes (or reuses) the customer, a lead job with the request's details, and job file records for the
// photos and plans (they stay where the customer uploaded them). Returns the new job's id.
async function convert(r, customerId, atts) {
  let custId = customerId;
  if (!custId) {
    const c = await add('customers', {
      name: r.name, company: r.company || '', phone: r.phone || '', email: r.email || '', address: '',
      notes: `From a website quote request (${fmtWhen(r)}). Prefers ${label(REQUEST_CONTACT, r.contactBy).toLowerCase()}.`,
    });
    custId = c.id;
  }
  const notes = [r.details, r.timeline ? `Timeline: ${label(REQUEST_TIMELINES, r.timeline)}` : '', r.notes ? `Follow-up notes: ${r.notes}` : ''].filter(Boolean).join('\n\n');
  const job = await add('jobs', {
    name: `${r.company || r.name}: ${serviceLabel(r.service)}`.slice(0, 120), customerId: custId, siteAddress: r.siteAddress || '',
    type: JOB_TYPE[r.service] || 'other', status: 'lead', architect: '', poNumber: '', notes, requestId: r.id,
  });
  for (const a of atts) {
    const image = a.contentType.startsWith('image/');
    await put('files', newId('files'), {
      jobId: job.id, customerId: custId, category: image ? 'photos' : 'plans', name: a.name, contentType: a.contentType, size: a.size,
      path: a.path, url: a.url, thumbPath: '', thumbUrl: image && !/hei[cf]/.test(a.contentType) ? a.url : '',
      note: 'Sent with the website quote request', createdByName: 'Website request',
    });
  }
  await update('requests', r.id, { status: 'converted', customerId: custId, jobId: job.id });
  return job.id;
}
