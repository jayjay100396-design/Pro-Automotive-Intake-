// Talking to Google: the app's OAuth client settings, sign-in codes, refreshing and revoking access, and a small
// Calendar API client that retries what's worth retrying. Plain fetch, no Google libraries. Every base URL comes in
// as an argument, so tests and the emulator can point it all at the fake server (test/fake-google.js).
import { HttpsError } from 'firebase-functions/v2/https';
import { MESSAGES } from './messages.js';

export const DEFAULT_BASES = {
  oauth: 'https://oauth2.googleapis.com',
  calendar: 'https://www.googleapis.com/calendar/v3',
  idtk: 'https://identitytoolkit.googleapis.com',
};

// What the app asks Google for. BASIC lets it make calendars of its own and change only those. PICK, asked for
// only when the owner wants to use one of their existing calendars, adds seeing their list of calendars and
// changing events on calendars they own.
export const APP_CREATED_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
export const LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
export const OWNED_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';
export const BASIC_SCOPE = `openid email ${APP_CREATED_SCOPE}`;
export const PICK_SCOPE = `${LIST_SCOPE} ${OWNED_EVENTS_SCOPE}`;

const scopeSet = (scope) => new Set(String(scope || '').split(/\s+/).filter(Boolean));
export const hasScope = (scope, wanted) => scopeSet(scope).has(wanted);
export const hasPickScopes = (scope) => hasScope(scope, LIST_SCOPE) && hasScope(scope, OWNED_EVENTS_SCOPE);
export function sameScopes(a, b) {
  const x = scopeSet(a);
  const y = scopeSet(b);
  return x.size === y.size && [...x].every((s) => y.has(s));
}

// Waits between tries when Google is busy or briefly down: three more tries, after 0.5 s, 1 s and 2 s.
const BACKOFF_MS = [500, 1000, 2000];
const REQUEST_TIMEOUT_MS = 30000;
// An access token this close to expiring is refreshed first.
const EARLY_REFRESH_MS = 60000;
const RATE_LIMITS = ['rateLimitExceeded', 'userRateLimitExceeded'];

// kind says what to do about it:
//   auth          the person removed the app's access (or it was revoked): they need to connect again
//   transient     Google was busy or down, or the network failed: try again later
//   notFound, gone, conflict   404, 410, 409, which the callers handle
//   scope         the access granted doesn't cover this (needs the PICK permission)
//   forbidden     any other 403
//   client        Google doesn't accept the app's OAuth client settings
//   refused       any other answer Google gave (a 400, say)
//   calendarGone  the calendar itself is gone (sync.js decides this from a 404)
export class GoogleError extends Error {
  constructor(message, { status = 0, reason = '', kind = 'refused' } = {}) {
    super(message);
    this.name = 'GoogleError';
    this.status = status;
    this.reason = reason;
    this.kind = kind;
  }
}

function kindOf(status, reason, message) {
  if (status === 401) return 'auth';
  if (status === 429 || status >= 500 || (status === 403 && RATE_LIMITS.includes(reason))) return 'transient';
  if (status === 404) return 'notFound';
  if (status === 410) return 'gone';
  if (status === 409) return 'conflict';
  if (status === 403) return reason === 'insufficientPermissions' || /insufficient authentication scopes/i.test(message) ? 'scope' : 'forbidden';
  return 'refused';
}

// The reason and message in an error answer. The Calendar API sends { error: { message, errors: [{ reason }] } };
// the OAuth endpoints send { error: 'invalid_grant', error_description }.
async function errorDetails(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  const err = body?.error;
  if (err && typeof err === 'object') return { reason: err.errors?.[0]?.reason || err.status || '', message: err.message || '' };
  return { reason: typeof err === 'string' ? err : '', message: body?.error_description || '' };
}

const postForm = (fetchFn, url, fields) => fetchFn(url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});

const sleepFor = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---------- The app's OAuth client ----------

// The OAuth web client Firebase made for Google sign-in, read from Firebase Auth's Google provider settings with
// the function's own service account, so there's no secret to set up. GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET,
// when both are set, are used instead (the emulator and tests). Returns async () => ({ clientId, clientSecret }).
// Reading the secret needs the Firebase Authentication Admin role (CALENDAR_SETUP.md step 4): without any access
// Google answers 403, and with only the Viewer role it leaves the secret out. Both get the same message for people,
// and a log line that tells them apart.
export function makeClientLoader({
  fetch: fetchFn = globalThis.fetch, idtkBase = DEFAULT_BASES.idtk, projectId, clientId, clientSecret, getAdminToken,
  now = () => new Date(), cacheMs = 10 * 60 * 1000, logger = { warn() {} },
}) {
  if (clientId && clientSecret) {
    const fixed = { clientId, clientSecret };
    return async () => fixed;
  }
  let cached = null;
  let cachedAt = 0;
  return async function loadClient() {
    if (cached && now().getTime() - cachedAt < cacheMs) return cached;
    let res;
    try {
      const token = await getAdminToken();
      res = await fetchFn(`${idtkBase}/admin/v2/projects/${encodeURIComponent(projectId)}/defaultSupportedIdpConfigs/google.com`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      logger.warn('Calendar sync: couldn\'t reach Firebase Auth for the Google sign-in settings', { error: e?.message });
      throw new HttpsError('unavailable', MESSAGES.unavailable);
    }
    if (res.status === 401 || res.status === 403) {
      const { reason, message } = await errorDetails(res);
      logger.warn('Calendar sync: reading Firebase Auth\'s Google sign-in settings was refused. The functions\' service account needs the Firebase Authentication Admin role.', { status: res.status, reason, message });
      throw new HttpsError('failed-precondition', MESSAGES.setupCantRead);
    }
    if (res.status === 404) throw new HttpsError('failed-precondition', MESSAGES.googleSignInOff);
    if (!res.ok) {
      const { reason, message } = await errorDetails(res);
      logger.warn('Calendar sync: Firebase Auth didn\'t give the Google sign-in settings', { status: res.status, reason, message });
      throw new HttpsError('unavailable', MESSAGES.unavailable);
    }
    const cfg = await res.json();
    if (!cfg.enabled || !cfg.clientId) throw new HttpsError('failed-precondition', MESSAGES.googleSignInOff);
    if (!cfg.clientSecret) {
      logger.warn('Calendar sync: Firebase Auth\'s Google sign-in settings came back without the client secret. The functions\' service account has a viewer role; it needs Firebase Authentication Admin.', { status: res.status });
      throw new HttpsError('failed-precondition', MESSAGES.setupCantRead);
    }
    cached = { clientId: cfg.clientId, clientSecret: cfg.clientSecret };
    cachedAt = now().getTime();
    return cached;
  };
}

// ---------- Sign-in codes, refresh, revoke ----------

// The email address in Google's id_token. It came straight from Google over TLS, so it isn't checked again.
export function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email.trim() : '';
  } catch {
    return '';
  }
}

// Swaps the one-time code from the browser (Google Identity Services, popup mode) for tokens. Not retried: a code
// works only once, so a second try after a lost answer would fail anyway.
export async function exchangeCode({ fetch: fetchFn = globalThis.fetch, oauthBase, client, code }) {
  let res;
  try {
    res = await postForm(fetchFn, `${oauthBase}/token`, {
      code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: 'postmessage', grant_type: 'authorization_code',
    });
  } catch (e) {
    throw new GoogleError(`Couldn't reach Google to finish signing in: ${e.message}`, { kind: 'transient' });
  }
  if (!res.ok) {
    const { reason, message } = await errorDetails(res);
    const kind = res.status === 429 || res.status >= 500 ? 'transient' : (reason === 'invalid_client' || reason === 'unauthorized_client' ? 'client' : 'refused');
    throw new GoogleError(`Google didn't take the sign-in code: ${res.status} ${reason}${message ? `: ${message}` : ''}`.trim(), { status: res.status, reason, kind });
  }
  const body = await res.json();
  return {
    accessToken: body.access_token || '',
    expiresIn: Number(body.expires_in) || 3600,
    refreshToken: body.refresh_token || '',
    scope: body.scope || '',
    email: emailFromIdToken(body.id_token),
  };
}

// A fresh access token for a refresh token. Throws kind 'auth' when Google says the access is gone.
export async function refreshAccessToken({ fetch: fetchFn = globalThis.fetch, oauthBase, loadClient, refreshToken, now = () => new Date(), sleep = sleepFor }) {
  if (!refreshToken) throw new GoogleError('No Google refresh token is stored.', { kind: 'auth' });
  const client = await loadClient();
  for (let tries = 0; ; tries += 1) {
    let res;
    try {
      res = await postForm(fetchFn, `${oauthBase}/token`, {
        client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token',
      });
    } catch (e) {
      if (tries < BACKOFF_MS.length) { await sleep(BACKOFF_MS[tries]); continue; }
      throw new GoogleError(`Couldn't reach Google to refresh access: ${e.message}`, { kind: 'transient' });
    }
    if (res.ok) {
      const body = await res.json();
      return {
        accessToken: body.access_token,
        expiresAt: now().getTime() + (Number(body.expires_in) || 3600) * 1000,
        scope: typeof body.scope === 'string' ? body.scope : '',
      };
    }
    const { reason } = await errorDetails(res);
    if (res.status === 401 || reason === 'invalid_grant') {
      throw new GoogleError('Google Calendar access was removed.', { status: res.status, reason, kind: 'auth' });
    }
    const transient = res.status === 429 || res.status >= 500;
    if (transient && tries < BACKOFF_MS.length) { await sleep(BACKOFF_MS[tries]); continue; }
    throw new GoogleError(`Refreshing Google access failed: ${res.status} ${reason}`.trim(), {
      status: res.status, reason, kind: transient ? 'transient' : (reason === 'invalid_client' ? 'client' : 'refused'),
    });
  }
}

// Ends the access a token belongs to. Google drops the whole grant (every token that person gave the app), which
// is why callers check that no other connection uses the same Google account first. A token Google no longer
// knows (400 invalid_token) counts as done.
export async function revokeToken({ fetch: fetchFn = globalThis.fetch, oauthBase, token }) {
  const res = await postForm(fetchFn, `${oauthBase}/revoke`, { token });
  if (res.ok) return true;
  const { reason } = await errorDetails(res);
  if (res.status === 400 && reason === 'invalid_token') return false;
  throw new GoogleError(`Google didn't revoke the access: ${res.status} ${reason}`.trim(), { status: res.status, reason, kind: kindOf(res.status, reason, '') });
}

// ---------- Access tokens and the Calendar API ----------

// Hands out an access token for one stored refresh token, refreshing it when needed. `scope` starts as the stored
// scopes; when a refresh shows different ones, onScope(scope) is called so they can be saved (a refresh token reused
// from another connection may cover less than the sign-in asked for). `cache` (a Map) keeps access tokens between
// calls on a warm instance; it lives in memory only.
export function createSession({
  fetch: fetchFn = globalThis.fetch, oauthBase, loadClient, refreshToken, accessToken = '', expiresAt = 0, scope = '',
  now = () => new Date(), sleep = sleepFor, cache = null, onScope = null,
}) {
  let token = accessToken;
  let until = expiresAt;
  let current = scope;
  const hit = !token && refreshToken && cache?.get(refreshToken);
  if (hit) {
    token = hit.token;
    until = hit.until;
    current = hit.scope || current;
  }
  const session = {
    get scope() { return current; },
    async accessToken() {
      if (token && until - EARLY_REFRESH_MS > now().getTime()) return token;
      return session.refresh();
    },
    async refresh() {
      const fresh = await refreshAccessToken({ fetch: fetchFn, oauthBase, loadClient, refreshToken, now, sleep });
      token = fresh.accessToken;
      until = fresh.expiresAt;
      if (fresh.scope && !sameScopes(fresh.scope, current)) {
        current = fresh.scope;
        if (onScope) await onScope(current);
      }
      cache?.set(refreshToken, { token, until, scope: current });
      return token;
    },
    invalidate() {
      token = '';
      until = 0;
      cache?.delete(refreshToken);
    },
  };
  return session;
}

// request(method, path, { query, body, idempotent }) against the Calendar API, as the session's Google account.
// Retries 429s, rate limit 403s and 5xx answers up to three times with backoff, and network failures too unless
// the request isn't safe to repeat (idempotent: false, used for making a calendar: Google may have made it before
// the answer got lost). A 401 refreshes the access token once and tries again.
export function createCalendarApi({ fetch: fetchFn = globalThis.fetch, calendarBase, session, sleep = sleepFor }) {
  async function request(method, path, { query = {}, body, idempotent = true } = {}) {
    const url = new URL(calendarBase + path);
    for (const [key, value] of Object.entries(query)) {
      for (const one of [].concat(value)) if (one !== undefined && one !== null) url.searchParams.append(key, String(one));
    }
    let tries = 0;
    let refreshed = false;
    for (;;) {
      const token = await session.accessToken();
      let res;
      try {
        res = await fetchFn(url, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        if (idempotent && tries < BACKOFF_MS.length) { await sleep(BACKOFF_MS[tries++]); continue; }
        throw new GoogleError(`Couldn't reach Google Calendar (${method} ${url.pathname}): ${e.message}`, { kind: 'transient' });
      }
      if (res.ok) {
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      }
      const { reason, message } = await errorDetails(res);
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        session.invalidate();
        continue;
      }
      const kind = kindOf(res.status, reason, message);
      // Busy answers mean Google did nothing, so even a request that isn't safe to repeat can go again.
      const busy = res.status === 429 || (res.status === 403 && kind === 'transient');
      if (kind === 'transient' && (idempotent || busy) && tries < BACKOFF_MS.length) { await sleep(BACKOFF_MS[tries++]); continue; }
      throw new GoogleError(`Google Calendar ${method} ${url.pathname}: ${res.status} ${reason || message}`.trim(), { status: res.status, reason, kind });
    }
  }
  return { request, session };
}
