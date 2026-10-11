// The calendarSync trigger and full syncs (sync.js) against the Firestore emulator and the fake Google server.
// Runs under `npm test`; skipped when no Firestore emulator is running.
import assert from 'node:assert/strict';
import { FieldValue } from 'firebase-admin/firestore';
import { addDays, buildGoogleEvent, googleEventId } from '../mapping.js';
import { MESSAGES } from '../messages.js';
import { handleEventWrite } from '../sync.js';
import { APP, NOW, TEAM, appEvent, startTestbed, business } from './helpers.js';

const at = (day, from = '08:00', to = '09:00') => ({ start: `${day}T${from}`, end: `${day}T${to}` });
const dentist = (date = '2026-10-13') => ({
  id: 'dentist01', summary: 'Dentist', start: { dateTime: `${date}T09:00:00`, timeZone: 'America/New_York' }, end: { dateTime: `${date}T10:00:00`, timeZone: 'America/New_York' },
});

describe('Calendar sync (with the Firestore emulator)', function () {
  this.timeout(30000);
  let bed;
  let fake;
  let co;
  const calendarOf = async (linkId) => (await co.link(linkId)).calendarId;
  // Calls that changed something in Google since call number `from`, as 'METHOD last-path-part'.
  const writesSince = (from) => fake.state.calls.slice(from).filter((c) => c.method !== 'GET' && c.path.startsWith('/calendar/'))
    .map((c) => `${c.method} ${decodeURIComponent(c.path.split('/').pop())}`);

  before(async function () {
    if (!process.env.FIRESTORE_EMULATOR_HOST) this.skip();
    bed = await startTestbed();
    fake = bed.fake;
  });
  after(async () => { if (bed) await bed.close(); });
  beforeEach(async () => {
    await bed.reset();
    co = business(bed);
    await co.seed();
  });

  it('copies new and changed events to the business calendar and to the people on them', async () => {
    await co.connect('jason', 'business');
    await co.connect('maria', 'personal');
    const biz = await calendarOf('business');
    const maria = await calendarOf('maria');

    assert.deepEqual(await co.write('e1', { assignees: ['maria'] }), { business: 'written', maria: 'written' });
    assert.equal(co.inGoogle(biz, 'e1').summary, 'Install storefront (Maria)');
    assert.deepEqual(co.inGoogle(biz, 'e1').reminders.overrides, []);
    assert.equal(co.inGoogle(maria, 'e1').summary, 'Install storefront');
    assert.deepEqual(co.inGoogle(maria, 'e1').reminders.overrides, [{ method: 'popup', minutes: 60 }]);
    assert.equal(fake.calls({ method: 'POST', path: '/events' }).length, 2, 'made with POST once PUT found nothing');

    assert.deepEqual(await co.edit('e1', { title: 'Install doors', start: '2026-10-14T09:00' }), { business: 'written', maria: 'written' });
    assert.equal(co.inGoogle(biz, 'e1').summary, 'Install doors (Maria)');
    assert.deepEqual(co.inGoogle(maria, 'e1').start, { dateTime: '2026-10-14T09:00:00', timeZone: 'America/New_York' });

    assert.deepEqual(await co.write('e2', { assignees: ['wes'] }), { business: 'written', maria: 'nothing to do' }, 'not Maria\'s');
    assert.equal(co.inGoogle(maria, 'e2'), undefined);
    const link = await co.link('maria');
    assert.equal(link.status, 'on');
    assert.equal(link.error, '');
  });

  it('takes events off when they\'re canceled, unassigned or deleted, and puts them back when uncanceled', async () => {
    await co.connect('jason', 'business');
    await co.connect('maria', 'personal');
    const biz = await calendarOf('business');
    const maria = await calendarOf('maria');

    await co.write('e1', { assignees: ['maria'] });
    assert.deepEqual(await co.edit('e1', { canceled: true }), { business: 'removed', maria: 'removed' });
    assert.equal(co.inGoogle(biz, 'e1'), undefined);
    assert.equal(co.inGoogle(maria, 'e1'), undefined);
    assert.equal(fake.event(biz, googleEventId('e1')).status, 'cancelled');
    assert.deepEqual(await co.edit('e1', { canceled: false }), { business: 'written', maria: 'written' });
    assert.equal(co.inGoogle(biz, 'e1').status, 'confirmed');
    assert.ok(co.inGoogle(maria, 'e1'));

    await co.write('e2', { assignees: ['maria'] });
    assert.deepEqual(await co.edit('e2', { assignees: [] }), { business: 'written', maria: 'removed' });
    assert.equal(co.inGoogle(maria, 'e2'), undefined);
    assert.equal(co.inGoogle(biz, 'e2').summary, 'Install storefront');

    assert.deepEqual(await co.remove('e2'), { business: 'removed', maria: 'nothing to do' });
    assert.equal(co.inGoogle(biz, 'e2'), undefined);
    // The same deletion again (triggers can repeat): already gone counts as done.
    assert.deepEqual(await co.trigger('e2', appEvent()), { business: 'removed', maria: 'nothing to do' });
  });

  it('brings back an event deleted earlier even when Google\'s update can\'t find it (the 409 path)', async () => {
    await co.connect('jason', 'business');
    const biz = await calendarOf('business');
    await co.write('e1', {});
    await co.edit('e1', { canceled: true });
    fake.fail({ method: 'PUT', path: googleEventId('e1'), status: 404, reason: 'notFound' });
    const from = fake.state.calls.length;
    assert.deepEqual(await co.edit('e1', { canceled: false }), { business: 'written' });
    assert.deepEqual(fake.state.calls.slice(from).filter((c) => c.path.includes('/events')).map((c) => `${c.method} ${c.status}`), ['PUT 404', 'POST 409', 'PUT 200']);
    assert.equal(co.inGoogle(biz, 'e1').status, 'confirmed');
  });

  it('pauses the business calendar when ownership moves; the new owner\'s connect moves the schedule and cleans up', async () => {
    await co.connect('jason', 'business');
    const old = await calendarOf('business');
    await co.write('e1', {});
    await co.write('e2', at('2026-10-15'));
    fake.addEvent(old, dentist()); // Jason put an event of his own in the app's calendar

    await co.handOver('wes');
    assert.deepEqual(await co.write('e3', at('2026-10-16')), { business: 'paused' });
    assert.equal(co.inGoogle(old, 'e3'), undefined, 'nothing more goes on Jason\'s calendar');
    const paused = await co.link('business');
    assert.equal(paused.status, 'paused');
    assert.equal(paused.error, 'Paused: the business has a new owner. They connect their own Google Calendar to take over.');
    const writes = fake.state.calls.length;
    await co.write('e4', at('2026-10-17'));
    assert.deepEqual(writesSince(writes), [], 'still paused');

    assert.equal((await co.connect('wes', 'business')).count, 4);
    const link = await co.link('business');
    assert.deepEqual([link.uid, link.holderName, link.email, link.status, link.error], ['wes', 'Wes Carter', 'wes@example.com', 'on', '']);
    assert.equal(fake.calendar(link.calendarId).owner, 'wes@example.com');
    assert.deepEqual(co.appEventsIn(link.calendarId), ['e1', 'e2', 'e3', 'e4']);
    // Jason's calendar: the app's events are gone, his own stays, so the calendar stays too.
    assert.deepEqual(co.appEventsIn(old), []);
    assert.ok(fake.event(old, 'dentist01'));
    assert.equal(fake.event(old, 'dentist01').status, 'confirmed');
    assert.equal(fake.calendar(old).deleted, false);
    assert.deepEqual(fake.state.revoked.map((x) => x.email), ['jason@example.com'], 'Jason\'s access is handed back');
  });

  it('deletes the previous owner\'s calendar once it\'s empty, and keeps the access their own schedule uses', async () => {
    await co.connect('jason', 'business');
    await co.connect('jason', 'personal');
    const old = await calendarOf('business');
    await co.write('e1', { assignees: ['jason'] });
    await co.handOver('wes');
    await co.connect('wes', 'business');
    assert.equal(fake.calendar(old).deleted, true);
    assert.deepEqual(fake.state.revoked, [], 'Jason\'s own schedule uses the same Google account');
    assert.deepEqual(await co.edit('e1', { title: 'Install doors' }), { business: 'written', jason: 'written' });
    assert.equal(co.inGoogle(await calendarOf('jason'), 'e1').summary, 'Install doors');
  });

  it('notes on the link when Google access was removed, without trying again', async () => {
    await co.connect('jason', 'business');
    fake.revokeAccount('jason@example.com');
    const out = await co.write('e1', {});
    assert.match(out.business, /^error/);
    const link = await co.link('business');
    assert.equal(link.status, 'error');
    assert.equal(link.error, 'Google Calendar access was removed. Connect again.');
    // Connecting again catches up, on the same calendar.
    assert.equal((await co.connect('jason', 'business')).count, 1);
    const again = await co.link('business');
    assert.deepEqual([again.status, again.error, again.calendarId], ['on', '', link.calendarId]);
    assert.ok(co.inGoogle(link.calendarId, 'e1'));
  });

  it('tries again later when Google is down, after the other calendars are done', async () => {
    await co.connect('jason', 'business');
    await co.connect('maria', 'personal');
    const biz = await calendarOf('business');
    const maria = await calendarOf('maria');
    fake.fail({ path: encodeURIComponent(maria), status: 500, times: 4 });
    await assert.rejects(co.write('e1', { assignees: ['maria'] }), (e) => e.kind === 'transient' && e.status === 500);
    assert.ok(co.inGoogle(biz, 'e1'));
    assert.equal(co.inGoogle(maria, 'e1'), undefined);
    assert.equal((await co.link('maria')).status, 'on', 'not an error: it will be tried again');
    assert.deepEqual(bed.waits, [500, 1000, 2000]);
    // The retry of the same change goes through.
    assert.deepEqual(await co.trigger('e1', null), { business: 'written', maria: 'written' });
    assert.ok(co.inGoogle(maria, 'e1'));
    // A single failure is retried right away.
    bed.waits = [];
    fake.fail({ method: 'PUT', status: 503 });
    assert.deepEqual(await co.edit('e1', { title: 'Install doors' }), { business: 'written', maria: 'written' });
    assert.deepEqual(bed.waits, [500]);
  });

  it('notes an event Google turned down on the link, without trying again', async () => {
    await co.connect('jason', 'business');
    fake.fail({ method: 'PUT', status: 400, reason: 'invalid', message: 'Bad Request' });
    const out = await co.write('e1', {});
    assert.match(out.business, /^error/);
    assert.equal((await co.link('business')).error, MESSAGES.refused);
    await co.write('e2', at('2026-10-15'));
    assert.deepEqual([(await co.link('business')).status, (await co.link('business')).error], ['on', ''], 'the next one that works clears it');
  });

  it('disconnects people who left the team', async () => {
    await co.connect('jason', 'business');
    await co.connect('maria', 'personal');
    const maria = await calendarOf('maria');
    await co.write('e1', { assignees: ['maria'] });
    await bed.db.doc(`companies/${co.companyId}/members/maria`).delete();
    const out = await co.write('e2', {});
    assert.equal(out.business, 'written');
    assert.match(out.maria, /^disconnected \(not on the team\), 1 removed/);
    assert.equal(await co.link('maria'), undefined);
    assert.equal(await co.token('maria'), undefined);
    assert.equal(fake.calendar(maria).deleted, true);
    assert.deepEqual(fake.state.revoked.map((x) => x.email), ['maria@example.com']);
  });

  it('full syncs write only what changed, delete stale events in the window, and leave older ones alone', async () => {
    await co.put('soon', {});
    await co.put('later', at('2026-10-20'));
    await co.put('recent', at('2026-09-20'));
    await co.put('old', at('2026-08-15'));
    await co.put('edge', { allDay: true, start: '2026-09-10', end: '2026-09-10' }); // ended the day before the window
    await co.connect('jason', 'business');
    const cal = await calendarOf('business');
    assert.deepEqual(co.appEventsIn(cal), ['later', 'recent', 'soon']);

    // Also in the calendar now: a copy of 'edge' from an earlier sync, two of the app's events whose app events are
    // gone (one in the window, one long before it), and an event of Jason's own.
    fake.addEvent(cal, buildGoogleEvent({
      eventId: 'edge', event: appEvent({ allDay: true, start: '2026-09-10', end: '2026-09-10' }), link: { kind: 'business', uid: 'jason' },
      company: { name: 'Stellar Glass LLC', timeZone: 'America/New_York' }, members: new Map(Object.entries(TEAM)), appUrl: APP,
    }));
    const ghost = (eventId, date) => ({
      id: googleEventId(eventId), summary: 'Gone', start: { date }, end: { date: addDays(date, 1) },
      extendedProperties: { private: { stellar: '1', stellarEvent: eventId, stellarV: 'old' } },
    });
    fake.addEvent(cal, ghost('ghost', '2026-10-01'));
    fake.addEvent(cal, ghost('ancient', '2026-06-01'));
    fake.addEvent(cal, dentist('2026-10-02'));

    await bed.db.doc(`companies/${co.companyId}/events/later`).update({ title: 'Changed while sync was off' });
    const from = fake.state.calls.length;
    assert.deepEqual(await co.call('jason', { action: 'resync', kind: 'business' }), { ok: true, count: 3 });
    assert.deepEqual(writesSince(from).sort(), [`DELETE ${googleEventId('ghost')}`, `PUT ${googleEventId('later')}`].sort());
    assert.equal(co.inGoogle(cal, 'later').summary, 'Changed while sync was off');
    assert.equal(co.inGoogle(cal, 'ghost'), undefined);
    assert.ok(co.inGoogle(cal, 'ancient'), 'older than the window: left alone');
    assert.ok(co.inGoogle(cal, 'edge'), 'still wanted in the app: left alone');
    assert.ok(fake.event(cal, 'dentist01'));
    const list = fake.calls({ method: 'GET', path: '/events' }).at(-1).query;
    assert.deepEqual([list.privateExtendedProperty, list.timeMin, list.showDeleted, list.maxResults], ['stellar=1', '2026-09-10T00:00:00Z', 'false', '2500']);

    // Nothing changed: nothing written.
    const again = fake.state.calls.length;
    await co.call('jason', { action: 'resync', kind: 'business' });
    assert.deepEqual(writesSince(again), []);
  });

  it('lists every page of a calendar', async () => {
    for (let i = 0; i < 7; i += 1) await co.put(`e${i}`, at(`2026-10-${12 + i}`));
    fake.state.pageSize = 3;
    await co.connect('jason', 'business');
    const cal = await calendarOf('business');
    const from = fake.state.calls.length;
    await co.call('jason', { action: 'resync', kind: 'business' });
    assert.deepEqual(writesSince(from), [], 'all seven found across three pages');
    assert.equal(fake.calls({ method: 'GET', path: '/events' }).slice(-3).map((c) => c.query.pageToken || '').join(','), ',3,6');
    assert.equal((await co.call('jason', { action: 'disconnect', kind: 'business' })).removed, 7);
    assert.equal(fake.calendar(cal).deleted, true);
  });

  it('makes a new calendar when the app\'s was deleted in Google, and asks for another when the owner\'s own was', async () => {
    await co.connect('jason', 'business');
    const first = await calendarOf('business');
    await co.write('e1', {});
    fake.deleteCalendar(first);
    const out = await co.write('e2', at('2026-10-15'));
    assert.equal(out.business, 'calendar deleted in Google, full sync: 2');
    const link = await co.link('business');
    assert.notEqual(link.calendarId, first);
    assert.deepEqual([link.status, link.calendarName, link.appCalendar, link.count], ['on', 'Stellar Glass', true, 2]);
    assert.deepEqual(co.appEventsIn(link.calendarId), ['e1', 'e2']);
    const token = await co.token('business');
    assert.equal(token.calendarId, link.calendarId);
    assert.equal(token.needsFullSync, undefined);

    const work = fake.addCalendar({ owner: 'jason@example.com', summary: 'Work' });
    await co.connect('jason', 'business', 'emulator:jason@example.com:pick');
    await co.call('jason', { action: 'choose', kind: 'business', calendarId: work.id });
    fake.deleteCalendar(work.id);
    const calendars = fake.calendarsOf('jason@example.com').length;
    assert.match((await co.edit('e1', { title: 'Install doors' })).business, /^error/);
    const after = await co.link('business');
    assert.equal(after.status, 'error');
    assert.equal(after.error, 'The chosen calendar was deleted in Google. Choose another.');
    assert.equal(fake.calendarsOf('jason@example.com').length, calendars, 'no calendar made');
  });

  it('skips changes more than an hour old, and businesses without a calendar', async () => {
    await co.put('e1', {});
    assert.deepEqual(await co.trigger('e1', null), { skipped: 'no Google Calendar connected' });
    await co.connect('jason', 'business');
    const late = await handleEventWrite({
      ...bed.deps(), companyId: co.companyId, eventId: 'e1', before: null, eventTime: new Date(NOW.getTime() - 2 * 3600e3).toISOString(),
    });
    assert.deepEqual(late, { skipped: 'more than an hour old' });
  });

  it('goes again when the event changes while it works', async () => {
    await co.connect('jason', 'business');
    const cal = await calendarOf('business');
    await co.write('e1', {});
    // A newer version is saved just as Google is being updated (and its own trigger run could finish first).
    let saved = false;
    bed.fetch = async (url, init) => {
      if (!saved && init?.method === 'PUT' && String(url).includes(googleEventId('e1'))) {
        saved = true;
        await bed.db.doc(`companies/${co.companyId}/events/e1`).update({ title: 'Newest title', updatedAt: FieldValue.serverTimestamp() });
      }
      return globalThis.fetch(url, init);
    };
    const from = fake.state.calls.length;
    await co.edit('e1', { title: 'Older title' });
    assert.equal(co.inGoogle(cal, 'e1').summary, 'Newest title');
    assert.deepEqual(writesSince(from), [`PUT ${googleEventId('e1')}`, `PUT ${googleEventId('e1')}`]);
  });
});
