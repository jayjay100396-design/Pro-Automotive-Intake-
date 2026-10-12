// Emails a parts request to its supplier when someone presses "Send from the app" (public/js/parts.js), through the
// supplier email account (SUPPLIER_EMAIL_USER, EMAIL_ALERTS.md). The email is built from the request as it's
// saved, by parts-email.js: the same code the app uses for its preview, so what Wes sees is what goes out.
//
// Who can send: the business's owners, admins and staff. Who it goes to: the supplier's saved addresses (Suppliers,
// which only owners and admins change), with copies to the person sending and the office as the request says;
// never an address from the call itself. Each business sends up to DAILY_LIMIT supplier emails a day, counted in
// emailUsage/{companyId}, which nothing but this server can read or write.
// How it went is saved on the request as `appEmail` { status: 'sending' | 'sent' | 'failed', sendId, what, at, by,
// to, cc, attached, error }, with a line in its history, and sending the request or the order moves it along.
import { FieldValue } from 'firebase-admin/firestore';
import { buildPartsEmail, recipients, requestProblems, fromName, MESSAGES, MAX_ATTACHMENTS, MAX_ATTACH_BYTES, MAX_NOTE } from './parts-email.js';
import { isPermanent } from './mailer.js';

export const DAILY_LIMIT = 40;
// A send that has been 'sending' this long died (the function stops at 2 minutes), so another may go.
const STALE_MS = 3 * 60 * 1000;
const TIME_ZONE = 'America/New_York';
const LABEL = { request: 'Request', order: 'Order', followup: 'Update request' };

// The day in Florida, "YYYY-MM-DD": the daily count starts over at midnight there.
export const floridaDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TIME_ZONE });

// A problem the person can do something about. `code` is what the app gets (a callable function error code).
export class SendError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);

// The problem in words for the app.
export function problemText(e) {
  if (e instanceof SendError) return e.message;
  if (e?.code === 'EAUTH') return 'The email account supplier emails come from refused the login. It needs a new app password (EMAIL_ALERTS.md, Parts requests to suppliers). Use Open in Gmail for now.';
  if (isPermanent(e)) return `The email server refused it: ${oneLine(e.response || e.message).slice(0, 200)}`;
  return 'Couldn\'t reach the email server. Try again in a minute, or use Open in Gmail.';
}

// The job files picked for the email: they must be this job's, in this business's folder, and fit the limits.
async function loadAttachments({ db, bucket, companyId, request }) {
  const ids = [...new Set(Array.isArray(request.attachments) ? request.attachments : [])];
  if (!ids.length) return [];
  if (ids.length > MAX_ATTACHMENTS) throw new SendError('failed-precondition', `Attach up to ${MAX_ATTACHMENTS} files.`);
  if (!isId(request.jobId) || !ids.every(isId)) throw new SendError('failed-precondition', 'Only the job\'s own files can go with the email.');
  const snaps = await db.getAll(...ids.map((f) => db.doc(`companies/${companyId}/files/${f}`)));
  let total = 0;
  const picked = [];
  for (const snap of snaps) {
    if (!snap.exists) throw new SendError('failed-precondition', 'One of the files picked to go with it was deleted. Untick it and send again.');
    const f = snap.data();
    const name = oneLine(f.name) || 'file';
    if (f.jobId !== request.jobId || typeof f.path !== 'string' || !f.path.startsWith(`companies/${companyId}/`)) {
      throw new SendError('failed-precondition', `${name} isn't one of this job's files.`);
    }
    const file = bucket.file(f.path);
    let meta;
    try { [meta] = await file.getMetadata(); } catch (e) {
      if (e.code === 404) throw new SendError('failed-precondition', `${name} is missing from storage. Untick it and send again.`);
      throw e;
    }
    // The stored size, not the record's, counts.
    total += Number(meta.size) || 0;
    if (total > MAX_ATTACH_BYTES) throw new SendError('failed-precondition', `The files come to more than ${MAX_ATTACH_BYTES / 1024 / 1024} MB. Leave some out.`);
    picked.push({ file, filename: name, contentType: meta.contentType || 'application/octet-stream' });
  }
  return Promise.all(picked.map(async (a) => ({ filename: a.filename, contentType: a.contentType, content: (await a.file.download())[0] })));
}

// Sends one email about a parts request: `what` is 'request' (the request itself), 'order' (placing the order the
// supplier quoted) or 'followup' (asking for an update), which can carry a `note` typed for that email. `sendId` is
// new for each press of the button, so a call that's repeated (a double click, a retry) sends nothing more.
// Returns { status, to, cc, attached }; throws a SendError the app shows when it can't go.
export async function handlePartsEmail({ db, bucket, send, uid, token = {}, data = {}, now = new Date() }) {
  const { companyId, requestId, what = 'request', sendId, note } = data || {};
  if (!uid) throw new SendError('unauthenticated', 'Sign in to email suppliers.');
  if (!isId(companyId) || !isId(requestId) || !MESSAGES.includes(what) || !isId(sendId) || sendId.length < 8) {
    throw new SendError('invalid-argument', 'That request can\'t be emailed.');
  }
  const ref = db.doc(`companies/${companyId}/partsRequests/${requestId}`);
  const usageRef = db.doc(`emailUsage/${companyId}`);
  const today = floridaDay(now);

  // Checks and claims it in one transaction, so two presses can't both send it.
  const claim = await db.runTransaction(async (tx) => {
    const [member, co, snap, usage] = await tx.getAll(db.doc(`companies/${companyId}/members/${uid}`), db.doc(`companies/${companyId}`), ref, usageRef);
    if (!member.exists || !['owner', 'admin', 'staff'].includes(member.data().role)) throw new SendError('permission-denied', 'Your role can\'t email suppliers.');
    if (!snap.exists) throw new SendError('not-found', 'This parts request was deleted.');
    const request = snap.data();
    const prev = request.appEmail || {};
    if (prev.sendId === sendId) return { duplicate: prev };
    if (prev.status === 'sending' && now.getTime() - (prev.at?.toMillis?.() ?? 0) < STALE_MS) {
      throw new SendError('aborted', 'Another email about this request is still going out. Wait a minute, then check its history.');
    }
    if (!isId(request.supplierId)) throw new SendError('failed-precondition', 'Pick the supplier first.');
    const s = await tx.get(db.doc(`companies/${companyId}/suppliers/${request.supplierId}`));
    if (!s.exists) throw new SendError('failed-precondition', 'That supplier was deleted. Pick another one.');
    const supplier = s.data();
    const company = co.exists ? co.data() : {};
    const { to, cc } = recipients({ request, supplier, company, senderEmail: token.email || '' });
    if (!to.length) throw new SendError('failed-precondition', `There's no email saved for ${oneLine(supplier.name) || 'this supplier'}. Add it under Suppliers, or use Open in Gmail.`);
    if (what !== 'followup') {
      const problems = requestProblems(request);
      if (problems.length) throw new SendError('failed-precondition', problems[0]);
    }
    const used = usage.exists && usage.data().day === today ? Number(usage.data().count) || 0 : 0;
    if (used >= DAILY_LIMIT) {
      throw new SendError('resource-exhausted', `The app has sent ${DAILY_LIMIT} supplier emails today, the most it sends in a day. Use Open in Gmail, or send it tomorrow.`);
    }
    tx.set(usageRef, { day: today, count: used + 1 });
    tx.update(ref, { appEmail: { status: 'sending', sendId, what, at: FieldValue.serverTimestamp(), by: uid } });
    return { request, supplier, company, to, cc, senderName: oneLine(token.name || member.data().name) };
  });
  if (claim.duplicate) return { status: claim.duplicate.status, to: claim.duplicate.to || [], cc: claim.duplicate.cc || [], duplicate: true };

  const { request, supplier, company, to, cc, senderName } = claim;
  const by = senderName || token.email || 'Someone';
  const record = (fields) => ref.update(fields).catch((e) => {
    if (e.code !== 5) throw e; // 5 = NOT_FOUND: the request was deleted meanwhile
  });

  let sent = false;
  try {
    const job = isId(request.jobId) ? (await db.doc(`companies/${companyId}/jobs/${request.jobId}`).get()).data() || {} : {};
    const files = what === 'request' ? await loadAttachments({ db, bucket, companyId, request }) : [];
    const mail = buildPartsEmail({
      request, supplier, job, company, attachments: files.map((f) => f.filename), note: typeof note === 'string' ? note.slice(0, MAX_NOTE) : '',
    }, what);
    await send({
      ...mail, to, cc, replyTo: token.email || company.email || undefined, fromName: fromName(senderName, company), attachments: files,
    });
    sent = true;

    const fields = {
      appEmail: { status: 'sent', sendId, what, at: FieldValue.serverTimestamp(), by: uid, to, cc, attached: files.map((f) => f.filename) },
      lastEmail: { what, via: 'app', at: now.toISOString() },
    };
    if (what === 'request' && request.status === 'draft') {
      fields.status = request.kind === 'order' ? 'ordered' : 'sent';
      fields[request.kind === 'order' ? 'orderedOn' : 'requestedOn'] = today;
    }
    if (what === 'order' && ['draft', 'sent', 'quoted'].includes(request.status)) Object.assign(fields, { status: 'ordered', kind: 'order', orderedOn: today });
    fields.events = FieldValue.arrayUnion({
      at: now.toISOString(), status: fields.status || request.status, note: `${LABEL[what]} emailed from the app to ${to.join(', ')}`, by,
    });
    await record(fields);
    return { status: 'sent', to, cc, attached: files.length };
  } catch (e) {
    // The email went out but noting it failed: say it went, rather than have someone send it twice.
    if (sent) return { status: 'sent', to, cc, unrecorded: e.message };
    await record({ appEmail: { status: 'failed', sendId, what, at: FieldValue.serverTimestamp(), by: uid, error: problemText(e) } });
    if (e instanceof SendError) throw e;
    throw Object.assign(new SendError(isPermanent(e) ? 'failed-precondition' : 'unavailable', problemText(e)), { cause: e });
  }
}
