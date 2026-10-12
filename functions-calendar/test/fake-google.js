// A pretend Google for the tests and the local emulator: OAuth under /oauth, and the parts of the Calendar API that
// calendar sync uses under /calendar/v3, all kept in memory. It never talks to the real Google.
//
//   node functions-calendar/test/fake-google.js     listens on 127.0.0.1:8790 (PORT changes it) and prints each call
//
// Sign-in codes: `emulator:<email>` always works and grants the basic scopes (openid email calendar.app.created);
// `emulator:<email>:pick` also grants the two scopes for using an existing calendar. Both come with a refresh token.
// Tests register other codes with addCode() (chosen scopes, no refresh token). Each account gets a primary calendar
// with its email as id and name. GET /__fake/state shows what it holds; POST /__fake/reset empties it.
//
// Behaves like Google where calendar sync depends on it: deleting an event only marks it cancelled (get still finds
// it, insert with its id says 409, a PUT brings it back) and deleting it again says 410; revoking any token ends all
// of that account's tokens (the whole grant); calendar.app.created reaches only calendars the app made, and
// calendar.events.owned only events on calendars the account owns. Simplified: timeMin compares end times as if
// wall-clock times were UTC, which is close enough for tests whose dates are days apart.
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const CLIENT_ID = 'fake-client.apps.googleusercontent.com';
export const CLIENT_SECRET = 'fake-secret';
const APP_CREATED = 'https://www.googleapis.com/auth/calendar.app.created';
const LIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const OWNED_EVENTS = 'https://www.googleapis.com/auth/calendar.events.owned';
const FULL = 'https://www.googleapis.com/auth/calendar';
// What a sign-in grants: the basic scopes, or those plus the two for using an existing calendar.
export const BASIC_SCOPES = `openid email ${APP_CREATED}`;
export const PICK_SCOPES = `${BASIC_SCOPES} ${LIST} ${OWNED_EVENTS}`;

const RANK = { freeBusyReader: 0, reader: 1, writer: 2, owner: 3 };
const EVENT_ID = /^[a-v0-9]{5,1024}$/;

function emptyState() {
  return {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    codes: new Map(), // code -> { email, scope, refreshToken: bool, reusable }
    grants: new Map(), // refresh token -> { email, scope, revoked }
    tokens: new Map(), // access token -> { email, scope, refreshToken, expired }
    calendars: new Map(), // id -> { id, summary, summaryOverride?, description, timeZone, owner, appCreated, shared: { email: role }, deleted }
    events: new Map(), // calendar id -> Map(event id -> event)
    revoked: [], // { token, email } for each revoke that worked
    calls: [], // { method, path, query, status }
    failures: [], // answers to give instead: { method, path, status, reason, times }
    idp: { status: 200, enabled: true, withSecret: true }, // Firebase Auth's Google provider settings
    pageSize: 1000, // the most items one page of a list holds (lower it to test paging)
    emptyFirstPages: 0, // how many event lists start with an empty page that has more after it (Google may do that)
    extendedFilters: 'and', // 'or': a repeated privateExtendedProperty matches any one of them (one of Google's docs says so)
    seq: 0,
  };
}

const newId = (prefix, bytes = 12) => `${prefix}${randomBytes(bytes).toString('hex')}`;
const has = (who, scope) => who.scope.split(/\s+/).includes(scope);
const roleOf = (cal, email) => (cal.owner === email ? 'owner' : cal.shared[email]);
const apiError = (status, message, reason) => ({ error: { code: status, message, errors: [{ domain: 'global', reason, message }] } });
const notFound = () => [404, apiError(404, 'Not Found', 'notFound')];
const noScope = () => [403, apiError(403, 'Request had insufficient authentication scopes.', 'insufficientPermissions')];
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function fakeIdToken(email, clientId) {
  const now = Math.floor(Date.now() / 1000);
  const sub = createHash('sha1').update(email).digest('hex').slice(0, 20);
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iss: 'https://accounts.google.com', aud: clientId, sub, email, email_verified: true, iat: now, exp: now + 3600 })}.fake-signature`;
}

function eventsOf(state, calendarId) {
  if (!state.events.has(calendarId)) state.events.set(calendarId, new Map());
  return state.events.get(calendarId);
}

function addCalendar(state, { id = newId('c_', 10) + '@group.calendar.google.com', owner, summary, summaryOverride, description = '', timeZone = 'America/New_York', appCreated = false, shared = {} }) {
  const cal = { id, summary: summary ?? id, description, timeZone, owner, appCreated, shared, deleted: false };
  if (summaryOverride) cal.summaryOverride = summaryOverride;
  state.calendars.set(id, cal);
  return cal;
}

function ensurePrimary(state, email) {
  if (!state.calendars.has(email)) addCalendar(state, { id: email, owner: email, summary: email });
}

function revokeAccount(state, email) {
  for (const g of state.grants.values()) if (g.email === email) g.revoked = true;
  for (const t of state.tokens.values()) if (t.email === email) t.expired = true;
}

function issueAccess(state, email, scope, refreshToken) {
  const token = newId('ya29.fake-');
  state.tokens.set(token, { email, scope, refreshToken, expired: false });
  return token;
}

// ---------- OAuth ----------

function codeGrant(state, code) {
  const registered = state.codes.get(code);
  if (registered) {
    if (!registered.reusable) state.codes.delete(code);
    return registered;
  }
  const m = /^emulator:(.+?)(:pick)?$/.exec(String(code || ''));
  if (!m || !m[1].includes('@')) return null;
  return { email: m[1].trim(), scope: m[2] ? PICK_SCOPES : BASIC_SCOPES, refreshToken: true };
}

function oauthToken(state, form) {
  if (form.client_id !== state.clientId || form.client_secret !== state.clientSecret) {
    return [401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' }];
  }
  if (form.grant_type === 'authorization_code') {
    if (form.redirect_uri !== 'postmessage') return [400, { error: 'redirect_uri_mismatch', error_description: 'Bad Request' }];
    const grant = codeGrant(state, form.code);
    if (!grant) return [400, { error: 'invalid_grant', error_description: 'Malformed auth code.' }];
    ensurePrimary(state, grant.email);
    const refresh = grant.refreshToken ? newId('1//fake-refresh-') : '';
    if (refresh) state.grants.set(refresh, { email: grant.email, scope: grant.scope, revoked: false });
    return [200, {
      access_token: issueAccess(state, grant.email, grant.scope, refresh),
      expires_in: 3599,
      ...(refresh ? { refresh_token: refresh } : {}),
      scope: grant.scope,
      token_type: 'Bearer',
      id_token: fakeIdToken(grant.email, state.clientId),
    }];
  }
  if (form.grant_type === 'refresh_token') {
    const grant = state.grants.get(form.refresh_token);
    if (!grant || grant.revoked) return [400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }];
    return [200, { access_token: issueAccess(state, grant.email, grant.scope, form.refresh_token), expires_in: 3599, scope: grant.scope, token_type: 'Bearer' }];
  }
  return [400, { error: 'unsupported_grant_type' }];
}

function oauthRevoke(state, form) {
  const grant = state.grants.get(form.token);
  const access = state.tokens.get(form.token);
  const email = (grant && !grant.revoked && grant.email) || (access && !access.expired && access.email);
  if (!email) return [400, { error: 'invalid_token', error_description: 'Token expired or revoked' }];
  revokeAccount(state, email);
  state.revoked.push({ token: form.token, email });
  return [200, {}];
}

function idpConfig(state, headers) {
  if (!/^Bearer .+/.test(headers.authorization || '')) return [401, apiError(401, 'Missing credentials', 'authError')];
  if (state.idp.status !== 200) return [state.idp.status, apiError(state.idp.status, 'The caller does not have permission', 'forbidden')];
  return [200, {
    name: 'projects/fake/defaultSupportedIdpConfigs/google.com',
    enabled: state.idp.enabled,
    clientId: state.clientId,
    ...(state.idp.withSecret ? { clientSecret: state.clientSecret } : {}),
  }];
}

// ---------- Calendar API ----------

function caller(state, headers) {
  const m = /^Bearer (.+)$/.exec(headers.authorization || '');
  const who = m && state.tokens.get(m[1]);
  return who && !who.expired ? who : null;
}

// Events (and reading an app-made calendar) need: the full calendar scope, calendar.app.created on a calendar the
// app made for this account, or calendar.events.owned on a calendar the account owns.
function eventAccess(state, who, calendarId) {
  const cal = state.calendars.get(calendarId);
  if (!cal || cal.deleted || !roleOf(cal, who.email)) return { error: notFound() };
  if (has(who, FULL) || (cal.appCreated && cal.owner === who.email && has(who, APP_CREATED)) || (cal.owner === who.email && has(who, OWNED_EVENTS))) return { cal };
  return { error: noScope() };
}

// Like Google, a `fields` list that leaves out nextPageToken gets none back.
const withNext = (query, next) => (next && (!query.get('fields') || query.get('fields').includes('nextPageToken')) ? { nextPageToken: next } : {});

function pageOf(state, items, query, mapItem = (x) => x) {
  const max = Math.min(Number(query.get('maxResults')) || 250, 2500, state.pageSize);
  const offset = Number(query.get('pageToken')) || 0;
  const next = offset + max < items.length ? String(offset + max) : undefined;
  return { items: items.slice(offset, offset + max).map(mapItem), ...withNext(query, next) };
}

// When an event ends, for timeMin (see the note at the top).
function endMs(e) {
  if (e.recurrence?.length) {
    const until = /UNTIL=([0-9TZ]+)/.exec(e.recurrence.join(';'))?.[1];
    if (!until) return Infinity;
    const day = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
    return Date.parse(until.length > 8 ? `${day}T${until.slice(9, 11)}:${until.slice(11, 13)}:${until.slice(13, 15)}Z` : `${day}T23:59:59Z`);
  }
  const end = e.end || {};
  if (end.date) return Date.parse(`${end.date}T00:00:00Z`);
  if (end.dateTime) return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(end.dateTime) ? end.dateTime : `${end.dateTime}Z`);
  return Infinity;
}

// What Google would turn down with a 400, so mapping mistakes show up in the tests.
function invalidEvent(e) {
  if (!e || typeof e !== 'object') return 'Missing event.';
  if (e.id !== undefined && !EVENT_ID.test(e.id)) return 'Invalid resource id value.';
  const s = e.start || {};
  const t = e.end || {};
  if (s.date || t.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) return 'Invalid start or end date.';
    if (t.date <= s.date) return 'The specified time range is empty.';
  } else {
    if (!s.dateTime || !t.dateTime) return 'Missing end time.';
    const zoned = (x) => x.timeZone || /[zZ]|[+-]\d\d:\d\d$/.test(x.dateTime);
    if (!zoned(s) || !zoned(t)) return 'Missing time zone definition for start time.';
    if (t.dateTime < s.dateTime) return 'The specified time range is empty.';
  }
  for (const rule of e.recurrence || []) {
    if (!/^RRULE:FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[^;]+)*$/.test(rule)) return 'Invalid recurrence rule.';
    const until = /;UNTIL=([^;]+)/.exec(rule)?.[1];
    if (until && !(s.date ? /^\d{8}$/ : /^\d{8}T\d{6}Z$/).test(until)) return 'Invalid recurrence rule.';
  }
  if (e.reminders) {
    const overrides = e.reminders.overrides || [];
    if (e.reminders.useDefault && overrides.length) return 'Cannot specify both default reminders and overrides at the same time.';
    if (overrides.length > 5) return 'Too many reminders.';
    if (overrides.some((r) => !['popup', 'email'].includes(r.method) || !Number.isInteger(r.minutes) || r.minutes < 0 || r.minutes > 40320)) return 'Invalid reminder.';
  }
  if (e.colorId !== undefined && !/^([1-9]|1[01])$/.test(String(e.colorId))) return 'Invalid color.';
  if (e.transparency !== undefined && !['opaque', 'transparent'].includes(e.transparency)) return 'Invalid transparency.';
  if (e.status !== undefined && !['confirmed', 'tentative', 'cancelled'].includes(e.status)) return 'Invalid status.';
  if (e.source && !/^https?:\/\//.test(e.source.url || '')) return 'Invalid source URL.';
  return '';
}

function storeEvent(state, calendarId, id, body) {
  state.seq += 1;
  const event = {
    ...structuredClone(body), id, kind: 'calendar#event', status: body.status || 'confirmed', etag: `"${state.seq}"`, updated: new Date().toISOString(),
  };
  eventsOf(state, calendarId).set(id, event);
  return event;
}

function pickFields(fields) {
  const keys = /items\(([^)]*)\)/.exec(fields || '')?.[1]?.split(',').map((k) => k.trim());
  return keys ? (item) => Object.fromEntries(keys.filter((k) => k in item).map((k) => [k, item[k]])) : (item) => item;
}

function listEvents(state, cal, query) {
  if (state.emptyFirstPages > 0 && !query.get('pageToken')) {
    state.emptyFirstPages -= 1;
    return [200, { kind: 'calendar#events', items: [], ...withNext(query, '0') }];
  }
  let items = [...eventsOf(state, cal.id).values()];
  if (query.get('showDeleted') !== 'true') items = items.filter((e) => e.status !== 'cancelled');
  const wanted = query.getAll('privateExtendedProperty').map((p) => {
    const [key, ...rest] = p.split('=');
    return (e) => e.extendedProperties?.private?.[key] === rest.join('=');
  });
  if (wanted.length) items = items.filter((e) => (state.extendedFilters === 'or' ? wanted.some((w) => w(e)) : wanted.every((w) => w(e))));
  if (query.get('timeMin')) {
    const min = Date.parse(query.get('timeMin'));
    items = items.filter((e) => endMs(e) > min);
  }
  return [200, { kind: 'calendar#events', ...pageOf(state, items, query, pickFields(query.get('fields'))) }];
}

function calendarApi(state, method, rest, query, body, who) {
  let m;
  if (rest === '/calendars' && method === 'POST') {
    if (!has(who, APP_CREATED) && !has(who, FULL)) return noScope();
    if (!body?.summary) return [400, apiError(400, 'Missing title.', 'required')];
    const cal = addCalendar(state, { owner: who.email, summary: body.summary, description: body.description || '', timeZone: body.timeZone || 'UTC', appCreated: true });
    return [200, { kind: 'calendar#calendar', etag: `"${state.seq}"`, id: cal.id, summary: cal.summary, description: cal.description, timeZone: cal.timeZone }];
  }
  if (rest === '/users/me/calendarList' && method === 'GET') {
    if (!has(who, LIST) && !has(who, FULL)) return noScope();
    const min = RANK[query.get('minAccessRole')] ?? 0;
    const items = [...state.calendars.values()]
      .filter((c) => !c.deleted && roleOf(c, who.email) && RANK[roleOf(c, who.email)] >= min)
      .map((c) => ({
        kind: 'calendar#calendarListEntry', id: c.id, summary: c.summary, ...(c.summaryOverride ? { summaryOverride: c.summaryOverride } : {}),
        timeZone: c.timeZone, accessRole: roleOf(c, who.email), ...(c.id === who.email ? { primary: true } : {}),
      }));
    return [200, { kind: 'calendar#calendarList', ...pageOf(state, items, query) }];
  }
  if ((m = /^\/users\/me\/calendarList\/([^/]+)$/.exec(rest)) && method === 'GET') {
    if (!has(who, LIST) && !has(who, FULL)) return noScope();
    const cal = state.calendars.get(decodeURIComponent(m[1]));
    if (!cal || cal.deleted || !roleOf(cal, who.email)) return notFound();
    return [200, { kind: 'calendar#calendarListEntry', id: cal.id, summary: cal.summary, accessRole: roleOf(cal, who.email), ...(cal.id === who.email ? { primary: true } : {}) }];
  }
  if ((m = /^\/calendars\/([^/]+)$/.exec(rest))) {
    const cal = state.calendars.get(decodeURIComponent(m[1]));
    if (!cal || cal.deleted || !roleOf(cal, who.email)) return notFound();
    const appOwn = cal.appCreated && cal.owner === who.email && has(who, APP_CREATED);
    if (method === 'GET') {
      if (!appOwn && !has(who, FULL)) return noScope();
      return [200, { kind: 'calendar#calendar', id: cal.id, summary: cal.summary, description: cal.description, timeZone: cal.timeZone }];
    }
    if (method === 'DELETE') {
      if (cal.id === who.email) return [400, apiError(400, 'Cannot delete primary calendar.', 'cannotDeletePrimaryCalendar')];
      if (!appOwn && !(has(who, FULL) && cal.owner === who.email)) return noScope();
      cal.deleted = true;
      return [204, null];
    }
  }
  if ((m = /^\/calendars\/([^/]+)\/events$/.exec(rest))) {
    const { cal, error } = eventAccess(state, who, decodeURIComponent(m[1]));
    if (error) return error;
    if (method === 'GET') return listEvents(state, cal, query);
    if (method === 'POST') {
      const problem = invalidEvent(body);
      if (problem) return [400, apiError(400, problem, 'invalid')];
      const id = body.id || newId('', 10);
      if (eventsOf(state, cal.id).has(id)) return [409, apiError(409, 'The requested identifier already exists.', 'duplicate')];
      return [200, storeEvent(state, cal.id, id, body)];
    }
  }
  if ((m = /^\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(rest))) {
    const { cal, error } = eventAccess(state, who, decodeURIComponent(m[1]));
    if (error) return error;
    const id = decodeURIComponent(m[2]);
    const existing = eventsOf(state, cal.id).get(id);
    if (!existing) return notFound();
    if (method === 'GET') return [200, existing];
    if (method === 'PUT') {
      const problem = invalidEvent(body);
      if (problem) return [400, apiError(400, problem, 'invalid')];
      return [200, storeEvent(state, cal.id, id, body)];
    }
    if (method === 'DELETE') {
      if (existing.status === 'cancelled') return [410, apiError(410, 'Resource has been deleted', 'deleted')];
      existing.status = 'cancelled';
      existing.updated = new Date().toISOString();
      return [204, null];
    }
  }
  return notFound();
}

// ---------- The server ----------

function takeFailure(state, method, path) {
  const i = state.failures.findIndex((f) => (f.method === '*' || f.method === method)
    && (!f.path || (f.path instanceof RegExp ? f.path.test(path) : path.includes(f.path))));
  if (i < 0) return null;
  const f = state.failures[i];
  f.times -= 1;
  if (f.times <= 0) state.failures.splice(i, 1);
  if (f.status === 'network') return 'network';
  return [f.status, f.body || (path.startsWith('/oauth') ? { error: f.reason } : apiError(f.status, f.message || 'Injected failure', f.reason))];
}

function snapshot(state) {
  return {
    calendars: [...state.calendars.values()].map((c) => ({ ...c, events: [...eventsOf(state, c.id).values()] })),
    grants: [...state.grants].map(([token, g]) => ({ token, ...g })),
    revoked: state.revoked,
    calls: state.calls.slice(-300),
  };
}

function route(state, method, path, query, body, headers) {
  const injected = takeFailure(state, method, path);
  if (injected) return injected;
  if (path === '/__fake/state' && method === 'GET') return [200, snapshot(state)];
  if (path === '/__fake/reset' && method === 'POST') {
    Object.assign(state, emptyState());
    return [200, {}];
  }
  if (path === '/oauth/token' && method === 'POST') return oauthToken(state, body || {});
  if (path === '/oauth/revoke' && method === 'POST') return oauthRevoke(state, body || {});
  if (/^\/idtk\/admin\/v2\/projects\/[^/]+\/defaultSupportedIdpConfigs\/google\.com$/.test(path) && method === 'GET') return idpConfig(state, headers);
  if (!path.startsWith('/calendar/v3/')) return notFound();
  const who = caller(state, headers);
  if (!who) return [401, apiError(401, 'Request had invalid authentication credentials.', 'authError')];
  return calendarApi(state, method, path.slice('/calendar/v3'.length), query, body, who);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// What a printed line says about a call, besides the method, path and answer.
function note(path, body, status, json) {
  if (path === '/oauth/token') return body?.grant_type === 'authorization_code' ? ` sign-in ${json?.id_token ? JSON.parse(Buffer.from(json.id_token.split('.')[1], 'base64url')).email : ''}` : ` ${body?.grant_type || ''}`;
  if (body?.summary) return ` "${body.summary}"`;
  return status >= 400 && json?.error ? ` ${json.error.message || json.error}` : '';
}

// Starts the fake on a port (0 picks a free one). Returns the url, the state, close(), and helpers for tests.
export async function startFakeGoogle({ port = 0, host = '127.0.0.1', log = false } = {}) {
  const state = emptyState();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fake');
      const body = await readBody(req);
      const query = url.searchParams;
      const answer = route(state, req.method, url.pathname, query, body, req.headers);
      if (answer === 'network') {
        req.socket.destroy();
        return;
      }
      const [status, json] = answer;
      // A parameter given more than once is recorded as a list.
      const asked = Object.fromEntries([...new Set(query.keys())].map((k) => [k, query.getAll(k).length > 1 ? query.getAll(k) : query.get(k)]));
      state.calls.push({ method: req.method, path: url.pathname, query: asked, status });
      if (log) console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${url.pathname} ${status}${note(url.pathname, body, status, json)}`);
      res.writeHead(status, json === null ? {} : { 'content-type': 'application/json; charset=utf-8' });
      res.end(json === null ? undefined : JSON.stringify(json));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(apiError(500, `Fake Google failed: ${e.message}`, 'backendError')));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://${host}:${server.address().port}`;
  return {
    url,
    state,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
    reset: () => Object.assign(state, emptyState()),
    // A sign-in code with chosen scopes, and whether Google sends a refresh token with it. Works once unless reusable.
    addCode: ({ code, email, scope = BASIC_SCOPES, refreshToken = true, reusable = false }) => {
      state.codes.set(code, { email, scope, refreshToken, reusable });
      return code;
    },
    // A calendar someone made themselves (appCreated false) or shared with others: shared = { email: 'reader' }.
    addCalendar: (fields) => addCalendar(state, fields),
    // An event put in a calendar directly, as a person would (no checks).
    addEvent: (calendarId, event) => storeEvent(state, calendarId, event.id || newId('', 10), event),
    // A calendar's events; cancelled ones only with deleted: true.
    events: (calendarId, { deleted = false } = {}) => [...eventsOf(state, calendarId).values()].filter((e) => deleted || e.status !== 'cancelled'),
    event: (calendarId, id) => eventsOf(state, calendarId).get(id),
    calendar: (id) => state.calendars.get(id),
    calendarsOf: (email) => [...state.calendars.values()].filter((c) => c.owner === email && !c.deleted),
    // The next `times` calls matching the method and path (a substring or RegExp; none = any) get this answer
    // instead. Status 'network' drops the connection.
    fail: ({ method = '*', path, status = 500, reason = 'backendError', message, body, times = 1 }) => {
      state.failures.push({ method, path, status, reason, message, body, times });
    },
    // As if the person removed the app's access in their Google account.
    revokeAccount: (email) => revokeAccount(state, email),
    expireAccessTokens: () => { for (const t of state.tokens.values()) t.expired = true; },
    // As if the person deleted the calendar in Google.
    deleteCalendar: (id) => { state.calendars.get(id).deleted = true; },
    grantsOf: (email) => [...state.grants].filter(([, g]) => g.email === email).map(([token, g]) => ({ token, ...g })),
    calls: ({ method, path } = {}) => state.calls.filter((c) => (!method || c.method === method)
      && (!path || (path instanceof RegExp ? path.test(c.path) : c.path.includes(path)))),
  };
}

// Run directly: listen on 8790 and print each call.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = await startFakeGoogle({ port: Number(process.env.PORT) || 8790, log: true });
  console.log(`Fake Google on ${fake.url}: OAuth at /oauth, Calendar API at /calendar/v3, everything it holds at /__fake/state`);
}
