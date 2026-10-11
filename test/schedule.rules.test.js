// Security rules for the schedule and its Google Calendar connections. Run with: npm test (needs Java)
const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment, assertSucceeds, assertFails,
} = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, serverTimestamp } = require('firebase/firestore');

let env;
const db = (uid) => env.authenticatedContext(uid).firestore();

// What the app writes for a new event (schedule.js addEvent / the event form, through data.js add()).
const event = (uid, extra = {}) => ({
  type: 'install', title: 'Install storefront', allDay: false, start: '2026-10-20T07:30', end: '2026-10-20T15:00',
  tz: 'America/New_York', repeat: '', repeatUntil: '', jobId: 'j1', customerId: '', location: '12 Main St',
  assignees: ['crew'], reminders: [1440, 60], notes: '', done: false, canceled: false, createdByName: 'Someone',
  createdBy: uid, createdAt: serverTimestamp(), ...extra,
});
const stamp = (data) => ({ ...data, updatedAt: serverTimestamp() });

async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const f = ctx.firestore();
    await setDoc(doc(f, 'companies/stellar'), { name: 'Stellar Glass', ownerUid: 'wes' });
    await setDoc(doc(f, 'companies/stellar/members/wes'), { role: 'owner' });
    await setDoc(doc(f, 'companies/stellar/members/admin1'), { role: 'admin' });
    await setDoc(doc(f, 'companies/stellar/members/crew'), { role: 'staff' });
    await setDoc(doc(f, 'companies/stellar/members/crew2'), { role: 'staff' });
    await setDoc(doc(f, 'companies/stellar/members/cpa'), { role: 'accountant' });
    const base = { tz: 'America/New_York', allDay: false, createdAt: new Date(), done: false };
    await setDoc(doc(f, 'companies/stellar/events/install'), { ...base, type: 'install', title: 'Install', start: '2026-10-20T07:30', end: '2026-10-20T15:00', assignees: ['crew'], createdBy: 'crew' });
    await setDoc(doc(f, 'companies/stellar/events/cpaTask'), { ...base, type: 'task', title: 'Send pay app', start: '2026-10-25T09:00', end: '2026-10-25T09:30', assignees: ['cpa'], createdBy: 'wes', repeat: 'monthly' });
    await setDoc(doc(f, 'companies/stellar/events/ownTask'), { ...base, type: 'task', title: 'Notarize lien waiver', start: '2026-10-21T09:00', end: '2026-10-21T09:30', assignees: [], createdBy: 'cpa' });
    await setDoc(doc(f, 'companies/stellar/calendarLinks/business'), { kind: 'business', uid: 'wes', email: 'wes@example.com', status: 'on' });
    await setDoc(doc(f, 'companies/stellar/calendarTokens/business'), { kind: 'business', uid: 'wes', refreshToken: 'secret' });
    await setDoc(doc(f, 'companies/other'), { name: 'Other Co', ownerUid: 'bob' });
    await setDoc(doc(f, 'companies/other/members/bob'), { role: 'owner' });
    await setDoc(doc(f, 'companies/other/events/e9'), { ...base, type: 'install', title: 'Secret', start: '2026-10-20T07:30', end: '2026-10-20T08:00', createdBy: 'bob' });
  });
}

describe('Schedule rules', function () {
  this.timeout(20000);
  before(async () => {
    env = await initializeTestEnvironment({
      projectId: 'demo-stellar-glass',
      firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8') },
    });
  });
  after(() => env.cleanup());
  beforeEach(async () => { await env.clearFirestore(); await seed(); });

  it('shows the schedule to the team only', async () => {
    for (const uid of ['wes', 'admin1', 'crew', 'cpa']) {
      await assertSucceeds(getDoc(doc(db(uid), 'companies/stellar/events/install')));
      await assertSucceeds(getDocs(collection(db(uid), 'companies/stellar/events')));
    }
    await assertFails(getDoc(doc(db('bob'), 'companies/stellar/events/install')));
    await assertFails(getDoc(doc(db('wes'), 'companies/other/events/e9')));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'companies/stellar/events/install')));
  });

  it('lets owners, admins and staff schedule anything that is well formed', async () => {
    await assertSucceeds(setDoc(doc(db('crew'), 'companies/stellar/events/n1'), event('crew')));
    await assertSucceeds(setDoc(doc(db('admin1'), 'companies/stellar/events/n2'), event('admin1', { type: 'timeoff', allDay: true, start: '2026-11-25', end: '2026-11-27', reminders: [] })));
    await assertSucceeds(setDoc(doc(db('wes'), 'companies/stellar/events/n3'), event('wes', { type: 'meeting', repeat: 'weekly', repeatUntil: '2026-12-31', ref: { path: '#/jobs/j1', label: 'Job' } })));
    // Overnight: ends the next day.
    await assertSucceeds(setDoc(doc(db('crew'), 'companies/stellar/events/n4'), event('crew', { start: '2026-10-20T22:00', end: '2026-10-21T02:00' })));
  });

  it('refuses malformed events', async () => {
    const f = db('crew');
    const bad = [
      { type: 'party' },
      { title: '' },
      { title: 'x'.repeat(201) },
      { end: '2026-10-20T07:30' },
      { end: '2026-10-19T15:00' },
      { allDay: true },
      { allDay: true, start: '2026-10-20', end: '2026-10-19' },
      { start: '2026-10-20 07:30' },
      { repeat: 'daily' },
      { repeatUntil: 'someday' },
      { assignees: Array.from({ length: 21 }, (_, i) => `u${i}`) },
      { reminders: [1, 2, 3, 4, 5, 6] },
      { notes: 'x'.repeat(4001) },
      { location: 'x'.repeat(301) },
      { done: 'yes' },
      { createdBy: 'wes' },
      { surprise: true },
      { ref: { path: 'javascript:alert(1)', label: 'x' } },
      { ref: { path: 'https://evil.example/#/jobs', label: 'x' } },
      { ref: { path: '#/jobs/"><script>', label: 'x' } },
    ];
    for (const extra of bad) {
      await assertFails(setDoc(doc(f, 'companies/stellar/events/bad'), event('crew', extra)));
    }
    const { tz, ...noZone } = event('crew');
    await assertFails(setDoc(doc(f, 'companies/stellar/events/bad'), noZone));
    await assertFails(setDoc(doc(f, 'companies/stellar/events/bad'), event('crew', { createdAt: new Date('2020-01-01') })));
    await assertFails(setDoc(doc(db('bob'), 'companies/stellar/events/bad'), event('bob')));
  });

  it('stamps every change and keeps who added an event', async () => {
    const f = db('crew2');
    await assertSucceeds(updateDoc(doc(f, 'companies/stellar/events/install'), stamp({ title: 'Install doors' })));
    await assertFails(updateDoc(doc(f, 'companies/stellar/events/install'), { title: 'No stamp' }));
    await assertFails(updateDoc(doc(f, 'companies/stellar/events/install'), stamp({ createdBy: 'crew2' })));
    await assertFails(updateDoc(doc(f, 'companies/stellar/events/install'), stamp({ start: '2026-10-20T16:00' })));
  });

  it('lets the accountant keep tasks and meetings of their own and tick off tasks they are on', async () => {
    const f = db('cpa');
    await assertSucceeds(setDoc(doc(f, 'companies/stellar/events/a1'), event('cpa', { type: 'task', assignees: ['cpa'] })));
    await assertSucceeds(setDoc(doc(f, 'companies/stellar/events/a2'), event('cpa', { type: 'meeting' })));
    await assertFails(setDoc(doc(f, 'companies/stellar/events/a3'), event('cpa', { type: 'install' })));
    // Their own task.
    await assertSucceeds(updateDoc(doc(f, 'companies/stellar/events/ownTask'), stamp({ title: 'Notarize both waivers', done: true, doneAt: serverTimestamp() })));
    await assertFails(updateDoc(doc(f, 'companies/stellar/events/ownTask'), stamp({ type: 'install' })));
    // A repeating task someone else gave them: ticking it off moves it to next month.
    await assertSucceeds(updateDoc(doc(f, 'companies/stellar/events/cpaTask'), stamp({ start: '2026-11-25T09:00', end: '2026-11-25T09:30', lastDone: '2026-10-25', updatedBy: 'cpa' })));
    await assertSucceeds(updateDoc(doc(f, 'companies/stellar/events/cpaTask'), stamp({ done: true, doneAt: serverTimestamp() })));
    await assertFails(updateDoc(doc(f, 'companies/stellar/events/cpaTask'), stamp({ title: 'Changed' })));
    await assertFails(updateDoc(doc(f, 'companies/stellar/events/cpaTask'), stamp({ assignees: [] })));
    // Not theirs and not a task they're on.
    await assertFails(updateDoc(doc(f, 'companies/stellar/events/install'), stamp({ done: true })));
    for (const id of ['ownTask', 'cpaTask', 'install']) await assertFails(deleteDoc(doc(f, `companies/stellar/events/${id}`)));
  });

  it('lets owners and admins delete any event and staff the ones they added', async () => {
    await assertFails(deleteDoc(doc(db('crew2'), 'companies/stellar/events/install')));
    await assertSucceeds(deleteDoc(doc(db('crew'), 'companies/stellar/events/install')));
    await assertSucceeds(deleteDoc(doc(db('admin1'), 'companies/stellar/events/cpaTask')));
    await assertSucceeds(deleteDoc(doc(db('wes'), 'companies/stellar/events/ownTask')));
  });

  it('shows Google Calendar connections to the team, but only the server writes them or sees their access', async () => {
    for (const uid of ['wes', 'crew', 'cpa']) {
      await assertSucceeds(getDoc(doc(db(uid), 'companies/stellar/calendarLinks/business')));
      await assertFails(getDoc(doc(db(uid), 'companies/stellar/calendarTokens/business')));
      await assertFails(getDocs(collection(db(uid), 'companies/stellar/calendarTokens')));
    }
    await assertFails(getDoc(doc(db('bob'), 'companies/stellar/calendarLinks/business')));
    await assertFails(setDoc(doc(db('wes'), 'companies/stellar/calendarLinks/business'), { kind: 'business', uid: 'wes', status: 'on' }));
    await assertFails(updateDoc(doc(db('wes'), 'companies/stellar/calendarLinks/business'), { status: 'paused' }));
    await assertFails(deleteDoc(doc(db('wes'), 'companies/stellar/calendarLinks/business')));
    await assertFails(setDoc(doc(db('wes'), 'companies/stellar/calendarTokens/wes'), { refreshToken: 'x' }));
    await assertFails(setDoc(doc(db('crew'), 'companies/stellar/calendarLinks/crew'), { kind: 'personal', uid: 'crew' }));
  });
});
