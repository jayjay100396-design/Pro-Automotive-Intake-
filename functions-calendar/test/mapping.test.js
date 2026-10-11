// How app events look in Google Calendar (mapping.js). Needs nothing running.
import assert from 'node:assert/strict';
import {
  base32hex, googleEventId, shortCompanyName, isWanted, addDays, todayIn, windowStartFor, zonedTimeToUtc, recurrenceFor, remindersFor,
  buildGoogleEvent, TYPE_COLORS,
} from '../mapping.js';

const APP = 'https://stellar-glass-jobs.web.app';
const company = { name: 'Stellar Glass LLC', timeZone: 'America/New_York' };
const members = new Map([
  ['jason', { role: 'owner', name: 'Jason Reed', email: 'jason@example.com' }],
  ['maria', { role: 'staff', name: 'Maria Lopez', email: 'maria@example.com' }],
  ['wes', { role: 'admin', name: 'Wes Carter', email: 'wes@example.com' }],
]);
const business = { kind: 'business', uid: 'jason' };
const mine = (uid) => ({ kind: 'personal', uid });
const event = (over = {}) => ({
  type: 'install', title: 'Install storefront', allDay: false, start: '2026-10-14T08:00', end: '2026-10-14T12:30', tz: 'America/New_York',
  repeat: '', repeatUntil: '', jobId: 'j1', customerId: 'c1', location: '12 Lake Ave, Lakeland FL', assignees: [], reminders: [60],
  notes: '', done: false, canceled: false, ...over,
});
const build = (over = {}, link = business, extra = {}) => buildGoogleEvent({ eventId: 'ev1', event: event(over), link, company, members, appUrl: APP, ...extra });

describe('Calendar mapping', () => {
  it('turns app event ids into Google event ids', () => {
    // RFC 4648 base32hex test vectors, lowercase and unpadded.
    for (const [text, want] of [['', ''], ['f', 'co'], ['fo', 'cpng'], ['foo', 'cpnmu'], ['foob', 'cpnmuog'], ['fooba', 'cpnmuoj1'], ['foobar', 'cpnmuoj1e8']]) {
      assert.equal(base32hex(Buffer.from(text)), want, text);
    }
    const id = googleEventId('Xq3vB9kLmN0pQrS7tUvW'); // a Firestore auto id
    assert.match(id, /^st[0-9a-v]+$/);
    assert.equal(id.length, 2 + 32);
    assert.equal(googleEventId('Xq3vB9kLmN0pQrS7tUvW'), id, 'always the same');
    assert.notEqual(googleEventId('Xq3vB9kLmN0pQrS7tUvX'), id);
    assert.notEqual(googleEventId('ab'), googleEventId('AB'), 'ids differ by case');
    assert.match(googleEventId('é/ü'), /^st[0-9a-v]+$/, 'any characters');
  });

  it('shortens the business name the way the app does', () => {
    assert.equal(shortCompanyName('Stellar Glass LLC'), 'Stellar Glass');
    assert.equal(shortCompanyName('Stellar Glass, LLC'), 'Stellar Glass');
    assert.equal(shortCompanyName('Stellar Glass, L.L.C.'), 'Stellar Glass');
    assert.equal(shortCompanyName('Acme Glass Inc.'), 'Acme Glass');
    assert.equal(shortCompanyName('Acme Glass Co'), 'Acme Glass');
    assert.equal(shortCompanyName('  Lake Glass Corporation '), 'Lake Glass');
    assert.equal(shortCompanyName('Costco'), 'Costco');
    assert.equal(shortCompanyName(''), 'Stellar Glass');
    assert.equal(shortCompanyName(undefined), 'Stellar Glass');
  });

  it('puts every event on the business calendar and assigned ones on people\'s own', () => {
    assert.equal(isWanted(business, event()), true);
    assert.equal(isWanted(business, event({ canceled: true })), false);
    assert.equal(isWanted(mine('maria'), event()), false);
    assert.equal(isWanted(mine('maria'), event({ assignees: ['maria'] })), true);
    assert.equal(isWanted(mine('maria'), event({ assignees: ['maria'], canceled: true })), false);
    assert.equal(isWanted(business, null), false);
  });

  it('gives Google an exclusive end date for all-day events', () => {
    const one = build({ allDay: true, start: '2026-10-14', end: '2026-10-14' });
    assert.deepEqual([one.start, one.end], [{ date: '2026-10-14' }, { date: '2026-10-15' }]);
    assert.deepEqual(build({ allDay: true, start: '2026-10-30', end: '2026-10-31' }).end, { date: '2026-11-01' });
    assert.deepEqual(build({ allDay: true, start: '2026-12-31', end: '2026-12-31' }).end, { date: '2027-01-01' });
    assert.deepEqual(build({ allDay: true, start: '2028-02-28', end: '2028-02-28' }).end, { date: '2028-02-29' }, 'leap day');
    assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  });

  it('gives timed events their wall-clock time and zone', () => {
    const g = build();
    assert.deepEqual(g.start, { dateTime: '2026-10-14T08:00:00', timeZone: 'America/New_York' });
    assert.deepEqual(g.end, { dateTime: '2026-10-14T12:30:00', timeZone: 'America/New_York' });
    assert.deepEqual(build({ tz: 'America/Chicago', end: '2026-10-15T07:00' }).end, { dateTime: '2026-10-15T07:00:00', timeZone: 'America/Chicago' }, 'overnight');
    assert.equal(build({ tz: 'Not/AZone' }).start.timeZone, 'America/New_York', 'falls back to the business\'s zone');
    assert.equal(build({ tz: '' }, business, { company: { ...company, timeZone: 'America/Denver' } }).start.timeZone, 'America/Denver');
    assert.equal(build({ start: '2026-10-14' }), null, 'unreadable dates are left alone');
    assert.equal(build({ allDay: true, start: '2026-02-30', end: '2026-02-30' }), null);
  });

  it('ends repeats on the last day, in UTC for timed events, across daylight saving changes', () => {
    const ny = 'America/New_York';
    assert.equal(recurrenceFor(event({ repeat: '' }), ny), undefined);
    assert.deepEqual(recurrenceFor(event({ repeat: 'monthly' }), ny), ['RRULE:FREQ=MONTHLY']);
    assert.deepEqual(recurrenceFor(event({ repeat: 'yearly', allDay: true, start: '2026-10-14', end: '2026-10-14', repeatUntil: '2030-10-14' }), ny),
      ['RRULE:FREQ=YEARLY;UNTIL=20301014']);
    // Starts in October (EDT, UTC-4) and ends after the change back to EST (UTC-5) on Nov 1, 2026.
    assert.deepEqual(recurrenceFor(event({ repeat: 'weekly', start: '2026-10-05T09:00', end: '2026-10-05T10:00', repeatUntil: '2026-11-30' }), ny),
      ['RRULE:FREQ=WEEKLY;UNTIL=20261201T045959Z']);
    assert.deepEqual(recurrenceFor(event({ repeat: 'weekly', repeatUntil: '2026-07-15' }), ny), ['RRULE:FREQ=WEEKLY;UNTIL=20260716T035959Z'], 'summer: EDT');
    assert.deepEqual(recurrenceFor(event({ repeat: 'weekly', repeatUntil: '2026-11-01' }), ny), ['RRULE:FREQ=WEEKLY;UNTIL=20261102T045959Z'], 'the day clocks go back');
    assert.deepEqual(recurrenceFor(event({ repeat: 'weekly', repeatUntil: '2026-03-08' }), ny), ['RRULE:FREQ=WEEKLY;UNTIL=20260309T035959Z'], 'the day clocks go forward');
    assert.deepEqual(recurrenceFor(event({ repeat: 'weekly', repeatUntil: '2026-11-30' }), 'Europe/London'), ['RRULE:FREQ=WEEKLY;UNTIL=20261130T235959Z']);
    assert.equal(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 1, minute: 30 }, ny).toISOString(), '2026-03-08T06:30:00.000Z', 'just before the change');
    assert.equal(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 3, minute: 30 }, ny).toISOString(), '2026-03-08T07:30:00.000Z', 'just after');
    assert.deepEqual(build({ repeat: 'weekly', repeatUntil: '2026-11-30' }).recurrence, ['RRULE:FREQ=WEEKLY;UNTIL=20261201T045959Z']);
    assert.equal('recurrence' in build(), false);
  });

  it('reminds whoever\'s calendar it is, but not the owner about other people\'s events', () => {
    const popups = (...m) => ({ useDefault: false, overrides: m.map((minutes) => ({ method: 'popup', minutes })) });
    const none = { useDefault: false, overrides: [] };
    assert.deepEqual(remindersFor(business, event({ reminders: [60, 15] })), popups(15, 60), 'nobody assigned: the owner');
    assert.deepEqual(remindersFor(business, event({ assignees: ['maria'] })), none, 'Maria\'s event: not the owner');
    assert.deepEqual(remindersFor(business, event({ assignees: ['maria', 'jason'] })), popups(60), 'the owner is on it');
    assert.deepEqual(remindersFor(mine('maria'), event({ assignees: ['maria'] })), popups(60));
    assert.deepEqual(remindersFor(mine('maria'), event({ assignees: ['maria'], done: true })), none, 'done');
    assert.deepEqual(remindersFor(business, event({ done: true })), none);
    assert.deepEqual(remindersFor(mine('maria'), event({ reminders: [30, 0, 30, 900, -5, 1.5, 50000, 10, 20, 40, 1440] })), popups(0, 10, 20, 30, 40),
      'unique, sorted, valid, at most five');
    assert.deepEqual(remindersFor(mine('maria'), event({ reminders: undefined })), none);
  });

  it('shows who\'s on it in the business calendar\'s titles', () => {
    assert.equal(build().summary, 'Install storefront');
    assert.equal(build({ assignees: ['maria', 'wes'] }).summary, 'Install storefront (Maria, Wes)');
    assert.equal(build({ assignees: ['maria', 'wes'] }, mine('maria')).summary, 'Install storefront', 'not on people\'s own');
    assert.equal(build({ assignees: ['maria', 'gone'] }).summary, 'Install storefront (Maria)', 'someone not on the team any more');
    assert.equal(build({ assignees: ['gone'] }).summary, 'Install storefront');
    assert.equal(build({ done: true, type: 'task', title: 'Order glass' }).summary, '✓ Order glass');
    assert.equal(build({ assignees: ['x'] }, business, { members: new Map([['x', { name: '', email: 'sam@example.com' }]]) }).summary, 'Install storefront (sam)');
  });

  it('describes the event, with links back to the app', () => {
    const customer = { name: 'Pat Customer', company: 'Lake Dental', phone: '(863) 555-0100', email: 'pat@example.com' };
    const job = { name: 'Lake Dental storefront' };
    const g = build({ assignees: ['maria', 'wes'], notes: 'Bring the long ladder.\nCall on arrival.' }, business, { customer, job });
    assert.equal(g.description, [
      'Install',
      'Customer: Pat Customer (Lake Dental) · (863) 555-0100 · pat@example.com',
      'Job: Lake Dental storefront',
      'Who: Maria Lopez, Wes Carter',
      '',
      'Bring the long ladder.\nCall on arrival.',
      '',
      `Open in the app: ${APP}/#/schedule/ev1`,
    ].join('\n'));
    assert.equal(build({ type: 'timeoff' }).description, `Time off\n\nOpen in the app: ${APP}/#/schedule/ev1`, 'nothing else to say');
    assert.match(build({}, business, { customer: { name: '', company: 'Lake Dental' } }).description, /^Customer: Lake Dental$/m);
    assert.match(build({}, business, { customer: { name: 'Pat' } }).description, /^Customer: Pat$/m);
    assert.equal(g.location, '12 Lake Ave, Lakeland FL');
    assert.equal(build({ location: undefined }).location, '');
    assert.deepEqual(g.source, { title: 'Stellar Glass', url: `${APP}/#/schedule/ev1` });
    assert.equal(g.status, 'confirmed');
    assert.equal(g.id, googleEventId('ev1'));
    assert.deepEqual(Object.keys(g.extendedProperties.private).sort(), ['stellar', 'stellarEvent', 'stellarV']);
    assert.equal(g.extendedProperties.private.stellar, '1');
    assert.equal(g.extendedProperties.private.stellarEvent, 'ev1');
    const tagged = build({}, business, { companyId: 'co1' });
    assert.equal(tagged.extendedProperties.private.stellarCompany, 'co1', 'the business, so cleanups never touch another business\'s copies');
    assert.equal(tagged.extendedProperties.private.stellarV, build({}, business).extendedProperties.private.stellarV, 'the tag isn\'t part of the fingerprint');
  });

  it('colors events by type and keeps tasks from looking busy', () => {
    for (const [type, color] of Object.entries(TYPE_COLORS)) {
      const g = build({ type });
      assert.equal(g.colorId, color);
      assert.equal(g.transparency, type === 'task' ? 'transparent' : 'opaque');
    }
    assert.deepEqual([TYPE_COLORS.measure, TYPE_COLORS.install, TYPE_COLORS.meeting, TYPE_COLORS.delivery, TYPE_COLORS.task, TYPE_COLORS.timeoff, TYPE_COLORS.other],
      ['7', '9', '3', '6', '5', '8', '2']);
    assert.equal(build({ type: 'mystery' }).colorId, '2', 'unknown types count as Other');
  });

  it('fingerprints what Google shows, and only that', () => {
    const v = (over, link, extra) => build(over, link, extra).extendedProperties.private.stellarV;
    const base = v();
    assert.match(base, /^[0-9a-f]{12}$/);
    assert.equal(v(), base, 'stable');
    assert.equal(v({ createdAt: 'x', updatedAt: 'y', updatedBy: 'wes', createdByName: 'Wes', lastDone: '' }), base, 'bookkeeping fields don\'t count');
    const reordered = Object.fromEntries(Object.entries(event()).reverse());
    assert.equal(buildGoogleEvent({ eventId: 'ev1', event: reordered, link: business, company, members, appUrl: APP }).extendedProperties.private.stellarV, base, 'field order doesn\'t count');
    for (const change of [{ title: 'Install door' }, { notes: 'Gate code 1234' }, { end: '2026-10-14T13:00' }, { reminders: [30] }, { done: true },
      { assignees: ['maria'] }, { repeat: 'weekly' }, { location: 'Elsewhere' }, { type: 'measure' }, { tz: 'America/Chicago' }]) {
      assert.notEqual(v(change), base, JSON.stringify(change));
    }
    assert.notEqual(v({}, business, { customer: { name: 'Pat', phone: '1' } }), v({}, business, { customer: { name: 'Pat', phone: '2' } }), 'customer details count');
    assert.notEqual(v({ assignees: ['maria'] }), v({ assignees: ['maria'] }, mine('maria')), 'business and personal copies differ');
  });

  it('knows today and the sync window where the business is', () => {
    const lateEvening = new Date('2026-10-12T02:30:00Z'); // 10:30 PM on Oct 11 in Florida
    assert.equal(todayIn('America/New_York', lateEvening), '2026-10-11');
    assert.equal(todayIn('UTC', lateEvening), '2026-10-12');
    assert.equal(windowStartFor('America/New_York', lateEvening), '2026-09-11');
  });
});
