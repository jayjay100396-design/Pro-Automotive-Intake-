// Shared setup for the tests that use the Firestore emulator: an admin Firestore client, the fake Google server,
// a clock the tests set, and a business with a team. The functions are called directly (not through the Functions
// emulator). Business ids start with 'caltest-' and are deleted again, since `npm test` runs the rules tests
// against the same emulator.
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { startFakeGoogle } from './fake-google.js';
import { handleAccountCall } from '../account.js';
import { handleEventWrite } from '../sync.js';
import { googleEventId } from '../mapping.js';

export const APP = 'https://stellar-glass-jobs.web.app';
// 11 AM in Florida. The full sync's window starts 30 days back: 2026-09-11.
export const NOW = new Date('2026-10-11T15:00:00Z');
export const COMPANIES = ['caltest-a', 'caltest-b'];
export const TEAM = {
  jason: { role: 'owner', name: 'Jason Reed', email: 'jason@example.com' },
  wes: { role: 'admin', name: 'Wes Carter', email: 'wes@example.com' },
  maria: { role: 'staff', name: 'Maria Lopez', email: 'maria@example.com' },
  pat: { role: 'accountant', name: 'Pat Books', email: 'pat@example.com' },
};

// An app event as the app writes it (firestore.rules checks the same fields).
export const appEvent = (over = {}) => ({
  type: 'install', title: 'Install storefront', allDay: false, start: '2026-10-14T08:00', end: '2026-10-14T12:00', tz: 'America/New_York',
  repeat: '', repeatUntil: '', jobId: 'j1', customerId: 'c1', location: '12 Lake Ave, Lakeland FL', assignees: [], reminders: [60], notes: '',
  done: false, canceled: false, createdBy: 'jason', createdAt: FieldValue.serverTimestamp(), ...over,
});

// assert.rejects check for an HttpsError with this code (and message).
export const httpsError = (code, message) => (e) => {
  assert.ok(e instanceof HttpsError, `expected an HttpsError, got ${e?.stack || e}`);
  assert.equal(e.code, code);
  if (message !== undefined) assert.equal(e.message, message);
  return true;
};

let apps = 0;
export async function startTestbed() {
  apps += 1;
  const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-calendar-test' }, `calendar-tests-${apps}`);
  const db = getFirestore(app);
  const fake = await startFakeGoogle();
  const bed = {
    db,
    fake,
    clock: NOW,
    waits: [],
    logs: [],
    fetch: globalThis.fetch,
    deps: () => ({
      db,
      fetch: (...args) => bed.fetch(...args),
      oauthBase: `${fake.url}/oauth`,
      calendarBase: `${fake.url}/calendar/v3`,
      appUrl: APP,
      oauthClient: async () => ({ clientId: fake.state.clientId, clientSecret: fake.state.clientSecret }),
      now: () => bed.clock,
      sleep: async (ms) => { bed.waits.push(ms); },
      logger: {
        info: (...a) => bed.logs.push(['info', ...a]), warn: (...a) => bed.logs.push(['warn', ...a]), error: (...a) => bed.logs.push(['error', ...a]),
      },
    }),
    async reset() {
      fake.reset();
      bed.clock = NOW;
      bed.waits = [];
      bed.logs = [];
      bed.fetch = globalThis.fetch;
      await bed.wipe();
    },
    async wipe() {
      for (const id of COMPANIES) await db.recursiveDelete(db.doc(`companies/${id}`));
    },
    async close() {
      await bed.wipe();
      await fake.close();
      await deleteApp(app);
    },
  };
  return bed;
}

// A business in the emulator, with ways to use it the way the app and the trigger would.
export function business(bed, companyId = 'caltest-a') {
  const { db, fake } = bed;
  const co = db.doc(`companies/${companyId}`);
  const events = co.collection('events');
  const trigger = (eventId, before) => handleEventWrite({ ...bed.deps(), companyId, eventId, before, eventTime: bed.clock.toISOString() });
  const before = async (id) => (await events.doc(id).get()).data() || null;
  return {
    companyId,
    async seed({ name = 'Stellar Glass LLC', ownerUid = 'jason', timeZone = 'America/New_York', team = TEAM } = {}) {
      await co.set({ name, ownerUid, timeZone });
      await Promise.all(Object.entries(team).map(([uid, m]) => co.collection('members').doc(uid).set(m)));
      await co.collection('customers').doc('c1').set({ name: 'Pat Customer', company: 'Lake Dental', phone: '(863) 555-0100', email: 'pat@example.com' });
      await co.collection('jobs').doc('j1').set({ name: 'Lake Dental storefront', customerId: 'c1' });
    },
    // The callable, as a signed-in member (uid null: signed out).
    call: (uid, data) => handleAccountCall({ ...bed.deps(), auth: uid ? { uid } : undefined, data: { companyId, ...data } }),
    connect(uid, kind, code = `emulator:${TEAM[uid].email}`) {
      return this.call(uid, { action: 'connect', kind, code });
    },
    // Saves an event without the trigger, as if it was made before any calendar was connected.
    put: (id, over) => events.doc(id).set(appEvent(over)),
    // Saves an event (all of it), then runs the trigger the way the write would.
    async write(id, over) {
      const was = await before(id);
      await events.doc(id).set(appEvent(over));
      return trigger(id, was);
    },
    async edit(id, changes) {
      const was = await before(id);
      await events.doc(id).update({ ...changes, updatedAt: FieldValue.serverTimestamp() });
      return trigger(id, was);
    },
    async remove(id) {
      const was = await before(id);
      await events.doc(id).delete();
      return trigger(id, was);
    },
    trigger,
    link: async (id) => (await co.collection('calendarLinks').doc(id).get()).data(),
    token: async (id) => (await co.collection('calendarTokens').doc(id).get()).data(),
    async handOver(to, from = 'jason') {
      await co.update({ ownerUid: to });
      await co.collection('members').doc(to).update({ role: 'owner' });
      await co.collection('members').doc(from).update({ role: 'admin' });
    },
    // Google's copy of an app event in a calendar, or undefined when there's none (or it's deleted).
    inGoogle(calendarId, eventId) {
      const g = fake.event(calendarId, googleEventId(eventId));
      return g && g.status !== 'cancelled' ? g : undefined;
    },
    // The app events a calendar holds, by app event id.
    appEventsIn: (calendarId) => fake.events(calendarId).filter((g) => g.extendedProperties?.private?.stellar === '1')
      .map((g) => g.extendedProperties.private.stellarEvent).sort(),
  };
}
