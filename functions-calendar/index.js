// Cloud Functions for the Stellar Glass app: Google Calendar sync. Setup steps are in CALENDAR_SETUP.md.
// Its own codebase ("calendar" in firebase.json), so it deploys on its own.
//   calendarAccount  callable from the app: status, connect, calendars, choose, resync, disconnect (account.js)
//   calendarSync     copies each change to the schedule to the connected Google Calendars (sync.js)
// No secrets: the Google sign-in client is read from Firebase Auth with the functions' own service account.
import { onCall } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import * as logger from 'firebase-functions/logger';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { DEFAULT_BASES, makeClientLoader } from './google.js';
import { handleAccountCall } from './account.js';
import { handleEventWrite } from './sync.js';

initializeApp();
const db = getFirestore();

// Scale to zero when idle and cap at two instances, which keeps the cost at or near $0.
setGlobalOptions({ region: 'us-central1', maxInstances: 2, memory: '256MiB' });

const emulated = process.env.FUNCTIONS_EMULATOR === 'true';

// Access tokens for the connected Google accounts, kept between calls while an instance stays warm (memory only).
const tokenCache = new Map();

// Made on first use, after the runtime has loaded functions-calendar/.env.<project id>. The emulator's
// (.env.demo-stellar-glass) points everything at the fake Google server, test/fake-google.js.
let deps;
function getDeps() {
  if (deps) return deps;
  const env = process.env;
  const projectId = env.GCLOUD_PROJECT || JSON.parse(env.FIREBASE_CONFIG || '{}').projectId;
  deps = {
    db,
    fetch: globalThis.fetch,
    logger,
    tokenCache,
    oauthBase: env.GOOGLE_OAUTH_BASE || DEFAULT_BASES.oauth,
    calendarBase: env.GOOGLE_CALENDAR_BASE || DEFAULT_BASES.calendar,
    // The app's address, for the links on calendar events: the project's Firebase Hosting site unless APP_URL says otherwise.
    appUrl: (env.APP_URL || (emulated ? 'http://127.0.0.1:5000' : `https://${projectId}.web.app`)).replace(/\/+$/, ''),
    oauthClient: makeClientLoader({
      idtkBase: env.GOOGLE_IDTK_BASE || DEFAULT_BASES.idtk,
      projectId,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      getAdminToken: async () => (await applicationDefault().getAccessToken()).access_token,
      logger,
    }),
  };
  return deps;
}

export const calendarAccount = onCall({
  // Connecting copies the whole schedule to the new calendar, which can take a while for a busy one.
  timeoutSeconds: 300,
}, (request) => handleAccountCall({ ...getDeps(), auth: request.auth, data: request.data }));

export const calendarSync = onDocumentWritten({
  document: 'companies/{companyId}/events/{eventId}',
  // A change Google didn't take (busy or down) is tried again; see the one-hour cutoff in handleEventWrite.
  retry: true,
  timeoutSeconds: 120,
}, async (event) => {
  const { companyId, eventId } = event.params;
  const before = event.data?.before?.exists ? event.data.before.data() : null;
  const result = await handleEventWrite({ ...getDeps(), companyId, eventId, before, eventTime: event.time });
  logger.info('Calendar sync', { companyId, eventId, result });
});
