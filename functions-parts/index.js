// Cloud Functions for the Stellar Glass app: parts requests emailed to suppliers. Setup steps are in EMAIL_ALERTS.md
// (Parts requests to suppliers). Its own codebase ("parts" in firebase.json), so it deploys on its own
// (npm run deploy:parts), and the quote request emails (functions-alerts) never need its settings to deploy.
//   sendPartsEmail   emails a parts request to its supplier when someone presses Send from the app (Parts orders)
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret, defineString } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { createMailer } from './mailer.js';
import { handlePartsEmail, SendError } from './parts-request.js';

initializeApp();
const db = getFirestore();

// Scale to zero when idle and cap at two instances, which keeps the cost at or near $0.
setGlobalOptions({ region: 'us-central1', maxInstances: 2, memory: '256MiB' });

// The account supplier emails come from. Suppliers see its address, so it's best as Wes's own. It's kept apart from
// the quote request alerts' account (EMAIL_USER) because the alerts go to Wes, and Gmail can file an email an account
// sends to itself under Sent instead of the inbox. Its address is saved in functions-parts/.env.<project id> (the
// first deploy asks for it; kept out of git, since the repo is public); its app password is in Google Secret Manager.
const SUPPLIER_EMAIL_USER = defineString('SUPPLIER_EMAIL_USER', {
  description: 'Email address supplier emails (Parts orders) are sent from, which suppliers see: ideally Wes\'s own, with an app password.',
});
const SUPPLIER_EMAIL_PASSWORD = defineSecret('SUPPLIER_EMAIL_PASSWORD');

// Made on first use, when the secret can be read. Gmail's mail server unless SMTP_HOST and SMTP_PORT in
// functions-parts/.env.<project id> name another (the emulator uses a fake one: functions-alerts/test/smtp-sink.js).
let send;
const mailer = () => send || (send = createMailer({
  host: process.env.SMTP_HOST || undefined,
  port: Number(process.env.SMTP_PORT) || undefined,
  user: SUPPLIER_EMAIL_USER.value(),
  // Google shows app passwords in groups of four letters; the spaces aren't part of it.
  pass: SUPPLIER_EMAIL_PASSWORD.value().replace(/\s+/g, ''),
}));

// Called by the app (public/js/parts.js) with { companyId, requestId, what, sendId }. Only signed-in members of that
// business with an editing role get anything sent, and only to the supplier's saved addresses (parts-request.js).
export const sendPartsEmail = onCall({
  secrets: [SUPPLIER_EMAIL_PASSWORD],
  // Room for attachments: up to 15 MB of the job's files go along.
  timeoutSeconds: 120,
  memory: '512MiB',
}, async (request) => {
  try {
    const result = await handlePartsEmail({
      db,
      bucket: getStorage().bucket(),
      send: (message) => mailer()(message),
      uid: request.auth?.uid,
      token: request.auth?.token,
      data: request.data,
    });
    logger.info('Parts request email', { companyId: request.data?.companyId, requestId: request.data?.requestId, what: request.data?.what, status: result.status });
    return result;
  } catch (e) {
    if (e instanceof SendError) {
      if (e.cause) logger.warn('Parts request email failed', { requestId: request.data?.requestId, error: e.cause.message });
      throw new HttpsError(e.code, e.message);
    }
    logger.error('Parts request email', e);
    throw new HttpsError('internal', 'The email didn\'t go out. Try again, or use Open in Gmail.');
  }
});
