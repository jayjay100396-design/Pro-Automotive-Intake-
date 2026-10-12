// Parts requests emailed to suppliers from the app (parts-request.js). The first part needs nothing running; the
// second runs under `npm test` against the Firestore and Storage emulators, with a fake send function.
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { handlePartsEmail, problemText, floridaDay, SendError, DAILY_LIMIT } from '../parts-request.js';
import { buildPartsEmail, MAX_ATTACH_BYTES } from '../parts-email.js';
import { createMailer, isPermanent } from '../mailer.js';
import * as alerts from '../../functions-alerts/request-alert.js';
import { startSmtpSink } from '../../functions-alerts/test/smtp-sink.js';

const company = { name: 'Stellar Glass LLC', email: 'wes@stellarglassllc.com', phone: '(863) 255-5731' };
const supplier = (over = {}) => ({
  name: 'Trulite Glass & Aluminum Solutions', plugin: 'trulite', contactName: 'Pat', emails: ['pat@trulite.example'], cc: ['desk@trulite.example'],
  account: 'STE-1001', branch: 'Plant City', ...over,
});
const items = [{ heading: 'Stock lengths' }, { qty: 5, unit: 'S/L', partNo: 'CG451-1', desc: 'HEAD/JAMB/VERT MULL', got: 0 }, { qty: 2, unit: 'pkg', partNo: 'ED450-2', desc: 'End Dam', got: 0 }];
const partsRequest = (over = {}) => ({
  number: 7, jobId: 'j1', supplierId: 's1', status: 'draft', kind: 'quote', listType: 'parts', items, po: '4512', delivery: 'site',
  deliverTo: '3955 Anchuca Dr, Lakeland FL', neededBy: '2026-11-14', attachments: [], signature: 'Crew Member\nStellar Glass LLC',
  events: [{ at: '2026-10-12T13:00:00.000Z', status: 'draft', note: 'Started', by: 'Crew Member' }], createdBy: 'crew', ...over,
});
const token = { email: 'crew@stellarglassllc.com', name: 'Crew Member' };
const NOW = new Date('2026-10-12T14:00:00Z');

describe('Parts request emails', () => {
  it('counts the day in Florida', () => {
    assert.equal(floridaDay(new Date('2026-10-12T14:00:00Z')), '2026-10-12');
    assert.equal(floridaDay(new Date('2026-10-12T03:30:00Z')), '2026-10-11', '11:30 PM the night before in Lakeland');
    assert.equal(floridaDay(new Date('2026-01-15T04:30:00Z')), '2026-01-14', 'in winter too');
  });

  it('sends mail the same way as the quote request alerts (mailer.js is a copy of theirs)', () => {
    assert.equal(createMailer.toString(), alerts.createMailer.toString());
    assert.equal(isPermanent.toString(), alerts.isPermanent.toString());
  });

  it('says what went wrong in words Wes can act on', () => {
    assert.match(problemText({ code: 'EAUTH', responseCode: 535 }), /app password/);
    assert.match(problemText({ code: 'EENVELOPE', responseCode: 550, response: '550 5.1.1 No such user\r\nhere' }), /^The email server refused it: 550 5\.1\.1 No such user here$/);
    assert.match(problemText({ code: 'ETIMEDOUT' }), /Couldn't reach the email server/);
    assert.equal(problemText(new SendError('aborted', 'Wait a minute.')), 'Wait a minute.');
  });

  it('goes out through a real mail server connection, from the person, with the files', async () => {
    const got = [];
    const server = await startSmtpSink({ port: 2528, onMessage: (m) => got.push(m) });
    try {
      const send = createMailer({ host: '127.0.0.1', port: 2528, user: 'alerts@example.com' });
      const mail = buildPartsEmail({ request: partsRequest(), supplier: supplier(), job: { name: 'Shell Warehouse' }, company, attachments: ['Door order form.pdf'] });
      await send({
        ...mail, to: ['pat@trulite.example'], cc: ['desk@trulite.example', 'crew@stellarglassllc.com'], replyTo: 'crew@stellarglassllc.com',
        fromName: 'Crew Member at Stellar Glass', attachments: [{ filename: 'Door order form.pdf', content: Buffer.from('pdf bytes'), contentType: 'application/pdf' }],
      });
      assert.equal(got.length, 1);
      assert.equal(got[0].from, 'alerts@example.com');
      assert.deepEqual(got[0].to, ['pat@trulite.example', 'desk@trulite.example', 'crew@stellarglassllc.com']);
      const raw = got[0].raw.toString();
      assert.match(raw, /^From: "?Crew Member at Stellar Glass"? <alerts@example\.com>/m);
      assert.match(raw, /^Reply-To: crew@stellarglassllc\.com/m);
      assert.match(raw, /^Cc: desk@trulite\.example, crew@stellarglassllc\.com/m);
      assert.match(raw, /^Subject: Quote request: Shell Warehouse, PO 4512 \(Stellar Glass\)/m);
      assert.match(raw, /filename="?Door order form\.pdf"?/);
    } finally { server.close(); }
  });
});

describe('Parts request emails (with the emulators)', function () {
  this.timeout(30000);
  let app;
  let db;
  let bucket;
  let sent;
  let failNext;
  const C = 'stellar';
  const ref = (id = 'p1') => db.doc(`companies/${C}/partsRequests/${id}`);
  const usage = () => db.doc(`emailUsage/${C}`);
  const send = async (m) => {
    if (failNext) { const e = failNext; failNext = null; throw e; }
    sent.push(m);
  };
  let n = 0;
  const call = ({ uid = 'crew', data = {}, now = NOW, ...extra } = {}) => handlePartsEmail({
    db, bucket, send, uid, token, now, data: { companyId: C, requestId: 'p1', what: 'request', sendId: `send-${String(n += 1).padStart(4, '0')}`, ...data }, ...extra,
  });
  const code = (c, text) => (e) => e instanceof SendError && e.code === c && (!text || text.test(e.message));
  const read = async (id = 'p1') => (await ref(id).get()).data();
  const addFile = async (id, over = {}, bytes = 'pdf bytes') => {
    const f = { jobId: 'j1', category: 'documents', name: `${id}.pdf`, path: `companies/${C}/documents/j1/${id}/${id}.pdf`, contentType: 'application/pdf', ...over };
    await db.doc(`companies/${C}/files/${id}`).set(f);
    if (bytes !== null) await bucket.file(f.path).save(Buffer.from(bytes), { contentType: f.contentType });
    return id;
  };

  before(function () {
    if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) this.skip();
    // Its own project, so the other tests' clean-ups don't touch this data.
    app = initializeApp({ projectId: 'demo-stellar-parts', storageBucket: 'demo-stellar-parts.appspot.com' }, 'parts-tests');
    db = getFirestore(app);
    bucket = getStorage(app).bucket();
  });
  after(async () => { if (app) await deleteApp(app); });

  beforeEach(async () => {
    sent = [];
    failNext = null;
    await db.recursiveDelete(db.collection('companies'));
    await db.recursiveDelete(db.collection('emailUsage'));
    await bucket.deleteFiles({ prefix: 'companies/' }).catch(() => {});
    await db.doc(`companies/${C}`).set({ ...company, ownerUid: 'wes' });
    for (const [uid, role] of [['wes', 'owner'], ['admin1', 'admin'], ['crew', 'staff'], ['cpa', 'accountant']]) {
      await db.doc(`companies/${C}/members/${uid}`).set({ role, name: uid });
    }
    await db.doc('companies/other/members/bob').set({ role: 'owner' });
    await db.doc(`companies/${C}/jobs/j1`).set({ name: 'Shell Warehouse', siteAddress: '3955 Anchuca Dr, Lakeland FL' });
    await db.doc(`companies/${C}/suppliers/s1`).set(supplier());
    await ref().set(partsRequest());
  });

  it('emails the request to the supplier with the job\'s files, and moves it along', async () => {
    await addFile('f1', { name: 'Door order form.pdf' });
    await ref().update({ attachments: ['f1'] });
    assert.deepEqual(await call({ data: { sendId: 'press-0001' } }),
      { status: 'sent', to: ['pat@trulite.example'], cc: ['desk@trulite.example', 'crew@stellarglassllc.com'], attached: 1 });
    assert.equal(sent.length, 1);
    const m = sent[0];
    assert.equal(m.subject, 'Quote request: Shell Warehouse, PO 4512 (Stellar Glass)');
    assert.deepEqual([m.to, m.cc, m.replyTo, m.fromName], [['pat@trulite.example'], ['desk@trulite.example', 'crew@stellarglassllc.com'], 'crew@stellarglassllc.com', 'Crew Member at Stellar Glass']);
    for (const s of ['Hi Pat,', 'Kindly quote the following for us.', 'Job: Shell Warehouse', 'Account #: STE-1001', '5 S/L – CG451-1 – HEAD/JAMB/VERT MULL', 'Attached: Door order form.pdf']) {
      assert.ok(m.text.includes(s), `email has ${s}`);
    }
    assert.deepEqual(m.attachments.map((a) => [a.filename, a.contentType, a.content.toString()]), [['Door order form.pdf', 'application/pdf', 'pdf bytes']]);

    const r = await read();
    assert.equal(r.status, 'sent');
    assert.equal(r.requestedOn, '2026-10-12');
    assert.deepEqual({ ...r.appEmail, at: undefined }, {
      status: 'sent', sendId: 'press-0001', what: 'request', at: undefined, by: 'crew', to: ['pat@trulite.example'],
      cc: ['desk@trulite.example', 'crew@stellarglassllc.com'], attached: ['Door order form.pdf'],
    });
    assert.ok(r.appEmail.at instanceof Timestamp);
    assert.deepEqual(r.lastEmail, { what: 'request', via: 'app', at: NOW.toISOString() });
    assert.deepEqual(r.events.at(-1), { at: NOW.toISOString(), status: 'sent', note: 'Request emailed from the app to pat@trulite.example', by: 'Crew Member' });
    assert.deepEqual((await usage().get()).data(), { day: '2026-10-12', count: 1 });

    // A double click, or the app trying again, sends nothing more.
    assert.deepEqual(await call({ data: { sendId: 'press-0001' } }), { status: 'sent', to: ['pat@trulite.example'], cc: ['desk@trulite.example', 'crew@stellarglassllc.com'], duplicate: true });
    assert.equal(sent.length, 1);
    assert.equal((await usage().get()).data().count, 1);
  });

  it('starts an order straight away, and copies the office when asked', async () => {
    await ref().update({ kind: 'order', ccMe: false, ccOffice: true });
    assert.equal((await call({ uid: 'wes' })).status, 'sent');
    assert.match(sent[0].subject, /^Order: /);
    assert.deepEqual(sent[0].cc, ['desk@trulite.example', 'wes@stellarglassllc.com']);
    const r = await read();
    assert.deepEqual([r.status, r.orderedOn, r.requestedOn], ['ordered', '2026-10-12', undefined]);
  });

  it('places the order a supplier quoted, then asks for updates', async () => {
    await addFile('f1');
    await ref().update({ status: 'quoted', requestedOn: '2026-10-05', quotedOn: '2026-10-09', quoteRef: 'Q-7731', attachments: ['f1'] });
    assert.deepEqual(await call({ data: { what: 'order', note: 'Deliver before 10 AM, please.' } }), { status: 'sent', to: ['pat@trulite.example'], cc: ['desk@trulite.example', 'crew@stellarglassllc.com'], attached: 0 });
    assert.equal(sent[0].subject, 'Order: Shell Warehouse, PO 4512 (Stellar Glass)');
    assert.ok(sent[0].text.includes('Please enter the following order per your quote #Q-7731.'));
    assert.ok(sent[0].text.includes('\nDeliver before 10 AM, please.\n'));
    assert.deepEqual(sent[0].attachments, [], 'the files went with the request');
    let r = await read();
    assert.deepEqual([r.status, r.kind, r.orderedOn, r.requestedOn], ['ordered', 'order', '2026-10-12', '2026-10-05']);
    assert.equal(r.events.at(-1).note, 'Order emailed from the app to pat@trulite.example');

    await ref().update({ status: 'confirmed', expectedOn: '2026-10-19', items: [] });
    await call({ data: { what: 'followup' }, now: new Date('2026-10-21T13:00:00Z') });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].subject, 'Checking on our order: Shell Warehouse, PO 4512 (Stellar Glass)');
    assert.ok(sent[1].text.includes('The last date we had was Mon, Oct 19, 2026.'));
    r = await read();
    assert.equal(r.status, 'confirmed', 'asking for an update changes nothing else');
    assert.deepEqual(r.events.at(-1), { at: '2026-10-21T13:00:00.000Z', status: 'confirmed', note: 'Update request emailed from the app to pat@trulite.example', by: 'Crew Member' });
    assert.deepEqual((await usage().get()).data(), { day: '2026-10-21', count: 1 }, 'a new day starts a new count');
  });

  it('lets the team send, and only to the supplier\'s saved addresses', async () => {
    await assert.rejects(call({ uid: 'cpa' }), code('permission-denied'));
    await assert.rejects(call({ uid: 'bob' }), code('permission-denied'));
    await assert.rejects(call({ uid: '' }), code('unauthenticated'));
    await assert.rejects(call({ data: { requestId: '../suppliers/s1' } }), code('invalid-argument'));
    await assert.rejects(call({ data: { what: 'spam' } }), code('invalid-argument'));
    await assert.rejects(call({ data: { sendId: 'short' } }), code('invalid-argument'));
    await assert.rejects(call({ data: { companyId: 'other' } }), code('permission-denied'), 'another business\'s requests');
    // Addresses in the call itself go nowhere, and the request's email is the request as saved.
    await call({ data: { to: ['someone@example.com'], cc: ['x@example.com'], emails: ['y@example.com'], note: 'Not in the request email' } });
    assert.deepEqual([sent[0].to, sent[0].cc], [['pat@trulite.example'], ['desk@trulite.example', 'crew@stellarglassllc.com']]);
    assert.ok(!sent[0].text.includes('Not in the request email'));
    // A note too long, or not text, is cut down or left out.
    await call({ data: { what: 'followup', note: 'x'.repeat(5000) } });
    assert.ok(sent[1].text.includes(`\n${'x'.repeat(1000)}\n`) && !sent[1].text.includes('x'.repeat(1001)));
    await call({ data: { what: 'followup', note: { html: '<b>hi</b>' } } });
    assert.ok(!sent[2].text.includes('hi') && !sent[2].html.includes('<b>'));
    assert.equal(sent.length, 3);
  });

  it('says why it can\'t go, and sends nothing', async () => {
    await db.doc(`companies/${C}/suppliers/s1`).update({ emails: [] });
    await assert.rejects(call(), code('failed-precondition', /no email saved for Trulite/));
    await db.doc(`companies/${C}/suppliers/s1`).update({ emails: ['not an email'] });
    await assert.rejects(call(), code('failed-precondition', /no email saved/));
    await db.doc(`companies/${C}/suppliers/s1`).delete();
    await assert.rejects(call(), code('failed-precondition', /supplier was deleted/));
    await ref().update({ supplierId: '' });
    await assert.rejects(call(), code('failed-precondition', /Pick the supplier/));
    await db.doc(`companies/${C}/suppliers/s1`).set(supplier());
    await ref().update({ supplierId: 's1', items: [{ heading: 'Stock lengths' }] });
    await assert.rejects(call(), code('failed-precondition', /Add at least one line/));
    await ref().update({ items: [{ qty: 0, unit: 'ea', desc: 'Door closer' }] });
    await assert.rejects(call(), code('failed-precondition', /Line 1 needs a quantity/));
    await assert.rejects(call({ data: { requestId: 'gone' } }), code('not-found'));
    assert.equal(sent.length, 0);
    assert.equal((await usage().get()).exists, false, 'none of these count toward the day');
    assert.equal((await read()).appEmail, undefined);
  });

  it('sends only this job\'s own files, within the size limit', async () => {
    const tryWith = async (ids, pattern, extra) => {
      await ref().update({ attachments: ids });
      await assert.rejects(call(extra), code('failed-precondition', pattern));
    };
    await addFile('f1');
    await addFile('other-job', { jobId: 'j2' });
    await tryWith(['f1', 'other-job'], /other-job\.pdf isn't one of this job's files/);
    await addFile('other-co', { path: 'companies/other/documents/j1/x/secret.pdf' }, null);
    await tryWith(['other-co'], /isn't one of this job's files/);
    await tryWith(['f1', 'deleted'], /was deleted\. Untick it/);
    await addFile('no-upload', {}, null);
    await tryWith(['no-upload'], /no-upload\.pdf is missing from storage/);
    await tryWith(['f1', '../members/wes'], /Only the job's own files/);
    await tryWith(Array.from({ length: 11 }, (_, i) => `f${i}`), /Attach up to 10 files/);
    // The stored sizes count, not what the record says.
    const big = { file: (path) => ({ getMetadata: async () => [{ size: String(MAX_ATTACH_BYTES / 2 + 1), contentType: 'application/pdf', name: path }], download: async () => [Buffer.from('x')] }) };
    await addFile('f2');
    await tryWith(['f1', 'f2'], /more than 15 MB/, { bucket: big });

    assert.equal(sent.length, 0);
    const r = await read();
    assert.equal(r.status, 'draft');
    assert.equal(r.appEmail.status, 'failed');
    assert.match(r.appEmail.error, /more than 15 MB/);
  });

  it('won\'t send twice at once, but takes over from a send that died', async () => {
    await ref().update({ appEmail: { status: 'sending', sendId: 'other-press', what: 'request', at: Timestamp.fromMillis(NOW.getTime() - 30 * 1000), by: 'wes' } });
    await assert.rejects(call(), code('aborted', /still going out/));
    assert.equal(sent.length, 0);
    await ref().update({ appEmail: { status: 'sending', sendId: 'other-press', what: 'request', at: Timestamp.fromMillis(NOW.getTime() - 10 * 60 * 1000), by: 'wes' } });
    assert.equal((await call()).status, 'sent');
    assert.equal(sent.length, 1);
  });

  it('sends up to the daily limit, counted by the day in Florida', async () => {
    await usage().set({ day: '2026-10-12', count: DAILY_LIMIT });
    await assert.rejects(call(), code('resource-exhausted', /Open in Gmail/));
    assert.equal(sent.length, 0);
    // 11:30 PM in Lakeland is still the same day.
    await assert.rejects(call({ now: new Date('2026-10-13T03:30:00Z') }), code('resource-exhausted'));
    assert.equal((await call({ now: new Date('2026-10-13T04:30:00Z') })).status, 'sent');
    assert.deepEqual((await usage().get()).data(), { day: '2026-10-13', count: 1 });
    await usage().set({ day: '2026-10-13', count: DAILY_LIMIT - 1 });
    await ref().update({ status: 'sent' });
    assert.equal((await call({ data: { what: 'followup' }, now: new Date('2026-10-13T15:00:00Z') })).status, 'sent');
    await assert.rejects(call({ data: { what: 'followup' }, now: new Date('2026-10-13T15:05:00Z') }), code('resource-exhausted'));
  });

  it('notes a failed send on the request, and lets it go again', async () => {
    failNext = Object.assign(new Error('Invalid login: 535 5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 });
    await assert.rejects(call(), (e) => code('failed-precondition', /app password/)(e) && e.cause?.code === 'EAUTH');
    let r = await read();
    assert.deepEqual([r.status, r.appEmail.status, r.lastEmail, r.events.length], ['draft', 'failed', undefined, 1]);
    assert.match(r.appEmail.error, /app password/);

    failNext = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
    await assert.rejects(call(), code('unavailable', /Couldn't reach the email server/));

    assert.equal((await call()).status, 'sent');
    r = await read();
    assert.deepEqual([r.status, r.appEmail.status, r.appEmail.error], ['sent', 'sent', undefined]);
    assert.equal(sent.length, 1);
  });
});
