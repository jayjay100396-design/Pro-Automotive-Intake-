// Screens: dashboard, customers, jobs, estimates, contracts (with change orders), pay apps, invoices, settings.
// Each view returns { html, mount(root), live }. Live views re-render when data changes;
// editors render once so typing isn't interrupted.
import { state, add, update, remove, get, where, nextNumber, can, updateCompany, savePreparedBy, listMembers, transferOwnership, createInvite, listInvites, revokeInvite, inviteLink, setMemberRole, removeMember } from './data.js';
import {
  estimateTotals, invoiceTotals, lineTotal, lineQty, contractSum, g702, nextPayAppLines, money, pctFmt, round2,
  proposalOptions, estimateAmount,
} from './calc.js';
import { esc, today, addDays, fmtDate, options, badge, formData, readLines, toast, empty } from './ui.js';
import { fileBrowser, countJobFiles } from './files.js';

const go = (hash) => { location.hash = hash; };
const D = () => state.data;

const JOB_TYPES = [['storefront', 'Commercial storefront'], ['shower', 'Shower enclosure'], ['other', 'Other']];
const JOB_STATUS = ['lead', 'estimating', 'contracted', 'in progress', 'complete', 'closed'];
const EST_STATUS = ['draft', 'sent', 'accepted', 'declined'];
const CONTRACT_STATUS = ['draft', 'sent', 'signed', 'complete'];
const CO_STATUS = ['pending', 'approved', 'rejected'];
const PAYAPP_STATUS = ['draft', 'submitted', 'approved', 'paid'];
const INV_STATUS = ['unpaid', 'paid', 'void'];
const KINDS = ['Glass', 'Framing', 'Door', 'Hardware', 'Labor', 'Materials', 'Other'];
const UNITS = [['sqft', 'sq ft'], ['each', 'each'], ['lf', 'lin ft'], ['hour', 'hour'], ['lot', 'lot']];

const customerName = (id) => get('customers', id)?.name || '';
const jobName = (id) => get('jobs', id)?.name || '(no job)';
const jobLink = (id) => (id && get('jobs', id) ? `<a href="#/jobs/${esc(id)}">${esc(jobName(id))}</a>` : '');
const jobOptions = (selected) => options([['', 'Choose a job…'], ...D().jobs.map((j) => [j.id, `${j.name}${j.customerId ? ' · ' + customerName(j.customerId) : ''}`])], selected);
const sortNum = (a, b) => (Number(b.number) || 0) - (Number(a.number) || 0);
const coForContract = (cid) => where('changeOrders', 'contractId', cid);
const contractTotal = (c) => contractSum(c, coForContract(c.id)).toDate;

async function attempt(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { console.error(e); toast(e.code === 'permission-denied' ? 'Your role can\'t make that change.' : e.message, true); return null; }
}
const confirmDelete = (what) => confirm(`Delete this ${what}? This can't be undone.`);

const TILE_ICONS = {
  estimates: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  jobs: '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
  invoices: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  payapps: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
};
const tileIcon = (cls, k) => `<span class="t-icon ${cls}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TILE_ICONS[k]}</svg></span>`;

function header(title, actions = '') {
  return `<div class="page-head"><div class="page-title"><h1>${title}</h1></div><div class="actions">${actions}</div></div>`;
}

// ---------- Dashboard ----------
export function dashboard() {
  const est = D().estimates.filter((e) => ['draft', 'sent'].includes(e.status));
  const estValue = est.reduce((s, e) => s + estimateAmount(e), 0);
  const active = D().jobs.filter((j) => ['contracted', 'in progress'].includes(j.status));
  const unpaid = D().invoices.filter((i) => i.status === 'unpaid');
  const owed = unpaid.reduce((s, i) => s + invoiceTotals(i).total, 0);
  const overdue = unpaid.filter((i) => i.dueDate && i.dueDate < today());
  const pending = D().payApps.filter((p) => ['submitted', 'approved'].includes(p.status));
  const pendingDue = pending.reduce((s, p) => s + payAppSummary(p).currentDue, 0);
  const signed = D().contracts.filter((c) => ['signed', 'sent'].includes(c.status)).length;
  const pendingCOs = D().changeOrders.filter((c) => c.status === 'pending').length;
  const flow = [
    ['estimates', 'Estimate', `${est.length} open`],
    ['contracts', 'Contract', `${signed} sent or signed`],
    ['contracts', 'Change order', `${pendingCOs} pending`],
    ['payapps', 'Pay app', `${pending.length} awaiting payment`],
    ['invoices', 'Invoice', `${unpaid.length} unpaid`],
  ];
  const recentJobs = [...D().jobs].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)).slice(0, 6);

  return {
    live: true,
    html: `
    ${header(`${esc(state.company?.name || 'Stellar Glass')}`, can.edit() ? `<a class="btn primary" href="#/jobs/new">New job</a> <a class="btn" href="#/estimates/new">New estimate</a>` : '')}
    <div class="tiles">
      <a class="tile" href="#/estimates">${tileIcon('i-cyan', 'estimates')}<span class="t-label">Open estimates</span><span class="t-value">${est.length}</span><span class="t-sub">${money(estValue)} quoted</span></a>
      <a class="tile" href="#/jobs">${tileIcon('i-blue', 'jobs')}<span class="t-label">Active jobs</span><span class="t-value">${active.length}</span><span class="t-sub">${D().jobs.length} in all</span></a>
      <a class="tile" href="#/invoices">${tileIcon('i-amber', 'invoices')}<span class="t-label">Invoices owed</span><span class="t-value">${money(owed)}</span><span class="t-sub ${overdue.length ? 'warn' : ''}">${unpaid.length} unpaid${overdue.length ? `, ${overdue.length} overdue` : ''}</span></a>
      <a class="tile" href="#/payapps">${tileIcon('i-purple', 'payapps')}<span class="t-label">Pay apps pending</span><span class="t-value">${money(pendingDue)}</span><span class="t-sub">${pending.length} submitted or approved</span></a>
    </div>
    <nav class="flow" aria-label="Job workflow">
      ${flow.map(([href, name, note], i) => `${i ? '<span class="flow-arrow" aria-hidden="true">→</span>' : ''}<a href="#/${href}"><span class="step-num">${i + 1}</span><span><strong>${name}</strong><small>${note}</small></span></a>`).join('')}
    </nav>
    <div class="card"><h2>Recent jobs</h2>
      ${recentJobs.length ? `<table class="list"><thead><tr><th>Job</th><th>Customer</th><th>Type</th><th>Status</th></tr></thead><tbody>
      ${recentJobs.map((j) => `<tr data-href="#/jobs/${esc(j.id)}"><td>${esc(j.name)}</td><td>${esc(customerName(j.customerId))}</td><td>${esc(JOB_TYPES.find((t) => t[0] === j.type)?.[1] || '')}</td><td>${badge(j.status)}</td></tr>`).join('')}
      </tbody></table>` : empty('No jobs yet. Start with a customer and a job, then build the estimate.', can.edit() ? '<a class="btn primary" href="#/jobs/new">Add the first job</a>' : '')}
    </div>`,
  };
}

// ---------- Customers ----------
export function customers() {
  const rows = [...D().customers].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return {
    live: true,
    html: `${header('Customers', can.edit() ? '<a class="btn primary" href="#/customers/new">New customer</a>' : '')}
    <div class="card">${rows.length ? `<table class="list"><thead><tr><th>Name</th><th>Company</th><th>Phone</th><th>Email</th><th>Jobs</th></tr></thead><tbody>
      ${rows.map((c) => `<tr data-href="#/customers/${esc(c.id)}"><td>${esc(c.name)}</td><td>${esc(c.company)}</td><td>${esc(c.phone)}</td><td>${esc(c.email)}</td><td>${where('jobs', 'customerId', c.id).length}</td></tr>`).join('')}
    </tbody></table>` : empty('No customers yet.')}</div>`,
  };
}

export function customerEdit(id) {
  const isNew = id === 'new';
  const c = isNew ? {} : get('customers', id);
  if (!c) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const jobs = isNew ? [] : where('jobs', 'customerId', id);
  return {
    html: `${header(isNew ? 'New customer' : esc(c.name), !isNew && can.remove() ? '<button class="btn danger" id="del">Delete</button>' : '')}
    <form class="card grid2" id="f">
      <label>Name <input name="name" value="${esc(c.name)}" required></label>
      <label>Company / GC <input name="company" value="${esc(c.company)}"></label>
      <label>Phone <input name="phone" type="tel" value="${esc(c.phone)}"></label>
      <label>Email <input name="email" type="email" value="${esc(c.email)}"></label>
      <label class="span2">Billing address <input name="address" value="${esc(c.address)}"></label>
      <label class="span2">Notes <textarea name="notes" rows="3">${esc(c.notes)}</textarea></label>
      <div class="span2 row"><button class="btn primary" ${can.edit() ? '' : 'disabled'}>Save customer</button>
      ${!isNew ? `<a class="btn" href="#/jobs/new?customer=${esc(id)}">New job for this customer</a>` : ''}</div>
    </form>
    ${jobs.length ? `<div class="card"><h2>Jobs</h2><ul class="links">${jobs.map((j) => `<li>${jobLink(j.id)} ${badge(j.status)}</li>`).join('')}</ul></div>` : ''}`,
    mount(root) {
      root.querySelector('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = formData(e.target);
        if (isNew) {
          const r = await attempt(() => add('customers', data), 'Customer saved');
          if (r) go(`#/customers/${r.id}`);
        } else await attempt(() => update('customers', id, data), 'Customer saved');
      });
      root.querySelector('#del')?.addEventListener('click', async () => {
        if (confirmDelete('customer') && await attempt(() => remove('customers', id), 'Customer deleted') !== null) go('#/customers');
      });
    },
  };
}

// ---------- Jobs ----------
export function jobs() {
  const rows = [...D().jobs].sort((a, b) => JOB_STATUS.indexOf(a.status) - JOB_STATUS.indexOf(b.status) || (a.name || '').localeCompare(b.name || ''));
  return {
    live: true,
    html: `${header('Jobs', can.edit() ? '<a class="btn primary" href="#/jobs/new">New job</a>' : '')}
    <div class="card">${rows.length ? `<table class="list"><thead><tr><th>Job</th><th>Customer</th><th>Site</th><th>Type</th><th>Status</th><th class="num">Contract</th></tr></thead><tbody>
    ${rows.map((j) => {
      const c = where('contracts', 'jobId', j.id)[0];
      return `<tr data-href="#/jobs/${esc(j.id)}"><td>${esc(j.name)}</td><td>${esc(customerName(j.customerId))}</td><td>${esc(j.siteAddress)}</td><td>${esc(JOB_TYPES.find((t) => t[0] === j.type)?.[1] || '')}</td><td>${badge(j.status)}</td><td class="num">${c ? money(contractTotal(c)) : ''}</td></tr>`;
    }).join('')}</tbody></table>` : empty('No jobs yet.')}</div>`,
  };
}

// The job's tabs: details and paperwork, and its files.
const jobTabs = (id, tab) => `<nav class="tabs" aria-label="Job sections">
  <a href="#/jobs/${esc(id)}" class="${tab === 'files' ? '' : 'on'}">Details</a>
  <a href="#/jobs/${esc(id)}?tab=files" class="${tab === 'files' ? 'on' : ''}">Files <span data-file-count></span></a></nav>`;

export function jobEdit(id, params) {
  const isNew = id === 'new';
  const j = isNew ? { status: 'lead', type: 'storefront', customerId: params.get('customer') || '' } : get('jobs', id);
  if (!j) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  if (!isNew && params.get('tab') === 'files') {
    const files = fileBrowser({ jobId: id });
    return {
      html: `${header(esc(j.name), `<span class="muted">${esc(customerName(j.customerId))}</span>`)}${jobTabs(id, 'files')}${files.html}`,
      mount: files.mount,
      unmount: files.unmount,
    };
  }
  const related = (c) => (isNew ? [] : where(c, 'jobId', id).sort(sortNum));
  const ests = related('estimates'); const cons = related('contracts'); const pays = related('payApps'); const invs = related('invoices');
  const custOpts = options([['', 'Choose a customer…'], ['__new', '+ Add a new customer'], ...D().customers.map((c) => [c.id, c.name + (c.company ? ` (${c.company})` : '')])], j.customerId);

  return {
    html: `${header(isNew ? 'New job' : esc(j.name), !isNew && can.remove() ? '<button class="btn danger" id="del">Delete</button>' : '')}
    ${isNew ? '' : jobTabs(id, 'details')}
    <form class="card grid2" id="f">
      <label>Job name <input name="name" value="${esc(j.name)}" placeholder="e.g. Publix #1432 storefront" required></label>
      <label>Customer <select name="customerId" id="cust">${custOpts}</select></label>
      <div class="span2 grid2 hidden" id="newcust">
        <label>New customer name <input name="newCustName"></label>
        <label>Phone <input name="newCustPhone" type="tel"></label>
      </div>
      <label class="span2">Site address <input name="siteAddress" value="${esc(j.siteAddress)}"></label>
      <label>Type <select name="type">${options(JOB_TYPES, j.type)}</select></label>
      <label>Status <select name="status">${options(JOB_STATUS.map((s) => [s, s]), j.status)}</select></label>
      <label>GC / Architect <input name="architect" value="${esc(j.architect)}"></label>
      <label>Customer PO / project # <input name="poNumber" value="${esc(j.poNumber)}"></label>
      <label class="span2">Notes <textarea name="notes" rows="3">${esc(j.notes)}</textarea></label>
      <div class="span2 row"><button class="btn primary" ${can.edit() ? '' : 'disabled'}>Save job</button></div>
    </form>
    ${isNew ? '' : `
    <div class="cols">
      <div class="card"><div class="row between"><h2>Estimates</h2>${can.edit() ? `<a class="btn small" href="#/estimates/new?job=${esc(id)}">New estimate</a>` : ''}</div>
        ${ests.length ? `<ul class="links">${ests.map((e) => `<li><a href="#/estimates/${esc(e.id)}">Proposal ${esc(e.number)}</a> ${badge(e.status)} <span class="num">${money(estimateAmount(e))}</span></li>`).join('')}</ul>` : '<p class="muted">None yet.</p>'}</div>
      <div class="card"><h2>Contracts and change orders</h2>
        ${cons.length ? `<ul class="links">${cons.map((c) => `<li><a href="#/contracts/${esc(c.id)}">Contract ${esc(c.number)}</a> ${badge(c.status)} <span class="num">${money(contractTotal(c))}</span>${coForContract(c.id).length ? `<br><span class="muted small">${coForContract(c.id).length} change order(s)</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Accept an estimate and convert it to a contract.</p>'}</div>
      <div class="card"><h2>Pay apps</h2>
        ${pays.length ? `<ul class="links">${pays.map((p) => `<li><a href="#/payapps/${esc(p.id)}">Application ${esc(p.number)}</a> ${badge(p.status)} <span class="num">${money(payAppSummary(p).currentDue)}</span></li>`).join('')}</ul>` : '<p class="muted">Start pay apps from the contract.</p>'}</div>
      <div class="card"><div class="row between"><h2>Invoices</h2>${can.bill() ? `<a class="btn small" href="#/invoices/new?job=${esc(id)}">New invoice</a>` : ''}</div>
        ${invs.length ? `<ul class="links">${invs.map((i) => `<li><a href="#/invoices/${esc(i.id)}">Invoice ${esc(i.number)}</a> ${badge(i.status)} <span class="num">${money(invoiceTotals(i).total)}</span></li>`).join('')}</ul>` : '<p class="muted">None yet.</p>'}</div>
    </div>`}`,
    mount(root) {
      if (!isNew) countJobFiles(id).then((n) => { const c = root.querySelector('[data-file-count]'); if (c && n) c.textContent = `(${n})`; }).catch(() => {});
      const cust = root.querySelector('#cust');
      cust.addEventListener('change', () => root.querySelector('#newcust').classList.toggle('hidden', cust.value !== '__new'));
      root.querySelector('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const { newCustName, newCustPhone, ...data } = formData(e.target);
        if (data.customerId === '__new') {
          if (!newCustName) return toast('Enter the new customer\'s name.', true);
          const c = await attempt(() => add('customers', { name: newCustName, phone: newCustPhone || '' }));
          if (!c) return;
          data.customerId = c.id;
        }
        if (isNew) {
          const r = await attempt(() => add('jobs', data), 'Job saved');
          if (r) go(`#/jobs/${r.id}`);
        } else await attempt(() => update('jobs', id, data), 'Job saved');
      });
      root.querySelector('#del')?.addEventListener('click', async () => {
        if (confirmDelete('job') && await attempt(() => remove('jobs', id), 'Job deleted') !== null) go('#/jobs');
      });
    },
  };
}

// ---------- Files across all jobs ----------
export function filesPage(params) {
  const files = fileBrowser({ jobId: null, startJob: params.get('job') || '' });
  return { html: `${header('Files')}${files.html}`, mount: files.mount, unmount: files.unmount };
}

// ---------- Estimates ----------
const PRESETS = {
  storefront: [
    { desc: '1" insulated clear tempered glass', kind: 'Glass', unit: 'sqft', qty: 1, widthIn: 48, heightIn: 96, minSqft: 3, price: 28, taxable: true },
    { desc: '4-1/2" aluminum storefront framing, clear anodized', kind: 'Framing', unit: 'lf', qty: 40, price: 32, taxable: true },
    { desc: 'Medium stile door, closer, panic hardware', kind: 'Door', unit: 'each', qty: 1, price: 2400, taxable: true },
    { desc: 'Caulking and fasteners', kind: 'Materials', unit: 'lot', qty: 1, price: 150, taxable: true },
    { desc: 'Installation labor', kind: 'Labor', unit: 'hour', qty: 16, price: 75, taxable: false },
  ],
  shower: [
    { desc: '3/8" clear tempered door panel', kind: 'Glass', unit: 'sqft', qty: 1, widthIn: 28, heightIn: 72, minSqft: 3, price: 38, taxable: true },
    { desc: '3/8" clear tempered fixed panel', kind: 'Glass', unit: 'sqft', qty: 1, widthIn: 30, heightIn: 72, minSqft: 3, price: 38, taxable: true },
    { desc: 'Hinges, pull handle, clips (brushed nickel)', kind: 'Hardware', unit: 'lot', qty: 1, price: 320, taxable: true },
    { desc: 'Installation labor', kind: 'Labor', unit: 'hour', qty: 4, price: 75, taxable: false },
  ],
};

const PROPOSAL_DEFAULTS = {
  intro: 'We propose to supply and install the following in prepared openings:',
  priceNote: '*Prices subject to change due to volatility of pricing in the marketplace.',
  exclusions: 'Cleaning; Protection; brake metal flashing.',
  terms: 'A 50% deposit is required before materials can be ordered.',
};
const OPTION_SPECS = {
  storefront: 'Aluminum Framing- Clear anodized; non-thermal; non-impact resistant\nGlass: 1" Clear Low E Tempered Insulated',
  shower: 'Glass: 3/8" Clear Tempered\nHardware: Brushed nickel hinges, pull handle and clips',
};

function optionCard(o = {}, i = 0, accepted = 0) {
  return `<div class="opt" data-opt>
    <div class="row between"><b class="opt-title">Price ${i + 1}</b>
      <span class="row"><label class="inline"><input type="radio" name="acceptedOption" value="${i}" ${i === accepted ? 'checked' : ''}> Accepted</label>
      <button type="button" class="icon" data-delopt title="Remove option">✕</button></span></div>
    <div class="grid4">
      <label class="span2">Name (optional, e.g. a manufacturer) <input name="name" value="${esc(o.name)}" placeholder="e.g. Akela"></label>
      <label>Price <input name="price" type="number" step="0.01" value="${esc(o.fromLines ? '' : o.price ?? '')}" ${o.fromLines ? 'disabled' : ''}></label>
      <label class="inline">&nbsp;<span><input type="checkbox" name="fromLines" ${o.fromLines ? 'checked' : ''}> Use line-item total</span></label>
      <label class="span4">Specs (one per line) <textarea name="specs" rows="3">${esc(o.specs)}</textarea></label>
    </div>
  </div>`;
}

function readOptions(container) {
  return [...container.querySelectorAll('[data-opt]')].map((el) => {
    const fromLines = el.querySelector('[name=fromLines]').checked;
    const price = el.querySelector('[name=price]').value;
    return { name: el.querySelector('[name=name]').value.trim(), fromLines, price: fromLines ? null : Number(price) || 0, specs: el.querySelector('[name=specs]').value };
  });
}

function estLineRow(l = {}) {
  const sq = l.unit === 'sqft';
  return `<tr data-row>
    <td><input name="desc" value="${esc(l.desc)}" placeholder="Description"></td>
    <td><select name="kind">${options(KINDS.map((k) => [k, k]), l.kind || 'Glass')}</select></td>
    <td><input name="qty" type="number" step="any" min="0" value="${esc(l.qty ?? 1)}" class="n"></td>
    <td><select name="unit" data-unit>${options(UNITS, l.unit || 'each')}</select></td>
    <td><input name="widthIn" type="number" step="any" min="0" value="${esc(l.widthIn ?? '')}" class="n" ${sq ? '' : 'disabled'} title="Width (in)"></td>
    <td><input name="heightIn" type="number" step="any" min="0" value="${esc(l.heightIn ?? '')}" class="n" ${sq ? '' : 'disabled'} title="Height (in)"></td>
    <td><input name="minSqft" type="number" step="any" min="0" value="${esc(l.minSqft ?? '')}" class="n" ${sq ? '' : 'disabled'} title="Minimum billable sq ft per lite"></td>
    <td><input name="price" type="number" step="0.01" value="${esc(l.price ?? 0)}" class="n"></td>
    <td class="c"><input name="taxable" type="checkbox" ${l.taxable === false ? '' : 'checked'}></td>
    <td class="num" data-qty></td>
    <td class="num" data-total></td>
    <td><button type="button" class="icon" data-del title="Remove line">✕</button></td>
  </tr>`;
}

export function estimates() {
  const rows = [...D().estimates].sort(sortNum);
  return {
    live: true,
    html: `${header('Estimates', can.edit() ? '<a class="btn primary" href="#/estimates/new">New proposal</a>' : '')}
    <div class="card">${rows.length ? `<table class="list"><thead><tr><th>#</th><th>Job</th><th>Customer</th><th>Date</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>
    ${rows.map((e) => `<tr data-href="#/estimates/${esc(e.id)}"><td>${esc(e.number)}</td><td>${esc(jobName(e.jobId))}</td><td>${esc(customerName(get('jobs', e.jobId)?.customerId))}</td><td>${fmtDate(e.date)}</td><td>${badge(e.status)}</td><td class="num">${money(estimateAmount(e))}</td></tr>`).join('')}
    </tbody></table>` : empty('No estimates yet.')}</div>`,
  };
}

export function estimateEdit(id, params) {
  const isNew = id === 'new';
  const job = get('jobs', params.get('job'));
  const e = isNew
    ? (() => {
      const template = job?.type === 'shower' ? 'shower' : 'storefront';
      const prep = state.profile?.preparedBy || {};
      return {
        number: nextNumber('estimates'), jobId: job?.id || '', date: today(), validUntil: addDays(today(), 30), status: 'draft', template,
        markupPct: 0, minCharge: 250, taxPct: 7, lines: [], ...PROPOSAL_DEFAULTS, scope: '', attn: '', projectTitle: job?.name || '',
        options: [{ fromLines: true, name: '', specs: OPTION_SPECS[template] }], acceptedOption: 0, showLines: false,
        preparedName: prep.name || state.user.displayName || '', preparedTitle: prep.title || 'Estimator',
        preparedPhone: prep.phone || state.user.phoneNumber || '', preparedEmail: prep.email || state.user.email || '',
      };
    })()
    : get('estimates', id);
  if (!e) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const opts = e.options?.length ? e.options : [{ fromLines: true, name: '', specs: '' }];
  const accepted = Number(e.acceptedOption) || 0;
  const lines = e.lines?.length ? e.lines : PRESETS[e.template] || PRESETS.storefront;
  const hasContract = !isNew && where('contracts', 'estimateId', id).length;
  const ro = can.edit() ? '' : 'disabled';

  return {
    html: `${header(isNew ? 'New proposal' : `Proposal ${esc(e.number)}`, `
      ${!isNew ? `<a class="btn" href="#/estimates/${esc(id)}/print">Print proposal / PDF</a>` : ''}
      ${!isNew && can.edit() && !hasContract ? '<button class="btn" id="tocontract">Convert to contract</button>' : ''}
      ${hasContract ? `<a class="btn" href="#/contracts/${esc(where('contracts', 'estimateId', id)[0].id)}">View contract</a>` : ''}
      ${!isNew && can.remove() ? '<button class="btn danger" id="del">Delete</button>' : ''}`)}
    <form id="f" class="stack">
      <fieldset class="card grid4" ${ro}>
        <label class="span2">Job <select name="jobId" required>${jobOptions(e.jobId)}</select></label>
        <label>Proposal # <input name="number" type="number" value="${esc(e.number)}"></label>
        <label>Status <select name="status">${options(EST_STATUS.map((s) => [s, s]), e.status)}</select></label>
        <label>Date <input name="date" type="date" value="${esc(e.date)}"></label>
        <label>Valid until <input name="validUntil" type="date" value="${esc(e.validUntil)}"></label>
        <label>Template <select name="template" id="template">${options([['storefront', 'Storefront'], ['shower', 'Shower']], e.template)}</select></label>
        <label>&nbsp;<button type="button" class="btn" id="preset">Load template lines</button></label>
      </fieldset>
      <fieldset class="card grid4" ${ro}>
        <h2 class="span4">Proposal</h2>
        <label class="span2">Project (as printed) <input name="projectTitle" value="${esc(e.projectTitle)}" placeholder="Job name, e.g. Lakeland Central Park Bldg 300 - Revised"></label>
        <label class="span2">Attn (contact at the customer) <input name="attn" value="${esc(e.attn)}" placeholder="Leave blank to use the customer's name"></label>
        <label class="span4">Opening line <input name="intro" value="${esc(e.intro ?? PROPOSAL_DEFAULTS.intro)}"></label>
        <label class="span4">Openings / scope <textarea name="scope" rows="2" placeholder="(4) F2; (8) F3; (10) F4; (8) F5; (38) F8">${esc(e.scope)}</textarea></label>
      </fieldset>
      <fieldset class="card" ${ro}>
        <div class="row between"><h2>Prices</h2><button type="button" class="btn small" id="addopt">+ Add price option</button></div>
        <p class="hint">Each option prints as "Price 1", "Price 2"… with its specs. Use the line-item total for one, or type a lump sum. Mark the one the customer accepts; that's the amount used for the contract.</p>
        <div id="opts" class="stack" data-lines>${opts.map((o, i) => optionCard(o, i, accepted)).join('')}</div>
      </fieldset>
      <fieldset class="card" ${ro}>
        <h2>Line items <span class="muted small">(your pricing; not printed unless you choose)</span></h2>
        <div class="scroll"><table class="lines" data-lines>
          <thead><tr><th>Description</th><th>Kind</th><th>Qty</th><th>Unit</th><th>W in</th><th>H in</th><th>Min sf</th><th>Price</th><th>Tax</th><th class="num">Bill qty</th><th class="num">Total</th><th></th></tr></thead>
          <tbody id="lines">${lines.map(estLineRow).join('')}</tbody>
        </table></div>
        <button type="button" class="btn small" id="addline">+ Add line</button>
        <p class="hint">For sq ft lines, enter one lite's width and height in inches and the number of lites as Qty. Each lite bills at least the minimum sq ft.</p>
      </fieldset>
      <div class="cols">
        <fieldset class="card grid2" ${ro}>
          <label>Markup % <input name="markupPct" type="number" step="any" value="${esc(e.markupPct)}"></label>
          <label>Minimum charge <input name="minCharge" type="number" step="0.01" value="${esc(e.minCharge)}"></label>
          <label>Sales tax % <input name="taxPct" type="number" step="any" value="${esc(e.taxPct)}"></label>
          <span></span>
          <label class="span2 inline"><span><input type="checkbox" name="showLines" ${e.showLines ? 'checked' : ''}> Print the itemized line list on the proposal</span></label>
          <label class="span2">Internal notes (not printed) <textarea name="notes" rows="2">${esc(e.notes)}</textarea></label>
        </fieldset>
        <div class="card totals" id="totals"></div>
      </div>
      <fieldset class="card grid4" ${ro}>
        <h2 class="span4">Terms</h2>
        <label class="span4">Price note <input name="priceNote" value="${esc(e.priceNote ?? PROPOSAL_DEFAULTS.priceNote)}"></label>
        <label class="span4">Exclude <input name="exclusions" value="${esc(e.exclusions ?? '')}" placeholder="Cleaning; Protection; brake metal flashing."></label>
        <label class="span4">Payment terms <textarea name="terms" rows="2">${esc(e.terms)}</textarea></label>
        <h2 class="span4 top-gap">Proposal prepared by</h2>
        <label>Name <input name="preparedName" value="${esc(e.preparedName)}"></label>
        <label>Title <input name="preparedTitle" value="${esc(e.preparedTitle)}"></label>
        <label>Phone <input name="preparedPhone" type="tel" value="${esc(e.preparedPhone)}"></label>
        <label>Email <input name="preparedEmail" type="email" value="${esc(e.preparedEmail)}"></label>
      </fieldset>
      <div class="row"><button class="btn primary" ${ro}>Save proposal</button></div>
    </form>`,
    mount(root) {
      const body = root.querySelector('#lines');
      const form = root.querySelector('#f');
      const optBox = root.querySelector('#opts');
      const acceptedIndex = () => Number(optBox.querySelector('[name=acceptedOption]:checked')?.value) || 0;
      const recalc = () => {
        const ls = readLines(body);
        body.querySelectorAll('tr[data-row]').forEach((tr, i) => {
          const l = ls[i];
          tr.querySelector('[data-qty]').textContent = l.unit === 'sqft' ? lineQty(l).toFixed(2) : '';
          tr.querySelector('[data-total]').textContent = money(lineTotal(l));
          tr.querySelectorAll('[name=widthIn],[name=heightIn],[name=minSqft]').forEach((x) => { x.disabled = l.unit !== 'sqft'; });
        });
        const cur = { ...formData(form), lines: ls, options: readOptions(optBox) };
        const t = estimateTotals(cur);
        optBox.querySelectorAll('[data-opt]').forEach((el, i) => {
          el.querySelector('.opt-title').textContent = `Price ${i + 1}`;
          el.querySelector('[name=acceptedOption]').value = i;
          const fl = el.querySelector('[name=fromLines]').checked;
          const price = el.querySelector('[name=price]');
          price.disabled = fl;
          if (fl) price.placeholder = money(t.total);
        });
        root.querySelector('#totals').innerHTML = `
          <div class="tr"><span>Line items</span><span>${money(t.subtotal)}</span></div>
          ${t.markup ? `<div class="tr"><span>Markup</span><span>${money(t.markup)}</span></div>` : ''}
          ${t.minApplied ? '<div class="tr warn"><span>Minimum charge applied</span><span></span></div>' : ''}
          <div class="tr"><span>Tax</span><span>${money(t.tax)}</span></div>
          <div class="tr"><span>Line-item total</span><span>${money(t.total)}</span></div>
          ${proposalOptions(cur).map((o) => `<div class="tr ${o.number - 1 === acceptedIndex() ? 'grand' : ''}"><span>Price ${o.number}${o.name ? ` (${esc(o.name)})` : ''}</span><span>${money(o.price)}</span></div>`).join('')}`;
      };
      form.addEventListener('input', recalc);
      form.addEventListener('change', recalc);
      body.addEventListener('click', (ev) => { if (ev.target.closest('[data-del]')) { ev.target.closest('tr').remove(); recalc(); } });
      root.querySelector('#addline').addEventListener('click', () => { body.insertAdjacentHTML('beforeend', estLineRow({ unit: 'sqft', qty: 1, minSqft: 3 })); recalc(); });
      root.querySelector('#addopt').addEventListener('click', () => {
        const n = optBox.querySelectorAll('[data-opt]').length;
        optBox.insertAdjacentHTML('beforeend', optionCard({ fromLines: false, specs: OPTION_SPECS[root.querySelector('#template').value] || '' }, n, -1));
        recalc();
      });
      optBox.addEventListener('click', (ev) => {
        if (!ev.target.closest('[data-delopt]')) return;
        if (optBox.querySelectorAll('[data-opt]').length === 1) return toast('A proposal needs at least one price.', true);
        ev.target.closest('[data-opt]').remove();
        if (!optBox.querySelector('[name=acceptedOption]:checked')) optBox.querySelector('[name=acceptedOption]').checked = true;
        recalc();
      });
      root.querySelector('#preset').addEventListener('click', () => {
        const t = root.querySelector('#template').value;
        if (readLines(body).some((l) => l.desc) && !confirm('Replace the current lines with the template lines?')) return;
        body.innerHTML = PRESETS[t].map(estLineRow).join(''); recalc();
      });
      recalc();

      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const data = { ...formData(form), lines: readLines(body).filter((l) => l.desc || l.price), options: readOptions(optBox), acceptedOption: acceptedIndex() };
        data.total = estimateTotals(data).total;
        data.amount = estimateAmount(data);
        data.customerId = get('jobs', data.jobId)?.customerId || '';
        if (!data.projectTitle) data.projectTitle = get('jobs', data.jobId)?.name || '';
        savePreparedBy({ name: data.preparedName, title: data.preparedTitle, phone: data.preparedPhone, email: data.preparedEmail });
        if (isNew) {
          const r = await attempt(() => add('estimates', data), 'Proposal saved');
          if (r) {
            const j = get('jobs', data.jobId);
            if (j && j.status === 'lead') update('jobs', j.id, { status: 'estimating' }).catch(() => {});
            go(`#/estimates/${r.id}`);
          }
        } else await attempt(() => update('estimates', id, data), 'Proposal saved');
      });
      root.querySelector('#del')?.addEventListener('click', async () => {
        if (confirmDelete('proposal') && await attempt(() => remove('estimates', id), 'Proposal deleted') !== null) go('#/estimates');
      });
      root.querySelector('#tocontract')?.addEventListener('click', async () => {
        const cur = get('estimates', id);
        const t = estimateTotals(cur);
        const opt = proposalOptions(cur)[Number(cur.acceptedOption) || 0] || proposalOptions(cur)[0];
        let sov;
        if (opt.fromLines && cur.lines?.length) {
          // Schedule of values: one line per estimate line, scaled so it adds up to the accepted price.
          const factor = t.subtotal ? opt.price / t.subtotal : 1;
          sov = cur.lines.map((l, i) => ({ item: i + 1, desc: l.desc, value: round2(lineTotal(l) * factor) }));
          const diff = round2(opt.price - sov.reduce((sum, l) => sum + l.value, 0));
          sov[sov.length - 1].value = round2(sov[sov.length - 1].value + diff);
        } else {
          const spec = (opt.specs || '').split('\n').map((x) => x.trim()).filter(Boolean).join('; ');
          sov = [{ item: 1, desc: `Supply and install per proposal ${cur.number}, Price ${opt.number}${opt.name ? ` (${opt.name})` : ''}${spec ? ': ' + spec : ''}`, value: opt.price }];
        }
        const terms = [cur.terms, cur.exclusions ? `Exclude: ${cur.exclusions}` : ''].filter(Boolean).join('\n');
        const r = await attempt(() => add('contracts', {
          number: nextNumber('contracts'), jobId: cur.jobId, customerId: cur.customerId || '', estimateId: id, date: today(),
          amount: opt.price, retainagePct: 10, status: 'draft', sov, terms,
        }), 'Contract created');
        if (r) {
          update('estimates', id, { status: 'accepted' }).catch(() => {});
          if (get('jobs', cur.jobId)) update('jobs', cur.jobId, { status: 'contracted' }).catch(() => {});
          go(`#/contracts/${r.id}`);
        }
      });
    },
  };
}

// ---------- Contracts and change orders ----------
export function contracts() {
  const rows = [...D().contracts].sort(sortNum);
  return {
    live: true,
    html: `${header('Contracts')}
    <div class="card">${rows.length ? `<table class="list"><thead><tr><th>#</th><th>Job</th><th>Date</th><th>Status</th><th class="num">Original</th><th class="num">Change orders</th><th class="num">Contract sum</th></tr></thead><tbody>
    ${rows.map((c) => { const s = contractSum(c, coForContract(c.id)); return `<tr data-href="#/contracts/${esc(c.id)}"><td>${esc(c.number)}</td><td>${esc(jobName(c.jobId))}</td><td>${fmtDate(c.date)}</td><td>${badge(c.status)}</td><td class="num">${money(s.original)}</td><td class="num">${money(s.netChange)}</td><td class="num">${money(s.toDate)}</td></tr>`; }).join('')}
    </tbody></table>` : empty('No contracts yet. Open an estimate and choose "Convert to contract".')}</div>`,
  };
}

const sovRow = (l = {}) => `<tr data-row>
  <td><input name="item" value="${esc(l.item ?? '')}" class="n"></td>
  <td><input name="desc" value="${esc(l.desc)}"></td>
  <td><input name="value" type="number" step="0.01" value="${esc(l.value ?? 0)}" class="n"></td>
  <td><button type="button" class="icon" data-del>✕</button></td></tr>`;

export function contractEdit(id) {
  const c = get('contracts', id);
  if (!c) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const cos = coForContract(id).sort(sortNum);
  const s = contractSum(c, cos);
  const pays = where('payApps', 'contractId', id).sort(sortNum);
  const ro = can.edit() ? '' : 'disabled';
  return {
    live: false,
    html: `${header(`Contract ${esc(c.number)}`, `<a class="btn" href="#/contracts/${esc(id)}/print">Print / PDF</a>
      ${can.bill() ? '<button class="btn primary" id="newpay">New pay app</button>' : ''}
      ${can.remove() ? '<button class="btn danger" id="del">Delete</button>' : ''}`)}
    <p class="muted">${jobLink(c.jobId)}${c.estimateId ? ` · from <a href="#/estimates/${esc(c.estimateId)}">estimate ${esc(get('estimates', c.estimateId)?.number || '')}</a>` : ''}</p>
    <div class="tiles small">
      <div class="tile"><span class="t-label">Original contract</span><span class="t-value">${money(s.original)}</span></div>
      <div class="tile"><span class="t-label">Approved change orders</span><span class="t-value">${money(s.netChange)}</span></div>
      <div class="tile"><span class="t-label">Contract sum to date</span><span class="t-value">${money(s.toDate)}</span></div>
    </div>
    <form id="f" class="stack">
      <fieldset class="card grid4" ${ro}>
        <label>Contract # <input name="number" type="number" value="${esc(c.number)}"></label>
        <label>Date <input name="date" type="date" value="${esc(c.date)}"></label>
        <label>Status <select name="status">${options(CONTRACT_STATUS.map((x) => [x, x]), c.status)}</select></label>
        <label>Retainage % <input name="retainagePct" type="number" step="any" value="${esc(c.retainagePct)}"></label>
        <label>Original contract sum <input name="amount" type="number" step="0.01" value="${esc(c.amount)}"></label>
        <label>Signed by <input name="signedBy" value="${esc(c.signedBy)}"></label>
        <label>Signed date <input name="signedDate" type="date" value="${esc(c.signedDate)}"></label>
        <span></span>
        <label class="span4">Terms <textarea name="terms" rows="4">${esc(c.terms)}</textarea></label>
      </fieldset>
      <fieldset class="card" ${ro}>
        <h2>Schedule of values</h2>
        <p class="hint">These lines become the G703 continuation sheet on every pay app.</p>
        <table class="lines" data-lines><thead><tr><th>Item</th><th>Description of work</th><th>Scheduled value</th><th></th></tr></thead>
        <tbody id="sov">${(c.sov || []).map(sovRow).join('')}</tbody></table>
        <div class="row between"><button type="button" class="btn small" id="addsov">+ Add line</button><span id="sovcheck" class="small"></span></div>
      </fieldset>
      <div class="row"><button class="btn primary" ${ro}>Save contract</button></div>
    </form>
    <div class="card">
      <h2>Change orders</h2>
      ${cos.length ? `<table class="list"><thead><tr><th>#</th><th>Date</th><th>Description</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead><tbody>
      ${cos.map((co) => `<tr><td>${esc(co.number)}</td><td>${fmtDate(co.date)}</td><td>${esc(co.desc)}</td><td>${badge(co.status)}</td><td class="num">${money(co.amount)}</td>
        <td class="actions-cell">${can.edit() && co.status === 'pending' ? `<button class="btn small" data-co="${esc(co.id)}" data-st="approved">Approve</button> <button class="btn small" data-co="${esc(co.id)}" data-st="rejected">Reject</button>` : ''}
        <a class="btn small" href="#/changeorders/${esc(co.id)}/print">Print</a>
        ${can.remove() ? `<button class="icon" data-codel="${esc(co.id)}" title="Delete">✕</button>` : ''}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">No change orders.</p>'}
      ${can.edit() ? `<form id="coform" class="grid4 top-gap">
        <label class="span2">Description <input name="desc" required placeholder="e.g. Add transom above door"></label>
        <label>Amount (negative to deduct) <input name="amount" type="number" step="0.01" required></label>
        <label>&nbsp;<button class="btn">Add change order</button></label>
      </form>` : ''}
    </div>
    <div class="card"><h2>Pay apps</h2>
      ${pays.length ? `<ul class="links">${pays.map((p) => `<li><a href="#/payapps/${esc(p.id)}">Application ${esc(p.number)}</a>, period to ${fmtDate(p.periodTo)} ${badge(p.status)} <span class="num">${money(payAppSummary(p).currentDue)} due</span></li>`).join('')}</ul>` : '<p class="muted">No pay apps yet.</p>'}
    </div>`,
    mount(root) {
      const body = root.querySelector('#sov');
      const form = root.querySelector('#f');
      const check = () => {
        const total = round2(readLines(body).reduce((sum, l) => sum + (Number(l.value) || 0), 0));
        const amt = round2(form.amount.value);
        const el = root.querySelector('#sovcheck');
        el.textContent = `Schedule total ${money(total)}${total === amt ? ' matches the contract sum' : `, contract sum is ${money(amt)}`}`;
        el.className = 'small ' + (total === amt ? 'ok' : 'warn');
      };
      form.addEventListener('input', check);
      body.addEventListener('click', (ev) => { if (ev.target.closest('[data-del]')) { ev.target.closest('tr').remove(); check(); } });
      root.querySelector('#addsov').addEventListener('click', () => { body.insertAdjacentHTML('beforeend', sovRow({ item: body.children.length + 1 })); check(); });
      check();
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        await attempt(() => update('contracts', id, { ...formData(form), sov: readLines(body).filter((l) => l.desc || l.value) }), 'Contract saved');
      });
      root.querySelector('#coform')?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const d = formData(ev.target);
        attempt(() => add('changeOrders', { ...d, contractId: id, jobId: c.jobId, number: Math.max(0, ...coForContract(id).map((x) => Number(x.number) || 0)) + 1, date: today(), status: 'pending' }), 'Change order added');
        rerender();
      });
      root.querySelectorAll('[data-co]').forEach((b) => b.addEventListener('click', async () => {
        attempt(() => update('changeOrders', b.dataset.co, { status: b.dataset.st, decidedDate: today() }), `Change order ${b.dataset.st}`);
        rerender();
      }));
      root.querySelectorAll('[data-codel]').forEach((b) => b.addEventListener('click', async () => {
        if (confirmDelete('change order')) { attempt(() => remove('changeOrders', b.dataset.codel), 'Change order deleted'); rerender(); }
      }));
      root.querySelector('#newpay')?.addEventListener('click', async () => {
        const cur = get('contracts', id);
        const prior = where('payApps', 'contractId', id).sort(sortNum)[0];
        const approved = coForContract(id).filter((x) => x.status === 'approved').sort((a, b) => a.number - b.number);
        const sov = [...(cur.sov || []), ...approved.map((x) => ({ item: `CO${x.number}`, desc: `Change order ${x.number}: ${x.desc}`, value: Number(x.amount) || 0 }))];
        const r = await attempt(() => add('payApps', {
          contractId: id, jobId: cur.jobId, customerId: cur.customerId || '', number: prior ? (Number(prior.number) || 0) + 1 : 1,
          date: today(), periodTo: today(), retainagePct: cur.retainagePct ?? 10, storedRetainagePct: cur.retainagePct ?? 10,
          status: 'draft', lines: nextPayAppLines(sov, prior),
        }), 'Pay app created');
        if (r) go(`#/payapps/${r.id}`);
      });
      root.querySelector('#del')?.addEventListener('click', async () => {
        if (confirmDelete('contract') && await attempt(() => remove('contracts', id), 'Contract deleted') !== null) go('#/contracts');
      });
    },
  };
}

// Re-render the current page after a change made from a non-live view.
// Firestore applies writes to its local cache right away, so this doesn't wait for the server.
function rerender() {
  const at = location.hash;
  setTimeout(() => { if (location.hash === at) window.dispatchEvent(new HashChangeEvent('hashchange')); }, 50);
}

// ---------- Pay apps (AIA G702 / G703) ----------
export function payAppSummary(p, override) {
  const c = get('contracts', p.contractId) || { amount: 0 };
  const prior = where('payApps', 'contractId', p.contractId)
    .filter((x) => (Number(x.number) || 0) < (Number(p.number) || 0))
    .sort(sortNum)[0];
  const prevCert = prior ? payAppSummary(prior).earnedLessRetainage : 0;
  return g702(override || p, c, coForContract(p.contractId), prevCert);
}

export function payApps() {
  const rows = [...D().payApps].sort((a, b) => (a.jobId || '').localeCompare(b.jobId || '') || sortNum(a, b));
  return {
    live: true,
    html: `${header('Pay apps')}
    <p class="muted">Progress billing on AIA G702/G703. Start a pay app from its contract.</p>
    <div class="card">${rows.length ? `<table class="list"><thead><tr><th>Job</th><th>App #</th><th>Period to</th><th>Status</th><th class="num">Completed to date</th><th class="num">Retainage</th><th class="num">Current due</th></tr></thead><tbody>
    ${rows.map((p) => { const s = payAppSummary(p); return `<tr data-href="#/payapps/${esc(p.id)}"><td>${esc(jobName(p.jobId))}</td><td>${esc(p.number)}</td><td>${fmtDate(p.periodTo)}</td><td>${badge(p.status)}</td><td class="num">${money(s.totalCompleted)}</td><td class="num">${money(s.totalRetainage)}</td><td class="num">${money(s.currentDue)}</td></tr>`; }).join('')}
    </tbody></table>` : empty('No pay apps yet.')}</div>`,
  };
}

const payRow = (l, first) => `<tr data-row>
  <td><input name="item" value="${esc(l.item)}" class="n" readonly></td>
  <td><input name="desc" value="${esc(l.desc)}"></td>
  <td><input name="value" type="number" step="0.01" value="${esc(l.value)}" class="n"></td>
  <td><input name="prevWork" type="number" step="0.01" value="${esc(l.prevWork)}" class="n" ${first ? '' : 'readonly'}></td>
  <td><input name="thisWork" type="number" step="0.01" value="${esc(l.thisWork)}" class="n"></td>
  <td><input name="stored" type="number" step="0.01" value="${esc(l.stored)}" class="n"></td>
  <td class="num" data-g></td><td class="num" data-pct></td><td class="num" data-h></td><td class="num" data-i></td>
  <td><input type="number" step="any" min="0" max="100" class="n pct" data-topct title="Set % complete to date" placeholder="%"></td>
</tr>`;

export function payAppEdit(id) {
  const p = get('payApps', id);
  if (!p) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const first = !where('payApps', 'contractId', p.contractId).some((x) => (Number(x.number) || 0) < (Number(p.number) || 0));
  const ro = can.bill() ? '' : 'disabled';
  const c = get('contracts', p.contractId);
  return {
    html: `${header(`Pay app ${esc(p.number)}`, `<a class="btn" href="#/payapps/${esc(id)}/print">Print G702/G703</a>
      ${can.bill() ? '<button class="btn" id="toinvoice">Create invoice</button>' : ''}
      ${can.remove() ? '<button class="btn danger" id="del">Delete</button>' : ''}`)}
    <p class="muted">${jobLink(p.jobId)}${c ? ` · <a href="#/contracts/${esc(c.id)}">Contract ${esc(c.number)}</a>` : ''}</p>
    <form id="f" class="stack">
      <fieldset class="card grid4" ${ro}>
        <label>Application # <input name="number" type="number" value="${esc(p.number)}"></label>
        <label>Application date <input name="date" type="date" value="${esc(p.date)}"></label>
        <label>Period to <input name="periodTo" type="date" value="${esc(p.periodTo)}"></label>
        <label>Status <select name="status">${options(PAYAPP_STATUS.map((x) => [x, x]), p.status)}</select></label>
        <label>Retainage % on work <input name="retainagePct" type="number" step="any" value="${esc(p.retainagePct)}"></label>
        <label>Retainage % on stored materials <input name="storedRetainagePct" type="number" step="any" value="${esc(p.storedRetainagePct)}"></label>
      </fieldset>
      <fieldset class="card" ${ro}>
        <h2>G703 continuation sheet</h2>
        <p class="hint">Enter work completed this period (E) and materials presently stored (F), or type a % complete to date at the right. ${first ? 'This is the first application, so you can also enter work billed before this app in column D.' : 'Column D carries over from the previous application.'}</p>
        <div class="scroll"><table class="lines g703" data-lines>
          <thead><tr><th>A<br>Item</th><th>B<br>Description of work</th><th>C<br>Scheduled value</th><th>D<br>From previous</th><th>E<br>This period</th><th>F<br>Stored</th><th>G<br>Completed &amp; stored</th><th>G÷C<br>%</th><th>H<br>Balance to finish</th><th>I<br>Retainage</th><th>Set %</th></tr></thead>
          <tbody id="lines">${(p.lines || []).map((l) => payRow(l, first)).join('')}</tbody>
          <tfoot><tr id="foot"></tr></tfoot>
        </table></div>
      </fieldset>
      <div class="card"><h2>G702 summary</h2><div id="g702" class="g702"></div></div>
      <div class="row"><button class="btn primary" ${ro}>Save pay app</button></div>
    </form>`,
    mount(root) {
      const body = root.querySelector('#lines');
      const form = root.querySelector('#f');
      const current = () => ({ ...p, ...formData(form), lines: readLines(body) });
      const recalc = () => {
        const s = payAppSummary(p, current());
        body.querySelectorAll('tr[data-row]').forEach((tr, i) => {
          const r = s.rows[i];
          tr.querySelector('[data-g]').textContent = money(r.completed);
          tr.querySelector('[data-pct]').textContent = pctFmt(r.pct);
          tr.querySelector('[data-h]').textContent = money(r.balance);
          tr.querySelector('[data-i]').textContent = money(r.retainage);
        });
        const t = s.totals;
        root.querySelector('#foot').innerHTML = `<td></td><td>Totals</td><td class="num">${money(t.value)}</td><td class="num">${money(t.prevWork)}</td><td class="num">${money(t.thisWork)}</td><td class="num">${money(t.stored)}</td><td class="num">${money(t.completed)}</td><td class="num">${pctFmt(t.pct)}</td><td class="num">${money(t.balance)}</td><td class="num">${money(t.retainage)}</td><td></td>`;
        root.querySelector('#g702').innerHTML = g702Table(s);
      };
      body.addEventListener('input', (ev) => {
        const pctEl = ev.target.closest('[data-topct]');
        if (pctEl && pctEl.value !== '') {
          const tr = pctEl.closest('tr');
          const value = Number(tr.querySelector('[name=value]').value) || 0;
          const prev = Number(tr.querySelector('[name=prevWork]').value) || 0;
          const stored = Number(tr.querySelector('[name=stored]').value) || 0;
          tr.querySelector('[name=thisWork]').value = round2(value * Number(pctEl.value) / 100 - prev - stored);
        }
      });
      form.addEventListener('input', recalc);
      recalc();
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const cur = current();
        const s = payAppSummary(p, cur);
        await attempt(() => update('payApps', id, { ...formData(form), lines: cur.lines, currentDue: s.currentDue }), 'Pay app saved');
      });
      root.querySelector('#toinvoice')?.addEventListener('click', async () => {
        const s = payAppSummary(p, current());
        const r = await attempt(() => add('invoices', {
          number: nextNumber('invoices'), jobId: p.jobId, customerId: p.customerId || get('jobs', p.jobId)?.customerId || '', payAppId: id,
          date: today(), dueDate: addDays(today(), 30), status: 'unpaid', taxPct: 0,
          lines: [{ desc: `Application for payment #${p.number}, period to ${p.periodTo} (net of retainage)`, qty: 1, price: s.currentDue }],
        }), 'Invoice created');
        if (r) go(`#/invoices/${r.id}`);
      });
      root.querySelector('#del')?.addEventListener('click', async () => {
        if (confirmDelete('pay app') && await attempt(() => remove('payApps', id), 'Pay app deleted') !== null) go('#/payapps');
      });
    },
  };
}

export function g702Table(s) {
  const r = (n, label, v, cls = '') => `<div class="tr ${cls}"><span><b>${n}</b> ${label}</span><span>${money(v)}</span></div>`;
  return `
    ${r('1.', 'Original contract sum', s.originalSum)}
    ${r('2.', 'Net change by change orders', s.netChange)}
    ${r('3.', 'Contract sum to date (1 ± 2)', s.contractSumToDate)}
    ${r('4.', 'Total completed and stored to date (G703 col. G)', s.totalCompleted)}
    ${r('5a.', 'Retainage on completed work', s.workRetainage, 'sub')}
    ${r('5b.', 'Retainage on stored material', s.storedRetainage, 'sub')}
    ${r('5.', 'Total retainage', s.totalRetainage)}
    ${r('6.', 'Total earned less retainage (4 − 5)', s.earnedLessRetainage)}
    ${r('7.', 'Less previous certificates for payment', s.previousCertificates)}
    ${r('8.', 'Current payment due', s.currentDue, 'grand')}
    ${r('9.', 'Balance to finish, including retainage (3 − 6)', s.balanceToFinish)}`;
}

// ---------- Invoices ----------
export function invoices() {
  const rows = [...D().invoices].sort(sortNum);
  return {
    live: true,
    html: `${header('Invoices', can.bill() ? '<a class="btn primary" href="#/invoices/new">New invoice</a>' : '')}
    <div class="card">${rows.length ? `<table class="list"><thead><tr><th>#</th><th>Job</th><th>Customer</th><th>Date</th><th>Due</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>
    ${rows.map((i) => { const late = i.status === 'unpaid' && i.dueDate && i.dueDate < today(); return `<tr data-href="#/invoices/${esc(i.id)}"><td>${esc(i.number)}</td><td>${esc(jobName(i.jobId))}</td><td>${esc(customerName(i.customerId))}</td><td>${fmtDate(i.date)}</td><td class="${late ? 'warn' : ''}">${fmtDate(i.dueDate)}${late ? ' (overdue)' : ''}</td><td>${badge(i.status)}</td><td class="num">${money(invoiceTotals(i).total)}</td></tr>`; }).join('')}
    </tbody></table>` : empty('No invoices yet.')}</div>`,
  };
}

const invRow = (l = {}) => `<tr data-row>
  <td><input name="desc" value="${esc(l.desc)}" placeholder="Description"></td>
  <td><input name="qty" type="number" step="any" value="${esc(l.qty ?? 1)}" class="n"></td>
  <td><input name="price" type="number" step="0.01" value="${esc(l.price ?? 0)}" class="n"></td>
  <td class="num" data-total></td>
  <td><button type="button" class="icon" data-del>✕</button></td></tr>`;

export function invoiceEdit(id, params) {
  const isNew = id === 'new';
  const job = get('jobs', params.get('job'));
  const inv = isNew
    ? { number: nextNumber('invoices'), jobId: job?.id || '', date: today(), dueDate: addDays(today(), 30), status: 'unpaid', taxPct: 7, lines: [{ desc: '', qty: 1, price: 0 }] }
    : get('invoices', id);
  if (!inv) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const ro = can.bill() ? '' : 'disabled';
  return {
    html: `${header(isNew ? 'New invoice' : `Invoice ${esc(inv.number)}`, `
      ${!isNew ? `<a class="btn" href="#/invoices/${esc(id)}/print">Print / PDF</a>` : ''}
      ${!isNew && can.bill() && inv.status === 'unpaid' ? '<button class="btn primary" id="paid">Mark paid</button>' : ''}
      ${!isNew && can.remove() ? '<button class="btn danger" id="del">Delete</button>' : ''}`)}
    ${inv.payAppId ? `<p class="muted">From <a href="#/payapps/${esc(inv.payAppId)}">pay app ${esc(get('payApps', inv.payAppId)?.number || '')}</a></p>` : ''}
    <form id="f" class="stack">
      <fieldset class="card grid4" ${ro}>
        <label class="span2">Job <select name="jobId" required>${jobOptions(inv.jobId)}</select></label>
        <label>Invoice # <input name="number" type="number" value="${esc(inv.number)}"></label>
        <label>Status <select name="status">${options(INV_STATUS.map((x) => [x, x]), inv.status)}</select></label>
        <label>Date <input name="date" type="date" value="${esc(inv.date)}"></label>
        <label>Due <input name="dueDate" type="date" value="${esc(inv.dueDate)}"></label>
        <label>Paid on <input name="paidDate" type="date" value="${esc(inv.paidDate)}"></label>
        <label>Sales tax % <input name="taxPct" type="number" step="any" value="${esc(inv.taxPct)}"></label>
      </fieldset>
      <fieldset class="card" ${ro}>
        <table class="lines" data-lines><thead><tr><th>Description</th><th>Qty</th><th>Price</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody id="lines">${(inv.lines || []).map(invRow).join('')}</tbody></table>
        <button type="button" class="btn small" id="addline">+ Add line</button>
      </fieldset>
      <div class="cols">
        <fieldset class="card" ${ro}><label>Notes printed on the invoice <textarea name="notes" rows="3">${esc(inv.notes ?? state.company?.invoiceNotes ?? '')}</textarea></label></fieldset>
        <div class="card totals" id="totals"></div>
      </div>
      <div class="row"><button class="btn primary" ${ro}>Save invoice</button></div>
    </form>`,
    mount(root) {
      const body = root.querySelector('#lines');
      const form = root.querySelector('#f');
      const recalc = () => {
        const ls = readLines(body);
        body.querySelectorAll('tr[data-row]').forEach((tr, i) => { tr.querySelector('[data-total]').textContent = money(round2(ls[i].qty * ls[i].price)); });
        const t = invoiceTotals({ ...formData(form), lines: ls });
        root.querySelector('#totals').innerHTML = `<div class="tr"><span>Subtotal</span><span>${money(t.subtotal)}</span></div><div class="tr"><span>Tax</span><span>${money(t.tax)}</span></div><div class="tr grand"><span>Total</span><span>${money(t.total)}</span></div>`;
      };
      form.addEventListener('input', recalc);
      body.addEventListener('click', (ev) => { if (ev.target.closest('[data-del]')) { ev.target.closest('tr').remove(); recalc(); } });
      root.querySelector('#addline').addEventListener('click', () => { body.insertAdjacentHTML('beforeend', invRow()); recalc(); });
      recalc();
      const save = async (extra = {}) => {
        const data = { ...formData(form), lines: readLines(body).filter((l) => l.desc || l.price), ...extra };
        data.customerId = get('jobs', data.jobId)?.customerId || inv.customerId || '';
        data.total = invoiceTotals(data).total;
        if (isNew) {
          const r = await attempt(() => add('invoices', { ...data, payAppId: inv.payAppId || '' }), 'Invoice saved');
          if (r) go(`#/invoices/${r.id}`);
        } else {
          const done = attempt(() => update('invoices', id, data), 'Invoice saved');
          if (extra.status) rerender(); else await done;
        }
      };
      form.addEventListener('submit', (ev) => { ev.preventDefault(); save(); });
      root.querySelector('#paid')?.addEventListener('click', () => save({ status: 'paid', paidDate: today() }));
      root.querySelector('#del')?.addEventListener('click', async () => {
        if (confirmDelete('invoice') && await attempt(() => remove('invoices', id), 'Invoice deleted') !== null) go('#/invoices');
      });
    },
  };
}

// ---------- Team ----------
const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', staff: 'Staff', accountant: 'Accountant' };

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copied'); } catch { prompt('Copy this link:', text); }
}

function mountTeam(root) {
  const team = root.querySelector('#team');
  const invites = root.querySelector('#invites');
  const me = state.user.uid;
  // Which roles the current user may assign to someone else (mirrors the security rules).
  const assignable = (m) => m.uid !== me && m.role !== 'owner' && can.remove() && (state.role === 'owner' || m.role !== 'admin');

  const drawTeam = async () => {
    const members = (await listMembers()).sort((a, b) => ['owner', 'admin', 'staff', 'accountant'].indexOf(a.role) - ['owner', 'admin', 'staff', 'accountant'].indexOf(b.role));
    const roles = state.role === 'owner' ? ['admin', 'staff', 'accountant'] : ['staff', 'accountant'];
    team.innerHTML = `<table class="list"><thead><tr><th>Name</th><th>Sign-in</th><th>Role</th><th></th></tr></thead><tbody>
      ${members.map((m) => `<tr><td>${esc(m.name || '—')}${m.uid === me ? ' <span class="muted small">(you)</span>' : ''}</td><td>${esc(m.email || m.phone || '')}</td>
        <td>${assignable(m) ? `<select data-role="${esc(m.uid)}">${options(roles.map((r) => [r, ROLE_LABEL[r]]), m.role)}</select>` : esc(ROLE_LABEL[m.role] || m.role)}</td>
        <td class="actions-cell">${assignable(m) ? `<button class="btn small danger" data-remove="${esc(m.uid)}">Remove</button>` : ''}</td></tr>`).join('')}
    </tbody></table>`;
    team.querySelectorAll('[data-role]').forEach((sel) => sel.addEventListener('change', async () => {
      await attempt(() => setMemberRole(sel.dataset.role, sel.value), 'Role updated');
      drawTeam();
    }));
    team.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      const m = members.find((x) => x.uid === b.dataset.remove);
      if (!confirm(`Remove ${m.name || m.email || m.phone || 'this person'} from the team? They lose access right away.`)) return;
      await attempt(() => removeMember(m.uid), 'Removed from the team');
      drawTeam();
    }));
  };

  const drawInvites = async () => {
    if (!invites) return;
    const list = (await listInvites()).filter((i) => i.expiresAt?.toMillis() > Date.now());
    invites.innerHTML = list.length ? `<h2 class="top-gap">Open invite links</h2><table class="list"><tbody>
      ${list.map((i) => `<tr><td>${esc(i.label || 'Invite')}</td><td>${esc(ROLE_LABEL[i.role] || i.role)}</td><td class="muted small">expires ${esc(i.expiresAt.toDate().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</td>
        <td class="actions-cell"><button class="btn small" data-copy="${esc(i.id)}">Copy link</button> <button class="btn small danger" data-revoke="${esc(i.id)}">Cancel</button></td></tr>`).join('')}
    </tbody></table>` : '';
    invites.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(inviteLink(b.dataset.copy))));
    invites.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      await attempt(() => revokeInvite(b.dataset.revoke), 'Invite canceled');
      drawInvites();
    }));
  };

  root.querySelector('#invite')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    const id = await attempt(() => createInvite(f.role, f.label));
    if (!id) return;
    e.target.reset();
    await drawInvites();
    copyText(inviteLink(id));
  });

  drawTeam().catch((e) => { team.innerHTML = `<p class="muted small">Couldn't load the team: ${esc(e.message)}</p>`; });
  drawInvites().catch(() => {});
}

// ---------- Settings ----------
export function settings() {
  if (!state.company) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const c = state.company;
  const u = state.user;
  const ro = can.manage() ? '' : 'disabled';
  return {
    html: `${header('Settings')}
    <form id="f" class="card grid2">
      <h2 class="span2">Company (printed on estimates, contracts, pay apps and invoices)</h2>
      <fieldset class="span2 grid2 bare" ${ro}>
        <label>Business name <input name="name" value="${esc(c.name)}" required></label>
        <label>License # <input name="license" value="${esc(c.license)}"></label>
        <label>Contact <input name="contactName" value="${esc(c.contactName)}"></label>
        <label>Title <input name="contactTitle" value="${esc(c.contactTitle)}"></label>
        <label>Office phone <input name="phone" type="tel" value="${esc(c.phone)}"></label>
        <label>Cell <input name="cell" type="tel" value="${esc(c.cell)}"></label>
        <label>Email <input name="email" type="email" value="${esc(c.email)}"></label>
        <label>Website <input name="website" value="${esc(c.website)}"></label>
        <label class="span2">Address <input name="address" value="${esc(c.address)}"></label>
        <label class="span2">Default invoice notes <textarea name="invoiceNotes" rows="2" placeholder="e.g. Make checks payable to Stellar Glass. Thank you!">${esc(c.invoiceNotes)}</textarea></label>
        <div class="span2"><button class="btn primary">Save company</button></div>
      </fieldset>
    </form>
    <div class="card"><h2>Your account</h2>
      <p>${esc(u.displayName || '')} ${esc(u.email || u.phoneNumber || '')}<br><span class="muted small">Role: ${esc(state.role)} · signed in with ${esc(u.providerData.map((p) => ({ 'google.com': 'Google', password: 'email and password', phone: 'phone' }[p.providerId] || p.providerId)).join(', '))}</span></p>
    </div>
    <div class="card"><h2>Team</h2>
      <p class="muted small">Roles: <b>owner</b> does everything; <b>admin</b> does everything except company settings and ownership; <b>staff</b> create and edit jobs and paperwork but can't delete; <b>accountant</b> sees everything and handles pay apps and invoices.</p>
      <div id="team"><p class="muted small">Loading team…</p></div>
      ${can.remove() ? `<h2 class="top-gap">Invite someone</h2>
      <form class="grid4" id="invite">
        <label class="span2">Who is it for? (just a note) <input name="label" placeholder="e.g. Wes, or the accountant"></label>
        <label>Role <select name="role">${options([['accountant', 'Accountant'], ['staff', 'Staff'], ...(can.manage() ? [['admin', 'Admin']] : [])], 'accountant')}</select></label>
        <label>&nbsp;<button class="btn primary">Create invite link</button></label>
      </form>
      <p class="hint">Each link works once and expires in 7 days. Send it by text or email; they open it, sign in any way they like, and tap Join.</p>
      <div id="invites"></div>` : ''}
    </div>
    ${can.manage() ? `<div class="card"><h2>Transfer ownership</h2>
      <p class="small">Hand the business to another team member. They become the owner and you become an admin.</p>
      <div id="transfer"><p class="muted small">Loading team…</p></div></div>` : ''}`,
    mount(root) {
      root.querySelector('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        await attempt(() => updateCompany(formData(e.target)), 'Company saved');
      });
      mountTeam(root);
      const box = root.querySelector('#transfer');
      if (!box) return;
      listMembers().then((members) => {
        const others = members.filter((m) => m.uid !== state.user.uid);
        const label = (m) => `${m.name || m.email || m.phone || m.uid} (${m.role})`;
        box.innerHTML = others.length ? `
          <form class="row" id="tf">
            <label class="grow">New owner <select name="to" required>${options([['', 'Choose a team member…'], ...others.map((m) => [m.uid, label(m)])], '')}</select></label>
            <label>&nbsp;<button class="btn danger">Transfer ownership</button></label>
          </form>` : '<p class="muted small">Add the new owner to the team first; then you can hand ownership to them here.</p>';
        box.querySelector('#tf')?.addEventListener('submit', async (e) => {
          e.preventDefault();
          const m = others.find((x) => x.uid === e.target.to.value);
          if (!m || !confirm(`Make ${label(m)} the owner of ${state.company?.name || 'this business'}? You'll become an admin and can't undo this yourself; only the new owner can hand it back.`)) return;
          if (await attempt(() => transferOwnership(m.uid), 'Ownership transferred') !== null) location.hash = '#/';
        });
      }).catch((e) => { box.innerHTML = `<p class="muted small">Couldn't load the team: ${esc(e.message)}</p>`; });
    },
  };
}
