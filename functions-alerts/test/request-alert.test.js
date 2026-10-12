// Quote request emails. The first part needs nothing running; the second runs under `npm test` against the
// Firestore and Storage emulators, with a fake mail server (smtp-sink.js) or a fake send function.
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import {
  REQUEST_SERVICES, REQUEST_TIMELINES, REQUEST_CONTACT, HOURLY_LIMIT, alertRecipients, buildAlertEmail, pickAttachments,
  isPermanent, problemText, handleNewRequest, createMailer,
} from '../request-alert.js';
import * as brand from '../../public/js/brand.js';
import { startSmtpSink } from './smtp-sink.js';

const request = (over = {}) => ({
  name: 'Pat Customer', company: 'Lake Dental', phone: '(863) 555-0100', email: 'pat@example.com', contactBy: 'text',
  service: 'shower', timeline: 'soon', siteAddress: '12 Lake Ave, Lakeland FL', details: 'Frameless door and panel.\n60 inch opening.',
  files: 0, site: 'stellar-glass', source: 'website', status: 'new', createdAt: Timestamp.fromDate(new Date('2026-10-11T14:05:00Z')), ...over,
});
const company = { name: 'Stellar Glass LLC', email: 'wes@stellarglassllc.com' };
const APP = 'https://stellar-glass-jobs.web.app';

describe('Quote request emails', () => {
  it('words the choices the way the quote form does', () => {
    assert.deepEqual(REQUEST_SERVICES, brand.REQUEST_SERVICES);
    assert.deepEqual(REQUEST_TIMELINES, brand.REQUEST_TIMELINES);
    assert.deepEqual(REQUEST_CONTACT, brand.REQUEST_CONTACT);
  });

  it('emails the business address until Settings says who', () => {
    assert.deepEqual(alertRecipients(company), ['wes@stellarglassllc.com']);
    assert.deepEqual(alertRecipients({ ...company, requestAlertEmails: ['office@example.com', ' Wes@StellarGlassLLC.com '] }), ['office@example.com', 'Wes@StellarGlassLLC.com']);
    assert.deepEqual(alertRecipients({ ...company, requestAlertEmails: [] }), [], 'saved blank means no emails');
    assert.deepEqual(alertRecipients({ ...company, requestAlertEmails: ['a@x.com', 'A@x.com', 'not an email', 'b@x', '', null] }), ['a@x.com']);
    assert.equal(alertRecipients({ requestAlertEmails: ['1@x.com', '2@x.com', '3@x.com', '4@x.com', '5@x.com', '6@x.com'] }).length, 5);
    assert.deepEqual(alertRecipients({}), []);
    assert.deepEqual(alertRecipients(undefined), []);
  });

  it('puts what Wes needs in the email', () => {
    const m = buildAlertEmail({ request: request(), requestId: 'r1', company, appUrl: APP });
    assert.equal(m.subject, 'Quote request from Pat Customer (Lake Dental): Frameless shower enclosure');
    assert.equal(m.replyTo, 'pat@example.com');
    assert.equal(m.fromName, 'Stellar Glass LLC website');
    for (const s of ['(863) 555-0100', 'pat@example.com', 'Prefers: Text message', 'In the next 1 to 3 months', '12 Lake Ave, Lakeland FL',
      'Frameless door and panel.\n60 inch opening.', `${APP}/#/requests/r1`, 'Sun, Oct 11, 10:05 AM', 'Reply to this email to answer Pat directly.']) {
      assert.ok(m.text.includes(s), `text has ${s}`);
    }
    assert.ok(!m.text.includes('Files:'), 'no files line without files');
    for (const s of ['href="tel:8635550100"', 'href="sms:8635550100"', 'href="mailto:pat@example.com?subject=Your%20quote%20request"',
      'https://www.google.com/maps/search/?api=1&amp;query=12%20Lake%20Ave%2C%20Lakeland%20FL', `href="${APP}/#/requests/r1"`,
      'Frameless door and panel.<br>60 inch opening.', 'Text Pat']) {
      assert.ok(m.html.includes(s), `html has ${s}`);
    }
  });

  it('escapes what the customer typed', () => {
    const m = buildAlertEmail({
      request: request({ name: 'Eve <script>alert(1)</script>', company: '', details: '<img src=x onerror=alert(1)> & "quotes"', email: 'x"><a@evil.com', phone: '' }),
      requestId: 'r/../x', company, appUrl: APP,
    });
    assert.ok(!m.html.includes('<script>') && !m.html.includes('<img src=x'));
    assert.ok(m.html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;'));
    assert.ok(m.html.includes('#/requests/r%2F..%2Fx'));
    assert.equal(m.replyTo, undefined, 'no reply-to for an address that isn\'t one');
    assert.ok(!m.html.includes('mailto:') && !m.html.includes('tel:'));
    assert.equal(m.subject, 'Quote request from Eve <script>alert(1)</script>: Frameless shower enclosure', 'subject is plain text');
    const lines = buildAlertEmail({ request: request({ name: 'Line\r\nBreak', company: 'Bcc: x@y.com\nZ' }), requestId: 'r', company, appUrl: APP });
    assert.ok(!/[\r\n]/.test(lines.subject));
  });

  it('says what happened to the photos', () => {
    const files = (fileCount, attached) => buildAlertEmail({ request: request(), requestId: 'r', company, appUrl: APP, fileCount, attached }).text.match(/Files: (.*)/)?.[1];
    assert.equal(files(3, 3), '3 attached');
    assert.equal(files(3, 1), '3 sent, 1 attached, the rest in the app');
    assert.equal(files(2, 0), '2 sent, too big to attach or still uploading, so see them in the app');
    const hold = buildAlertEmail({ request: request(), requestId: 'r', company, appUrl: APP, lastBeforeHold: true });
    assert.ok(hold.text.startsWith(`That's ${HOURLY_LIMIT} requests in the past hour`));
  });

  it('attaches photos and PDFs up to the size limit', () => {
    const f = (name, contentType, size) => ({ name, metadata: { contentType, size: String(size) } });
    const list = [f('0-a.jpg', 'image/jpeg', 4e6), f('1-b.pdf', 'application/pdf', 5e6), f('2-c.heic', 'image/heic', 3e6), f('3-d.zip', 'application/zip', 10), f('4-e.png', 'image/png', 1e6)];
    assert.deepEqual(pickAttachments(list, 10e6).map((x) => x.name), ['0-a.jpg', '1-b.pdf', '4-e.png']);
  });

  it('tells a refused login from a mail server that is down', () => {
    assert.equal(isPermanent({ code: 'EAUTH', responseCode: 535 }), true);
    assert.equal(isPermanent({ code: 'EENVELOPE', responseCode: 550 }), true);
    assert.equal(isPermanent({ code: 'ECONNECTION' }), false);
    assert.equal(isPermanent({ code: 'EMESSAGE', responseCode: 421 }), false);
    assert.match(problemText({ code: 'EAUTH' }), /app password/);
    assert.match(problemText({ code: 'ETIMEDOUT' }), /tries again/);
  });

  it('sends through a real mail server connection', async () => {
    const got = [];
    const server = await startSmtpSink({ port: 2526, onMessage: (m) => got.push(m) });
    try {
      const send = createMailer({ host: '127.0.0.1', port: 2526, user: 'alerts@example.com' });
      const mail = buildAlertEmail({ request: request(), requestId: 'r1', company, appUrl: APP, fileCount: 1, attached: 1 });
      await send({ ...mail, to: ['wes@stellarglassllc.com', 'office@example.com'], attachments: [{ filename: 'door.jpg', content: Buffer.from('jpeg bytes'), contentType: 'image/jpeg' }] });
      assert.equal(got.length, 1);
      assert.equal(got[0].from, 'alerts@example.com');
      assert.deepEqual(got[0].to, ['wes@stellarglassllc.com', 'office@example.com']);
      const raw = got[0].raw.toString();
      assert.match(raw, /^From: "?Stellar Glass LLC website"? <alerts@example\.com>/m);
      assert.match(raw, /^Reply-To: pat@example\.com/m);
      assert.match(raw, /filename=door\.jpg/);
      assert.match(raw, /Content-Type: text\/html/);

      // A refused login comes back as a permanent error.
      const strict = await startSmtpSink({ port: 2527, auth: 'reject' });
      try {
        const bad = createMailer({ host: '127.0.0.1', port: 2527, user: 'alerts@example.com', pass: 'wrong' });
        await assert.rejects(bad({ ...mail, to: ['wes@stellarglassllc.com'] }), (e) => isPermanent(e) && e.code === 'EAUTH');
      } finally { strict.close(); }
    } finally { server.close(); }
  });
});

describe('Quote request emails (with the emulators)', function () {
  this.timeout(30000);
  let app;
  let db;
  let bucket;
  let sent;
  let failNext;
  const C = 'stellar';
  const ref = (id) => db.doc(`companies/${C}/requests/${id}`);
  const send = async (m) => {
    if (failNext) { const e = failNext; failNext = null; throw e; }
    sent.push(m);
  };
  const run = (id, extra = {}) => handleNewRequest({ db, bucket, send, companyId: C, requestId: id, appUrl: APP, fileWaitMs: 3000, fileCheckMs: 200, ...extra });
  const add = async (id, over = {}) => { await ref(id).set(request({ createdAt: FieldValue.serverTimestamp(), ...over })); return id; };
  const upload = (id, name, contentType, bytes) => bucket.file(`companies/${C}/requests/${id}/${name}`).save(Buffer.from(bytes), { contentType });
  const alert = async (id) => (await ref(id).get()).data().alert;

  before(function () {
    if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) this.skip();
    // Its own project, so the rules tests' clearFirestore() doesn't touch this data.
    app = initializeApp({ projectId: 'demo-stellar-alerts', storageBucket: 'demo-stellar-alerts.appspot.com' }, 'alert-tests');
    db = getFirestore(app);
    bucket = getStorage(app).bucket();
  });
  after(async () => { if (app) await deleteApp(app); });

  beforeEach(async () => {
    sent = [];
    failNext = null;
    await db.recursiveDelete(db.collection('companies'));
    await bucket.deleteFiles({ prefix: 'companies/' }).catch(() => {});
    await db.doc(`companies/${C}`).set({ ...company, ownerUid: 'wes' });
  });

  it('emails each new request once, with its photos, and notes it on the request', async () => {
    await add('r1', { files: 2 });
    await upload('r1', '0-front door.jpg', 'image/jpeg', 'jpeg bytes');
    await upload('r1', '1-plan.pdf', 'application/pdf', 'pdf bytes');
    assert.deepEqual(await run('r1'), { status: 'sent', to: ['wes@stellarglassllc.com'], attached: 2 });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ['wes@stellarglassllc.com']);
    assert.deepEqual(sent[0].attachments.map((x) => [x.filename, x.contentType, x.content.toString()]),
      [['front door.jpg', 'image/jpeg', 'jpeg bytes'], ['plan.pdf', 'application/pdf', 'pdf bytes']]);
    assert.match(sent[0].text, /Files: 2 attached/);
    const a = await alert('r1');
    assert.equal(a.status, 'sent');
    assert.deepEqual(a.to, ['wes@stellarglassllc.com']);
    assert.equal(a.attached, 2);
    assert.equal(a.tries, 1);
    assert.ok(a.at instanceof Timestamp);
    // The same event again (they can repeat) sends nothing.
    assert.deepEqual(await run('r1'), { status: 'skipped', reason: 'already sent' });
    assert.equal(sent.length, 1);
  });

  it('waits for photos that are still uploading', async () => {
    await add('r2', { files: 2 });
    await upload('r2', '0-a.jpg', 'image/jpeg', 'first');
    setTimeout(() => { upload('r2', '1-b.jpg', 'image/jpeg', 'second'); }, 600);
    await run('r2');
    assert.deepEqual(sent[0].attachments.map((x) => x.filename), ['a.jpg', 'b.jpg']);
  });

  it('sends anyway when the photos never finish, and says so', async () => {
    await add('r3', { files: 3 });
    await upload('r3', '0-a.jpg', 'image/jpeg', 'only one');
    const started = Date.now();
    await run('r3', { fileWaitMs: 800 });
    assert.ok(Date.now() - started >= 800);
    assert.equal(sent[0].attachments.length, 1);
    assert.match(sent[0].text, /Files: 3 sent, 1 attached, the rest in the app/);
  });

  it('goes to the addresses saved in Settings, or nobody', async () => {
    await db.doc(`companies/${C}`).update({ requestAlertEmails: ['office@example.com', 'wes@stellarglassllc.com'] });
    await add('r4');
    await run('r4');
    assert.deepEqual(sent[0].to, ['office@example.com', 'wes@stellarglassllc.com']);

    await db.doc(`companies/${C}`).update({ requestAlertEmails: [] });
    await add('r5');
    assert.deepEqual(await run('r5'), { status: 'skipped', reason: 'no one to email (Settings)' });
    assert.equal(sent.length, 1);
    assert.equal((await alert('r5')).status, 'off');
  });

  it('tries again when the mail server is down, but not when the login is refused', async () => {
    await add('r6');
    failNext = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
    await assert.rejects(run('r6'), /Connection timeout/);
    let a = await alert('r6');
    assert.equal(a.status, 'failed');
    assert.match(a.error, /tries again/);
    // The retry goes through.
    assert.equal((await run('r6')).status, 'sent');
    a = await alert('r6');
    assert.equal(a.status, 'sent');
    assert.equal(a.tries, 2);
    assert.equal(a.error, undefined);

    await add('r7');
    failNext = Object.assign(new Error('Invalid login: 535 5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 });
    assert.equal((await run('r7')).status, 'failed');
    a = await alert('r7');
    assert.equal(a.status, 'failed');
    assert.match(a.error, /app password/);
  });

  it('leaves a request alone while another try is sending it', async () => {
    await add('r8');
    await ref('r8').update({ alert: { status: 'sending', at: Timestamp.now(), tries: 1 } });
    await assert.rejects(run('r8'), /still sending/);
    assert.equal(sent.length, 0);
    // One that died long ago is picked up.
    await ref('r8').update({ alert: { status: 'sending', at: Timestamp.fromMillis(Date.now() - 10 * 60 * 1000), tries: 1 } });
    assert.equal((await run('r8')).status, 'sent');
    assert.equal((await alert('r8')).tries, 2);
  });

  it('skips a request deleted before its email went out', async () => {
    assert.deepEqual(await run('gone'), { status: 'skipped', reason: 'request deleted' });
    assert.equal(sent.length, 0);
  });

  it('stops emailing during a flood of requests', async () => {
    const batch = db.batch();
    for (let i = 0; i < HOURLY_LIMIT - 1; i += 1) batch.set(ref(`old${i}`), request({ createdAt: Timestamp.fromMillis(Date.now() - 30 * 60 * 1000) }));
    // Older than an hour: doesn't count.
    batch.set(ref('yesterday'), request({ createdAt: Timestamp.fromMillis(Date.now() - 864e5) }));
    await batch.commit();
    await add('last');
    await run('last');
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /no more emails go out until it slows down/);
    await add('extra');
    assert.equal((await run('extra')).status, 'held');
    assert.equal(sent.length, 1);
    assert.equal((await alert('extra')).status, 'held');
  });
});
