// The Google client (google.js) against the fake Google server. Needs nothing else running.
import assert from 'node:assert/strict';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  BASIC_SCOPE, PICK_SCOPE, GoogleError, createCalendarApi, createSession, emailFromIdToken, exchangeCode, hasPickScopes, makeClientLoader,
  refreshAccessToken, revokeToken, sameScopes,
} from '../google.js';
import { MESSAGES } from '../messages.js';
import { startFakeGoogle, BASIC_SCOPES, PICK_SCOPES, CLIENT_ID, CLIENT_SECRET } from './fake-google.js';

describe('Google client', () => {
  let fake;
  let oauthBase;
  let calendarBase;
  let waits;
  const client = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
  const loadClient = async () => client;
  const sleep = async (ms) => { waits.push(ms); };

  // A Calendar API client for a fresh sign-in, plus the session behind it.
  async function signedIn(email = 'jason@example.com', scope = BASIC_SCOPES) {
    const code = fake.addCode({ code: `code-${Math.random()}`, email, scope });
    const grant = await exchangeCode({ oauthBase, client, code });
    const session = createSession({ oauthBase, loadClient, refreshToken: grant.refreshToken, scope: grant.scope, sleep });
    return { grant, session, api: createCalendarApi({ calendarBase, session, sleep }) };
  }

  before(async () => {
    fake = await startFakeGoogle();
    oauthBase = `${fake.url}/oauth`;
    calendarBase = `${fake.url}/calendar/v3`;
  });
  after(() => fake.close());
  beforeEach(() => {
    fake.reset();
    waits = [];
  });

  it('asks for the scopes the spec lists', () => {
    assert.equal(BASIC_SCOPE, 'openid email https://www.googleapis.com/auth/calendar.app.created');
    assert.equal(PICK_SCOPE, 'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.owned');
    assert.equal(hasPickScopes(BASIC_SCOPES), false);
    assert.equal(hasPickScopes(PICK_SCOPES), true);
    assert.ok(sameScopes('a b c', 'c a  b'));
    assert.ok(!sameScopes('a b', 'a b c'));
  });

  it('swaps a sign-in code for tokens and reads the email from the id token', async () => {
    const grant = await exchangeCode({ oauthBase, client, code: 'emulator:Jason@Example.com:pick' });
    assert.equal(grant.email, 'Jason@Example.com');
    assert.equal(grant.scope, PICK_SCOPES);
    assert.ok(grant.refreshToken && grant.accessToken);
    assert.equal(grant.expiresIn, 3599);
    assert.equal((await exchangeCode({ oauthBase, client, code: 'emulator:wes@example.com' })).scope, BASIC_SCOPES);
    assert.equal(emailFromIdToken('not a token'), '');
    // A code works once; a wrong client is a setup problem.
    fake.addCode({ code: 'once', email: 'a@example.com' });
    await exchangeCode({ oauthBase, client, code: 'once' });
    await assert.rejects(exchangeCode({ oauthBase, client, code: 'once' }), (e) => e instanceof GoogleError && e.kind === 'refused' && e.reason === 'invalid_grant');
    await assert.rejects(exchangeCode({ oauthBase, client: { ...client, clientSecret: 'wrong' }, code: 'emulator:a@example.com' }), (e) => e.kind === 'client');
    fake.addCode({ code: 'no-refresh', email: 'a@example.com', refreshToken: false });
    assert.equal((await exchangeCode({ oauthBase, client, code: 'no-refresh' })).refreshToken, '');
  });

  it('refreshes, and tells a removed access from a busy Google', async () => {
    const { grant } = await signedIn();
    const fresh = await refreshAccessToken({ oauthBase, loadClient, refreshToken: grant.refreshToken, sleep });
    assert.ok(fresh.accessToken);
    assert.equal(fresh.scope, BASIC_SCOPES);
    fake.fail({ method: 'POST', path: '/oauth/token', status: 503, times: 2 });
    await refreshAccessToken({ oauthBase, loadClient, refreshToken: grant.refreshToken, sleep });
    assert.deepEqual(waits, [500, 1000]);
    fake.revokeAccount('jason@example.com');
    await assert.rejects(refreshAccessToken({ oauthBase, loadClient, refreshToken: grant.refreshToken, sleep }), (e) => e.kind === 'auth');
    await assert.rejects(refreshAccessToken({ oauthBase, loadClient, refreshToken: '', sleep }), (e) => e.kind === 'auth');
  });

  it('revokes the whole grant, and counts an unknown token as done', async () => {
    const a = await signedIn('jason@example.com');
    const b = await signedIn('jason@example.com');
    assert.equal(await revokeToken({ oauthBase, token: a.grant.refreshToken }), true);
    assert.deepEqual(fake.grantsOf('jason@example.com').map((g) => g.revoked), [true, true], 'every token of that account');
    assert.equal(await revokeToken({ oauthBase, token: b.grant.refreshToken }), false);
  });

  it('retries a busy or failing Google with backoff, up to three times', async () => {
    const { api } = await signedIn();
    fake.fail({ method: 'POST', path: '/calendars', status: 429, reason: 'rateLimitExceeded', times: 1 });
    fake.fail({ method: 'GET', path: '/calendars/jason', status: 500, times: 2 });
    const cal = await api.request('POST', '/calendars', { body: { summary: 'Stellar Glass' }, idempotent: false });
    assert.match(cal.id, /@group\.calendar\.google\.com$/);
    await assert.rejects(api.request('GET', `/calendars/${encodeURIComponent('jason@example.com')}`), (e) => e.kind === 'scope', 'reaches Google after two 500s');
    assert.deepEqual(waits, [500, 500, 1000]);

    waits = [];
    fake.fail({ method: 'GET', path: '/events', status: 503, times: 9 });
    await assert.rejects(api.request('GET', `/calendars/${encodeURIComponent(cal.id)}/events`), (e) => e instanceof GoogleError && e.kind === 'transient' && e.status === 503);
    assert.deepEqual(waits, [500, 1000, 2000]);
    fake.state.failures = [];

    waits = [];
    fake.fail({ method: 'GET', path: '/events', status: 403, reason: 'userRateLimitExceeded', times: 1 });
    await api.request('GET', `/calendars/${encodeURIComponent(cal.id)}/events`);
    assert.deepEqual(waits, [500], 'a rate limit 403 is retried');

    waits = [];
    fake.fail({ method: 'GET', path: '/events', status: 403, reason: 'forbidden', times: 1 });
    await assert.rejects(api.request('GET', `/calendars/${encodeURIComponent(cal.id)}/events`), (e) => e.kind === 'forbidden');
    assert.deepEqual(waits, [], 'any other 403 isn\'t');
  });

  it('doesn\'t repeat making a calendar after a failure that may have made it', async () => {
    const { api } = await signedIn();
    fake.fail({ method: 'POST', path: '/calendars', status: 500, times: 1 });
    await assert.rejects(api.request('POST', '/calendars', { body: { summary: 'X' }, idempotent: false }), (e) => e.kind === 'transient');
    assert.deepEqual(waits, []);
    fake.fail({ method: 'POST', path: '/calendars', status: 'network', times: 1 });
    await assert.rejects(api.request('POST', '/calendars', { body: { summary: 'X' }, idempotent: false }), (e) => e.kind === 'transient');
    assert.equal(fake.calendarsOf('jason@example.com').length, 1, 'only the primary calendar');
  });

  it('retries a dropped connection, and calls a server that never answers transient', async () => {
    const { api } = await signedIn();
    fake.fail({ method: 'GET', path: '/calendarList', status: 'network', times: 1 });
    await assert.rejects(api.request('GET', '/users/me/calendarList'), (e) => e.kind === 'scope', 'got through on the retry');
    assert.deepEqual(waits, [500]);
    const nowhere = createCalendarApi({ calendarBase: 'http://127.0.0.1:9/calendar/v3', session: { accessToken: async () => 't', invalidate() {} }, sleep });
    await assert.rejects(nowhere.request('GET', '/users/me/calendarList'), (e) => e instanceof GoogleError && e.kind === 'transient');
  });

  it('gets a new access token once when Google says the old one stopped working', async () => {
    const { api, session } = await signedIn();
    await api.request('POST', '/calendars', { body: { summary: 'A' }, idempotent: false });
    const refreshes = () => fake.calls({ method: 'POST', path: '/oauth/token' }).length;
    const before = refreshes();
    fake.expireAccessTokens();
    await api.request('POST', '/calendars', { body: { summary: 'B' }, idempotent: false });
    assert.equal(refreshes(), before + 1);
    // Twice in a row means the access is really gone.
    fake.fail({ path: '/calendar/v3/calendars', status: 401, reason: 'authError', times: 2 });
    await assert.rejects(api.request('POST', '/calendars', { body: { summary: 'C' }, idempotent: false }), (e) => e.kind === 'auth');
    assert.ok(session.scope);
  });

  it('notices when a refresh shows different scopes', async () => {
    const seen = [];
    const { grant } = await signedIn('jason@example.com', BASIC_SCOPES);
    const session = createSession({ oauthBase, loadClient, refreshToken: grant.refreshToken, scope: PICK_SCOPES, sleep, onScope: async (s) => { seen.push(s); } });
    await session.accessToken();
    assert.equal(session.scope, BASIC_SCOPES);
    assert.deepEqual(seen, [BASIC_SCOPES]);
    await session.refresh();
    assert.equal(seen.length, 1, 'only when they change');
    // A warm instance reuses the access token and remembers its scopes.
    const cache = new Map();
    const one = createSession({ oauthBase, loadClient, refreshToken: grant.refreshToken, scope: PICK_SCOPES, sleep, cache });
    await one.accessToken();
    const calls = fake.calls({ path: '/oauth/token' }).length;
    const two = createSession({ oauthBase, loadClient, refreshToken: grant.refreshToken, scope: PICK_SCOPES, sleep, cache });
    await two.accessToken();
    assert.equal(fake.calls({ path: '/oauth/token' }).length, calls);
    assert.equal(two.scope, BASIC_SCOPES);
  });

  describe('the app\'s OAuth client', () => {
    let now;
    let warnings;
    const loader = (over = {}) => makeClientLoader({
      idtkBase: `${fake.url}/idtk`, projectId: 'stellar-glass-jobs', getAdminToken: async () => 'admin-token', now: () => now,
      logger: { warn: (...a) => warnings.push(a) }, ...over,
    });
    beforeEach(() => {
      now = new Date('2026-10-11T15:00:00Z');
      warnings = [];
    });

    it('uses GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET when both are set', async () => {
      assert.deepEqual(await loader({ clientId: 'id', clientSecret: 'secret', getAdminToken: () => { throw new Error('not used'); } })(), { clientId: 'id', clientSecret: 'secret' });
    });

    it('reads Firebase Auth\'s Google sign-in settings, for ten minutes at a time', async () => {
      const load = loader();
      assert.deepEqual(await load(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
      await load();
      now = new Date(now.getTime() + 9 * 60e3);
      await load();
      assert.equal(fake.calls({ path: '/idtk' }).length, 1);
      now = new Date(now.getTime() + 2 * 60e3);
      await load();
      assert.equal(fake.calls({ path: '/idtk' }).length, 2);
      assert.equal(fake.calls({ path: '/idtk' })[0].path, '/idtk/admin/v2/projects/stellar-glass-jobs/defaultSupportedIdpConfigs/google.com');
    });

    it('says what to fix when it can\'t read them', async () => {
      const setup = (e) => e instanceof HttpsError && e.code === 'failed-precondition' && e.message === MESSAGES.setupCantRead;
      fake.state.idp.status = 403;
      await assert.rejects(loader()(), setup);
      assert.match(warnings[0][0], /refused/);
      // A viewer role reads the client id but not the secret: the same fix.
      fake.state.idp = { status: 200, enabled: true, withSecret: false };
      await assert.rejects(loader()(), setup);
      assert.match(warnings[1][0], /without the client secret/);
      fake.state.idp = { status: 200, enabled: false, withSecret: true };
      await assert.rejects(loader()(), (e) => e.code === 'failed-precondition' && e.message === MESSAGES.googleSignInOff);
      fake.state.idp = { status: 404, enabled: true, withSecret: true };
      await assert.rejects(loader()(), (e) => e.message === MESSAGES.googleSignInOff);
      fake.state.idp = { status: 503, enabled: true, withSecret: true };
      await assert.rejects(loader()(), (e) => e.code === 'unavailable');
      assert.equal(MESSAGES.setupCantRead, 'Calendar sync can\'t read the app\'s Google sign-in settings. CALENDAR_SETUP.md step 4 has the fix.');
    });
  });
});
