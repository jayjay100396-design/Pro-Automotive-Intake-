// Google Calendar connections: which Google calendars get a copy of the schedule.
// The copy goes one way, from the app to Google. Nothing is read back, so personal events in those calendars never
// come into the app, and connecting, switching or disconnecting a calendar never changes anything in the app.
// The calendarAccount Cloud Function (functions-calendar/) keeps each connection's Google access and does the copying.
// The browser only gets Google's one-time permission code in a popup, and shows how each connection is doing from
// companies/{company}/calendarLinks, which only the server writes.
import { app, db, useEmulators } from './firebase.js';
import { collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { state, can, listMembers, onChange } from './data.js';
import { esc, toast } from './ui.js';

// The business name without "LLC" and the like, as the calendars are named ("Stellar Glass").
export const shortName = (name = state.company?.name) => String(name || '').trim()
  .replace(/[,\s]+(LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?|Ltd\.?|PLLC|LLP)$/i, '').trim() || 'Stellar Glass';

// ---------- The Cloud Function ----------
let callable = null;
async function calendarAccount() {
  if (!callable) {
    const { getFunctions, httpsCallable, connectFunctionsEmulator } = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js');
    const functions = getFunctions(app, 'us-central1');
    if (useEmulators) connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    // Connecting copies the whole schedule, which can take a while.
    callable = httpsCallable(functions, 'calendarAccount', { timeout: 310000 });
  }
  return callable;
}

const run = async (action, extra = {}) => (await (await calendarAccount())({ action, companyId: state.companyId, ...extra })).data;

// Firebase adds the HTTP status to the server's sentence ("Pick a calendar. [400]"). People see the sentence alone.
const messageOf = (e) => String(e?.message || '').replace(/\s*\[\d{1,3}\]$/, '');

// Before the function is deployed (or with no connection), a call fails with a bare "internal" or "not-found",
// with no sentence from the server.
function notSetUp(e) {
  const code = String(e?.code || '').replace(/^functions\//, '');
  const msg = messageOf(e);
  return (code === 'not-found' || code === 'internal') && (!msg || msg === code);
}

export function calendarError(e) {
  if (notSetUp(e)) {
    return navigator.onLine === false ? 'You\'re offline. Try again once you\'re connected.'
      : 'Google Calendar sync isn\'t set up yet (CALENDAR_SETUP.md has the steps).';
  }
  const msg = messageOf(e);
  // A crash on the server comes back as a bare INTERNAL.
  return !msg || msg === 'INTERNAL' ? 'Something went wrong with Google Calendar. Try again.' : msg;
}

// ---------- Google's permission popup ----------
// The app's Google sign-in client and the permissions to ask for come from the function, once per visit.
let setup = null;
const getSetup = () => {
  if (!setup) setup = run('status').catch((e) => { setup = null; throw e; });
  return setup;
};

let gis = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google);
  if (!gis) {
    gis = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => (window.google?.accounts?.oauth2 ? resolve(window.google) : reject(new Error('Google\'s sign-in window didn\'t load.')));
      s.onerror = () => { gis = null; s.remove(); reject(new Error('Couldn\'t reach Google. Check the connection, and that nothing blocks accounts.google.com.')); };
      document.head.append(s);
    });
  }
  return gis;
}

class Closed extends Error {}

// Browsers only allow a popup straight from a click, so Google's popups are made ahead of time
// and each click only opens one. `basic` makes and fills the app's own calendars; `pick` adds what's
// needed to list the owner's calendars and put events on one of them.
const clients = {};
let waiting = null;
const settle = (err, code) => {
  const w = waiting;
  waiting = null;
  if (!w) return;
  if (err) w.reject(err); else w.resolve(code);
};

async function prepare() {
  const s = await getSetup();
  if (useEmulators) return s;
  const google = await loadGis();
  for (const [key, scope] of [['basic', s.basicScope], ['pick', s.pickScope]]) {
    if (clients[key]) continue;
    clients[key] = google.accounts.oauth2.initCodeClient({
      client_id: s.clientId,
      scope,
      ux_mode: 'popup',
      // Lets them choose the Google account, e.g. Wes's own rather than whoever is signed in to the browser.
      select_account: true,
      callback: (r) => settle(r.error
        ? new Error(r.error === 'access_denied' ? 'Google Calendar access wasn\'t allowed.' : (r.error_description || `Google said: ${r.error}`))
        : null, r.code),
      error_callback: (err) => settle(err?.type === 'popup_closed' ? new Closed()
        : new Error(err?.type === 'popup_failed_to_open' ? 'The browser blocked Google\'s window. Allow pop-ups for this site and try again.' : 'Google\'s window ran into a problem. Try again.'), null),
    });
  }
  return s;
}

// Asks Google for a one-time permission code. It has to run in the click handler, before anything is awaited.
function askGoogle(key) {
  if (useEmulators) {
    // The emulators stand in for Google (functions-calendar/test/fake-google.js): the "code" names the account.
    const email = window.prompt('Google account to connect (local test)', state.user?.email || '');
    return email ? Promise.resolve(`emulator:${email.trim()}${key === 'pick' ? ':pick' : ''}`) : Promise.reject(new Closed());
  }
  const client = clients[key];
  if (!client) return Promise.reject(new Error('Still getting ready. Try again in a moment.'));
  settle(new Closed(), null);
  return new Promise((resolve, reject) => {
    waiting = { resolve, reject };
    client.requestCode();
  });
}

// ---------- Connections ----------
// Every Google Calendar connection in the business: the business calendar (id 'business') and each person's own (their uid).
export function watchLinks(cb) {
  if (!state.companyId) { cb([]); return () => {}; }
  return onSnapshot(collection(db, 'companies', state.companyId, 'calendarLinks'),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (e) => { console.error('calendarLinks', e); cb([]); });
}

// The business calendar stays on the Google account of the owner who connected it. Once the business has a new
// owner, nothing more goes there until they connect their own. The server marks it paused at the next change to the
// schedule; this shows it straight away.
const PAUSED = 'Paused: the business has a new owner. They connect their own Google Calendar to take over.';
const isPaused = (l) => !!l && (l.status === 'paused' || (l.kind === 'business' && !!state.company?.ownerUid && l.uid !== state.company.ownerUid));
const isActive = (l) => !!l && !isPaused(l);
// A connection's calendar in words. Google names a person's main calendar after their email address, so that one
// is "your main calendar" (or "Wes Stel's main calendar") instead of a quoted email address.
const isMainCalendar = (l) => !!l.calendarId && !!l.email && l.calendarId.toLowerCase() === String(l.email).toLowerCase();
function calendarWords(l) {
  if (!isMainCalendar(l)) return `“${l.calendarName}”`;
  return l.uid === state.user?.uid ? 'your main calendar' : `${l.holderName || l.email}'s main calendar`;
}

const listWords = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// One line for an event's form: which Google calendars it goes on. Empty when nobody has connected one.
export function syncNote(links, { assignees = [], canceled = false, name = (uid) => uid } = {}) {
  const biz = links.find((l) => l.id === 'business' && isActive(l));
  const own = links.filter((l) => l.kind === 'personal' && assignees.includes(l.uid));
  if (!biz && !links.some((l) => l.kind === 'personal')) return '';
  if (canceled) return 'Canceled, so it comes off Google Calendar.';
  const me = state.user?.uid;
  const where = [];
  if (biz) {
    if (biz.uid === me) where.push(isMainCalendar(biz) ? 'your main calendar' : `your calendar “${biz.calendarName}”`);
    else where.push(isMainCalendar(biz) ? `the business calendar (${calendarWords(biz)})` : `the business calendar “${biz.calendarName}”`);
  }
  for (const l of own) where.push(l.uid === me ? `your calendar “${l.calendarName}”` : `${name(l.uid)}'s calendar`);
  // Whoever holds the business calendar already has every event on it.
  const missing = assignees.filter((uid) => !own.some((l) => l.uid === uid) && biz?.uid !== uid)
    .map((uid) => (uid === me ? 'You haven\'t' : `${name(uid)} hasn't`));
  return `${where.length ? `On Google Calendar: ${listWords(where)}.` : 'Not on anyone\'s Google Calendar yet.'}${missing.length === 1 ? ` ${missing[0]} connected a Google Calendar.` : missing.length ? ` ${missing.length} people on it haven't connected a Google Calendar.` : ''}`;
}

function ago(ts) {
  const ms = ts?.toMillis?.();
  if (!ms) return '';
  const min = Math.round((Date.now() - ms) / 6e4);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function statusLine(l) {
  if (l.status === 'syncing') return '<span class="gc-state">Copying the schedule…</span>';
  if (isPaused(l)) return `<span class="gc-state warn">${esc(can.manage() ? 'Paused, because the business has a new owner.' : PAUSED)}</span>`;
  if (l.status === 'error') return `<span class="gc-state bad">${esc(l.error || 'Something went wrong. Connect again.')}</span>`;
  const when = ago(l.syncedAt);
  return `<span class="gc-state ok">Up to date</span>${when ? ` <span class="muted">· last change copied ${esc(when)}</span>` : ''}`;
}

const HINT_KEY = 'stellar-gcal-hint';
const hintDismissed = () => { try { return localStorage.getItem(`${HINT_KEY}:${state.user?.uid}`) === 'no'; } catch { return false; } };
const dismissHint = () => { try { localStorage.setItem(`${HINT_KEY}:${state.user?.uid}`, 'no'); } catch { /* private mode */ } };

// The Google Calendar panel. Full: the Settings card. Compact: one line or a short offer on the Schedule page.
// Returns a function that stops it.
export function mountCalendarPanel(box, { compact = false } = {}) {
  let links = [];
  let loaded = false;
  let ready = 'no';   // 'no' (not asked yet) | 'asking' | 'yes' | 'missing' (not deployed) | an error message
  let busy = '';
  let picker = null;  // { calendars } while the owner chooses a calendar
  let askPick = false;
  let members = [];
  let stopped = false;
  const me = () => state.user?.uid;
  const biz = () => links.find((l) => l.id === 'business');
  const mine = () => links.find((l) => l.id === me());
  const owner = () => can.manage();

  const getReady = () => {
    if (ready !== 'no') return;
    ready = 'asking';
    prepare().then(() => { ready = 'yes'; }, (e) => { console.warn('calendar setup', e); ready = notSetUp(e) ? 'missing' : calendarError(e); }).then(draw);
  };

  // Connecting needs Google's popup ready; the other buttons only need the function.
  const button = (attrs, text, cls = '', google = false) => `<button type="button" class="btn small ${cls}" ${attrs} ${busy || (google && ready !== 'yes') ? 'disabled' : ''}>${esc(text)}</button>`;
  // then: 'choose' opens the list of the owner's calendars once connected.
  const connectButton = (kind, text, cls = 'primary', scope = 'basic', then = '') => button(`data-connect="${kind}" data-scope="${scope}"${then ? ` data-then="${then}"` : ''}`, text, cls, true);
  const notReady = () => (ready === 'yes' || ready === 'no' || ready === 'asking' ? ''
    : `<p class="small warn">${esc(ready === 'missing' ? calendarError({ code: 'not-found' }) : ready)}</p>`);
  const busyLine = () => (busy ? `<p class="small gc-busy" role="status">${esc(busy)}</p>` : '');
  const memberName = (uid) => { const m = members.find((x) => x.uid === uid); return m?.name || m?.email || ''; };
  const holder = (l) => (l.uid === me() ? 'your' : `${esc(l.holderName || memberName(l.uid) || 'a former owner')}'s`);

  // ---------- Compact: the Schedule page ----------
  function compactHtml() {
    const b = biz();
    const p = mine();
    const line = (cls, text, link = '<a href="#/settings">Settings</a>') => `<p class="gc-line ${cls}">${text} ${link}</p>`;
    const offer = (title, text, kind, label) => {
      getReady();
      if (ready !== 'yes' && !busy) return '';
      return `<div class="card gc-offer"><div><strong>${esc(title)}</strong><p class="small">${esc(text)}</p>${busyLine()}</div>
        <div class="row">${connectButton(kind, label)}${hintDismissed() || kind === 'business' && b ? '' : button('data-dismiss', 'Not now')}</div></div>`;
    };
    if (isPaused(b) && owner()) {
      return offer('Take over the Google Calendar', `The schedule stopped going to ${b.holderName || 'the previous owner'}'s Google Calendar when you became the owner. Connect yours to take over.`, 'business', 'Connect my Google Calendar');
    }
    if (b?.status === 'error' && owner()) return line('warn', `Google Calendar: ${esc(b.error)}`, '<a href="#/settings">Fix it in Settings</a>');
    if (p?.status === 'error') return line('warn', `Your Google Calendar: ${esc(p.error)}`, '<a href="#/settings">Fix it in Settings</a>');
    if (!b && owner() && !hintDismissed()) {
      return offer('Put the schedule on Google Calendar', 'Every site measure, install and task goes on a Google calendar of yours, and each person on a job can get it on their phone with reminders.', 'business', 'Connect Google Calendar');
    }
    if (!p && !owner() && !hintDismissed()) {
      return offer('Get your schedule on your phone', 'The jobs and tasks you\'re on can go on your own Google Calendar, with reminders.', 'personal', 'Connect my Google Calendar');
    }
    const on = [];
    if (isActive(b) && can.remove()) on.push(esc(calendarWords(b)));
    if (p) on.push('your own calendar');
    return on.length ? line('', `<span class="gc-dot" aria-hidden="true"></span>Copied to Google Calendar: ${listWords(on)}.`) : '';
  }

  // ---------- Full: the Settings card ----------
  function businessHtml() {
    const b = biz();
    const short = esc(shortName());
    if (!b) {
      if (!owner()) {
        const o = members.find((m) => m.role === 'owner');
        return `<p class="muted small">Not connected. ${o ? `The owner (${esc(o.name || o.email)})` : 'The owner'} connects it here.</p>`;
      }
      return `<p class="small">Every event on the schedule goes on a Google calendar of yours. The app makes a new calendar called “${short}” for it, and you can switch to one of your own calendars afterwards.</p>
        ${busyLine()}<div class="row">${connectButton('business', 'Connect Google Calendar')}</div>`;
    }
    if (isPaused(b)) {
      const name = esc(b.holderName || memberName(b.uid) || 'The previous owner');
      return `<p class="small">${statusLine(b)}</p>
        <p class="small">${b.uid === me() ? 'Your' : `${name}'s`} ${isMainCalendar(b) ? 'main calendar' : `calendar “${esc(b.calendarName)}”`} (${esc(b.email)}) still has the schedule from before, but nothing new goes there.</p>
        ${owner() ? `<p class="small">Connect your own Google Calendar to take over. The schedule moves to a calendar in your account, and the app's events come off ${b.uid === me() ? 'the old one' : `${name}'s calendar`}. Nothing else in either calendar is touched.</p>` : ''}
        ${busyLine()}<div class="row">
          ${owner() ? connectButton('business', 'Take over with my Google Calendar') : ''}
          ${b.uid === me() ? button('data-disconnect="business"', 'Remove the app\'s events from my calendar', 'danger')
    : owner() ? button('data-disconnect="business"', `Remove them from ${name}'s calendar`, 'danger') : ''}
        </div>`;
    }
    const yours = b.uid === me();
    return `<p class="small">${isMainCalendar(b) ? `Every event goes on <b>${yours ? 'your' : holder(b)} main Google calendar</b> (${esc(b.email)}).`
    : `Every event goes on <b>“${esc(b.calendarName)}”</b> in ${yours ? 'your' : holder(b)} Google Calendar (${esc(b.email)}).`}</p>
      <p class="small">${statusLine(b)}</p>
      ${owner() ? pickerHtml(b) : ''}
      ${busyLine()}
      ${owner() && !picker && !askPick ? `<div class="row">
        ${b.status === 'error' ? connectButton('business', 'Connect again', 'primary', b.appCalendar === false ? 'pick' : 'basic') : ''}
        ${button('data-resync="business"', 'Sync now')}
        ${button('data-change', 'Use a different calendar')}
        ${button('data-disconnect="business"', 'Disconnect', 'danger')}
      </div>` : ''}`;
  }

  function pickerHtml(b) {
    if (askPick) {
      const back = b.status === 'error' && b.appCalendar === false; // connecting again to one of their own calendars
      return `<div class="gc-picker"><p class="small">${back ? 'The schedule goes on one of your own calendars, so' : 'To show your calendars,'} Google asks you to let the app see your list of calendars and manage events on calendars you own. The app still only ever changes the events it adds.</p>
        <div class="row">${connectButton('business', 'Continue to Google', 'primary', 'pick', back ? '' : 'choose')}${button('data-cancel', 'Cancel')}</div></div>`;
    }
    if (!picker) return '';
    const current = picker.calendars.find((c) => c.current);
    const rows = [
      ...(b.appCalendar ? [] : [{ id: 'new', name: `A new calendar just for the app (“${shortName()}”)`, current: false }]),
      ...picker.calendars.map((c) => ({ ...c, name: `${c.name}${c.primary ? ' (your main calendar)' : ''}` })),
    ];
    return `<div class="gc-picker"><p class="small"><b>Which calendar gets the schedule?</b></p>
      ${rows.map((c) => `<label class="pick-row"><input type="radio" name="gc-cal" value="${esc(c.id)}" ${c.current || (!current && c.id === 'new') ? 'checked' : ''}> ${esc(c.name)}${c.current ? ' <span class="muted small">(now)</span>' : ''}</label>`).join('')}
      <p class="hint">The app's events are tagged, so it only ever changes or removes its own events, never yours. Switching moves them to the calendar you pick.</p>
      <div class="row">${button('data-choose', 'Use this calendar', 'primary')}${button('data-cancel', 'Cancel')}</div></div>`;
  }

  function personalHtml() {
    const p = mine();
    if (!p) {
      const b = biz();
      return `<p class="small">Events you're on go on a “${esc(shortName())} – my schedule” calendar in your Google account, with their reminders on your phone.</p>
        ${isActive(b) && b.uid === me() ? '<p class="hint">You already have every event on the business calendar, so you don\'t need this as well.</p>' : ''}
        ${busyLine()}<div class="row">${connectButton('personal', 'Connect my Google Calendar', owner() || (isActive(b) && b.uid === me()) ? '' : 'primary')}</div>`;
    }
    return `<p class="small">Events you're on go on <b>“${esc(p.calendarName)}”</b> in your Google Calendar (${esc(p.email)}).</p>
      <p class="small">${statusLine(p)}</p>${busyLine()}
      <div class="row">${p.status === 'error' ? connectButton('personal', 'Connect again') : ''}${button('data-resync="personal"', 'Sync now')}${button('data-disconnect="personal"', 'Disconnect', 'danger')}</div>`;
  }

  // Like removing someone from the team: the owner can disconnect anyone, an admin only staff and the accountant (and
  // people no longer on the team).
  const mayDisconnect = (l) => owner() || (members.length > 0 && l.uid !== state.company?.ownerUid
    && !['owner', 'admin'].includes(members.find((m) => m.uid === l.uid)?.role));

  function teamHtml() {
    if (!can.remove()) return '';
    const others = links.filter((l) => l.kind === 'personal' && l.uid !== me());
    const holderUid = isActive(biz()) ? biz().uid : null;
    const without = members.filter((m) => m.uid !== me() && m.uid !== holderUid && !links.some((l) => l.kind === 'personal' && l.uid === m.uid));
    return `<h3>The team's calendars</h3>
      ${others.length ? `<table class="list"><tbody>${others.map((l) => `<tr><td>${esc(l.holderName || memberName(l.uid) || 'Former team member')}<br><span class="muted small">${esc(l.email)}</span></td><td class="small">${statusLine(l)}</td>
        <td class="actions-cell">${mayDisconnect(l) ? button(`data-disconnect="personal" data-uid="${esc(l.uid)}"`, 'Disconnect', 'danger') : ''}</td></tr>`).join('')}</tbody></table>` : ''}
      <p class="hint">${without.length ? `Not connected yet: ${esc(listWords(without.map((m) => m.name || m.email || 'a team member')))}. ` : ''}Each person connects their own here or on the Schedule page, so their jobs and reminders reach their phone.</p>`;
  }

  function fullHtml() {
    if (!loaded) return '<p class="muted small">Checking…</p>';
    return `<p class="small">The schedule is copied to Google Calendar so it shows on phones with Google's reminders. It only goes one way: nothing is read back from Google, so personal events stay out of the app, and connecting, switching or disconnecting a calendar never changes anything in the app.</p>
      ${notReady()}
      <h3>Business calendar</h3>${businessHtml()}
      <h3>Your own calendar</h3>${personalHtml()}
      ${teamHtml()}`;
  }

  function draw() {
    if (stopped) return;
    box.innerHTML = compact ? (loaded ? compactHtml() : '') : fullHtml();
  }

  async function work(text, fn) {
    busy = text;
    draw();
    try { await fn(); } catch (e) {
      console.error(e);
      if (messageOf(e) !== 'needs-permission') toast(calendarError(e), true);
      else if (compact) toast('Google Calendar needs one more permission. Open Settings to finish connecting.', true);
      else { picker = null; askPick = true; }
    } finally {
      busy = '';
      draw();
    }
  }

  async function openPicker() {
    const r = await run('calendars', { kind: 'business' });
    askPick = false;
    picker = { calendars: r.calendars || [] };
  }

  async function onClick(e) {
    const b = e.target.closest('button');
    if (!b || b.disabled || busy) return;
    if (b.dataset.connect) {
      const kind = b.dataset.connect;
      const scope = b.dataset.scope || 'basic';
      let code;
      try {
        code = await askGoogle(scope);
      } catch (err) {
        if (!(err instanceof Closed)) toast(err.message, true);
        return;
      }
      await work(kind === 'business' ? 'Connecting, and copying the schedule to Google Calendar…' : 'Connecting, and copying your events to Google Calendar…', async () => {
        const r = await run('connect', { kind, code });
        askPick = false;
        toast(`Connected. ${plural(r.count, 'event')} on “${r.calendarName}”.`);
        if (b.dataset.then === 'choose') await openPicker();
      });
    } else if (b.hasAttribute('data-change')) {
      if (!biz()?.canPick) { askPick = true; draw(); return; }
      await work('Getting your calendars…', openPicker);
    } else if (b.hasAttribute('data-choose')) {
      const id = box.querySelector('[name=gc-cal]:checked')?.value;
      if (!id) { toast('Pick a calendar.', true); return; }
      if (picker?.calendars.find((c) => c.id === id)?.current) { picker = null; draw(); return; }
      await work('Moving the schedule to that calendar…', async () => {
        const r = await run('choose', { kind: 'business', calendarId: id });
        picker = null;
        const main = biz()?.email && String(r.calendarName).toLowerCase() === biz().email.toLowerCase();
        toast(`Done. ${plural(r.count, 'event')} on ${main ? 'your main calendar' : `“${r.calendarName}”`}.`);
      });
    } else if (b.hasAttribute('data-cancel')) {
      picker = null; askPick = false; draw();
    } else if (b.dataset.resync) {
      await work('Copying everything to Google Calendar again…', async () => {
        const r = await run('resync', { kind: b.dataset.resync });
        toast(`Up to date: ${plural(r.count, 'event')} on Google Calendar.`);
      });
    } else if (b.dataset.disconnect) {
      const kind = b.dataset.disconnect;
      const uid = b.dataset.uid || null;
      const l = kind === 'business' ? biz() : links.find((x) => x.id === (uid || me()));
      if (!l) return;
      const whose = l.uid === me() ? 'your' : l.holderName ? `${l.holderName}'s` : 'their';
      const gone = l.appCalendar ? ' The app\'s own calendar is deleted too, if nothing else is in it.' : '';
      const which = isMainCalendar(l) ? `${whose} main Google calendar` : `${whose} Google Calendar “${l.calendarName}”`;
      if (!confirm(`Stop copying to ${which} (${l.email})? The app's events come off it.${gone} Nothing else in that calendar changes, and nothing in the app changes.`)) return;
      await work('Removing the app\'s events from Google Calendar…', async () => {
        const r = await run('disconnect', { kind, ...(uid ? { uid } : {}) });
        picker = null; askPick = false;
        toast(`Disconnected. ${plural(r.removed || 0, 'event')} came off Google Calendar.`);
      });
    } else if (b.hasAttribute('data-dismiss')) {
      dismissHint();
      draw();
    }
  }

  box.addEventListener('click', onClick);
  const offLinks = watchLinks((l) => { links = l; loaded = true; draw(); });
  // Handing the business over pauses the business calendar, so the panel changes then too.
  let ownerUid = state.company?.ownerUid;
  const offOwner = onChange(() => {
    if (state.company?.ownerUid === ownerUid) return;
    ownerUid = state.company?.ownerUid;
    draw();
  });
  if (!compact) {
    getReady();
    listMembers().then((m) => { members = m; draw(); }).catch(() => {});
  }
  draw();
  return () => {
    stopped = true;
    offLinks();
    offOwner();
    box.removeEventListener('click', onClick);
  };
}
