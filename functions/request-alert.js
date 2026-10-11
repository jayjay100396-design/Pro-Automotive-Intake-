// Emails the team when a customer sends a quote request from the public page (quote.html).
// The request is companies/{companyId}/requests/{requestId}. The photos and plans the customer picked upload
// right after it, one by one, to Cloud Storage under companies/{companyId}/requests/{requestId}/ (public/js/site.js).
// Who gets the email is set in the app under Settings > Website quote requests (requestAlertEmails on the company),
// and how it went is saved on the request as `alert`, which the app shows:
//   { status: 'sending' | 'sent' | 'failed' | 'off' | 'held', at, tries, to?, attached?, error? }
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import nodemailer from 'nodemailer';

// The form's choices, worded as in public/js/brand.js (functions/test/request-alert.test.js checks they match).
export const REQUEST_SERVICES = [
  ['storefront', 'Commercial storefront or entrance'],
  ['interior', 'Office or interior glass walls'],
  ['shower', 'Frameless shower enclosure'],
  ['railing', 'Glass railing'],
  ['other', 'Something else'],
];
export const REQUEST_TIMELINES = [
  ['', 'Not sure yet'],
  ['asap', 'As soon as possible'],
  ['soon', 'In the next 1 to 3 months'],
  ['later', 'More than 3 months out'],
  ['pricing', 'Just getting prices or bidding'],
];
export const REQUEST_CONTACT = [['phone', 'Phone call'], ['text', 'Text message'], ['email', 'Email']];

export const MAX_RECIPIENTS = 5;
// More requests than this in an hour looks like a spam attack, so the emails stop until it slows down.
// That also keeps the sending account under Gmail's daily limit.
export const HOURLY_LIMIT = 20;
// Photos and PDFs ride along up to this much in all (Gmail takes 25 MB per email after encoding).
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
// A try that has been 'sending' this long died (the function stops at 5 minutes), so another may take over.
const STALE_MS = 6 * 60 * 1000;
const TIME_ZONE = 'America/New_York';

const label = (pairs, key) => pairs.find(([k]) => k === key)?.[1] || key || '';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const EMAIL = /^[^\s@,;<>"()[\]]+@[^\s@,;<>"()[\]]+\.[a-z]{2,}$/i;
export const isEmail = (s) => EMAIL.test(String(s ?? '').trim());
// Plain addresses only go in mailto: links, where ? & # % would break the link.
const linkable = (s) => /^[A-Za-z0-9._+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(s);

// Who gets the email: the addresses saved in Settings, or the business email until that's been saved.
// Saving it blank (an empty list) turns the emails off.
export function alertRecipients(company = {}) {
  const list = Array.isArray(company.requestAlertEmails) ? company.requestAlertEmails : [company.email];
  const seen = new Set();
  return list.map((e) => String(e ?? '').trim()).filter((e) => {
    const key = e.toLowerCase();
    if (!isEmail(e) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_RECIPIENTS);
}

const fmtWhen = (ts) => (ts?.toDate ? ts.toDate() : new Date()).toLocaleString('en-US', {
  timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

// What the email says about the photos and plans.
function filesLine(fileCount, attached) {
  if (!fileCount) return '';
  if (attached >= fileCount) return `${fileCount} attached`;
  if (!attached) return `${fileCount} sent, too big to attach or still uploading, so see them in the app`;
  return `${fileCount} sent, ${attached} attached, the rest in the app`;
}

// The email for one request: subject, plain text and HTML. Everything the customer typed is escaped.
export function buildAlertEmail({ request: r, requestId, company = {}, appUrl, fileCount = 0, attached = 0, lastBeforeHold = false }) {
  const name = oneLine(r.name) || 'A customer';
  const firstName = name.split(' ')[0];
  const service = label(REQUEST_SERVICES, r.service);
  const timeline = label(REQUEST_TIMELINES, r.timeline || '');
  const prefers = label(REQUEST_CONTACT, r.contactBy);
  const phone = oneLine(r.phone);
  const email = oneLine(r.email);
  const dial = phone.replace(/[^\d+]/g, '');
  const site = oneLine(r.siteAddress);
  const details = String(r.details ?? '').trim();
  const link = `${appUrl}/#/requests/${encodeURIComponent(requestId)}`;
  const files = filesLine(fileCount, attached);
  const when = fmtWhen(r.createdAt);
  const business = oneLine(company.name) || 'Stellar Glass';
  const holdNote = lastBeforeHold
    ? `That's ${HOURLY_LIMIT} requests in the past hour, which looks like spam, so no more emails go out until it slows down. Every request is still saved under Requests in the app.`
    : '';
  const replyNote = isEmail(email) ? `Reply to this email to answer ${firstName} directly.` : '';

  const subject = `Quote request from ${name}${r.company ? ` (${oneLine(r.company)})` : ''}: ${service}`;

  const rows = [
    ['Phone', phone],
    ['Email', email],
    ['Prefers', prefers],
    ['Service', service],
    ['Timeline', timeline],
    ['Site', site || 'No address given'],
    ['Files', files],
  ].filter(([, v]) => v);

  const text = [
    ...(holdNote ? [holdNote, ''] : []),
    `New quote request from the website, ${when}`,
    '',
    name + (r.company ? `, ${oneLine(r.company)}` : ''),
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    'What they need:',
    details,
    '',
    `Open it in the app: ${link}`,
    ...(replyNote ? [replyNote] : []),
  ].join('\n') + '\n';

  // HTML: inline styles and tables, which is what email apps (Gmail, Outlook, iPhone Mail) handle reliably.
  const muted = 'color:#5b6b7d';
  const a = (href, body) => `<a href="${esc(href)}" style="color:#0071bc;text-decoration:none">${body}</a>`;
  const value = {
    Phone: dial ? a(`tel:${dial}`, esc(phone)) : esc(phone),
    Email: linkable(email) ? a(`mailto:${email}`, esc(email)) : esc(email),
    Site: site ? a(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(site)}`, esc(site)) : 'No address given',
  };
  const button = (href, body, primary) => `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border-radius:6px;font-weight:bold;font-size:15px;text-decoration:none;${primary ? 'background:#0071bc;color:#ffffff' : 'background:#e8f1fa;color:#123764'}">${body}</a>`;
  const actions = [
    dial && button(`tel:${dial}`, `Call ${esc(firstName)}`, r.contactBy === 'phone'),
    dial && button(`sms:${dial}`, `Text ${esc(firstName)}`, r.contactBy === 'text'),
    linkable(email) && button(`mailto:${email}?subject=${encodeURIComponent('Your quote request')}`, `Email ${esc(firstName)}`, r.contactBy === 'email'),
  ].filter(Boolean).join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eef2f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f6"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;font-family:Arial,Helvetica,sans-serif;color:#1d2733">
  <tr><td style="background:#123764;padding:18px 24px;border-radius:8px 8px 0 0">
    <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#a9c4e6">New quote request · ${esc(when)}</div>
    <div style="font-size:22px;font-weight:bold;color:#ffffff;margin-top:6px">${esc(name)}</div>
    <div style="font-size:15px;color:#dbe7f5;margin-top:2px">${r.company ? `${esc(oneLine(r.company))} · ` : ''}${esc(service)}</div>
  </td></tr>
  ${holdNote ? `<tr><td style="padding:14px 24px 0"><div style="background:#fff4d6;border-radius:6px;padding:10px 12px;font-size:14px;color:#6b4e00">${esc(holdNote)}</div></td></tr>` : ''}
  ${actions ? `<tr><td style="padding:18px 24px 6px">${actions}</td></tr>` : ''}
  <tr><td style="padding:8px 24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;line-height:1.45">
      ${rows.map(([k, v]) => `<tr><td style="${muted};padding:5px 12px 5px 0;width:84px;vertical-align:top">${k}</td><td style="padding:5px 0;vertical-align:top">${value[k] ?? esc(v)}</td></tr>`).join('\n      ')}
    </table>
  </td></tr>
  <tr><td style="padding:10px 24px 4px">
    <div style="${muted};font-size:13px;margin-bottom:6px">What they need</div>
    <div style="background:#f4f7fa;border-left:3px solid #0071bc;padding:12px 14px;font-size:15px;line-height:1.5">${esc(details).replace(/\r?\n/g, '<br>')}</div>
  </td></tr>
  <tr><td style="padding:18px 24px 22px">${button(link, 'Open the request in the app', true)}</td></tr>
  <tr><td style="padding:14px 24px;background:#f6f8fa;border-radius:0 0 8px 8px;${muted};font-size:12px;line-height:1.5">
    ${replyNote ? `${esc(replyNote)} ` : ''}Sent by the ${esc(business)} app because this address is under Settings &gt; Website quote requests.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject, text, html, replyTo: isEmail(email) ? email : undefined, fromName: `${business} website` };
}

// The customer's files for a request, in the order they added them ("0-photo.jpg", "1-plan.pdf", ...).
const fileNumber = (f) => Number(f.name.split('/').pop().match(/^(\d+)-/)?.[1] ?? 999);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The files upload one at a time after the request is saved. Waits until all `expected` are there, or maxWaitMs.
export async function waitForFiles({ bucket, prefix, expected, maxWaitMs = 120000, everyMs = 4000 }) {
  const start = Date.now();
  for (;;) {
    const [files] = await bucket.getFiles({ prefix });
    if (files.length >= expected || Date.now() - start >= maxWaitMs) return files.sort((x, y) => fileNumber(x) - fileNumber(y));
    await sleep(everyMs);
  }
}

// Photos and PDFs that fit, in order, up to ATTACH_MAX_BYTES in all.
export function pickAttachments(files, maxBytes = ATTACH_MAX_BYTES) {
  let total = 0;
  return files.filter((f) => {
    const size = Number(f.metadata?.size) || 0;
    if (!/^(image\/|application\/pdf$)/.test(f.metadata?.contentType || '') || total + size > maxBytes) return false;
    total += size;
    return true;
  });
}

// Sends email through a mail server: Gmail's unless host and port say otherwise. `user` is also the From address.
export function createMailer({ host = 'smtp.gmail.com', port = 465, user, pass }) {
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: pass ? { user, pass } : undefined,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
  });
  return ({ fromName, ...message }) => transport.sendMail({ ...message, from: { name: fromName, address: user } });
}

// Errors another try won't fix: the login was refused, or an address was rejected.
export const isPermanent = (e) => e?.code === 'EAUTH' || e?.code === 'EENVELOPE' || (e?.responseCode >= 500 && e?.responseCode < 600);

// The problem in words for the app (Settings and the request page).
export function problemText(e) {
  if (e?.code === 'EAUTH') return 'The email account that sends these refused the login. It needs a new app password (EMAIL_ALERTS.md, steps 1 and 2).';
  if (isPermanent(e)) return `The email server refused it: ${oneLine(e.response || e.message).slice(0, 200)}`;
  return `Couldn't send it yet (${oneLine(e?.code || e?.message || 'unknown error').slice(0, 120)}). It tries again for two hours.`;
}

// Sends the email for one new request and saves how it went on the request (`alert`, above).
// Returns what happened. Throws when it should be tried again later (the email server didn't answer, or another
// try is still sending), which the function's retries take care of.
export async function handleNewRequest({ db, bucket, send, companyId, requestId, appUrl, fileWaitMs = 120000, fileCheckMs = 4000 }) {
  const ref = db.doc(`companies/${companyId}/requests/${requestId}`);
  const companyRef = db.doc(`companies/${companyId}`);

  // Claim it first, so a repeated event doesn't send a second email.
  const claim = await db.runTransaction(async (tx) => {
    const [snap, co] = await tx.getAll(ref, companyRef);
    if (!snap.exists) return { skip: 'request deleted' };
    const r = snap.data();
    const prev = r.alert || {};
    if (['sent', 'off', 'held'].includes(prev.status)) return { skip: `already ${prev.status}` };
    if (prev.status === 'sending' && Date.now() - (prev.at?.toMillis?.() ?? 0) < STALE_MS) {
      throw Object.assign(new Error('Another try is still sending this alert.'), { busy: true });
    }
    const to = alertRecipients(co.exists ? co.data() : {});
    const tries = (prev.tries || 0) + 1;
    if (!to.length) {
      tx.update(ref, { alert: { status: 'off', at: FieldValue.serverTimestamp(), tries } });
      return { skip: 'no one to email (Settings)' };
    }
    tx.update(ref, { alert: { status: 'sending', at: FieldValue.serverTimestamp(), tries } });
    return { request: r, company: co.data(), to, tries };
  });
  if (claim.skip) return { status: 'skipped', reason: claim.skip };
  const { request, company, to, tries } = claim;

  const record = (alert) => ref.update({ alert: { ...alert, at: FieldValue.serverTimestamp(), tries } }).catch((e) => {
    if (e.code !== 5) throw e; // 5 = NOT_FOUND: the request was deleted meanwhile
  });

  let sent = false;
  try {
    const since = Timestamp.fromMillis(Date.now() - 3600 * 1000);
    const lastHour = (await db.collection(`companies/${companyId}/requests`).where('createdAt', '>=', since).count().get()).data().count;
    if (lastHour > HOURLY_LIMIT) {
      await record({ status: 'held', error: `More than ${HOURLY_LIMIT} requests came in within an hour, so this one wasn't emailed.` });
      return { status: 'held', lastHour };
    }

    const fileCount = Number(request.files) || 0;
    const files = fileCount ? await waitForFiles({ bucket, prefix: `companies/${companyId}/requests/${requestId}/`, expected: fileCount, maxWaitMs: fileWaitMs, everyMs: fileCheckMs }) : [];
    // A file that won't download is left for the app rather than holding up the email.
    const downloads = await Promise.allSettled(pickAttachments(files).map(async (f) => ({
      filename: f.name.split('/').pop().replace(/^\d+-/, ''),
      content: (await f.download())[0],
      contentType: f.metadata.contentType,
    })));
    const attachments = downloads.filter((d) => d.status === 'fulfilled').map((d) => d.value);

    const mail = buildAlertEmail({
      request, requestId, company, appUrl, fileCount: Math.max(fileCount, files.length), attached: attachments.length, lastBeforeHold: lastHour === HOURLY_LIMIT,
    });
    await send({ ...mail, to, attachments });
    sent = true;
    await record({ status: 'sent', to, attached: attachments.length });
    return { status: 'sent', to, attached: attachments.length };
  } catch (e) {
    // The email went out but noting it failed: a retry would send it twice, so leave it.
    if (sent) return { status: 'sent', to, unrecorded: e.message };
    await record({ status: 'failed', error: problemText(e) });
    if (!isPermanent(e)) throw e;
    return { status: 'failed', error: e.message };
  }
}
