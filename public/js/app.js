// App shell: auth state, company onboarding, hash router.
import { auth } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { state, can, loadCompany, createCompany, stopWatching, onChange, readInvite, joinCompany } from './data.js';
import { renderSignIn, signOut } from './auth.js';
import * as V from './views.js';
import * as P from './print.js';
import * as R from './requests.js';
import * as PT from './parts.js';
import * as SP from './suppliers.js';
import * as S from './schedule.js';
import { websitePage } from './website.js';
import { takeoffPage } from './takeoff/page.js';
import { openTutorialModal } from './takeoff/tutorial.js';
import { accountingPage, openAccountantTutorialModal } from './accounting.js';
import { initPwaInstall, triggerInstallOrModal } from './pwa.js';
import { esc, toast } from './ui.js';
import { BRAND, logoHtml } from './brand.js';
import { autosize } from './autosize.js';

const root = document.getElementById('app');
// Note boxes grow with their text.
autosize();
initPwaInstall();

const routes = [
  [/^$/, () => V.dashboard()],
  [/^schedule$/, (m, q) => S.schedulePage(q)],
  [/^schedule\/([^/]+)$/, (m, q) => S.eventEdit(m[1], q)],
  [/^requests$/, () => R.requestList()],
  [/^requests\/([^/]+)$/, (m) => R.requestView(m[1])],
  [/^customers$/, () => V.customers()],
  [/^customers\/([^/]+)$/, (m, q) => V.customerEdit(m[1], q)],
  [/^jobs$/, () => V.jobs()],
  [/^jobs\/([^/]+)$/, (m, q) => V.jobEdit(m[1], q)],
  [/^files$/, (m, q) => V.filesPage(q)],
  [/^takeoff\/([^/]+)$/, (m, q) => takeoffPage(m[1], q)],
  [/^estimates$/, () => V.estimates()],
  [/^proposals$/, () => V.estimates()],
  [/^estimates\/([^/]+)\/print$/, (m) => P.estimateDoc(m[1])],
  [/^estimates\/([^/]+)$/, (m, q) => V.estimateEdit(m[1], q)],
  [/^contracts$/, () => V.contracts()],
  [/^contracts\/([^/]+)\/print$/, (m) => P.contractDoc(m[1])],
  [/^contracts\/([^/]+)$/, (m) => V.contractEdit(m[1])],
  [/^changeorders\/([^/]+)\/print$/, (m) => P.changeOrderDoc(m[1])],
  [/^payapps$/, () => V.payApps()],
  [/^billing$/, () => V.payApps()],
  [/^payapps\/([^/]+)\/print$/, (m, q) => P.payAppDoc(m[1], q)],
  [/^payapps\/([^/]+)$/, (m) => V.payAppEdit(m[1])],
  [/^invoices$/, () => V.invoices()],
  [/^invoices\/([^/]+)\/print$/, (m) => P.invoiceDoc(m[1])],
  [/^invoices\/([^/]+)$/, (m, q) => V.invoiceEdit(m[1], q)],
  [/^accounting$/, () => accountingPage()],
  [/^accounting\/waiver\/print$/, (m, q) => P.lienWaiverDoc(q)],
  [/^parts$/, (m, q) => PT.partsList(q)],
  [/^parts\/([^/]+)$/, (m, q) => PT.partsEdit(m[1], q)],
  [/^suppliers$/, () => SP.supplierList()],
  [/^suppliers\/([^/]+)$/, (m, q) => SP.supplierEdit(m[1], q)],
  [/^website$/, () => websitePage()],
  [/^settings$/, () => V.settings()],
];

const NAV = [['', 'Dashboard'], ['schedule', 'Schedule'], ['requests', 'Requests'], ['jobs', 'Jobs'], ['files', 'Files'], ['customers', 'Customers'], ['estimates', 'Estimates'], ['contracts', 'Contracts'], ['payapps', 'Pay apps'], ['invoices', 'Invoices'], ['accounting', 'Accounting & Notary'], ['parts', 'Parts orders'], ['suppliers', 'Suppliers'], ['website', 'Website'], ['settings', 'Settings']];

// Sidebar groups: [label, [[section, link text, icon]]]. Icons are 24px stroke paths.
const ICONS = {
  '': '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  schedule: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/>',
  requests: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  jobs: '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
  files: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  customers: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  estimates: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  contracts: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  payapps: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  invoices: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  accounting: '<path d="M12 3v18"/><path d="m19 8 3 8a5 5 0 0 1-6 0z"/><path d="M3 7h18"/><path d="m5 8 3 8a5 5 0 0 1-6 0z"/><path d="M7 21h10"/>',
  parts: '<path d="M16.5 9.4 7.55 4.24"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" y1="22" x2="12" y2="12"/>',
  suppliers: '<path d="M10 17h4V5H2v12h3"/><path d="M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L19 9h-5"/><path d="M14 17h1"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  website: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};
const GROUPS = [
  ['Management', [['', 'Dashboard'], ['schedule', 'Schedule'], ['requests', 'Requests'], ['jobs', 'Jobs'], ['files', 'Files'], ['customers', 'Customers'], ['estimates', 'Estimates']]],
  ['Billing & contracts', [['contracts', 'Contracts'], ['payapps', 'Pay apps (G702)'], ['invoices', 'Invoices'], ['accounting', 'Accounting & Notary']]],
  ['Suppliers & parts', [['parts', 'Parts orders'], ['suppliers', 'Suppliers']]],
  ['Admin', [['website', 'Website'], ['settings', 'Settings']]],
];
// One line under each list page's title.
const SUBTITLES = {
  '': 'Open bids, active jobs and money owed at a glance.',
  schedule: 'Site measures, installs, deliveries, tasks and who is on each one.',
  requests: 'Quote requests from the website, ready to turn into jobs.',
  jobs: 'Storefront and shower jobs, from lead to closeout.',
  files: 'Photos, plans and paperwork for every job.',
  customers: 'General contractors, property owners and homeowners.',
  estimates: 'Proposals with line items, price options and deposits.',
  contracts: 'Contracts and their change orders.',
  payapps: 'AIA G702/G703 progress billing with retainage.',
  invoices: 'Simple invoices and what is still owed.',
  accounting: 'Notary queue, Florida § 713.20 lien waivers, document vault & QuickBooks / Xero sync.',
  parts: 'Quote requests and orders to suppliers, tracked until everything is in.',
  suppliers: 'Who you buy from, their branches, and where requests go.',
  website: 'Photos on your public quote page. Upload sharp ones of your own work.',
  settings: 'Company profile, team access and your account.',
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;

// Dark office mode or daylight mode, remembered on this device.
const THEME_KEY = 'stellar-theme';
const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const themeButton = () => (theme() === 'light'
  ? '<span aria-hidden="true">🌙</span><span class="theme-label">Dark mode</span>'
  : '<span aria-hidden="true">☀️</span><span class="theme-label">Daylight mode</span>');
function toggleTheme() {
  const next = theme() === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  document.querySelectorAll('[data-theme-toggle]').forEach((b) => { b.innerHTML = themeButton(); });
}

const initials = (s) => String(s || '').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

let current = null;
// Views with their own listeners (the file browser) clean up when you leave them.
function setCurrent(view) {
  current?.unmount?.();
  current = view;
}

function openQuickJumpModal() {
  let dlg = document.querySelector('dialog.quick-dlg');
  if (dlg) dlg.remove();
  dlg = document.createElement('dialog');
  dlg.className = 'quick-dlg';
  dlg.setAttribute('aria-label', 'Quick search and shortcuts');
  const d = state.data || {};
  const shortcuts = [
    ['#/', '🏠 Dashboard', 'Overview, open bids, schedule & money owed'],
    ...(can.edit() ? [
      ['#/takeoff/local', '📐 CAD & 3D Drawing Takeoff', 'Open .DXF, .DWG, or .PDF plans at 1:1 scale & model in 3D'],
      ['#/jobs/new', '＋ New Job', 'Start a commercial storefront or shower job'],
      ['#/estimates/new', '📄 New Proposal / Estimate', 'Build a multi-option proposal with deposit terms'],
      ['#/parts/new', '📦 New Glass / Parts Order', 'Order cut-to-size glass or Trulite extrusions'],
      ['#/customers/new', '👤 New Customer', 'Add a GC, property owner, or homeowner'],
    ] : []),
    ['#/schedule', '📅 Schedule & Calendar', 'Site measures, installs, deliveries & Google Calendar'],
    ['#/files', '📁 Drawings & Job Files', 'All CAD files, PDFs, photos & Google Drive sync'],
    ['#/requests', '📥 Website Quote Requests', 'Incoming leads from the public quote page'],
    ['#/contracts', '✍️ Contracts & Change Orders', 'Signed contracts, SOV & change orders'],
    ['#/payapps', '🏗️ AIA G702 / G703 Pay Apps', 'Commercial progress billing & retainage'],
    ['#/invoices', '💵 Invoices & Online Payments', 'Customer invoices & Stripe online payments'],
    ['#/accounting', '⚖️ Accounting & Notary Hub', 'Melina S. Arias Notary Queue, Florida § 713.20 Lien Waivers & QuickBooks/Xero Sync'],
    ['#/accounting/waiver/print?kind=progress', '📜 Print Florida Lien Waiver (§ 713.20)', 'Partial or Final Waiver & Release of Lien Upon Payment'],
    ['#/website', '🌐 Website Photos & Quote Page', 'Manage high-res photos on your public quote page'],
    ['#/settings', '⚙️ Settings & Team Members', 'Company profile, team invites & Google Calendar'],
  ];

  dlg.innerHTML = `<div class="stack">
    <div class="row between"><h2>⚡ Quick Jump &amp; Shortcuts</h2><button type="button" class="icon" data-qclose aria-label="Close">✕</button></div>
    <input type="search" id="qSearch" aria-label="Search jobs, customers, proposals, or shortcuts" placeholder="Search jobs, customers, proposals, or type a screen name…" autocomplete="off">
    <div class="quick-list" id="qList" role="region" aria-live="polite"></div>
  </div>`;
  document.body.append(dlg);
  const listEl = dlg.querySelector('#qList');
  const inputEl = dlg.querySelector('#qSearch');

  const renderList = (q = '') => {
    const s = q.trim().toLowerCase();
    const matchedShortcuts = shortcuts.filter(([, title, sub]) => !s || title.toLowerCase().includes(s) || sub.toLowerCase().includes(s));
    const matchedJobs = (d.jobs || []).filter((j) => s && (j.name || '').toLowerCase().includes(s)).slice(0, 6);
    const matchedCust = (d.customers || []).filter((c) => s && ((c.name || '').toLowerCase().includes(s) || (c.company || '').toLowerCase().includes(s))).slice(0, 5);
    const matchedEst = (d.estimates || []).filter((e) => s && (String(e.number || '').includes(s) || (e.projectTitle || '').toLowerCase().includes(s))).slice(0, 5);

    let html = '';
    if (matchedJobs.length) {
      html += `<div class="q-group">Jobs</div>` + matchedJobs.map((j) => `<a class="q-item" href="#/jobs/${esc(j.id)}"><strong>💼 ${esc(j.name)}</strong><small>${esc(j.status || '')}</small></a>`).join('');
    }
    if (matchedEst.length) {
      html += `<div class="q-group">Proposals</div>` + matchedEst.map((e) => `<a class="q-item" href="#/estimates/${esc(e.id)}"><strong>📄 Proposal #${esc(e.number)}</strong><small>${esc(e.projectTitle || '')}</small></a>`).join('');
    }
    if (matchedCust.length) {
      html += `<div class="q-group">Customers</div>` + matchedCust.map((c) => `<a class="q-item" href="#/customers/${esc(c.id)}"><strong>👤 ${esc(c.name)}</strong><small>${esc(c.company || '')}</small></a>`).join('');
    }
    if (matchedShortcuts.length) {
      html += `<div class="q-group">App Shortcuts</div>` + matchedShortcuts.map(([href, title, sub]) => `<a class="q-item" href="${href}"><strong>${esc(title)}</strong><small>${esc(sub)}</small></a>`).join('');
    }
    listEl.innerHTML = html || '<p class="muted small">No matches found.</p>';
  };

  renderList();
  inputEl.addEventListener('input', () => renderList(inputEl.value));
  listEl.addEventListener('click', (e) => {
    if (e.target.closest('a.q-item')) dlg.close();
  });
  dlg.querySelector('[data-qclose]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  inputEl.focus();
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (state.companyId) openQuickJumpModal();
  }
});

function shell() {
  const u = state.user;
  const who = u.displayName || u.email || u.phoneNumber || '';
  const name = esc(state.company?.name || 'Stellar Glass');
  root.innerHTML = `
  <a class="skip-link no-print" href="#view">Skip to main content</a>
  <div class="app" id="shell">
    <aside class="sidebar no-print" aria-label="Main navigation">
      <a class="brand" href="#/" title="${name}">${logoHtml()}<span class="brand-sub">Installation &amp; glazing</span></a>
      ${GROUPS.map(([label, links]) => `<div class="nav-label">${esc(label)}</div>
      <nav class="nav" aria-label="${esc(label)}">${links.map(([h, l]) => `<a href="#/${h}" data-nav="${h}">${icon(h)}<span>${esc(l)}</span><span class="nav-count hidden" data-count="${h}"></span></a>`).join('')}</nav>`).join('')}
      <div class="side-foot">
        <button type="button" class="theme-btn" data-install-app title="Download and install Stellar Glass as a desktop app on Windows or Mac"><span aria-hidden="true">⬇</span><span class="theme-label">Install App (Win / Mac)</span></button>
        <button class="theme-btn" data-theme-toggle title="Switch between dark office mode and high-contrast daylight mode">${themeButton()}</button>
        <div class="user-pill">
          <div class="avatar" aria-hidden="true">${esc(initials(u.displayName || u.email))}</div>
          <div class="user-meta"><strong>${esc(who)}</strong><small>${esc(state.role || '')}</small></div>
          <button class="signout" id="signout">Sign out</button>
        </div>
      </div>
    </aside>
    <div class="scrim no-print" id="scrim"></div>
    <div class="content">
      <header class="mobilebar no-print">
        <button class="menu" id="menu" aria-label="Menu">☰</button>
        <a class="brand" href="#/" aria-label="${name} home">${logoHtml()}</a>
        <button class="theme-btn" data-theme-toggle>${themeButton()}</button>
      </header>
      <nav class="quickbar no-print" aria-label="Quick navigation shortcuts">
        <a class="q-pill" href="#/" title="Go to Dashboard">🏠 Dashboard</a>
        ${can.edit() ? `
          <a class="q-pill accent" href="#/takeoff/local" title="Open CAD (.DXF/.DWG) or PDF drawing takeoff & 3D storefront model">📐 CAD &amp; 3D Takeoff</a>
          <a class="q-pill" href="#/jobs/new" title="Start a new job">＋ New Job</a>
          <a class="q-pill" href="#/estimates/new" title="Create a new customer proposal">📄 New Proposal</a>
          <a class="q-pill" href="#/parts/new" title="Order cut glass or Trulite storefront framing">📦 Order Glass / Parts</a>
        ` : ''}
        <a class="q-pill" href="#/schedule" title="View schedule & Google Calendar">📅 Schedule</a>
        <a class="q-pill" href="#/files" title="Job plans, CAD files & photos">📁 Files</a>
        <a class="q-pill" href="#/payapps" title="AIA G702/G703 Pay Applications">🏗️ Pay Apps</a>
        <a class="q-pill" href="#/invoices" title="Customer invoices & Stripe payments">💵 Invoices</a>
        <a class="q-pill" href="#/accounting" title="Notary Queue (Melina S. Arias), Florida § 713.20 Lien Waivers & QuickBooks/Xero Sync">⚖️ Accounting &amp; Notary</a>
        <button type="button" class="q-pill video" data-acct-tutorial title="Watch the Accountant & Notary Guide for Melina S. Arias, Wesley Stel & Jason Vergara">▶ Accountant Video</button>
        <button type="button" class="q-pill video" data-global-tutorial title="Watch the full Start-to-Finish Stellar Glass walkthrough video">▶ Takeoff Video</button>
        <button type="button" class="q-pill install" data-install-app title="Download and install Stellar Glass as a desktop app on Windows or Mac">⬇ Install App</button>
        <button type="button" class="q-pill search" data-quick-jump title="Search jobs, proposals, customers or shortcuts (⌘K)">⚡ Quick Jump</button>
      </nav>
      <main id="view"></main>
    </div>
  </div>`;
  root.querySelector('#signout').addEventListener('click', () => signOut());
  root.querySelector('#menu').addEventListener('click', () => root.querySelector('#shell').classList.toggle('nav-open'));
  root.querySelector('#scrim').addEventListener('click', () => root.querySelector('#shell').classList.remove('nav-open'));
  root.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', toggleTheme));
  root.querySelectorAll('[data-install-app]').forEach((b) => b.addEventListener('click', () => triggerInstallOrModal(root)));
  root.querySelector('[data-global-tutorial]')?.addEventListener('click', () => openTutorialModal(root, { showOpenTakeoff: true }));
  root.querySelector('[data-acct-tutorial]')?.addEventListener('click', () => openAccountantTutorialModal(root));
  root.querySelector('[data-quick-jump]')?.addEventListener('click', () => openQuickJumpModal());
}

// Live counts beside the sidebar links.
function updateCounts() {
  const d = state.data;
  const set = (key, n, text, cls = '') => {
    const el = document.querySelector(`[data-count="${key}"]`);
    if (!el) return;
    el.textContent = text ?? String(n);
    el.className = `nav-count ${cls}${n ? '' : ' hidden'}`;
  };
  const sched = S.scheduleCount();
  set('schedule', sched.n, sched.text, sched.cls);
  set('requests', R.newRequestCount(), null, 'accent');
  set('jobs', d.jobs.filter((j) => !['complete', 'closed'].includes(j.status)).length);
  set('estimates', d.estimates.filter((e) => ['draft', 'sent'].includes(e.status)).length, null, 'accent');
  const openApps = d.payApps.filter((p) => ['submitted', 'approved'].includes(p.status)).length;
  set('payapps', openApps, `${openApps} open`, 'amber');
  const unpaid = d.invoices.filter((i) => i.status === 'unpaid').length;
  set('invoices', unpaid, `${unpaid} unpaid`, 'amber');
  const late = PT.latePartsCount();
  set('parts', late || PT.openPartsCount(), late ? `${late} late` : null, late ? 'amber' : 'accent');
}

function route() {
  if (!state.companyId) return;
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(qs || '');
  const match = routes.find(([re]) => re.test(path));
  const view = match ? match[1](path.match(match[0]), params) : { html: '<p>Page not found. <a href="#/">Go to the dashboard</a>.</p>' };
  setCurrent(view);
  const el = document.getElementById('view');
  el.innerHTML = view.html;
  el.classList.toggle('print-view', !!view.title);
  el.classList.toggle('wide-view', !!view.wide);
  view.mount?.(el);
  document.title = `${view.title || NAV.find(([h]) => path.split('/')[0] === h)?.[1] || 'Stellar Glass'} · Stellar Glass`;
  const section = path.split('/')[0];
  const title = el.querySelector('.page-head .page-title');
  if (title && !title.querySelector('p') && path === section && SUBTITLES[section]) title.insertAdjacentHTML('beforeend', `<p>${esc(SUBTITLES[section])}</p>`);
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const isAct = a.dataset.nav === section;
    a.classList.toggle('active', isAct);
    if (isAct) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.getElementById('shell')?.classList.remove('nav-open');
  updateCounts();
}

// Clicking a table row opens its record.
document.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-href]');
  if (tr && !e.target.closest('a,button,input,select')) location.hash = tr.dataset.href;
});

window.addEventListener('hashchange', route);

let pending = null;
onChange(() => {
  updateCounts();
  // Brand name may change; list views refresh live; editors refresh only while waiting for their record.
  if (!current || !(current.live || current.waiting)) return;
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => {
    route();
  });
});

function onboarding() {
  const u = state.user;
  root.innerHTML = `
  <div class="auth-wrap"><form class="card auth-card stack" id="f">
    <div class="auth-logo">${logoHtml()}</div>
    <h2>Welcome</h2>
    <p>Signed in as ${esc(u.email || u.phoneNumber || u.displayName)}. Check the business details, then start tracking jobs. You can change them later in Settings.</p>
    <label>Business name <input name="name" value="${esc(BRAND.name)}" required></label>
    <div class="grid2">
      <label>Contact <input name="contactName" value="${esc(BRAND.contactName)}"></label>
      <label>Title <input name="contactTitle" value="${esc(BRAND.contactTitle)}"></label>
      <label>Office phone <input name="phone" type="tel" value="${esc(BRAND.phone)}"></label>
      <label>Cell <input name="cell" type="tel" value="${esc(BRAND.cell)}"></label>
    </div>
    <label>Email <input name="email" type="email" value="${esc(BRAND.email)}"></label>
    <label>Website <input name="website" value="${esc(BRAND.website)}"></label>
    <label>Address <input name="address" value="${esc(BRAND.address)}"></label>
    <button class="btn primary">Create business</button>
    <p class="small muted">Joining someone else's business instead, like the accountant? Ask the owner for an invite link and open it.</p>
    <button type="button" class="btn" id="out">Sign out</button>
  </form></div>`;
  root.querySelector('#out').addEventListener('click', () => signOut());
  root.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await createCompany(f); start(); } catch (err) { console.error(err); toast(err.message, true); }
  });
}

// Invite links look like #/join/{companyId}/{inviteId}. Remember one across sign-in.
const JOIN_KEY = 'stellar-pending-join';
function captureJoin() {
  const m = location.hash.match(/^#\/join\/([^/]+)\/([^/?]+)/);
  if (m) {
    try { sessionStorage.setItem(JOIN_KEY, JSON.stringify({ companyId: m[1], inviteId: m[2] })); } catch { /* private mode */ }
    history.replaceState(null, '', location.pathname + location.search + '#/');
    return { companyId: m[1], inviteId: m[2] };
  }
  try { return JSON.parse(sessionStorage.getItem(JOIN_KEY) || 'null'); } catch { return null; }
}
let pendingJoin = captureJoin();
const clearJoin = () => { pendingJoin = null; try { sessionStorage.removeItem(JOIN_KEY); } catch { /* ignore */ } };
window.addEventListener('hashchange', () => { if (location.hash.startsWith('#/join/')) { pendingJoin = captureJoin(); if (state.user) showJoin(state.user); } });

const ROLE_NAMES = { admin: 'an admin', staff: 'staff', accountant: 'the accountant' };

async function showJoin(user) {
  const { companyId, inviteId } = pendingJoin;
  const inv = await readInvite(companyId, inviteId);
  if (!inv) {
    clearJoin();
    toast('That invite link has expired or was already used. Ask for a new one.', true);
    return false;
  }
  setCurrent(null);
  root.innerHTML = `
  <div class="auth-wrap"><div class="card auth-card stack">
    <div class="auth-logo">${logoHtml()}</div>
    <h2>You're invited</h2>
    <p>Join <b>${esc(inv.companyName || 'this business')}</b> as ${esc(ROLE_NAMES[inv.role] || inv.role)}.</p>
    <p class="small muted">Signed in as ${esc(user.email || user.phoneNumber || user.displayName)}.${state.companyId ? ' Joining switches you to this business.' : ''}</p>
    <button class="btn primary" id="join">Join ${esc(inv.companyName || 'business')}</button>
    <button class="btn" id="skip">Not now</button>
  </div></div>`;
  root.querySelector('#join').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      stopWatching();
      await joinCompany(companyId, inviteId);
      clearJoin();
      start();
      toast(`Welcome to ${inv.companyName || 'the team'}`);
    } catch (err) { console.error(err); toast(err.message, true); e.target.disabled = false; }
  });
  root.querySelector('#skip').addEventListener('click', async () => {
    clearJoin();
    if (await loadCompany(user)) start(); else onboarding();
  });
  return true;
}

function start() {
  shell();
  route();
  updateCounts();
}

onAuthStateChanged(auth, async (user) => {
  setCurrent(null);
  stopWatching();
  if (!user) {
    state.user = null;
    renderSignIn(root);
    if (pendingJoin) root.querySelector('.auth-card .muted').textContent = 'You\'ve been invited to join a business. Sign in or create an account to accept.';
    return;
  }
  root.innerHTML = '<div class="loading">Loading…</div>';
  try {
    state.user = user;
    if (pendingJoin && await showJoin(user)) return;
    const companyId = await loadCompany(user);
    if (companyId) start(); else onboarding();
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="auth-wrap"><div class="card auth-card"><p>Couldn't load your data: ${esc(err.message)}</p><button class="btn" id="out">Sign out</button></div></div>`;
    root.querySelector('#out').addEventListener('click', () => signOut());
  }
});
