// The calendarAccount callable, which the app's Google Calendar panel uses (public/js/gcal.js). index.js wires it to
// Cloud Functions; the tests call handleAccountCall directly.
//
// request.data = { action, companyId, kind: 'business' | 'personal', code, calendarId, uid }. The caller must be
// signed in and on the business's team. Actions:
//   status      the OAuth client id and the scopes the browser asks Google for
//   connect     { kind, code }: swaps the browser's one-time code for lasting access, keeps or makes the calendar,
//               and copies the schedule to it (business: the owner only; personal: the caller's own)
//   calendars   { kind: 'business' }: the owner's own Google calendars, to choose from
//   choose      { kind: 'business', calendarId }: moves the business calendar ('new' = one the app makes)
//   resync      { kind }: a full sync now
//   disconnect  { kind, uid? }: takes the app's events off the calendar and ends the access
// Problems come back as HttpsErrors whose message the app shows as it is.
import { HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import {
  APP_CREATED_SCOPE, BASIC_SCOPE, GoogleError, PICK_SCOPE, exchangeCode, hasPickScopes, hasScope, refreshAccessToken, revokeToken,
} from './google.js';
import { MESSAGES } from './messages.js';
import {
  accessesOf, apiFor, cleanupLink, clearCalendar, createAppCalendar, emailKey, fullSync, linkRef, loadContext, ownedCalendars, removeLink,
  sameEmail, tokenRef, updateLink, withDefaults,
} from './sync.js';

const ID = /^[\w-]{1,128}$/;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const enc = encodeURIComponent;

// ---------- Who's asking ----------

// The caller must be signed in and a member of the business.
async function requireMember(db, uid, companyId) {
  if (typeof uid !== 'string' || !uid || uid.includes('/')) throw new HttpsError('permission-denied', MESSAGES.signIn);
  if (typeof companyId !== 'string' || !ID.test(companyId)) throw new HttpsError('invalid-argument', MESSAGES.noCompany);
  const [member, company] = await Promise.all([db.doc(`companies/${companyId}/members/${uid}`).get(), db.doc(`companies/${companyId}`).get()]);
  if (!member.exists) throw new HttpsError('permission-denied', MESSAGES.notMember);
  const ownerUid = company.data()?.ownerUid;
  return { uid, companyId, role: member.data().role || '', member: member.data(), isOwner: !!ownerUid && ownerUid === uid };
}

function kindOf(kind) {
  if (kind !== 'business' && kind !== 'personal') throw new HttpsError('invalid-argument', MESSAGES.badKind);
  return kind;
}

// A person's own link has their uid as its id ('business' is the business calendar's).
function personalLinkId(uid) {
  if (typeof uid !== 'string' || !ID.test(uid) || uid === 'business') throw new HttpsError('invalid-argument', MESSAGES.badRequest);
  return uid;
}

// calendars and choose: the business calendar, by the owner.
function requireOwnerBusiness(who, data) {
  if (data.kind !== 'business') throw new HttpsError('invalid-argument', MESSAGES.businessOnly);
  if (!who.isOwner) throw new HttpsError('permission-denied', MESSAGES.ownerOnly);
}

// The business link's access, which must be the owner's own. A link still on the previous owner's Google account
// is paused until the new owner connects theirs.
async function businessToken(deps, who) {
  const token = (await tokenRef(deps.db, who.companyId, 'business').get()).data();
  if (!token) throw new HttpsError('failed-precondition', MESSAGES.notConnected);
  if (token.uid !== who.uid) throw new HttpsError('failed-precondition', MESSAGES.pausedForOwner);
  return token;
}

// Turns anything else that went wrong into an HttpsError with words for people.
function toHttpsError(e, logger) {
  if (e instanceof HttpsError) return e;
  if (e instanceof GoogleError) {
    // People see a short message; the log keeps what Google said, to tell the causes apart.
    if (['auth', 'calendarGone', 'transient', 'scope', 'forbidden', 'client'].includes(e.kind)) {
      logger.warn('Calendar account: Google said no', { kind: e.kind, status: e.status, reason: e.reason, error: e.message });
    }
    switch (e.kind) {
      case 'auth': return new HttpsError('failed-precondition', MESSAGES.accessRemoved);
      case 'calendarGone': return new HttpsError('failed-precondition', MESSAGES.calendarDeleted);
      case 'transient': return new HttpsError('unavailable', MESSAGES.unavailable);
      case 'scope': case 'forbidden': return new HttpsError('failed-precondition', MESSAGES.forbidden);
      case 'client': return new HttpsError('failed-precondition', MESSAGES.clientRejected);
      default: break;
    }
  }
  logger.error('Calendar account: unexpected problem', { error: e?.message });
  return new HttpsError('internal', MESSAGES.somethingWrong);
}

// ---------- Connecting ----------

// The lasting access (a refresh token) for a new connection. Google sends one only the first time a person agrees,
// so when it doesn't, one stored for the same Google account is reused: this link's own first, then another link's
// in this business (the owner connecting their own schedule after the business calendar, say), then one from another
// business the person is on. It's refreshed right away, which checks it still works and shows the scopes it covers.
// With none at all, the access Google just gave is handed back, so that next time Google asks again and sends one.
// (Nothing else uses this Google account then, so the revoke can't cut another link off. When the other businesses
// can't be checked, nothing is handed back and the person is asked to try again.)
async function lastingAccess(deps, grant, linkId, tokens) {
  if (grant.refreshToken) {
    return {
      refreshToken: grant.refreshToken, scopes: grant.scope, accessToken: grant.accessToken, expiresAt: deps.now().getTime() + grant.expiresIn * 1000,
    };
  }
  const tried = new Set();
  const reuse = async (t) => {
    if (!t?.refreshToken || !sameEmail(t.email, grant.email) || tried.has(t.refreshToken)) return null;
    tried.add(t.refreshToken);
    try {
      const fresh = await refreshAccessToken({
        fetch: deps.fetch, oauthBase: deps.oauthBase, loadClient: deps.oauthClient, refreshToken: t.refreshToken, now: deps.now, sleep: deps.sleep,
      });
      return { refreshToken: t.refreshToken, scopes: fresh.scope || t.scopes || grant.scope, accessToken: fresh.accessToken, expiresAt: fresh.expiresAt };
    } catch (e) {
      if (e.kind !== 'auth') throw e; // that one's access was removed in Google: try the next
      return null;
    }
  };
  for (const t of [tokens.get(linkId), ...[...tokens].filter(([id]) => id !== linkId).map(([, other]) => other)]) {
    const access = await reuse(t);
    if (access) return access;
  }
  let elsewhere;
  try {
    elsewhere = await accessesOf(deps.db, grant.email);
  } catch (e) {
    deps.logger.error('Calendar connect: other businesses couldn\'t be checked for the same Google account (is the calendarTokens.emailKey index deployed?)', { error: e.message });
    throw new HttpsError('unavailable', MESSAGES.unavailable);
  }
  for (const { token } of elsewhere) {
    const access = await reuse(token);
    if (access) return access;
  }
  await revokeToken({ fetch: deps.fetch, oauthBase: deps.oauthBase, token: grant.accessToken }).catch((e) => {
    deps.logger.warn('Calendar connect: the short-term access wasn\'t revoked', { error: e.message });
  });
  throw new HttpsError('failed-precondition', MESSAGES.noLastingAccess);
}

// Whether a link's calendar can stay when the same Google account connects again: an app-made one that still exists,
// or one the owner chose that's still theirs (using that needs the PICK scopes).
async function calendarUsable(api, old, canPick) {
  try {
    if (old.appCalendar === true) {
      await api.request('GET', `/calendars/${enc(old.calendarId)}`, { query: { fields: 'id' } });
      return true;
    }
    if (!canPick) return false;
    const entry = await api.request('GET', `/users/me/calendarList/${enc(old.calendarId)}`, { query: { fields: 'id,accessRole' } });
    return entry?.accessRole === 'owner';
  } catch (e) {
    if (['notFound', 'gone', 'forbidden', 'scope'].includes(e.kind)) return false;
    throw e;
  }
}

async function connect(deps, who, data) {
  const kind = kindOf(data.kind);
  if (kind === 'business' && !who.isOwner) throw new HttpsError('permission-denied', MESSAGES.ownerOnlyConnect);
  const linkId = kind === 'business' ? 'business' : personalLinkId(who.uid);
  const code = typeof data.code === 'string' ? data.code.trim() : '';
  if (!code || code.length > 4096) throw new HttpsError('invalid-argument', MESSAGES.noCode);
  const { db } = deps;
  const { companyId } = who;

  let grant;
  try {
    grant = await exchangeCode({ fetch: deps.fetch, oauthBase: deps.oauthBase, client: await deps.oauthClient(), code });
  } catch (e) {
    if (e.kind === 'refused') {
      deps.logger.warn('Calendar connect: Google refused the sign-in code', { status: e.status, reason: e.reason, error: e.message });
      throw new HttpsError('invalid-argument', MESSAGES.codeRejected);
    }
    throw e;
  }
  // Google's sign-in screen has a box for calendar access, which people can untick.
  if (!hasScope(grant.scope, APP_CREATED_SCOPE)) throw new HttpsError('invalid-argument', MESSAGES.calendarNotAllowed);
  if (!grant.email) throw new HttpsError('invalid-argument', MESSAGES.noEmail);

  const tokens = new Map((await db.collection(`companies/${companyId}/calendarTokens`).get()).docs.map((d) => [d.id, d.data()]));
  const access = await lastingAccess(deps, grant, linkId, tokens);
  const progress = { saved: false };
  try {
    return await connectWith(deps, who, { kind, linkId, grant, access, old: tokens.get(linkId) || null, progress });
  } catch (e) {
    if (!progress.saved) await handBackUnsaved(deps, grant, access, tokens);
    throw e;
  }
}

// Google sends the lasting access (a refresh token) only the first time a person agrees. When connecting fails before
// it's saved and nothing else holds one for this Google account, it's handed back, so that the next Connect gets a new
// one instead of "Press Connect once more". Kept when another link uses the account (the next try reuses that one) or
// when that can't be checked.
async function handBackUnsaved(deps, grant, access, tokens) {
  if (!grant.refreshToken || access.refreshToken !== grant.refreshToken) return;
  const holds = (t) => !!t?.refreshToken && sameEmail(t.email, grant.email);
  if ([...tokens.values()].some(holds)) return;
  try {
    if ((await accessesOf(deps.db, grant.email)).some(({ token }) => holds(token))) return;
  } catch (e) {
    deps.logger.warn('Calendar connect: kept the new access, as other businesses couldn\'t be checked', { error: e.message });
    return;
  }
  await revokeToken({ fetch: deps.fetch, oauthBase: deps.oauthBase, token: grant.refreshToken }).catch((e) => {
    deps.logger.warn('Calendar connect: the unsaved access wasn\'t handed back', { error: e.message });
  });
}

async function connectWith(deps, who, { kind, linkId, grant, access, old, progress }) {
  const { db } = deps;
  const { companyId } = who;
  const sameAccount = !!old && sameEmail(old.email, grant.email);
  const canPick = hasPickScopes(access.scopes);
  // The same account coming back to one of its own calendars (after its access was removed, say) keeps that calendar,
  // which needs the extra permission: without it, a new calendar would be made and the app's copies on the old one
  // left behind for good. 'needs-permission' tells the app to ask for it.
  if (sameAccount && old.calendarId && old.appCalendar !== true && !canPick) throw new HttpsError('failed-precondition', MESSAGES.needsPermission);

  // Another Google account takes the link over (a new owner, or the holder switched accounts): the app's events come
  // off the old account's calendar first. Best effort, so an old access that no longer works doesn't stop this.
  if (old && !sameAccount) await cleanupLink(deps, companyId, linkId, old);

  // The same account keeps its calendar while it's still there. Otherwise the app makes a new one.
  const ctx = await loadContext(db, companyId);
  const setup = apiFor(deps, { companyId, token: { refreshToken: access.refreshToken, scopes: access.scopes }, accessToken: access.accessToken, expiresAt: access.expiresAt });
  let calendar = null;
  if (sameAccount && old.calendarId && await calendarUsable(setup, old, canPick)) {
    calendar = { calendarId: old.calendarId, calendarName: old.calendarName || '', appCalendar: old.appCalendar === true };
  } else {
    const cal = await createAppCalendar(setup, { kind, short: ctx.company.short, timeZone: ctx.company.timeZone, appUrl: deps.appUrl });
    calendar = { calendarId: cal.id, calendarName: cal.summary, appCalendar: true };
  }

  const connectedAt = Timestamp.fromDate(deps.now());
  const token = {
    kind, uid: who.uid, email: grant.email, emailKey: emailKey(grant.email), refreshToken: access.refreshToken, scopes: access.scopes, ...calendar,
    connectedAt, needsFullSync: true,
  };
  await tokenRef(db, companyId, linkId).set(token);
  progress.saved = true;
  await linkRef(db, companyId, linkId).set({
    kind, uid: who.uid, holderName: oneLine(who.member.name) || grant.email, email: grant.email, ...calendar, canPick,
    status: 'syncing', error: '', connectedAt, syncedAt: null, count: 0,
  });
  const api = apiFor(deps, { companyId, linkId, token, accessToken: access.accessToken, expiresAt: access.expiresAt });
  const count = await fullSync(deps, ctx, linkId, token, api);
  return { ok: true, email: grant.email, calendarName: token.calendarName, count: count ?? 0, canPick: hasPickScopes(token.scopes) };
}

// ---------- Choosing the business calendar ----------

// The owner's own calendars. That needs the PICK permission, so the scopes are checked first, and again once there's
// an access token: a refresh can show the access covers less (a refresh token reused from another link). Without it,
// 'needs-permission' tells the app to ask for it.
async function ownCalendarsOrAsk(api) {
  const ask = () => new HttpsError('failed-precondition', MESSAGES.needsPermission);
  if (!hasPickScopes(api.session.scope)) throw ask();
  await api.session.accessToken();
  if (!hasPickScopes(api.session.scope)) throw ask();
  try {
    return await ownedCalendars(api);
  } catch (e) {
    if (e.kind === 'scope') throw ask();
    throw e;
  }
}

// Calendars the business's other links use (people's own schedules), which the business calendar can't share: both
// would write the same events there.
async function calendarsOfOtherLinks(db, companyId) {
  const snap = await db.collection(`companies/${companyId}/calendarTokens`).get();
  return new Set(snap.docs.filter((d) => d.id !== 'business').map((d) => d.data().calendarId).filter(Boolean));
}

const calendarName = (c) => c.summaryOverride || c.summary || c.id;

async function calendars(deps, who, data) {
  requireOwnerBusiness(who, data);
  const token = await businessToken(deps, who);
  const api = apiFor(deps, { companyId: who.companyId, linkId: 'business', token });
  const list = await ownCalendarsOrAsk(api);
  const taken = await calendarsOfOtherLinks(deps.db, who.companyId);
  return {
    calendars: list.filter((c) => !taken.has(c.id))
      .map((c) => ({ id: c.id, name: calendarName(c), primary: c.primary === true, current: c.id === token.calendarId }))
      .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name)),
  };
}

async function choose(deps, who, data) {
  requireOwnerBusiness(who, data);
  const target = data.calendarId;
  if (typeof target !== 'string' || !target || target.length > 1024) throw new HttpsError('invalid-argument', MESSAGES.pickCalendar);
  const { db } = deps;
  const { companyId } = who;
  const token = await businessToken(deps, who);
  const api = apiFor(deps, { companyId, linkId: 'business', token });

  let next = null; // the calendar to move to, or null to stay
  if (target === 'new') {
    if (token.appCalendar !== true) next = 'new';
  } else if (target !== token.calendarId) {
    const list = await ownCalendarsOrAsk(api);
    if ((await calendarsOfOtherLinks(db, companyId)).has(target)) throw new HttpsError('failed-precondition', MESSAGES.calendarInUse);
    const found = list.find((c) => c.id === target);
    if (!found) throw new HttpsError('invalid-argument', MESSAGES.notYourCalendar);
    next = { calendarId: found.id, calendarName: calendarName(found), appCalendar: false };
  }

  const ctx = await loadContext(db, companyId);
  if (!next) {
    const count = await fullSync(deps, ctx, 'business', token, api);
    return { ok: true, calendarName: token.calendarName, count: count ?? 0 };
  }
  if (next === 'new') {
    const cal = await createAppCalendar(api, { kind: 'business', short: ctx.company.short, timeZone: ctx.company.timeZone, appUrl: deps.appUrl });
    next = { calendarId: cal.id, calendarName: cal.summary, appCalendar: true };
  }
  // The schedule is copied to the new calendar first. The app's events come off the old one (deleted if the app made
  // it and it's empty now) only once that worked, so a calendar Google won't let the app write to leaves everything
  // where it was.
  const was = { calendarId: token.calendarId, calendarName: token.calendarName || '', appCalendar: token.appCalendar === true };
  const point = async (cal, status) => {
    await tokenRef(db, companyId, 'business').update({ ...cal, needsFullSync: true });
    await updateLink(db, companyId, 'business', { ...cal, status, error: '' });
    Object.assign(token, cal, { needsFullSync: true });
  };
  await point(next, 'syncing');
  let count;
  try {
    count = await fullSync(deps, ctx, 'business', token, api);
  } catch (e) {
    deps.logger.warn('Calendar choose: the new calendar didn\'t take the schedule, so it stays on the old one', { error: e.message });
    await clearCalendar(deps, api, next.calendarId, { companyId, deleteIfEmpty: next.appCalendar === true });
    await point(was, 'syncing');
    // Back on the old calendar, which still has the schedule; a full sync catches up on changes made meanwhile.
    await fullSync(deps, ctx, 'business', token, api).catch(() => {}); // a problem there shows on the link
    if (e instanceof GoogleError && ['scope', 'forbidden'].includes(e.kind)) throw new HttpsError('failed-precondition', MESSAGES.cantUseCalendar);
    throw e;
  }
  await clearCalendar(deps, api, was.calendarId, { companyId, deleteIfEmpty: was.appCalendar });
  return { ok: true, calendarName: token.calendarName, count: count ?? 0 };
}

// ---------- Sync now, and disconnecting ----------

async function resync(deps, who, data) {
  const kind = kindOf(data.kind);
  let linkId;
  let token;
  if (kind === 'business') {
    if (!who.isOwner) throw new HttpsError('permission-denied', MESSAGES.ownerOnly);
    linkId = 'business';
    token = await businessToken(deps, who);
  } else {
    linkId = personalLinkId(who.uid);
    token = (await tokenRef(deps.db, who.companyId, linkId).get()).data();
    if (!token) throw new HttpsError('failed-precondition', MESSAGES.notConnected);
  }
  const ctx = await loadContext(deps.db, who.companyId);
  const count = await fullSync(deps, ctx, linkId, token);
  return { ok: true, count: count ?? 0 };
}

// Business: the owner, or whoever connected it (the previous owner, say). Personal: your own; anyone's for the owner;
// for an admin, staff's and the accountant's, and those of people no longer on the team. That's who each can remove
// from the team (firestore.rules), and a disconnect can end the person's Google access.
async function disconnect(deps, who, data) {
  const kind = kindOf(data.kind);
  const { db } = deps;
  const { companyId } = who;
  let linkId = 'business';
  if (kind === 'personal') {
    linkId = personalLinkId(data.uid === undefined || data.uid === null || data.uid === '' ? who.uid : data.uid);
    if (linkId !== who.uid && !who.isOwner) {
      if (who.role !== 'admin') throw new HttpsError('permission-denied', MESSAGES.othersCalendar);
      const [target, company] = await Promise.all([db.doc(`companies/${companyId}/members/${linkId}`).get(), db.doc(`companies/${companyId}`).get()]);
      if (company.data()?.ownerUid === linkId || ['owner', 'admin'].includes(target.data()?.role)) {
        throw new HttpsError('permission-denied', MESSAGES.adminsCalendar);
      }
    }
  }
  const [tokenSnap, linkSnap] = await Promise.all([tokenRef(db, companyId, linkId).get(), linkRef(db, companyId, linkId).get()]);
  const token = tokenSnap.data();
  if (kind === 'business' && !who.isOwner && (token?.uid ?? linkSnap.data()?.uid) !== who.uid) {
    throw new HttpsError('permission-denied', MESSAGES.businessDisconnect);
  }
  if (!token) {
    if (linkSnap.exists) await linkSnap.ref.delete();
    return { ok: true, removed: 0 };
  }
  const { removed } = await removeLink(deps, companyId, linkId, token);
  return { ok: true, removed };
}

// ---------- The callable ----------

// input: the deps (see withDefaults in sync.js) plus auth (request.auth) and data (request.data).
export async function handleAccountCall(input) {
  const deps = withDefaults(input);
  const data = input.data && typeof input.data === 'object' ? input.data : {};
  try {
    const who = await requireMember(deps.db, input.auth?.uid, data.companyId);
    switch (data.action) {
      case 'status': {
        const { clientId } = await deps.oauthClient();
        return { clientId, basicScope: BASIC_SCOPE, pickScope: `${BASIC_SCOPE} ${PICK_SCOPE}` };
      }
      case 'connect': return await connect(deps, who, data);
      case 'calendars': return await calendars(deps, who, data);
      case 'choose': return await choose(deps, who, data);
      case 'resync': return await resync(deps, who, data);
      case 'disconnect': return await disconnect(deps, who, data);
      default: throw new HttpsError('invalid-argument', MESSAGES.unknownAction);
    }
  } catch (e) {
    throw toHttpsError(e, deps.logger);
  }
}
