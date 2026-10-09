// App shell: auth state, company onboarding, hash router.
import { auth } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { state, loadCompany, createCompany, stopWatching, onChange, readInvite, joinCompany } from './data.js';
import { renderSignIn, signOut } from './auth.js';
import * as V from './views.js';
import * as P from './print.js';
import { esc, toast } from './ui.js';
import { BRAND, logoHtml } from './brand.js';

const root = document.getElementById('app');

const routes = [
  [/^$/, () => V.dashboard()],
  [/^customers$/, () => V.customers()],
  [/^customers\/([^/]+)$/, (m, q) => V.customerEdit(m[1], q)],
  [/^jobs$/, () => V.jobs()],
  [/^jobs\/([^/]+)$/, (m, q) => V.jobEdit(m[1], q)],
  [/^files$/, (m, q) => V.filesPage(q)],
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

const NAV = [['', 'Dashboard'], ['jobs', 'Jobs'], ['files', 'Files'], ['customers', 'Customers'], ['estimates', 'Estimates'], ['contracts', 'Contracts'], ['payapps', 'Pay apps'], ['invoices', 'Invoices'], ['settings', 'Settings']];

let current = null;
// Views with their own listeners (the file browser) clean up when you leave them.
function setCurrent(view) {
  current?.unmount?.();
  current = view;
}

function shell() {
  const u = state.user;
  root.innerHTML = `
  <header class="topbar no-print">
    <a class="brand" href="#/" title="${esc(state.company?.name || 'Stellar Glass')}">${logoHtml('header-logo')}</a>
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
  setCurrent(view);
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
