// The schedule: site measures, installs, meetings, deliveries, tasks and time off, and who's on each one.
// Events are companies/{company}/events/{id} (shapes in firestore.rules; dates, repeats and reminders in when.js).
// The app is the master copy. The calendarSync Cloud Function copies events one way to Google Calendar
// (functions-calendar/); gcal.js shows and changes those connections.
import { db } from './firebase.js';
import {
  collection, query, where as fwhere, onSnapshot, doc, getDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { state, add, update, remove, get, can, onChange, listMembers, EVENT_DAYS_BACK } from './data.js';
import { esc, options, toast } from './ui.js';
import * as W from './when.js';
import { mountCalendarPanel, watchLinks, syncNote } from './gcal.js';

const tz = () => state.company?.timeZone || W.DEFAULT_TZ;
const today = () => W.nowIn(tz()).date;
const me = () => state.user?.uid;
const thisYear = () => today().slice(0, 4);

// ---------- Who can do what (mirrors firestore.rules) ----------
const ACCOUNTANT_TYPES = ['task', 'meeting'];
const isAccountant = () => state.role === 'accountant';
export const canAdd = (type) => can.edit() || (isAccountant() && (!type || ACCOUNTANT_TYPES.includes(type)));
const canEditEvent = (ev) => can.edit() || (isAccountant() && ev.createdBy === me() && ACCOUNTANT_TYPES.includes(ev.type));
// Ticking a task off: anyone who can edit it, and the accountant for tasks they're on.
const canTick = (ev) => canEditEvent(ev) || (isAccountant() && ev.type === 'task' && (ev.assignees || []).includes(me()));
const canDelete = (ev) => can.remove() || (can.edit() && ev.createdBy === me());

// ---------- Team members (for "who's on it") ----------
let members = [];
let membersFor = null;
let membersLoading = null;
const ROLE_ORDER = ['owner', 'admin', 'staff', 'accountant'];
function loadMembers() {
  if (membersFor === state.companyId && membersLoading) return membersLoading;
  membersFor = state.companyId;
  membersLoading = listMembers().then((list) => {
    members = list.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || personName(a).localeCompare(personName(b)));
    return members;
  }).catch((e) => { console.error(e); membersLoading = null; return members; });
  return membersLoading;
}
const personName = (m) => m?.name || String(m?.email || '').split('@')[0] || m?.phone || 'Team member';
const memberName = (uid) => (uid === me() && !members.length ? 'Me' : personName(members.find((m) => m.uid === uid)) || 'Former team member');
const knownMember = (uid) => members.some((m) => m.uid === uid);
const initials = (uid) => {
  const m = members.find((x) => x.uid === uid);
  if (!m) return '?';
  return personName(m).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
};
const whoChips = (ev) => (ev.assignees || []).map((uid) => `<span class="who-dot" title="${esc(knownMember(uid) ? memberName(uid) : 'Former team member')}">${esc(initials(uid))}</span>`).join('');

// ---------- Which events to show ----------
const label = (key) => W.typeOf(key).label;
const jobOf = (ev) => (ev.jobId ? get('jobs', ev.jobId) : null);
const customerOf = (ev) => (ev.customerId ? get('customers', ev.customerId) : null) || (jobOf(ev)?.customerId ? get('customers', jobOf(ev).customerId) : null);
const isOverdue = (ev, day = today()) => ev.type === 'task' && !ev.done && !ev.canceled && W.datePart(ev.start) < day;

// Remembered while the app is open: the view, the day it's on, whose events and which kinds.
const VIEW_KEY = 'stellar-schedule-view';
const ui = {
  view: (() => { try { return localStorage.getItem(VIEW_KEY) || 'agenda'; } catch { return 'agenda'; } })(),
  anchor: null,
  who: null,
  hidden: new Set(),
};

function matches(ev) {
  if (ui.hidden.has(ev.type)) return false;
  if (!ui.who) return true;
  const uid = ui.who === 'me' ? me() : ui.who;
  return (ev.assignees || []).includes(uid);
}

// Every occurrence from `from` to `to` (dates) of the events given, soonest first.
function occurrencesIn(list, from, to, filter = matches) {
  const out = [];
  for (const ev of list) {
    if (!filter(ev)) continue;
    for (const occ of W.occurrences(ev, from, to)) out.push({ ev, occ });
  }
  return out.sort((a, b) => a.occ.start.localeCompare(b.occ.start) || (a.ev.title || '').localeCompare(b.ev.title || ''));
}

// ---------- Summaries for the dashboard, the sidebar and job pages ----------
// Owners and admins follow the whole team; everyone else, what they're on.
const mineOrAll = (ev) => can.remove() || (ev.assignees || []).includes(me()) || !(ev.assignees || []).length;

export function scheduleSummary() {
  const day = today();
  const list = state.data.events.filter((ev) => !ev.canceled && mineOrAll(ev));
  const todays = occurrencesIn(list, day, day, () => true).filter(({ ev }) => !ev.done);
  const overdue = list.filter((ev) => isOverdue(ev, day));
  return { today: todays.length, overdue: overdue.length };
}

// The count beside "Schedule" in the sidebar: overdue tasks first, else what's on today.
export function scheduleCount() {
  const s = scheduleSummary();
  if (s.overdue) return { n: s.overdue, text: `${s.overdue} overdue`, cls: 'amber' };
  return { n: s.today, text: `${s.today} today`, cls: 'accent' };
}

const itemLine = ({ ev, occ }, { showDay = true } = {}) => {
  const job = jobOf(ev);
  const cust = customerOf(ev);
  const late = isOverdue(ev);
  return `<li class="up-item t-${esc(ev.type)}${ev.done ? ' is-done' : ''}">
    <a href="#/schedule/${esc(ev.id)}"><span class="up-when${late ? ' warn' : ''}">${late ? 'Overdue · ' : ''}${showDay ? `${esc(W.fmtDay(occ.date, { thisYear: thisYear() }))} · ` : ''}${esc(W.fmtSpan(ev, occ))}</span>
    <span class="up-title">${esc(ev.title)}</span>
    <span class="up-meta">${esc([label(ev.type), job?.name, cust?.name].filter(Boolean).join(' · '))}</span></a></li>`;
};

// "Coming up" on the dashboard: overdue tasks, then the next two weeks.
export function comingUpHtml(limit = 6) {
  const day = today();
  const list = state.data.events.filter((ev) => !ev.canceled && !ev.done && mineOrAll(ev));
  const late = list.filter((ev) => isOverdue(ev, day)).map((ev) => ({ ev, occ: { start: ev.start, end: ev.end, date: W.datePart(ev.start) } }));
  const next = occurrencesIn(list, day, W.addDays(day, 14), (ev) => !isOverdue(ev, day));
  const items = [...late, ...next].slice(0, limit);
  return `<div class="card"><div class="card-head"><h2>Coming up</h2><a class="btn small" href="#/schedule">Schedule</a></div>
    ${items.length ? `<ul class="up-list">${items.map((it) => itemLine(it)).join('')}</ul>`
    : `<p class="muted small">Nothing in the next two weeks.${canAdd() ? ' <a href="#/schedule/new">Add a site measure, install or reminder</a>.' : ''}</p>`}</div>`;
}

// What's inside the schedule card on a job's page: the last three months on, plus open tasks (what the app keeps loaded).
export function jobScheduleHtml(jobId) {
  const list = state.data.events.filter((ev) => ev.jobId === jobId);
  const day = today();
  const upcoming = list.filter((ev) => W.lastDay(ev) >= day || ev.repeat || isOverdue(ev, day)).sort((a, b) => a.start.localeCompare(b.start));
  const past = list.filter((ev) => !upcoming.includes(ev)).sort((a, b) => b.start.localeCompare(a.start)).slice(0, 5);
  const row = (ev) => `<li><a href="#/schedule/${esc(ev.id)}">${esc(ev.title)}</a> <span class="badge t-badge t-${esc(ev.type)}">${esc(label(ev.type))}</span>${ev.done ? ' <span class="badge s-complete">done</span>' : ''}${ev.canceled ? ' <span class="badge s-void">canceled</span>' : ''}
    <span class="ev-when small${isOverdue(ev, day) ? ' warn' : ''}">${esc(W.fmtWhen(ev, thisYear()))}</span></li>`;
  return `<div class="row between"><h2>Schedule</h2>${canAdd() ? `<a class="btn small" href="#/schedule/new?job=${esc(jobId)}">${can.edit() ? 'Schedule' : 'Add a task'}</a>` : ''}</div>
    ${upcoming.length || past.length ? `<ul class="links">${upcoming.map(row).join('')}${past.length ? `<li class="muted small">Earlier</li>${past.map(row).join('')}` : ''}</ul>`
    : `<p class="muted">Nothing scheduled.${canAdd() ? ' Add the site measure, the install or a reminder.' : ''}</p>`}`;
}

// Keeps a job page's schedule card current while the page is open (job pages render once).
export function mountJobSchedule(el, jobId) {
  if (!el) return () => {};
  const draw = () => { el.innerHTML = jobScheduleHtml(jobId); };
  draw();
  return onChange(draw);
}

// ---------- For other screens ----------
// A link to a new schedule entry with parts filled in, e.g. a parts order's delivery:
//   scheduleLink({ type: 'delivery', jobId, title: 'Glass delivery', date: '2026-10-20', time: '08:00',
//                  ref: '#/parts/abc', refLabel: 'Parts order 12' })
// Fields: type, jobId, customerId, title, date, time, endDate, endTime, allDay, location, notes, assignees (uids or 'me'),
// ref (an app link starting with #/) and refLabel.
export function scheduleLink(fill = {}) {
  const p = new URLSearchParams();
  const put = (k, v) => { if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); };
  put('type', fill.type); put('job', fill.jobId); put('customer', fill.customerId); put('title', fill.title);
  put('date', fill.date); put('time', fill.time); put('endDate', fill.endDate); put('endTime', fill.endTime);
  if (fill.allDay) p.set('allDay', '1');
  put('location', fill.location); put('notes', fill.notes);
  if (fill.assignees?.length) p.set('assign', fill.assignees.join(','));
  put('ref', fill.ref); put('refLabel', fill.refLabel);
  return `#/schedule/new${p.toString() ? `?${p}` : ''}`;
}

const safeRef = (r) => (r && typeof r.path === 'string' && /^#\/[A-Za-z0-9/_?=&.-]+$/.test(r.path) && r.path.length <= 200
  ? { path: r.path, label: String(r.label || '').slice(0, 120) } : null);

// Fills in everything an event needs from a few fields (the form and addEvent both use it).
function completeEvent(fill) {
  const type = W.TYPES.some((t) => t.key === fill.type) ? fill.type : 'other';
  const t = W.typeOf(type);
  const job = fill.jobId ? get('jobs', fill.jobId) : null;
  const allDay = fill.allDay ?? !!t.allDay;
  const date = W.isDate(fill.date) ? fill.date : today();
  let start; let end;
  if (allDay) {
    start = date;
    end = W.isDate(fill.endDate) && fill.endDate >= date ? fill.endDate : date;
  } else {
    start = `${date}T${/^\d{2}:\d{2}$/.test(fill.time || '') ? fill.time : type === 'task' ? '09:00' : '08:00'}`;
    const endDate = W.isDate(fill.endDate) ? fill.endDate : date;
    end = /^\d{2}:\d{2}$/.test(fill.endTime || '') ? `${endDate}T${fill.endTime}` : W.addMinutes(start, t.minutes || 60);
    if (end <= start) end = W.addMinutes(start, t.minutes || 60);
  }
  const cust = fill.customerId || job?.customerId || '';
  const customer = cust ? get('customers', cust) : null;
  return {
    type,
    title: String(fill.title || '').trim().slice(0, 200) || `${t.label}${job ? `: ${job.name}` : customer ? `: ${customer.name}` : ''}`.slice(0, 200),
    allDay, start, end, tz: tz(),
    repeat: ['weekly', 'monthly', 'yearly'].includes(fill.repeat) ? fill.repeat : '',
    repeatUntil: fill.repeat && W.isDate(fill.repeatUntil) && fill.repeatUntil >= date ? fill.repeatUntil : '',
    jobId: job ? job.id : '',
    customerId: cust,
    location: String(fill.location ?? job?.siteAddress ?? '').trim().slice(0, 300),
    assignees: [...new Set((fill.assignees || [me()]).map((u) => (u === 'me' ? me() : u)).filter(Boolean))].slice(0, 20),
    reminders: W.cleanReminders(fill.reminders ?? (allDay ? (t.reminders.length ? [900] : []) : t.reminders)),
    notes: String(fill.notes || '').slice(0, 4000),
    done: false,
    canceled: false,
    ...(safeRef(fill.ref) ? { ref: safeRef(fill.ref) } : {}),
  };
}

// Adds an event right away and returns its id, e.g. for a delivery date another screen already knows.
export async function addEvent(fill) {
  const data = completeEvent(fill);
  if (!canAdd(data.type)) throw new Error('Your role can\'t add that to the schedule.');
  const r = await add('events', { ...data, createdByName: myName() });
  return r.id;
}

const myName = () => (state.user?.displayName || state.user?.email || state.user?.phoneNumber || '').slice(0, 100);

// Ticks a task off. A repeating one moves on to its next due date instead, until it's over.
async function tick(ev) {
  if (ev.repeat && !ev.done) {
    const next = W.nextOccurrence(ev, W.datePart(ev.start));
    if (next) {
      await update('events', ev.id, { start: next.start, end: next.end, lastDone: W.datePart(ev.start), updatedBy: me() });
      return `Done. Next one is due ${W.fmtDay(next.date)}.`;
    }
    await update('events', ev.id, { done: true, doneAt: serverTimestamp(), lastDone: W.datePart(ev.start), updatedBy: me() });
    return 'Done. That was the last one.';
  }
  await update('events', ev.id, { done: !ev.done, doneAt: ev.done ? null : serverTimestamp(), updatedBy: me() });
  return ev.done ? 'Marked not done' : 'Marked done';
}

async function attempt(fn) {
  try { return await fn(); } catch (e) {
    console.error(e);
    toast(e.code === 'permission-denied' ? 'Your role can\'t make that change.' : e.message, true);
    return null;
  }
}

// ---------- The Schedule page ----------
const VIEWS = [['agenda', 'Agenda'], ['month', 'Month'], ['team', 'Team week']];

// The days a view covers, and its title.
function range() {
  const a = ui.anchor;
  if (ui.view === 'month') {
    const first = `${a.slice(0, 7)}-01`;
    const from = W.addDays(first, -W.weekday(first));
    const last = W.addDays(W.addMonths(first, 1), -1);
    const to = W.addDays(last, 6 - W.weekday(last));
    return { from, to, title: W.monthName(first) };
  }
  if (ui.view === 'team') {
    const from = W.addDays(a, -W.weekday(a));
    const to = W.addDays(from, 6);
    return { from, to, title: `${W.shortDay(from)} – ${W.shortDay(to)}${to.slice(0, 4) !== thisYear() ? `, ${to.slice(0, 4)}` : ''}` };
  }
  const to = W.addDays(a, 27);
  return { from: a, to, title: `${W.shortDay(a)} – ${W.shortDay(to)}${to.slice(0, 4) !== thisYear() ? `, ${to.slice(0, 4)}` : ''}` };
}

function move(dir) {
  if (dir === 0) { ui.anchor = today(); return; }
  if (ui.view === 'month') ui.anchor = W.addMonths(`${ui.anchor.slice(0, 7)}-01`, dir);
  else ui.anchor = W.addDays(ui.anchor, (ui.view === 'team' ? 7 : 28) * dir);
}

export function schedulePage(params) {
  if (!ui.anchor) ui.anchor = today();
  if (ui.who === null) ui.who = can.remove() ? '' : 'me';
  if (W.isDate(params.get('day'))) { ui.anchor = params.get('day'); ui.view = 'agenda'; }
  let el = null;
  let offChange = null;
  let offPanel = null;
  let raf = 0;
  // Older events than the app keeps loaded, while someone looks at an earlier month.
  let older = { from: null, list: [], unsub: null };

  const html = `
  <div class="page-head"><div class="page-title"><h1>Schedule</h1></div><div class="actions">
    ${canAdd() ? `${can.edit() ? '<a class="btn primary" href="#/schedule/new">New event</a>' : ''}<a class="btn${can.edit() ? '' : ' primary'}" href="#/schedule/new?type=task">New task</a>` : ''}
  </div></div>
  <div data-sched>
    <div class="sched-bar">
      <div class="seg" role="tablist" aria-label="View">${VIEWS.map(([k, l]) => `<button type="button" role="tab" data-view="${k}">${l}</button>`).join('')}</div>
      <div class="sched-nav">
        <button type="button" class="btn small" data-move="-1" aria-label="Earlier">‹</button>
        <button type="button" class="btn small" data-move="0">Today</button>
        <button type="button" class="btn small" data-move="1" aria-label="Later">›</button>
        <strong data-title></strong>
      </div>
      <select data-who aria-label="Whose schedule" class="who-filter"></select>
    </div>
    <div class="chips type-chips" data-types></div>
    <div data-gcal></div>
    <div data-body><p class="muted">Loading…</p></div>
  </div>`;

  const allEvents = () => {
    if (!older.list.length) return state.data.events;
    const ids = new Set(state.data.events.map((e) => e.id));
    return [...state.data.events, ...older.list.filter((e) => !ids.has(e.id))];
  };

  // Loads events from before what the app keeps (three months back) for an earlier month or week.
  function loadOlder(from) {
    const kept = W.addDays(W.nowIn().date, -EVENT_DAYS_BACK);
    if (from >= kept || older.from === from) return;
    older.unsub?.();
    older = { from, list: [], unsub: null };
    const q = query(collection(db, 'companies', state.companyId, 'events'), fwhere('start', '>=', W.addDays(from, -31)), fwhere('start', '<', kept));
    older.unsub = onSnapshot(q, (snap) => {
      older.list = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));
      renderBody();
    }, (e) => console.error('older events', e));
  }

  function renderBar() {
    if (!el) return;
    const r = range();
    el.querySelectorAll('[data-view]').forEach((b) => { b.classList.toggle('on', b.dataset.view === ui.view); b.setAttribute('aria-selected', String(b.dataset.view === ui.view)); });
    el.querySelector('[data-title]').textContent = r.title;
    const who = el.querySelector('[data-who]');
    who.innerHTML = options([['', 'Everyone'], ['me', 'My schedule'], ...members.filter((m) => m.uid !== me()).map((m) => [m.uid, personName(m)])], ui.who);
    el.querySelector('[data-types]').innerHTML = W.TYPES.map((t) => `<button type="button" class="chip t-chip t-${t.key} ${ui.hidden.has(t.key) ? '' : 'on'}" data-type="${t.key}" aria-pressed="${!ui.hidden.has(t.key)}">${esc(t.label)}</button>`).join('');
  }

  const evLink = (ev, occ, cls, text) => `<a class="${cls} t-${esc(ev.type)}${ev.done ? ' is-done' : ''}${ev.canceled ? ' is-canceled' : ''}" href="#/schedule/${esc(ev.id)}" title="${esc(`${ev.title} · ${W.fmtSpan(ev, occ)}`)}">${text}</a>`;

  function agendaHtml(r) {
    const list = allEvents();
    const day = today();
    const late = r.from <= day && day <= r.to ? list.filter((ev) => matches(ev) && isOverdue(ev, day)) : [];
    const items = occurrencesIn(list, r.from, r.to).filter(({ ev }) => !late.includes(ev));
    const byDay = new Map();
    for (const it of items) {
      // A multi-day event shows on each of its days within the view.
      const lastShown = W.lastDay({ ...it.ev, start: it.occ.start, end: it.occ.end });
      for (let d = it.occ.date < r.from ? r.from : it.occ.date; d <= lastShown && d <= r.to; d = W.addDays(d, 1)) {
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(it);
      }
    }
    const row = ({ ev, occ }, d) => {
      const job = jobOf(ev);
      const cust = customerOf(ev);
      const multi = d !== occ.date;
      const tickBox = ev.type === 'task' && canTick(ev) && !ev.canceled
        ? `<input type="checkbox" class="tick" data-tick="${esc(ev.id)}" ${ev.done ? 'checked' : ''} aria-label="Done">` : '<span class="tick-gap"></span>';
      return `<li class="ag-item t-${esc(ev.type)}${ev.done ? ' is-done' : ''}${ev.canceled ? ' is-canceled' : ''}">
        <span class="ag-time">${multi ? 'continues' : esc(W.fmtSpan(ev, occ))}</span>
        ${tickBox}
        <span class="ag-main"><span><a class="ag-title" href="#/schedule/${esc(ev.id)}">${esc(ev.title)}</a>${ev.repeat ? ' <span class="muted small" title="Repeats">↻</span>' : ''}${ev.canceled ? ' <span class="badge s-void">canceled</span>' : ''}</span>
          <span class="ag-meta">${esc([label(ev.type), job?.name, cust?.name, ev.location].filter(Boolean).join(' · '))}</span></span>
        <span class="ag-who">${whoChips(ev)}</span></li>`;
    };
    const lateHtml = late.length ? `<section class="ag-day late"><h3>Overdue tasks</h3><ul class="ag-list">${late.sort((a, b) => a.start.localeCompare(b.start)).map((ev) => row({ ev, occ: { start: ev.start, end: ev.end, date: W.datePart(ev.start) } }, W.datePart(ev.start)).replace('<span class="ag-time">', `<span class="ag-time warn">${esc(W.fmtDay(W.datePart(ev.start)))} · `)).join('')}</ul></section>` : '';
    const days = [...byDay.keys()].sort();
    const dayTitle = (d) => (d === day ? `Today · ${W.fmtDay(d, { long: true })}` : d === W.addDays(day, 1) ? `Tomorrow · ${W.fmtDay(d, { long: true })}` : W.fmtDay(d, { long: true, thisYear: thisYear() }));
    if (!days.length && !late.length) {
      return `<div class="card empty"><p>Nothing scheduled from ${esc(W.shortDay(r.from))} to ${esc(W.shortDay(r.to))}${ui.who || ui.hidden.size ? ' that matches' : ''}.</p>${canAdd() ? `<a class="btn primary" href="#/schedule/new?date=${esc(r.from < day ? day : r.from)}">${can.edit() ? 'New event' : 'New task'}</a>` : ''}</div>`;
    }
    return `<div class="card agenda">${lateHtml}${days.map((d) => `<section class="ag-day${d === day ? ' is-today' : ''}"><h3><a href="#/schedule/new?date=${esc(d)}" class="ag-add" title="Add on this day" ${canAdd() ? '' : 'hidden'}>+</a>${esc(dayTitle(d))}</h3>
      <ul class="ag-list">${byDay.get(d).map((it) => row(it, d)).join('')}</ul></section>`).join('')}</div>`;
  }

  function monthHtml(r) {
    const items = occurrencesIn(allEvents(), r.from, r.to);
    const month = ui.anchor.slice(0, 7);
    const day = today();
    const cells = [];
    for (let d = r.from; d <= r.to; d = W.addDays(d, 1)) {
      const on = items.filter(({ ev, occ }) => occ.date <= d && W.lastDay({ ...ev, start: occ.start, end: occ.end }) >= d);
      const shown = on.slice(0, 3);
      cells.push(`<div class="m-cell${d.slice(0, 7) !== month ? ' other' : ''}${d === day ? ' is-today' : ''}" data-day="${d}">
        <div class="m-head"><a class="m-num" href="#/schedule?day=${d}" aria-label="${esc(W.fmtDay(d, { long: true }))}">${Number(d.slice(8))}</a>${canAdd() ? `<a class="m-add" href="#/schedule/new?date=${d}" title="Add on this day" aria-label="Add on ${esc(W.fmtDay(d))}">+</a>` : ''}</div>
        ${shown.map(({ ev, occ }) => evLink(ev, occ, 'm-ev', `${ev.allDay || occ.date !== d ? '' : `<b>${esc(W.fmtTime(W.timePart(occ.start)).replace(':00', '').replace(' ', '').toLowerCase())}</b> `}${esc(ev.title)}`)).join('')}
        ${on.length > shown.length ? `<a class="m-more" href="#/schedule?day=${d}">+${on.length - shown.length} more</a>` : ''}
        ${on.length ? `<span class="m-dots" aria-hidden="true">${on.slice(0, 4).map(({ ev }) => `<i class="t-${esc(ev.type)}"></i>`).join('')}</span>` : ''}
      </div>`);
    }
    return `<div class="card month"><div class="m-grid">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n) => `<div class="m-dow">${n}</div>`).join('')}${cells.join('')}</div></div>`;
  }

  function teamHtml(r) {
    const items = occurrencesIn(allEvents(), r.from, r.to, (ev) => !ui.hidden.has(ev.type));
    const daysList = [];
    for (let d = r.from; d <= r.to; d = W.addDays(d, 1)) daysList.push(d);
    const people = members.filter((m) => !ui.who || (ui.who === 'me' ? m.uid === me() : m.uid === ui.who));
    const rows = [...people.map((m) => ({ key: m.uid, name: personName(m), sub: m.role })), ...(!ui.who ? [{ key: '', name: 'Not assigned', sub: '' }] : [])];
    const day = today();
    const cell = (key, d) => items.filter(({ ev, occ }) => (key ? (ev.assignees || []).includes(key) : !(ev.assignees || []).length)
      && occ.date <= d && W.lastDay({ ...ev, start: occ.start, end: occ.end }) >= d)
      .map(({ ev, occ }) => evLink(ev, occ, 'tw-ev', `${ev.allDay || occ.date !== d ? '' : `<b>${esc(W.fmtTime(W.timePart(occ.start)))}</b> `}${esc(ev.title)}`)).join('');
    if (!members.length) return '<div class="card"><p class="muted">Loading the team…</p></div>';
    return `<div class="card team-card"><div class="scroll"><table class="team-week"><thead><tr><th>Team</th>${daysList.map((d) => `<th class="${d === day ? 'is-today' : ''}"><a href="#/schedule?day=${d}">${esc(W.fmtDay(d))}</a></th>`).join('')}</tr></thead>
      <tbody>${rows.map((p) => `<tr><th scope="row">${esc(p.name)}${p.sub ? `<small>${esc(p.sub)}</small>` : ''}</th>${daysList.map((d) => `<td class="${d === day ? 'is-today' : ''}">${cell(p.key, d)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  }

  function renderBody() {
    if (!el) return;
    const r = range();
    loadOlder(r.from);
    const body = el.querySelector('[data-body]');
    body.innerHTML = ui.view === 'month' ? monthHtml(r) : ui.view === 'team' ? teamHtml(r) : agendaHtml(r);
  }

  function render() { renderBar(); renderBody(); }

  function mount(root) {
    el = root.querySelector('[data-sched]');
    offPanel = mountCalendarPanel(el.querySelector('[data-gcal]'), { compact: true });
    offChange = onChange(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderBody); });
    loadMembers().then(() => render());
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (b?.dataset.view) {
        ui.view = b.dataset.view;
        try { localStorage.setItem(VIEW_KEY, ui.view); } catch { /* private mode */ }
        render();
      } else if (b?.dataset.move !== undefined) { move(Number(b.dataset.move)); render(); } else if (b?.dataset.type) {
        if (ui.hidden.has(b.dataset.type)) ui.hidden.delete(b.dataset.type); else ui.hidden.add(b.dataset.type);
        render();
      }
    });
    el.addEventListener('change', async (e) => {
      if (e.target.matches('[data-who]')) { ui.who = e.target.value; render(); return; }
      if (e.target.matches('[data-tick]')) {
        const ev = allEvents().find((x) => x.id === e.target.dataset.tick);
        if (!ev) return;
        e.target.disabled = true;
        const msg = await attempt(() => tick(ev));
        if (msg) toast(msg); else renderBody();
      }
    });
    render();
  }

  function unmount() {
    offChange?.(); offChange = null;
    offPanel?.(); offPanel = null;
    older.unsub?.();
    cancelAnimationFrame(raf);
    el = null;
  }

  return { html, mount, unmount };
}

// ---------- One event ----------
// Who's on it, from the form: the ticked boxes, or the people it had while the team is still loading.
const chosenPeople = (form) => [...form.querySelectorAll('[name=assignees]')].filter((i) => i.type === 'hidden' || i.checked).map((i) => i.value);
const TIMED = W.REMINDERS_TIMED;
const ALL_DAY = W.REMINDERS_ALL_DAY;

export function eventEdit(id, params) {
  const isNew = id === 'new';
  // Opened from a job page before the jobs have loaded: wait for them, so the form starts with the job filled in.
  if (isNew && params.get('job') && !state.data.jobs.length) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  let ev = isNew ? null : state.data.events.find((x) => x.id === id) || null;
  let el = null;
  let offLinks = null;
  let links = [];
  let touched = new Set();

  const html = `<div data-event>${isNew || ev ? '' : '<p class="muted">Loading…</p>'}</div>`;

  function fillFromParams() {
    const p = (k) => params.get(k) || '';
    const type = W.TYPES.some((t) => t.key === p('type')) ? p('type') : 'measure';
    const allowed = canAdd(type) ? type : 'task';
    let date = W.isDate(p('date')) ? p('date') : today();
    let time = p('time');
    if (!/^\d{2}:\d{2}$/.test(time)) {
      // Today: the next whole hour (not before 7 AM), or tomorrow at 8 AM once the working day is over.
      // Other days: 8 AM. Tasks are due at 9 AM.
      const now = W.nowIn(tz());
      const h = Number(now.time.slice(0, 2)) + 1;
      if (allowed === 'task') time = '09:00';
      else if (date === now.date && h > 18 && !p('date')) {
        date = W.addDays(date, 1);
        time = '08:00';
      } else if (date === now.date) time = `${String(Math.min(22, Math.max(7, h))).padStart(2, '0')}:00`;
      else time = '08:00';
    }
    const assign = p('assign') ? p('assign').split(',').filter(Boolean) : undefined;
    return completeEvent({
      type: allowed, jobId: p('job'), customerId: p('customer'), title: p('title'), date, time,
      endDate: p('endDate'), endTime: p('endTime'), allDay: p('allDay') === '1' ? true : undefined,
      location: p('location') || undefined, notes: p('notes'), assignees: assign,
      ref: p('ref') ? { path: p('ref'), label: p('refLabel') } : null,
    });
  }

  function render() {
    if (!el) return;
    const data = ev || fillFromParams();
    if (isNew) data.title = params.get('title') || '';
    const edit = isNew ? canAdd(data.type) : canEditEvent(data);
    const tickable = !isNew && canTick(data);
    const ro = edit ? '' : 'disabled';
    const t = W.typeOf(data.type);
    const task = data.type === 'task';
    const startDate = W.datePart(data.start);
    const endDate = W.lastDay(data);
    const jobs = [...state.data.jobs].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const customers = [...state.data.customers].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const types = isAccountant() && edit ? W.TYPES.filter((x) => ACCOUNTANT_TYPES.includes(x.key) || x.key === data.type) : W.TYPES;
    const ref = safeRef(data.ref);
    const assignees = data.assignees || [];
    const nextDue = data.repeat && !data.done ? W.nextOccurrence(data, startDate) : null;

    el.innerHTML = `
    <div class="page-head"><div class="page-title"><h1>${isNew ? `New ${task ? 'task' : 'event'}` : esc(data.title)}</h1></div><div class="actions">
      <a class="btn" href="#/schedule">Schedule</a>
      ${!isNew && canDelete(data) ? '<button type="button" class="btn danger" data-delete>Delete</button>' : ''}</div></div>
    <form class="card stack ev-form" data-form>
      <div class="type-pick" role="radiogroup" aria-label="Kind of event">
        ${types.map((x) => `<label class="type-opt t-${x.key}"><input type="radio" name="type" value="${x.key}" ${x.key === data.type ? 'checked' : ''} ${ro}><span>${esc(x.label)}</span></label>`).join('')}
      </div>
      <label>Title <input name="title" maxlength="200" value="${esc(isNew ? data.title : data.title)}" placeholder="${esc(placeholderTitle(data))}" ${ro}></label>
      <div class="grid2">
        <label>Job <select name="jobId" ${ro}>${options([['', 'No job'], ...jobs.map((j) => [j.id, `${j.name}${get('customers', j.customerId) ? ` · ${get('customers', j.customerId).name}` : ''}`])], data.jobId)}</select></label>
        <label>Customer <select name="customerId" ${ro}>${options([['', 'No customer'], ...customers.map((c) => [c.id, c.name + (c.company ? ` (${c.company})` : '')])], data.customerId)}</select></label>
      </div>
      <fieldset class="when-box" ${ro}>
        <legend>${task ? 'Due' : 'When'}</legend>
        <label class="inline"><input type="checkbox" name="allDay" ${data.allDay ? 'checked' : ''}> ${task ? 'Any time that day' : 'All day'}</label>
        <div class="when-grid">
          <label>${task ? 'Due date' : data.allDay ? 'First day' : 'Date'} <input type="date" name="startDate" value="${esc(startDate)}" required></label>
          <label data-timed ${data.allDay ? 'hidden' : ''}>${task ? 'Time' : 'Starts'} <input type="time" name="startTime" step="300" value="${esc(W.timePart(data.start))}"></label>
          <label data-timed data-end ${data.allDay || task ? 'hidden' : ''}>Ends <input type="time" name="endTime" step="300" value="${esc(W.timePart(data.end))}"></label>
          <label data-endday ${task && !data.allDay ? 'hidden' : ''}>${data.allDay ? 'Last day' : 'End date'} <input type="date" name="endDate" value="${esc(task && !data.allDay ? startDate : endDate)}"></label>
        </div>
        <div class="grid2">
          <label>Repeats <select name="repeat">${options(W.REPEATS, data.repeat || '')}</select></label>
          <label data-until ${data.repeat ? '' : 'hidden'}>Until (leave empty for no end) <input type="date" name="repeatUntil" value="${esc(data.repeatUntil || '')}"></label>
        </div>
      </fieldset>
      <label>Where <input name="location" maxlength="300" value="${esc(data.location)}" placeholder="Site address" ${ro}></label>
      <fieldset class="pick-box" ${ro}><legend>Who's on it</legend>
        <div class="who-pick" data-who-pick>${whoPickHtml(assignees)}</div>
        <p class="hint">Each person who's on it gets it on their own Google Calendar once they connect theirs.</p>
      </fieldset>
      <fieldset class="pick-box" ${ro}><legend>Reminders</legend>
        <div class="rem-pick" data-rem></div>
        <p class="hint">Google Calendar sends these to the phone of each person on it.</p>
      </fieldset>
      <label>Notes <textarea name="notes" rows="3" maxlength="4000" ${ro} placeholder="${esc(task ? 'e.g. Call the GC about the revised drawings' : 'e.g. Bring the 12 ft ladder; gate code 4321')}">${esc(data.notes)}</textarea></label>
      ${!isNew ? `<div class="row status-row">
        <label class="inline"><input type="checkbox" name="done" ${data.done ? 'checked' : ''} ${edit && !(data.repeat && !data.done) ? '' : 'disabled'}> Done</label>
        <label class="inline"><input type="checkbox" name="canceled" ${data.canceled ? 'checked' : ''} ${ro}> Canceled</label>
        ${tickable && data.repeat && !data.done && task ? `<button type="button" class="btn small" data-tick>Done for ${esc(W.fmtDay(startDate))}${nextDue ? `, next ${esc(W.shortDay(nextDue.date))}` : ''}</button>` : ''}
        ${tickable && !edit && !data.repeat ? `<button type="button" class="btn small" data-tick>${data.done ? 'Mark not done' : 'Mark done'}</button>` : ''}
        ${data.lastDone ? `<span class="muted small">Last done ${esc(W.fmtDay(data.lastDone))}</span>` : ''}
      </div>` : ''}
      ${ref ? `<p class="small">From <a href="${esc(ref.path)}">${esc(ref.label || 'the record it came from')}</a></p>` : ''}
      <p class="small muted" data-sync></p>
      ${edit ? `<div class="row"><button class="btn primary">${isNew ? 'Add to schedule' : 'Save'}</button>${isNew ? '' : '<a class="btn" href="#/schedule">Done</a>'}</div>` : `<p class="muted small">${isAccountant() ? 'The accountant can add and change tasks and meetings of their own.' : 'Your role can see the schedule but not change this.'}</p>`}
      ${!isNew && data.createdByName ? `<p class="hint">Added by ${esc(data.createdByName)}.</p>` : ''}
    </form>`;
    renderReminders(data.allDay, data.reminders || []);
    renderSync();
  }

  const placeholderTitle = (d) => {
    const job = d.jobId ? get('jobs', d.jobId) : null;
    const cust = d.customerId ? get('customers', d.customerId) : null;
    return `${W.typeOf(d.type).label}${job ? `: ${job.name}` : cust ? `: ${cust.name}` : ''}`;
  };

  // The team, as boxes to tick. Until the team has loaded, the people already on it stay on it.
  function whoPickHtml(assignees) {
    if (!members.length) {
      return `${assignees.map((uid) => `<input type="hidden" name="assignees" value="${esc(uid)}">`).join('')}<span class="muted small">Loading the team…</span>`;
    }
    const people = [...members, ...assignees.filter((uid) => !knownMember(uid)).map((uid) => ({ uid, name: 'Former team member' }))];
    return people.map((m) => `<label class="pick-opt"><input type="checkbox" name="assignees" value="${esc(m.uid)}" ${assignees.includes(m.uid) ? 'checked' : ''}> ${esc(m.uid === me() ? `${personName(m)} (me)` : personName(m))}</label>`).join('');
  }

  function renderReminders(allDay, chosen) {
    const box = el?.querySelector('[data-rem]');
    if (!box) return;
    const choices = allDay ? ALL_DAY : TIMED;
    const extra = chosen.filter((m) => !choices.some(([c]) => c === m)).map((m) => [m, W.reminderLabel(m, allDay)]);
    box.innerHTML = [...choices, ...extra].map(([m, l]) => `<label class="pick-opt"><input type="checkbox" name="reminders" value="${m}" ${chosen.includes(m) ? 'checked' : ''}> ${esc(l)}</label>`).join('');
  }

  // Where it goes on Google Calendar, from the connections people have made (gcal.js).
  function renderSync() {
    const box = el?.querySelector('[data-sync]');
    if (!box) return;
    const f = el.querySelector('[data-form]');
    const assignees = f ? chosenPeople(f) : (ev?.assignees || []);
    const canceled = f?.elements.canceled?.checked;
    box.textContent = syncNote(links, { assignees, canceled, name: memberName });
  }

  function read(form) {
    const f = form.elements;
    const type = f.type.value || 'other';
    const task = type === 'task';
    const allDay = f.allDay.checked;
    const startDate = f.startDate.value;
    const startTime = f.startTime.value;
    let start; let end;
    if (!W.isDate(startDate)) throw new Error('Pick a date.');
    if (allDay) {
      start = startDate;
      end = W.isDate(f.endDate.value) ? f.endDate.value : startDate;
      if (end < start) throw new Error('The last day is before the first day.');
    } else {
      if (!/^\d{2}:\d{2}$/.test(startTime)) throw new Error(task ? 'Pick the time it\'s due, or tick "Any time that day".' : 'Pick a start time, or tick "All day".');
      start = `${startDate}T${startTime}`;
      if (task) end = W.addMinutes(start, 30);
      else {
        const endTime = f.endTime.value;
        const endDay = W.isDate(f.endDate.value) ? f.endDate.value : startDate;
        end = /^\d{2}:\d{2}$/.test(endTime) ? `${endDay}T${endTime}` : W.addMinutes(start, W.typeOf(type).minutes || 60);
        if (end <= start) throw new Error('It ends before it starts. Check the end time and date.');
      }
    }
    const repeat = f.repeat.value;
    const repeatUntil = repeat && W.isDate(f.repeatUntil.value) ? f.repeatUntil.value : '';
    if (repeatUntil && repeatUntil < startDate) throw new Error('The repeat "until" date is before the first one.');
    const job = f.jobId.value ? get('jobs', f.jobId.value) : null;
    const data = {
      type,
      title: f.title.value.trim().slice(0, 200) || placeholderTitle({ type, jobId: f.jobId.value, customerId: f.customerId.value }),
      allDay, start, end, tz: ev?.tz || tz(), repeat, repeatUntil,
      jobId: f.jobId.value, customerId: f.customerId.value || job?.customerId || '',
      location: f.location.value.trim().slice(0, 300),
      assignees: chosenPeople(form).slice(0, 20),
      reminders: W.cleanReminders([...form.querySelectorAll('[name=reminders]:checked')].map((i) => Number(i.value))),
      notes: f.notes.value.slice(0, 4000),
    };
    if (!isNew) {
      if (f.done && !f.done.disabled) {
        if (f.done.checked !== !!ev.done) { data.done = f.done.checked; data.doneAt = f.done.checked ? serverTimestamp() : null; }
      }
      data.canceled = f.canceled.checked;
    }
    return data;
  }

  function mount(root) {
    el = root.querySelector('[data-event]');
    offLinks = watchLinks((l) => { links = l; renderSync(); });
    const start = () => {
      loadMembers().then(() => {
        const box = el?.querySelector('[data-who-pick]');
        if (!box || box.querySelector('[type=checkbox]')) return;
        box.innerHTML = whoPickHtml([...box.querySelectorAll('[name=assignees]')].map((i) => i.value));
        renderSync();
      });
      render();
    };
    if (isNew || ev) start();
    else {
      // Older than what the app keeps loaded: fetch it.
      getDoc(doc(db, 'companies', state.companyId, 'events', id)).then((snap) => {
        if (!el) return;
        if (!snap.exists()) { el.innerHTML = '<p>This event was deleted. <a href="#/schedule">Back to the schedule</a>.</p>'; return; }
        ev = { id: snap.id, ...snap.data() };
        start();
      }).catch((e) => { console.error(e); if (el) el.innerHTML = `<p>Couldn't load this event: ${esc(e.message)}</p>`; });
    }

    el.addEventListener('input', (e) => { if (e.target.name) touched.add(e.target.name); });
    el.addEventListener('change', (e) => {
      const form = el.querySelector('[data-form]');
      if (!form) return;
      const f = form.elements;
      const name = e.target.name;
      if (name) touched.add(name);
      if (name === 'type' || name === 'allDay') {
        const type = f.type.value;
        const task = type === 'task';
        const t = W.typeOf(type);
        if (name === 'type' && !ev && !touched.has('allDay')) f.allDay.checked = !!t.allDay;
        const allDay = f.allDay.checked;
        form.querySelectorAll('[data-timed]').forEach((x) => { x.hidden = allDay; });
        form.querySelector('[data-end]').hidden = allDay || task;
        form.querySelector('[data-endday]').hidden = task && !allDay;
        // New ones get the kind's usual length and reminders until someone changes them.
        if (!ev && name === 'type' && !touched.has('endTime') && /^\d{2}:\d{2}$/.test(f.startTime.value)) {
          const endAt = W.addMinutes(`${f.startDate.value || today()}T${f.startTime.value}`, t.minutes || 60);
          f.endTime.value = W.timePart(endAt);
          if (!touched.has('endDate')) f.endDate.value = W.datePart(endAt);
        }
        if (task && !allDay && !touched.has('startTime') && !ev) f.startTime.value = '09:00';
        const chosen = (!ev && !touched.has('reminders')) || name === 'allDay'
          ? (allDay ? (t.reminders.length ? [900] : []) : t.reminders)
          : [...form.querySelectorAll('[name=reminders]:checked')].map((i) => Number(i.value));
        renderReminders(allDay, chosen);
        form.querySelector('legend').textContent = task ? 'Due' : 'When';
      }
      if (name === 'startDate' && !touched.has('endDate') && W.isDate(f.startDate.value)) f.endDate.value = f.startDate.value;
      if (name === 'startDate' && W.isDate(f.endDate.value) && f.endDate.value < f.startDate.value) f.endDate.value = f.startDate.value;
      if (name === 'startTime' && !touched.has('endTime') && /^\d{2}:\d{2}$/.test(f.startTime.value)) {
        const prev = ev ? W.minutesBetween(ev.start, ev.end) : (W.typeOf(f.type.value).minutes || 60);
        const endAt = W.addMinutes(`${f.startDate.value || today()}T${f.startTime.value}`, prev > 0 ? prev : 60);
        f.endTime.value = W.timePart(endAt);
        if (W.datePart(endAt) > f.startDate.value) f.endDate.value = W.datePart(endAt);
      }
      if (name === 'repeat') form.querySelector('[data-until]').hidden = !f.repeat.value;
      if (name === 'jobId') {
        const job = get('jobs', f.jobId.value);
        if (job?.customerId && (!f.customerId.value || !touched.has('customerId'))) f.customerId.value = job.customerId;
        if (job?.siteAddress && (!f.location.value || !touched.has('location'))) f.location.value = job.siteAddress;
        f.title.placeholder = placeholderTitle({ type: f.type.value, jobId: f.jobId.value, customerId: f.customerId.value });
      }
      if (name === 'customerId' || name === 'type') f.title.placeholder = placeholderTitle({ type: f.type.value, jobId: f.jobId.value, customerId: f.customerId.value });
      if (name === 'assignees' || name === 'canceled') renderSync();
    });

    el.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      let data;
      try { data = read(form); } catch (err) { toast(err.message, true); return; }
      if (isNew && !canAdd(data.type)) { toast('Your role can add tasks and meetings.', true); return; }
      const btn = form.querySelector('button.primary');
      if (btn) btn.disabled = true;
      if (isNew) {
        const fill = fillFromParams();
        const r = await attempt(() => add('events', { ...data, done: false, canceled: false, ...(fill.ref ? { ref: fill.ref } : {}), createdByName: myName() }));
        if (r) { toast(data.type === 'task' ? 'Task added' : 'Added to the schedule'); location.hash = `#/schedule/${r.id}`; } else if (btn) btn.disabled = false;
        return;
      }
      const ok = await attempt(() => update('events', id, { ...data, updatedBy: me() }));
      if (btn) btn.disabled = false;
      if (ok !== null) {
        ev = { ...ev, ...data, doneAt: ev.doneAt };
        touched = new Set();
        toast('Saved');
        render();
      }
    });

    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-delete')) {
        if (!confirm(`Delete "${ev.title}"? It comes off everyone's Google Calendar too. This can't be undone.`)) return;
        if (await attempt(() => remove('events', id)) !== null) { toast('Deleted'); location.hash = '#/schedule'; }
      } else if (b.hasAttribute('data-tick')) {
        b.disabled = true;
        const msg = await attempt(() => tick(ev));
        if (msg) {
          toast(msg);
          const snap = await getDoc(doc(db, 'companies', state.companyId, 'events', id)).catch(() => null);
          if (snap?.exists()) ev = { id, ...snap.data() };
          touched = new Set();
          render();
        } else b.disabled = false;
      }
    });
  }

  function unmount() {
    offLinks?.(); offLinks = null;
    el = null;
  }

  return { html, mount, unmount };
}
