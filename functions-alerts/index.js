// Cloud Functions for the Stellar Glass app: quote request emails. Setup steps are in EMAIL_ALERTS.md.
// Its own codebase ("alerts" in firebase.json), so it deploys on its own: npm run deploy:alerts.
//   requestAlert   emails the team each quote request from the website (who gets it: Settings > Website quote requests)
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret, defineString } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { handleNewRequest, createMailer } from './request-alert.js';

initializeApp();
const db = getFirestore();

// Scale to zero when idle and cap at two instances, which keeps the cost at or near $0.
setGlobalOptions({ region: 'us-central1', maxInstances: 2, memory: '256MiB' });

// The email account the alerts come from. Its address is saved in functions-alerts/.env.<project id> (the first
// deploy asks for it); its app password is stored in Google Secret Manager.
const EMAIL_USER = defineString('EMAIL_USER', {
  description: 'Email address the quote request alerts are sent from: a Gmail or Google Workspace account with an app password.',
});
const EMAIL_PASSWORD = defineSecret('EMAIL_PASSWORD');

const emulated = process.env.FUNCTIONS_EMULATOR === 'true';

// The app's address, for the link in the email: the project's Firebase Hosting site unless APP_URL says otherwise.
const appUrl = () => process.env.APP_URL || (emulated ? 'http://127.0.0.1:5000' : `https://${process.env.GCLOUD_PROJECT}.web.app`);

// Made on first use, when the secret can be read. Gmail's mail server unless SMTP_HOST and SMTP_PORT in
// functions-alerts/.env.<project id> name another (the emulator uses a fake one: test/smtp-sink.js).
let send;
const mailer = () => send || (send = createMailer({
  host: process.env.SMTP_HOST || undefined,
  port: Number(process.env.SMTP_PORT) || undefined,
  user: EMAIL_USER.value(),
  // Google shows app passwords in groups of four letters; the spaces aren't part of it.
  pass: EMAIL_PASSWORD.value().replace(/\s+/g, ''),
}));

export const requestAlert = onDocumentCreated({
  document: 'companies/{companyId}/requests/{requestId}',
  secrets: [EMAIL_PASSWORD],
  // Long enough to wait for the customer's photos to finish uploading (up to 2 minutes).
  timeoutSeconds: 300,
  // A failed send (the mail server didn't answer) is tried again; see the two-hour cutoff below.
  retry: true,
}, async (event) => {
  const { companyId, requestId } = event.params;
  // Retries would go on for a day. After two hours the alert is stale, and the request shows it failed.
  if (Date.now() - Date.parse(event.time) > 2 * 3600 * 1000) {
    logger.error('Quote request alert: stopped retrying', { companyId, requestId });
    return;
  }
  const result = await handleNewRequest({
    db,
    bucket: getStorage().bucket(),
    companyId,
    requestId,
    appUrl: appUrl(),
    send: (message) => mailer()(message),
  });
  logger.info('Quote request alert', { companyId, requestId, ...result });
});
