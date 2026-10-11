// The calendarAccount callable (account.js) against the Firestore emulator and the fake Google server.
// Runs under `npm test`; skipped when no Firestore emulator is running.
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase-admin/firestore';
import { BASIC_SCOPE, PICK_SCOPE } from '../google.js';
import { googleEventId } from '../mapping.js';
import { MESSAGES } from '../messages.js';
import { BASIC_SCOPES, PICK_SCOPES, CLIENT_ID } from './fake-google.js';
import { APP, NOW, startTestbed, business, httpsError } from './helpers.js';

const at = (day, from = '08:00', to = '09:00') => ({ start: `${day}T${from}`, end: `${day}T${to}` });

describe('Calendar account (with the Firestore emulator)', function () {
  this.timeout(30000);
  let bed;
  let fake;
  let co;

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

  it('gives the browser the client id and the scopes to ask for', async () => {
    assert.deepEqual(await co.call('maria', { action: 'status' }), { clientId: CLIENT_ID, basicScope: BASIC_SCOPE, pickScope: `${BASIC_SCOPE} ${PICK_SCOPE}` });
  });

  it('lets only the team in, and only the owner connect the business calendar', async () => {
    await assert.rejects(co.call(null, { action: 'status' }), httpsError('permission-denied', MESSAGES.signIn));
    await assert.rejects(co.call('stranger', { action: 'status' }), httpsError('permission-denied', MESSAGES.notMember));
    await assert.rejects(co.call('jason', { action: 'status', companyId: 'caltest-a/members' }), httpsError('invalid-argument', MESSAGES.noCompany));
    await assert.rejects(co.call('jason', { action: 'explode' }), httpsError('invalid-argument', MESSAGES.unknownAction));
    await assert.rejects(co.connect('jason', 'team'), httpsError('invalid-argument', MESSAGES.badKind));
    for (const uid of ['maria', 'wes', 'pat']) {
      await assert.rejects(co.connect(uid, 'business'), httpsError('permission-denied', MESSAGES.ownerOnlyConnect));
    }
    await assert.rejects(co.call('maria', { action: 'calendars', kind: 'business' }), httpsError('permission-denied', MESSAGES.ownerOnly));
    await assert.rejects(co.call('maria', { action: 'choose', kind: 'business', calendarId: 'new' }), httpsError('permission-denied', MESSAGES.ownerOnly));
    await assert.rejects(co.call('maria', { action: 'resync', kind: 'business' }), httpsError('permission-denied', MESSAGES.ownerOnly));
    await assert.rejects(co.call('jason', { action: 'calendars', kind: 'personal' }), httpsError('invalid-argument', MESSAGES.businessOnly));
    assert.equal(fake.state.calls.length, 0, 'none of that reached Google');

    // The accountant connects their own schedule.
    assert.equal((await co.connect('pat', 'personal')).ok, true);
    assert.equal((await co.link('pat')).kind, 'personal');
    await assert.rejects(co.call('maria', { action: 'disconnect', kind: 'personal', uid: 'pat' }), httpsError('permission-denied', MESSAGES.othersCalendar));
    await assert.rejects(co.call('jason', { action: 'disconnect', kind: 'personal', uid: 'business' }), httpsError('invalid-argument'));
    assert.ok(await co.token('pat'), 'still connected');
  });

  it('connects the business calendar: makes the app\'s calendar and copies the events it should have', async () => {
    await co.put('upcoming', { assignees: ['maria'] });
    await co.put('allday', { type: 'delivery', title: 'Glass delivery', allDay: true, start: '2026-10-20', end: '2026-10-21' });
    await co.put('recent', { type: 'measure', title: 'Measure', ...at('2026-09-20') });
    await co.put('old', { type: 'meeting', title: 'Old meeting', ...at('2026-08-01') });
    await co.put('canceled', { canceled: true });
    await co.put('weekly', { type: 'meeting', title: 'Crew meeting', ...at('2026-01-05', '07:00', '07:30'), repeat: 'weekly' });
    await co.put('ended', { type: 'meeting', title: 'Summer meeting', ...at('2026-06-01'), repeat: 'weekly', repeatUntil: '2026-08-31' });
    await co.put('task', { type: 'task', title: 'Order glass', ...at('2026-10-12', '09:00', '09:15'), assignees: ['jason'], reminders: [0] });

    const r = await co.connect('jason', 'business');
    assert.deepEqual(r, { ok: true, email: 'jason@example.com', calendarName: 'Stellar Glass', count: 5, canPick: false });

    const link = await co.link('business');
    const cal = fake.calendar(link.calendarId);
    assert.equal(cal.owner, 'jason@example.com');
    assert.equal(cal.appCreated, true);
    assert.equal(cal.summary, 'Stellar Glass');
    assert.equal(cal.timeZone, 'America/New_York');
    assert.equal(cal.description, `Kept up to date by the Stellar Glass app. Make changes in the app: changes made here are replaced. ${APP}/#/schedule`);
    assert.deepEqual(co.appEventsIn(cal.id), ['allday', 'recent', 'task', 'upcoming', 'weekly'], 'not old, canceled or finished ones');

    const install = co.inGoogle(cal.id, 'upcoming');
    assert.equal(install.summary, 'Install storefront (Maria)');
    assert.deepEqual(install.reminders, { useDefault: false, overrides: [] }, 'Maria\'s event doesn\'t remind the owner');
    assert.match(install.description, /^Customer: Pat Customer \(Lake Dental\) · \(863\) 555-0100 · pat@example\.com$/m);
    assert.match(install.description, /^Job: Lake Dental storefront$/m);
    assert.match(install.description, /^Who: Maria Lopez$/m);
    assert.deepEqual(co.inGoogle(cal.id, 'task').reminders.overrides, [{ method: 'popup', minutes: 0 }]);
    assert.deepEqual(co.inGoogle(cal.id, 'allday').end, { date: '2026-10-22' });
    assert.deepEqual(co.inGoogle(cal.id, 'weekly').recurrence, ['RRULE:FREQ=WEEKLY']);

    assert.deepEqual(Object.keys(link).sort(), ['appCalendar', 'calendarId', 'calendarName', 'canPick', 'connectedAt', 'count', 'email', 'error', 'holderName',
      'kind', 'status', 'syncedAt', 'uid']);
    assert.deepEqual({ ...link, connectedAt: null, syncedAt: null }, {
      kind: 'business', uid: 'jason', holderName: 'Jason Reed', email: 'jason@example.com', calendarId: cal.id, calendarName: 'Stellar Glass',
      appCalendar: true, canPick: false, status: 'on', error: '', connectedAt: null, syncedAt: null, count: 5,
    });
    assert.ok(link.connectedAt instanceof Timestamp);
    assert.equal(link.syncedAt.toMillis(), NOW.getTime());

    const token = await co.token('business');
    assert.deepEqual(Object.keys(token).sort(), [
      'appCalendar', 'calendarId', 'calendarName', 'connectedAt', 'email', 'emailKey', 'kind', 'refreshToken', 'scopes', 'uid',
    ]);
    assert.equal(token.emailKey, 'jason@example.com');
    assert.equal(token.refreshToken, fake.grantsOf('jason@example.com')[0].token);
    assert.equal(token.scopes, BASIC_SCOPES);
    assert.equal(token.calendarId, cal.id);
  });

  it('connects a person\'s own calendar with just the events they\'re on, reminders included', async () => {
    await co.put('mine', { assignees: ['maria'] });
    await co.put('shared', { assignees: ['wes', 'maria'], title: 'Big install' });
    await co.put('notMine', { assignees: ['wes'] });
    await co.put('nobody', {});
    await co.put('canceled', { assignees: ['maria'], canceled: true });
    const r = await co.connect('maria', 'personal');
    assert.deepEqual(r, { ok: true, email: 'maria@example.com', calendarName: 'Stellar Glass – my schedule', count: 2, canPick: false });
    const link = await co.link('maria');
    assert.equal(link.kind, 'personal');
    assert.equal(link.uid, 'maria');
    assert.equal(link.holderName, 'Maria Lopez');
    const cal = fake.calendar(link.calendarId);
    assert.equal(cal.owner, 'maria@example.com');
    assert.equal(cal.summary, 'Stellar Glass – my schedule');
    assert.deepEqual(co.appEventsIn(cal.id), ['mine', 'shared']);
    assert.equal(co.inGoogle(cal.id, 'shared').summary, 'Big install', 'no names on your own calendar');
    assert.deepEqual(co.inGoogle(cal.id, 'mine').reminders.overrides, [{ method: 'popup', minutes: 60 }]);
    assert.equal(await co.link('business'), undefined);
  });

  it('needs calendar access, and lasting access, from Google', async () => {
    fake.addCode({ code: 'no-calendar', email: 'jason@example.com', scope: 'openid email' });
    await assert.rejects(co.connect('jason', 'business', 'no-calendar'), httpsError('invalid-argument', MESSAGES.calendarNotAllowed));
    await assert.rejects(co.connect('jason', 'business', 'not-a-real-code'), httpsError('invalid-argument', MESSAGES.codeRejected));
    await assert.rejects(co.connect('jason', 'business', '  '), httpsError('invalid-argument', MESSAGES.noCode));
    // No refresh token, and none stored for this Google account: the access goes back, so Google asks again next time.
    fake.addCode({ code: 'short', email: 'jason@example.com', refreshToken: false });
    await assert.rejects(co.connect('jason', 'business', 'short'), httpsError('failed-precondition', MESSAGES.noLastingAccess));
    assert.deepEqual(fake.state.revoked.map((x) => x.email), ['jason@example.com']);
    assert.equal(await co.token('business'), undefined);
    assert.equal(await co.link('business'), undefined);
    assert.deepEqual(fake.calendarsOf('jason@example.com').map((c) => c.id), ['jason@example.com'], 'no calendar made');
  });

  it('reuses the lasting access of another link with the same Google account', async () => {
    await co.connect('jason', 'business');
    const shared = (await co.token('business')).refreshToken;
    // Google sends no refresh token the second time Jason agrees.
    fake.addCode({ code: 'second', email: 'jason@example.com', refreshToken: false });
    const r = await co.connect('jason', 'personal', 'second');
    assert.equal(r.ok, true);
    assert.equal(r.calendarName, 'Stellar Glass – my schedule');
    assert.equal((await co.token('jason')).refreshToken, shared);
    assert.deepEqual(fake.state.revoked, [], 'nothing revoked');
    assert.ok(fake.grantsOf('jason@example.com').every((g) => !g.revoked));

    // Both keep syncing.
    assert.deepEqual(await co.write('e1', { assignees: ['jason'] }), { business: 'written', jason: 'written' });
    assert.ok(co.inGoogle((await co.link('business')).calendarId, 'e1'));
    assert.ok(co.inGoogle((await co.link('jason')).calendarId, 'e1'));
    assert.equal((await co.link('business')).status, 'on');
    assert.equal((await co.link('jason')).status, 'on');

    // Connecting a link again without a refresh token keeps its own, and its calendar.
    const calendarId = (await co.link('business')).calendarId;
    fake.addCode({ code: 'third', email: 'jason@example.com', refreshToken: false });
    await co.connect('jason', 'business', 'third');
    assert.equal((await co.token('business')).refreshToken, shared);
    assert.equal((await co.link('business')).calendarId, calendarId);
    assert.deepEqual(fake.state.revoked, []);
  });

  it('shares one Google account\'s lasting access between businesses, and gives it back only when the last one lets go', async () => {
    const other = business(bed, 'caltest-b');
    await other.seed({ name: 'Reed Glass Repair' });
    await co.connect('jason', 'business');
    const shared = (await co.token('business')).refreshToken;

    // Google sends no refresh token the second time Jason agrees, even for another business.
    fake.addCode({ code: 'second', email: 'jason@example.com', refreshToken: false });
    assert.equal((await other.connect('jason', 'business', 'second')).ok, true);
    assert.equal((await other.token('business')).refreshToken, shared);
    assert.deepEqual(fake.state.revoked, [], 'nothing revoked');

    // Letting go in one keeps the access the other still uses.
    assert.equal((await other.call('jason', { action: 'disconnect', kind: 'business' })).ok, true);
    assert.deepEqual(fake.state.revoked, []);
    assert.deepEqual(await co.write('e1', {}), { business: 'written' });
    assert.equal((await co.link('business')).status, 'on');

    // The last one gives it back.
    assert.equal((await co.call('jason', { action: 'disconnect', kind: 'business' })).ok, true);
    assert.deepEqual(fake.state.revoked.map((x) => x.email), ['jason@example.com']);
  });

  it('keeps the scopes the stored access really has, and asks again when it lacks the extra permission', async () => {
    await co.handOver('wes');
    await co.connect('wes', 'personal');
    // Wes asks for the extra permission for the business calendar, but Google sends no refresh token this time, so
    // his own schedule's is reused, and that one covers only the basic scopes.
    fake.addCode({ code: 'wes-pick', email: 'wes@example.com', scope: PICK_SCOPES, refreshToken: false });
    const r = await co.connect('wes', 'business', 'wes-pick');
    assert.equal(r.canPick, false);
    assert.equal((await co.link('business')).canPick, false);
    assert.equal((await co.token('business')).scopes, BASIC_SCOPES);
    await assert.rejects(co.call('wes', { action: 'calendars', kind: 'business' }), httpsError('failed-precondition', 'needs-permission'));

    // Stored scopes that claim more than the access has are corrected the next time it's used.
    await bed.db.doc(`companies/${co.companyId}/calendarTokens/business`).update({ scopes: PICK_SCOPES });
    await bed.db.doc(`companies/${co.companyId}/calendarLinks/business`).update({ canPick: true });
    await assert.rejects(co.call('wes', { action: 'calendars', kind: 'business' }), httpsError('failed-precondition', 'needs-permission'));
    assert.equal((await co.token('business')).scopes, BASIC_SCOPES);
    assert.equal((await co.link('business')).canPick, false);

    // Signing in with the extra permission (and a refresh token this time) fixes it.
    assert.equal((await co.connect('wes', 'business', 'emulator:wes@example.com:pick')).canPick, true);
    const { calendars } = await co.call('wes', { action: 'calendars', kind: 'business' });
    assert.deepEqual(calendars.map((c) => c.name), ['wes@example.com', 'Stellar Glass'], 'not the calendar of his own schedule');
  });

  it('moves the business calendar to one of the owner\'s own calendars, and back to a new one', async () => {
    const work = fake.addCalendar({ owner: 'jason@example.com', summary: 'Work' });
    fake.addEvent(work.id, {
      id: 'dentist01', summary: 'Dentist',
      start: { dateTime: '2026-10-13T09:00:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-10-13T10:00:00', timeZone: 'America/New_York' },
    });
    const shared = fake.addCalendar({ owner: 'boss@example.com', summary: 'Shared with me', shared: { 'jason@example.com': 'writer' } });
    await co.put('e1', {});
    await co.put('e2', at('2026-10-15'));

    await co.connect('jason', 'business');
    const first = (await co.link('business')).calendarId;
    await assert.rejects(co.call('jason', { action: 'calendars', kind: 'business' }), httpsError('failed-precondition', 'needs-permission'));
    await assert.rejects(co.call('jason', { action: 'choose', kind: 'business', calendarId: work.id }), httpsError('failed-precondition', 'needs-permission'));

    // Signing in again with the extra permission keeps the calendar.
    assert.equal((await co.connect('jason', 'business', 'emulator:jason@example.com:pick')).canPick, true);
    assert.equal((await co.link('business')).calendarId, first);
    assert.equal((await co.link('business')).canPick, true);
    await co.connect('jason', 'personal');
    const ownSchedule = (await co.link('jason')).calendarId;

    const { calendars } = await co.call('jason', { action: 'calendars', kind: 'business' });
    assert.deepEqual(calendars, [
      { id: 'jason@example.com', name: 'jason@example.com', primary: true, current: false },
      { id: first, name: 'Stellar Glass', primary: false, current: true },
      { id: work.id, name: 'Work', primary: false, current: false },
    ], 'his own calendars only: not one shared with him, nor his own schedule\'s');
    assert.equal(fake.calls({ path: '/users/me/calendarList' })[0].query.minAccessRole, 'owner');

    assert.deepEqual(await co.call('jason', { action: 'choose', kind: 'business', calendarId: work.id }), { ok: true, calendarName: 'Work', count: 2 });
    assert.equal(fake.calendar(first).deleted, true, 'the app\'s calendar, empty now, is deleted');
    assert.deepEqual(co.appEventsIn(work.id), ['e1', 'e2']);
    assert.ok(fake.event(work.id, 'dentist01'), 'Jason\'s own event stays');
    const link = await co.link('business');
    assert.deepEqual([link.calendarId, link.calendarName, link.appCalendar, link.status, link.count], [work.id, 'Work', false, 'on', 2]);
    assert.equal((await co.token('business')).calendarId, work.id);
    await co.write('e3', at('2026-10-16'));
    assert.ok(co.inGoogle(work.id, 'e3'), 'new events go there');

    await assert.rejects(co.call('jason', { action: 'choose', kind: 'business', calendarId: shared.id }), httpsError('invalid-argument', MESSAGES.notYourCalendar));
    await assert.rejects(co.call('jason', { action: 'choose', kind: 'business', calendarId: ownSchedule }), httpsError('failed-precondition', MESSAGES.calendarInUse));
    await assert.rejects(co.call('jason', { action: 'choose', kind: 'business', calendarId: '' }), httpsError('invalid-argument', MESSAGES.pickCalendar));

    assert.deepEqual(await co.call('jason', { action: 'choose', kind: 'business', calendarId: 'new' }), { ok: true, calendarName: 'Stellar Glass', count: 3 });
    const fresh = (await co.link('business')).calendarId;
    assert.notEqual(fresh, first);
    assert.equal(fake.calendar(fresh).appCreated, true);
    assert.deepEqual(co.appEventsIn(fresh), ['e1', 'e2', 'e3']);
    assert.deepEqual(co.appEventsIn(work.id), [], 'the app\'s events came off Work');
    assert.equal(fake.calendar(work.id).deleted, false, 'a calendar the app didn\'t make is never deleted');
    assert.ok(fake.event(work.id, 'dentist01'));
    assert.equal((await co.link('business')).appCalendar, true);
    // Asking for a new one again changes nothing.
    await co.call('jason', { action: 'choose', kind: 'business', calendarId: 'new' });
    assert.equal((await co.link('business')).calendarId, fresh);
  });

  it('disconnects a person\'s own calendar but keeps the access the business calendar still uses', async () => {
    await co.connect('jason', 'business');
    await co.connect('jason', 'personal');
    await co.write('e1', { assignees: ['jason'] });
    const own = (await co.link('jason')).calendarId;
    const biz = (await co.link('business')).calendarId;

    assert.deepEqual(await co.call('jason', { action: 'disconnect', kind: 'personal' }), { ok: true, removed: 1 });
    assert.equal(fake.calendar(own).deleted, true);
    assert.equal(await co.token('jason'), undefined);
    assert.equal(await co.link('jason'), undefined);
    assert.deepEqual(fake.state.revoked, [], 'the business calendar uses the same Google account');
    assert.deepEqual(await co.edit('e1', { title: 'Install doors' }), { business: 'written' });
    assert.equal(co.inGoogle(biz, 'e1').summary, 'Install doors (Jason)');
    assert.equal((await co.link('business')).status, 'on');

    assert.deepEqual(await co.call('jason', { action: 'disconnect', kind: 'business' }), { ok: true, removed: 1 });
    assert.equal(fake.calendar(biz).deleted, true);
    assert.deepEqual(fake.state.revoked.map((x) => x.email), ['jason@example.com']);
    assert.ok(fake.grantsOf('jason@example.com').every((g) => g.revoked));
    assert.deepEqual(await co.call('jason', { action: 'disconnect', kind: 'business' }), { ok: true, removed: 0 }, 'again: nothing to do');
  });

  it('lets the owner and admins disconnect other people, and the previous owner the paused business calendar', async () => {
    await co.connect('maria', 'personal');
    await co.connect('pat', 'personal');
    await assert.rejects(co.call('pat', { action: 'disconnect', kind: 'personal', uid: 'maria' }), httpsError('permission-denied', MESSAGES.othersCalendar));
    assert.deepEqual(await co.call('wes', { action: 'disconnect', kind: 'personal', uid: 'maria' }), { ok: true, removed: 0 });
    assert.deepEqual(await co.call('jason', { action: 'disconnect', kind: 'personal', uid: 'pat' }), { ok: true, removed: 0 });
    assert.equal(await co.link('maria'), undefined);
    assert.equal(await co.link('pat'), undefined);

    await co.connect('jason', 'business');
    await co.handOver('wes');
    await assert.rejects(co.call('maria', { action: 'disconnect', kind: 'business' }), httpsError('permission-denied', MESSAGES.businessDisconnect));
    assert.equal((await co.call('jason', { action: 'disconnect', kind: 'business' })).ok, true, 'Jason connected it');
    assert.equal(await co.link('business'), undefined);
  });

  it('syncs now on request, and says when there\'s nothing connected', async () => {
    await assert.rejects(co.call('maria', { action: 'resync', kind: 'personal' }), httpsError('failed-precondition', MESSAGES.notConnected));
    await assert.rejects(co.call('jason', { action: 'resync', kind: 'business' }), httpsError('failed-precondition', MESSAGES.notConnected));
    await co.put('e1', {});
    await co.connect('jason', 'business');
    const cal = (await co.link('business')).calendarId;
    // Someone deleted it in Google: Sync now puts it back.
    fake.event(cal, googleEventId('e1')).status = 'cancelled';
    assert.deepEqual(await co.call('jason', { action: 'resync', kind: 'business' }), { ok: true, count: 1 });
    assert.equal(co.inGoogle(cal, 'e1').status, 'confirmed');

    await co.put('e2', { assignees: ['maria'] });
    await co.connect('maria', 'personal');
    assert.deepEqual(await co.call('maria', { action: 'resync', kind: 'personal' }), { ok: true, count: 1 });

    // After a hand-over, the new owner connects their own first.
    await co.handOver('wes');
    await assert.rejects(co.call('wes', { action: 'resync', kind: 'business' }), httpsError('failed-precondition', MESSAGES.pausedForOwner));
    await assert.rejects(co.call('wes', { action: 'calendars', kind: 'business' }), httpsError('failed-precondition', MESSAGES.pausedForOwner));
    await assert.rejects(co.call('jason', { action: 'resync', kind: 'business' }), httpsError('permission-denied', MESSAGES.ownerOnly));
  });

  it('finishes an interrupted first sync with the next change to the schedule', async () => {
    await co.put('e1', {});
    fake.fail({ method: 'GET', path: /\/events$/, status: 503, times: 4 });
    await assert.rejects(co.connect('jason', 'business'), httpsError('unavailable', MESSAGES.unavailable));
    const link = await co.link('business');
    assert.equal(link.status, 'error');
    assert.equal(link.error, MESSAGES.syncUnfinished);
    assert.equal((await co.token('business')).needsFullSync, true);

    const out = await co.write('e2', at('2026-10-15'));
    assert.equal(out.business, 'written, full sync: 2');
    assert.deepEqual(co.appEventsIn(link.calendarId), ['e1', 'e2']);
    const after = await co.link('business');
    assert.deepEqual([after.status, after.error, after.count], ['on', '', 2]);
    assert.equal((await co.token('business')).needsFullSync, undefined);
  });
});
