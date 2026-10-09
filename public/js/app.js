// App shell: auth state, company onboarding, hash router.
import { auth } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { state, loadCompany, createCompany, stopWatching, onChange } from './data.js';
import { renderSignIn, signOut } from './auth.js';
import * as V from './views.js';
import * as P from './print.js';
import { esc, toast } from './ui.js';

const root = document.getElementById('app');

const routes = [
  [/^$/, () => V.dashboard()],
  [/^customers$/, () => V.customers()],
  [/^customers\/([^/]+)$/, (m, q) => V.customerEdit(m[1], q)],
  [/^jobs$/, () => V.jobs()],
  [/^jobs\/([^/]+)$/, (m, q) => V.jobEdit(m[1], q)],
  [/^estimates$/, () => V.estimates()],
  [/^estimates\/([^/]+)\/print$/, (m) => P.estimateDoc(m[1])],
  [/^estimates\/([^/]+)$/, (m, q) => V.estimateEdit(m[1], q)],
  [/^contracts$/, () => V.contracts()],
  [/^contracts\/([^/]+)\/print$/, (m) => P.contractDoc(m[1])],
  [/^contracts\/([^/]+)$/, (m) => V.contractEdit(m[1])],
  [/^changeorders\/([^/]+)\/print$/, (m) => P.changeOrderDoc(m[1])],
  [/^payapps$/, () => V.payApps()],
  [/^payapps\/([^/]+)\/print$/, (m) => P.payAppDoc(m[1])],
  [/^payapps\/([^/]+)$/, (m) => V.payAppEdit(m[1])],
  [/^invoices$/, () => V.invoices()],
  [/^invoices\/([^/]+)\/print$/, (m) => P.invoiceDoc(m[1])],
  [/^invoices\/([^/]+)$/, (m, q) => V.invoiceEdit(m[1], q)],
  [/^settings$/, () => V.settings()],
];

const NAV = [['', 'Dashboard'], ['jobs', 'Jobs'], ['customers', 'Customers'], ['estimates', 'Estimates'], ['contracts', 'Contracts'], ['payapps', 'Pay apps'], ['invoices', 'Invoices'], ['settings', 'Settings']];

let current = null;

function shell() {
  const u = state.user;
  root.innerHTML = `
  <header class="topbar no-print">
    <a class="brand" href="#/"><span class="logo">✦</span> ${esc(state.company?.name || 'Stellar Glass')}</a>
    <button class="icon menu" id="menu" aria-label="Menu">☰</button>
    <nav id="nav">${NAV.map(([h, l]) => `<a href="#/${h}" data-nav="${h}">${l}</a>`).join('')}</nav>
    <div class="user"><span class="small muted">${esc(u.displayName || u.email || u.phoneNumber || '')}</span> <button class="btn small" id="signout">Sign out</button></div>
  </header>
  <main id="view"></main>`;
  root.querySelector('#signout').addEventListener('click', () => signOut());
  root.querySelector('#menu').addEventListener('click', () => root.querySelector('#nav').classList.toggle('open'));
}

function route() {
  if (!state.companyId) return;
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(qs || '');
  const match = routes.find(([re]) => re.test(path));
  const view = match ? match[1](path.match(match[0]), params) : { html: '<p>Page not found. <a href="#/">Go to the dashboard</a>.</p>' };
  current = view;
  const el = document.getElementById('view');
  el.innerHTML = view.html;
  el.classList.toggle('print-view', !!view.title);
  view.mount?.(el);
  document.title = `${view.title || NAV.find(([h]) => path.split('/')[0] === h)?.[1] || 'Stellar Glass'} · Stellar Glass`;
  const section = path.split('/')[0];
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  document.getElementById('nav')?.classList.remove('open');
}

// Clicking a table row opens its record.
document.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-href]');
  if (tr && !e.target.closest('a,button,input,select')) location.hash = tr.dataset.href;
});

window.addEventListener('hashchange', route);

let pending = null;
onChange(() => {
  // Brand name may change; list views refresh live; editors refresh only while waiting for their record.
  if (!current || !(current.live || current.waiting)) return;
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => {
    const brand = document.querySelector('.topbar .brand');
    if (brand) brand.innerHTML = `<span class="logo">✦</span> ${esc(state.company?.name || 'Stellar Glass')}`;
    route();
  });
});

function onboarding() {
  const u = state.user;
  root.innerHTML = `
  <div class="auth-wrap"><form class="card auth-card stack" id="f">
    <div class="brand big"><span class="logo">✦</span> Welcome</div>
    <p>Signed in as ${esc(u.email || u.phoneNumber || u.displayName)}. Set up the business to start tracking jobs.</p>
    <label>Business name <input name="name" value="Stellar Glass" required></label>
    <label>Phone <input name="phone" type="tel"></label>
    <label>Email <input name="email" type="email" value="${esc(u.email || '')}"></label>
    <label>Address <input name="address"></label>
    <button class="btn primary">Create business</button>
    <p class="small muted">Joining someone else's business instead, like the accountant? Ask the owner to add you; invites are coming soon.</p>
    <button type="button" class="btn" id="out">Sign out</button>
  </form></div>`;
  root.querySelector('#out').addEventListener('click', () => signOut());
  root.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await createCompany(f); start(); } catch (err) { console.error(err); toast(err.message, true); }
  });
}

function start() {
  shell();
  route();
}

onAuthStateChanged(auth, async (user) => {
  stopWatching();
  current = null;
  if (!user) { state.user = null; renderSignIn(root); return; }
  root.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const companyId = await loadCompany(user);
    if (companyId) start(); else onboarding();
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="auth-wrap"><div class="card auth-card"><p>Couldn't load your data: ${esc(err.message)}</p><button class="btn" id="out">Sign out</button></div></div>`;
    root.querySelector('#out').addEventListener('click', () => signOut());
  }
});
