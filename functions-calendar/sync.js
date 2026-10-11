// Copies the app's schedule to Google Calendar, one way: the app is the master copy and nothing is read back from
// Google. index.js wires this to Cloud Functions; the tests call it directly with the Firestore emulator and the fake
// Google server (test/fake-google.js).
//
// Each Google Calendar connection ("link") of a business has two documents, written only by this code:
//   companies/{companyId}/calendarLinks/{linkId}   what members see: { kind, uid, holderName, email, calendarId,
//       calendarName, appCalendar, canPick, status: 'syncing'|'on'|'paused'|'error', error, connectedAt, syncedAt, count }
//   companies/{companyId}/calendarTokens/{linkId}  the Google access, which no app user can read: { kind, uid, email,
//       emailKey, refreshToken, scopes, calendarId, calendarName, appCalendar, connectedAt, needsFullSync? }
// linkId is 'business' for the business calendar (the owner's Google account, every event), or a member's uid for
// their own schedule (the events they're assigned to). needsFullSync is set while a full sync hasn't finished, so
// the next schedule change finishes it. emailKey is the Google account's email in lower case, which finds the same
// account's access in every business (the collection-group index on it is in firestore.indexes.json).
//
// Only events the app made are ever changed or deleted in Google: each carries extendedProperties.private.stellar =
// '1', and every list of events acted on is filtered by it. A calendar is deleted only if the app made it and nothing
// at all is left in it.
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { DEFAULT_BASES, GoogleError, createCalendarApi, createSession, hasPickScopes, revokeToken } from './google.js';
import { MESSAGES } from './messages.js';
import {
  DEFAULT_TIME_ZONE, REPEATS, addDays, buildGoogleEvent, googleEventId, isTimeZone, isWanted, shortCompanyName, windowStartFor,
} from './mapping.js';

const HOUR_MS = 3600e3;
const SYNCED_AT_EVERY_MS = 60e3;
const CONCURRENCY = 4;
const MAX_PAGES = 200;
const quiet = { info() {}, warn() {}, error() {} };

// What every function here needs (`deps`): db (Firestore), fetch, oauthBase and calendarBase (Google's addresses),
// oauthClient (async () => ({ clientId, clientSecret })), appUrl, now (the clock), sleep (waits between retries),
// logger, and tokenCache (a Map, optional). This fills in the ones left out.
export function withDefaults(deps) {
  const out = {
    fetch: globalThis.fetch,
    oauthBase: DEFAULT_BASES.oauth,
    calendarBase: DEFAULT_BASES.calendar,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    logger: quiet,
    tokenCache: null,
  };
  for (const [key, value] of Object.entries(deps)) if (value !== undefined) out[key] = value;
  return out;
}

export const tokenRef = (db, companyId, linkId) => db.doc(`companies/${companyId}/calendarTokens/${linkId}`);
export const linkRef = (db, companyId, linkId) => db.doc(`companies/${companyId}/calendarLinks/${linkId}`);
const enc = encodeURIComponent;
export const emailKey = (email) => String(email ?? '').trim().toLowerCase();
export const sameEmail = (a, b) => !!a && !!b && emailKey(a) === emailKey(b);
const isNotFound = (e) => e?.code === 5; // Firestore's NOT_FOUND
const ignoreNotFound = (e) => { if (!isNotFound(e)) throw e; };
const isDocId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 1500 && !id.includes('/') && id !== '.' && id !== '..';
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

// Updates a link's public status. A link disconnected meanwhile stays gone.
export async function updateLink(db, companyId, linkId, fields) {
  await linkRef(db, companyId, linkId).update(fields).catch(ignoreNotFound);
}

// A Calendar API client acting as a link's Google account. With a linkId, scopes a refresh turns up are saved on the
// token, and canPick on the link (a refresh token reused from another link may cover less than the sign-in did).
export function apiFor(deps, { companyId, linkId = null, token, accessToken, expiresAt }) {
  const onScope = linkId && (async (scopes) => {
    token.scopes = scopes;
    try {
      await deps.db.runTransaction(async (tx) => {
        const [t, l] = await tx.getAll(tokenRef(deps.db, companyId, linkId), linkRef(deps.db, companyId, linkId));
        // Only if the link still uses this access (a new connection may have replaced it).
        if (!t.exists || t.data().refreshToken !== token.refreshToken) return;
        tx.update(t.ref, { scopes });
        if (l.exists) tx.update(l.ref, { canPick: hasPickScopes(scopes) });
      });
    } catch (e) {
      deps.logger.warn('Calendar sync: couldn\'t save the Google access scopes', { companyId, linkId, error: e.message });
    }
  });
  const session = createSession({
    fetch: deps.fetch, oauthBase: deps.oauthBase, loadClient: deps.oauthClient, refreshToken: token.refreshToken, accessToken, expiresAt,
    scope: token.scopes || '', now: deps.now, sleep: deps.sleep, cache: deps.tokenCache, onScope: onScope || null,
  });
  return createCalendarApi({ fetch: deps.fetch, calendarBase: deps.calendarBase, session, sleep: deps.sleep });
}

// The business, its team and its calendar links, as a sync needs them.
export async function loadContext(db, companyId) {
  const co = db.doc(`companies/${companyId}`);
  const [companySnap, membersSnap, linksSnap] = await Promise.all([co.get(), co.collection('members').get(), co.collection('calendarLinks').get()]);
  const data = companySnap.data() || {};
  return {
    companyId,
    company: {
      ownerUid: data.ownerUid || '',
      name: data.name || '',
      timeZone: isTimeZone(data.timeZone) ? data.timeZone : DEFAULT_TIME_ZONE,
      short: shortCompanyName(data.name),
    },
    members: new Map(membersSnap.docs.map((d) => [d.id, d.data()])),
    links: new Map(linksSnap.docs.map((d) => [d.id, d.data()])),
  };
}

// The customers and jobs some events point to, read in one go.
async function recordsFor(db, companyId, events) {
  const read = async (collection, ids) => {
    const found = new Map();
    for (const part of chunks([...new Set(ids.filter(isDocId))], 100)) {
      const snaps = await db.getAll(...part.map((id) => db.doc(`companies/${companyId}/${collection}/${id}`)));
      for (const s of snaps) if (s.exists) found.set(s.id, s.data());
    }
    return found;
  };
  const [customers, jobs] = await Promise.all([read('customers', events.map((e) => e.customerId)), read('jobs', events.map((e) => e.jobId))]);
  return { customers, jobs };
}

const bodyFor = (deps, ctx, token, eventId, event, records) => buildGoogleEvent({
  eventId,
  event,
  link: token,
  company: ctx.company,
  members: ctx.members,
  customer: records.customers.get(event.customerId) || null,
  job: records.jobs.get(event.jobId) || null,
  appUrl: deps.appUrl,
});

// Runs fn on each item, four at a time. handle(e, item) decides about a failure: true carries on with the rest,
// false stops taking new ones (and the error is thrown once the running ones finish).
async function runAll(items, fn, handle) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await fn(item);
      } catch (e) {
        if (!handle(e, item)) failure = failure || e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  if (failure) throw failure;
}

// Problems with one event that shouldn't hold up the others (Google turned down that one event, say).
const PER_EVENT = ['refused', 'notFound', 'gone', 'conflict'];
const perEvent = (e) => e instanceof GoogleError && PER_EVENT.includes(e.kind);

// ---------- Google Calendar operations ----------

const calendarGone = (calendarId) => new GoogleError(`The calendar ${calendarId} is gone.`, { status: 404, kind: 'calendarGone' });

async function listAll(api, path, query) {
  const items = [];
  let pageToken;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await api.request('GET', path, { query: { ...query, pageToken } });
    items.push(...(res?.items || []));
    pageToken = res?.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

// The app's events in a calendar (only ones carrying stellar=1), ending after timeMin when given: [{ id, extendedProperties }].
export async function listAppEvents(api, calendarId, { timeMin } = {}) {
  try {
    return await listAll(api, `/calendars/${enc(calendarId)}/events`, {
      privateExtendedProperty: 'stellar=1', timeMin, showDeleted: 'false', maxResults: 2500, fields: 'items(id,extendedProperties),nextPageToken',
    });
  } catch (e) {
    if (e.kind === 'notFound') throw calendarGone(calendarId);
    throw e;
  }
}

// UPSERT: writes the whole event. An id Google doesn't know is created; one that exists already (a deleted event
// Google still remembers, or one made by another run meanwhile) is written again, which also brings a deleted one
// back (status 'confirmed').
export async function upsertEvent(api, calendarId, body) {
  const path = `/calendars/${enc(calendarId)}/events/${body.id}`;
  try {
    await api.request('PUT', path, { body });
    return 'updated';
  } catch (e) {
    if (e.kind !== 'notFound') throw e;
  }
  try {
    await api.request('POST', `/calendars/${enc(calendarId)}/events`, { body });
    return 'created';
  } catch (e) {
    if (e.kind === 'notFound') throw calendarGone(calendarId);
    if (e.kind !== 'conflict') throw e;
  }
  await api.request('PUT', path, { body });
  return 'restored';
}

// REMOVE: deletes the app's event by its id. Already gone (404, or 410 for deleted) counts as done.
export async function removeEvent(api, calendarId, googleId) {
  try {
    await api.request('DELETE', `/calendars/${enc(calendarId)}/events/${googleId}`);
    return true;
  } catch (e) {
    if (e.kind === 'notFound' || e.kind === 'gone') return false;
    throw e;
  }
}

// A calendar the app makes and owns: the business name for the business calendar, "<name> – my schedule" for a
// person's own. Not retried after a lost answer, which could make two.
export async function createAppCalendar(api, { kind, short, timeZone, appUrl }) {
  const summary = kind === 'business' ? short : `${short} – my schedule`;
  const description = `Kept up to date by the ${short} app. Make changes in the app: changes made here are replaced. ${appUrl}/#/schedule`;
  const cal = await api.request('POST', '/calendars', { body: { summary, description, timeZone }, idempotent: false });
  return { id: cal.id, summary: cal.summary || summary };
}

// The calendars the Google account owns (needs the PICK scopes).
export const ownedCalendars = (api) => listAll(api, '/users/me/calendarList', { minAccessRole: 'owner', maxResults: 250 });

// Takes every one of the app's events off a calendar, old ones too. With deleteIfEmpty (calendars the app made), the
// calendar is deleted too if nothing at all is left in it: an event someone added themselves keeps it. Best effort:
// problems are logged and it carries on. Returns { removed, calendarDeleted }.
export async function clearCalendar(deps, api, calendarId, { deleteIfEmpty = false } = {}) {
  const log = deps.logger;
  let removed = 0;
  let items;
  try {
    items = await listAppEvents(api, calendarId);
  } catch (e) {
    if (e.kind !== 'calendarGone') log.warn('Calendar cleanup: couldn\'t list the app\'s events', { calendarId, error: e.message });
    return { removed, calendarDeleted: false };
  }
  await runAll(items, async (g) => {
    if (await removeEvent(api, calendarId, g.id)) removed += 1;
  }, (e, g) => {
    log.warn('Calendar cleanup: an event wasn\'t removed', { calendarId, id: g.id, error: e.message });
    return e.kind !== 'auth'; // without access, the rest would fail the same way
  }).catch(() => {});
  let calendarDeleted = false;
  if (deleteIfEmpty) {
    try {
      const left = await api.request('GET', `/calendars/${enc(calendarId)}/events`, { query: { maxResults: 1, showDeleted: 'false', fields: 'items(id)' } });
      if (!left?.items?.length) {
        await api.request('DELETE', `/calendars/${enc(calendarId)}`);
        calendarDeleted = true;
      }
    } catch (e) {
      log.warn('Calendar cleanup: the calendar wasn\'t deleted', { calendarId, error: e.message });
    }
  }
  return { removed, calendarDeleted };
}

// Every stored access for a Google account, in any business, as { path, token }. Google's grant is per person, not
// per business, so a person on two businesses' teams has one grant behind both.
export async function accessesOf(db, email) {
  const key = emailKey(email);
  if (!key) return [];
  const snap = await db.collectionGroup('calendarTokens').where('emailKey', '==', key).get();
  return snap.docs.map((d) => ({ path: d.ref.path, token: d.data() }));
}

// Whether another link uses the same Google account, in this business or another one. When the other businesses
// can't be checked, it says yes, so the access is kept rather than cut off.
export async function emailUsedElsewhere(deps, companyId, linkId, email) {
  const snap = await deps.db.collection(`companies/${companyId}/calendarTokens`).get();
  if (snap.docs.some((d) => d.id !== linkId && sameEmail(d.data().email, email))) return true;
  const self = tokenRef(deps.db, companyId, linkId).path;
  try {
    return (await accessesOf(deps.db, email)).some((a) => a.path !== self);
  } catch (e) {
    deps.logger.warn('Calendar cleanup: other businesses couldn\'t be checked for the same Google account', { companyId, linkId, error: e.message });
    return true;
  }
}

// CLEAN UP: takes the app's events off the link's calendar (and deletes the calendar if the app made it and it's
// empty now), then gives the Google access back, unless another link uses the same Google account: a revoke ends
// that person's whole grant, which the other link needs. Best effort. Leaves the documents alone.
export async function cleanupLink(deps, companyId, linkId, token) {
  const api = apiFor(deps, { companyId, token });
  const result = token.calendarId
    ? await clearCalendar(deps, api, token.calendarId, { deleteIfEmpty: token.appCalendar === true })
    : { removed: 0, calendarDeleted: false };
  let revoked = false;
  if (token.refreshToken) {
    try {
      if (await emailUsedElsewhere(deps, companyId, linkId, token.email)) {
        deps.logger.info('Calendar cleanup: kept the Google access, another link uses the same account', { companyId, linkId });
      } else {
        revoked = await revokeToken({ fetch: deps.fetch, oauthBase: deps.oauthBase, token: token.refreshToken });
      }
    } catch (e) {
      deps.logger.warn('Calendar cleanup: the Google access wasn\'t revoked', { companyId, linkId, error: e.message });
    }
  }
  return { ...result, revoked };
}

// CLEAN UP, then delete the link's two documents.
export async function removeLink(deps, companyId, linkId, token) {
  const result = await cleanupLink(deps, companyId, linkId, token);
  await Promise.all([tokenRef(deps.db, companyId, linkId).delete(), linkRef(deps.db, companyId, linkId).delete()]);
  return result;
}

// ---------- Full sync ----------

// The app's events that a full sync looks at: ones ending windowStart or later, plus repeating ones still running then.
async function windowEvents(db, companyId, windowStart) {
  const events = db.collection(`companies/${companyId}/events`);
  const [recent, repeating] = await Promise.all([events.where('end', '>=', windowStart).get(), events.where('repeat', 'in', REPEATS).get()]);
  const found = new Map(recent.docs.map((d) => [d.id, d.data()]));
  for (const d of repeating.docs) {
    const until = d.data().repeatUntil || '';
    if (!until || until >= windowStart) found.set(d.id, d.data());
  }
  return found;
}

// Of the app's events in the calendar that a full sync didn't plan to write, the ones to delete: their app event is
// gone, canceled, or not this link's any more. One whose app event is still wanted stays (it ended just before the
// window, where the Google list reaches a day further back).
async function staleEvents(db, companyId, token, extras) {
  const appIds = [...new Set(extras.map((g) => g.extendedProperties?.private?.stellarEvent).filter(isDocId))];
  const keep = new Set();
  for (const part of chunks(appIds, 100)) {
    const snaps = await db.getAll(...part.map((id) => db.doc(`companies/${companyId}/events/${id}`)));
    for (const s of snaps) if (s.exists && isWanted(token, s.data())) keep.add(googleEventId(s.id));
  }
  return extras.map((g) => g.id).filter((id) => !keep.has(id));
}

// RECONCILE: makes the link's calendar match the app for recent and coming events (window: today in the business's
// time zone, less 30 days). Deletes the app's events the link no longer wants, and writes the wanted ones that are
// missing or differ (their stellarV fingerprint). Returns how many events the calendar should have.
export async function reconcileLink(deps, ctx, linkId, token, api = apiFor(deps, { companyId: ctx.companyId, linkId, token })) {
  const { db, logger } = deps;
  const windowStart = windowStartFor(ctx.company.timeZone, deps.now());
  const events = await windowEvents(db, ctx.companyId, windowStart);
  const wanted = [...events].filter(([, event]) => isWanted(token, event));
  const records = await recordsFor(db, ctx.companyId, wanted.map(([, event]) => event));
  const desired = new Map();
  for (const [eventId, event] of wanted) {
    const body = bodyFor(deps, ctx, token, eventId, event, records);
    if (!body) logger.warn('Calendar sync: skipped an event whose dates can\'t be read', { companyId: ctx.companyId, eventId });
    desired.set(googleEventId(eventId), body);
  }
  const existing = await listAppEvents(api, token.calendarId, { timeMin: `${addDays(windowStart, -1)}T00:00:00Z` });
  const stale = await staleEvents(db, ctx.companyId, token, existing.filter((g) => !desired.has(g.id)));
  const versions = new Map(existing.map((g) => [g.id, g.extendedProperties?.private?.stellarV]));
  const writes = [...desired.values()].filter((body) => body && versions.get(body.id) !== body.extendedProperties.private.stellarV);
  const jobs = [...stale.map((id) => ({ id })), ...writes.map((body) => ({ id: body.id, body }))];
  await runAll(jobs, (job) => (job.body ? upsertEvent(api, token.calendarId, job.body) : removeEvent(api, token.calendarId, job.id)), (e, job) => {
    if (!perEvent(e)) return false;
    logger.warn('Calendar sync: Google didn\'t take one event', { companyId: ctx.companyId, linkId, id: job.id, error: e.message });
    return true;
  });
  return desired.size;
}

// The words for a link's `error`, from what went wrong.
export function linkMessage(e) {
  if (e instanceof HttpsError) return e.code === 'failed-precondition' ? e.message : MESSAGES.syncUnfinished;
  switch (e?.kind) {
    case 'auth': return MESSAGES.accessRemoved;
    case 'calendarGone': return MESSAGES.calendarDeleted; // one the owner chose; the app's own is made again
    case 'scope': case 'forbidden': return MESSAGES.forbidden;
    case 'client': return MESSAGES.clientRejected;
    case 'refused': return MESSAGES.refused;
    default: return MESSAGES.syncUnfinished;
  }
}

// The link's calendar, which the app made, was deleted in Google: makes a new one and points the link at it.
// Returns false when the link changed meanwhile (disconnected, moved to another calendar, or another run already
// made the new one), and then the calendar just made is deleted again.
async function replaceAppCalendar(deps, ctx, linkId, token, api) {
  const { db } = deps;
  const cal = await createAppCalendar(api, { kind: token.kind, short: ctx.company.short, timeZone: ctx.company.timeZone, appUrl: deps.appUrl });
  const fields = { calendarId: cal.id, calendarName: cal.summary, appCalendar: true };
  const ref = tokenRef(db, ctx.companyId, linkId);
  const won = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().calendarId !== token.calendarId) return false;
    tx.update(ref, { ...fields, needsFullSync: true });
    return true;
  });
  if (!won) {
    await api.request('DELETE', `/calendars/${enc(cal.id)}`).catch((e) => {
      deps.logger.warn('Calendar sync: an extra calendar wasn\'t deleted', { companyId: ctx.companyId, linkId, error: e.message });
    });
    return false;
  }
  Object.assign(token, fields, { needsFullSync: true });
  await updateLink(db, ctx.companyId, linkId, { ...fields, status: 'syncing', error: '' });
  deps.logger.info('Calendar sync: the calendar was deleted in Google, so the app made a new one', { companyId: ctx.companyId, linkId });
  return true;
}

// A full sync of one link (RECONCILE), with the outcome on its link: 'on' with the count, or 'error' and why (and
// then the error is thrown). An app-made calendar that was deleted in Google is made again first. Returns the count,
// or null when the link changed meanwhile.
export async function fullSync(deps, ctx, linkId, token, api = apiFor(deps, { companyId: ctx.companyId, linkId, token })) {
  const { db } = deps;
  const ref = tokenRef(db, ctx.companyId, linkId);
  try {
    if (!token.needsFullSync) {
      await ref.update({ needsFullSync: true });
      token.needsFullSync = true;
    }
    let count;
    try {
      count = await reconcileLink(deps, ctx, linkId, token, api);
    } catch (e) {
      if (e.kind !== 'calendarGone' || token.appCalendar !== true) throw e;
      if (!(await replaceAppCalendar(deps, ctx, linkId, token, api))) return null;
      count = await reconcileLink(deps, ctx, linkId, token, api);
    }
    await ref.update({ needsFullSync: FieldValue.delete() });
    token.needsFullSync = false;
    await updateLink(db, ctx.companyId, linkId, { status: 'on', error: '', syncedAt: Timestamp.fromDate(deps.now()), count });
    return count;
  } catch (e) {
    if (isNotFound(e)) return null; // disconnected meanwhile
    await updateLink(db, ctx.companyId, linkId, { status: 'error', error: linkMessage(e) });
    throw e;
  }
}

// ---------- The calendarSync trigger ----------

// Worth trying again later: Google busy or down, the network, or something unexpected. Not: an answer that will
// stay the same (access removed, a 400, the app's sign-in settings).
const shouldRetry = (e) => (e instanceof GoogleError ? e.kind === 'transient' : !(e instanceof HttpsError) || e.code === 'unavailable');

// Success on a link: status 'on' with no error. syncedAt is written at most once a minute, to keep writes down when
// many events change at once.
async function markOk(deps, ctx, entry) {
  const now = deps.now();
  const { link } = entry;
  const stale = !link.syncedAt?.toMillis || now.getTime() - link.syncedAt.toMillis() >= SYNCED_AT_EVERY_MS;
  if (link.status === 'on' && !link.error && !stale) return;
  const fields = { status: 'on', error: '', ...(stale ? { syncedAt: Timestamp.fromDate(now) } : {}) };
  await updateLink(deps.db, ctx.companyId, entry.linkId, fields);
  entry.link = { ...link, ...fields };
}

// A link failed. Throws what should be tried again later; otherwise notes the problem on the link (unless the full
// sync already did) and carries on.
async function linkFailed(deps, ctx, entry, e, noted = false) {
  if (shouldRetry(e)) throw e;
  if (!noted) {
    const error = linkMessage(e);
    if (entry.link.status !== 'error' || entry.link.error !== error) await updateLink(deps.db, ctx.companyId, entry.linkId, { status: 'error', error });
    entry.link = { ...entry.link, status: 'error', error };
  }
  if (e.kind !== 'auth') deps.logger.warn('Calendar sync: a link failed', { companyId: ctx.companyId, linkId: entry.linkId, error: e.message });
  return `error: ${e.message}`;
}

// A full sync from the trigger. fullSync notes its own problems on the link.
async function triggerFullSync(deps, ctx, entry, api, label) {
  try {
    return `${label}, full sync: ${await fullSync(deps, ctx, entry.linkId, entry.token, api)}`;
  } catch (e) {
    return linkFailed(deps, ctx, entry, e, true);
  }
}

// One event on one link's calendar: written when the link wants it, taken off when it wanted it before.
async function syncLink(deps, ctx, entry, eventId, event, prev, records) {
  const { linkId, token } = entry;
  const want = isWanted(token, event);
  const had = isWanted(token, prev);
  const api = apiFor(deps, { companyId: ctx.companyId, linkId, token });
  let done = 'nothing to do';
  try {
    if (want) {
      const body = bodyFor(deps, ctx, token, eventId, event, records);
      if (body) {
        await upsertEvent(api, token.calendarId, body);
        done = 'written';
      } else {
        deps.logger.warn('Calendar sync: skipped an event whose dates can\'t be read', { companyId: ctx.companyId, eventId });
        done = 'skipped (dates can\'t be read)';
      }
    } else if (had) {
      await removeEvent(api, token.calendarId, googleEventId(eventId));
      done = 'removed';
    }
  } catch (e) {
    // The app's own calendar was deleted in Google: a full sync makes a new one and copies the schedule to it.
    if (e.kind === 'calendarGone' && token.appCalendar === true) return triggerFullSync(deps, ctx, entry, api, 'calendar deleted in Google');
    return linkFailed(deps, ctx, entry, e);
  }
  // An earlier full sync didn't finish (or a new calendar is waiting for the schedule): finish it now.
  if (token.needsFullSync) return triggerFullSync(deps, ctx, entry, api, done);
  if (want || had) await markOk(deps, ctx, entry);
  return done;
}

const sameVersion = (a, b) => a.exists === b.exists && (!a.exists || a.updateTime.isEqual(b.updateTime));

// calendarSync: an app event was created, changed or deleted, so the change goes to every link's calendar.
//   before     the event as it was (null when it was just made)
//   eventTime  when the change happened (the trigger's event time)
// Returns what happened on each link. Throws when the event should be tried again later (Google busy or down);
// every step is safe to repeat.
export async function handleEventWrite(input) {
  const deps = withDefaults(input);
  const { db, companyId, eventId, before = null, eventTime } = deps;
  // Retries go on for a long time when something keeps failing. After an hour the change is old news, and a full
  // sync (Sync now, or the next change after a failed one) catches the calendar up.
  if (eventTime && deps.now().getTime() - Date.parse(eventTime) > HOUR_MS) return { skipped: 'more than an hour old' };
  const tokens = await db.collection(`companies/${companyId}/calendarTokens`).get();
  if (tokens.empty) return { skipped: 'no Google Calendar connected' };
  const ctx = await loadContext(db, companyId);

  const outcome = {};
  const active = [];
  for (const doc of tokens.docs) {
    const linkId = doc.id;
    const token = doc.data();
    const link = ctx.links.get(linkId) || {};
    if (token.kind === 'business' && token.uid !== ctx.company.ownerUid) {
      // Ownership was handed over. Nothing more goes on the previous owner's calendar until the new owner connects
      // their own (which moves the schedule and cleans up the old one) or someone disconnects it.
      if (link.status !== 'paused' || link.error !== MESSAGES.paused) await updateLink(db, companyId, linkId, { status: 'paused', error: MESSAGES.paused });
      outcome[linkId] = 'paused';
    } else if (token.kind !== 'business' && ctx.members.size > 0 && !ctx.members.has(token.uid)) {
      // They're not on the team any more, so the schedule comes off their calendar.
      const { removed } = await removeLink(deps, companyId, linkId, token);
      outcome[linkId] = `disconnected (not on the team), ${removed} removed`;
    } else {
      active.push({ linkId, token, link });
    }
  }
  if (!active.length) return outcome;

  const ref = db.doc(`companies/${companyId}/events/${eventId}`);
  let snap = await ref.get();
  let prev = before;
  let retry = null;
  for (let pass = 1; pass <= 2; pass += 1) {
    const event = snap.exists ? snap.data() : null;
    const records = await recordsFor(db, companyId, event ? [event] : []);
    await runAll(active, async (entry) => {
      outcome[entry.linkId] = await syncLink(deps, ctx, entry, eventId, event, prev, records);
    }, (e, entry) => {
      retry = retry || e;
      outcome[entry.linkId] = `will try again: ${e.message}`;
      return true;
    });
    // Changed again while this ran? Then once more with the newer version: a run for that change may have finished
    // first, and this one would have put older details back over it.
    const again = await ref.get();
    if (sameVersion(snap, again)) break;
    prev = event;
    snap = again;
  }
  if (retry) throw retry;
  return outcome;
}
