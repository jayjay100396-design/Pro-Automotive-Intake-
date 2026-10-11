// Copies of job files in the signed-in person's own Google Drive, sorted into
//   Stellar Glass Jobs / <customer> / <job> / <category>
// It runs entirely in the browser: Firebase's Google sign-in popup hands back a Drive access token.
// The permission asked for is drive.file, so the app only ever sees the folders and files it made.
import { auth, useEmulators } from './firebase.js';
import { GoogleAuthProvider, reauthenticateWithPopup, linkWithPopup } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const KEY = 'stellar-drive';

export class DriveAuthError extends Error {}

// Google access tokens last an hour; keep it for this browser tab only.
let session = (() => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } })();
function keep(s) {
  session = s;
  try { if (s) sessionStorage.setItem(KEY, JSON.stringify(s)); else sessionStorage.removeItem(KEY); } catch { /* private mode */ }
}

// The connected Drive account ({ email }), or null when not connected or the access ran out.
export function driveAccount() {
  if (!session || session.uid !== auth.currentUser?.uid || session.exp < Date.now()) return null;
  return session;
}

export function disconnectDrive() {
  keep(null);
  folders.clear();
}

// Looks folders up afresh next time, in case they were renamed, moved or trashed in Drive itself.
export function forgetFolders() {
  folders.clear();
}

// Asks Google for access to Drive in a popup, so it has to run from a click.
export async function connectDrive() {
  const user = auth.currentUser;
  const provider = new GoogleAuthProvider();
  provider.addScope(SCOPE);
  const google = user.providerData.find((p) => p.providerId === 'google.com');
  let cred; let email;
  try {
    if (google) {
      provider.setCustomParameters({ login_hint: google.email || '' });
      cred = GoogleAuthProvider.credentialFromResult(await reauthenticateWithPopup(user, provider));
      email = google.email;
    } else {
      // Signed in by email or phone: this also lets them sign in with that Google account from now on,
      // so always let them choose the account rather than taking whichever one the browser is in.
      provider.setCustomParameters({ prompt: 'select_account' });
      const r = await linkWithPopup(user, provider);
      cred = GoogleAuthProvider.credentialFromResult(r);
      email = r.user.providerData.find((p) => p.providerId === 'google.com')?.email;
    }
  } catch (e) {
    // That Google account is already someone's sign-in (maybe their own second login). Its Drive still works.
    if (!['auth/credential-already-in-use', 'auth/email-already-in-use'].includes(e.code)) throw e;
    cred = GoogleAuthProvider.credentialFromError(e);
    email = e.customData?.email;
  }
  // The sign-in emulator doesn't issue real Google tokens; local tests stand in for Drive.
  const token = cred?.accessToken || (useEmulators ? 'emulator-token' : null);
  if (!token) throw new Error('Google didn\'t give access to Drive. Try again and allow access to Drive files.');
  folders.clear();
  keep({ uid: user.uid, token, email: email || '', exp: Date.now() + 50 * 60e3 });
  return session;
}

async function call(url, opts = {}) {
  const s = driveAccount();
  if (!s) throw new DriveAuthError('Connect Google Drive first.');
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${s.token}`, ...opts.headers } });
  if (res.ok) return res;
  const err = (await res.json().catch(() => ({}))).error || {};
  const why = `${err.status || ''} ${(err.errors || []).map((x) => x.reason).join(' ')} ${err.message || ''}`;
  if (res.status === 401) { keep(null); throw new DriveAuthError('Google Drive access ran out. Connect Drive again.'); }
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(why)) {
    throw new Error('The Google Drive API is turned off for this app. It needs to be turned on once in Google Cloud (see FIREBASE_SETUP.md).');
  }
  if (res.status === 403 && /insufficient|scope/i.test(why)) {
    keep(null);
    throw new DriveAuthError('Drive access wasn\'t allowed. Connect Drive again and tick the box for Drive files.');
  }
  throw new Error(err.message || `Google Drive error ${res.status}`);
}

const json = (body) => ({ headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body) });

// Finds the app's file or folder tagged with this key (appProperties.stellarKey).
async function findByKey(key, extra = '') {
  const q = `appProperties has { key='stellarKey' and value='${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' } and trashed=false${extra}`;
  const res = await call(`${API}?${new URLSearchParams({ q, fields: 'files(id,name,parents,webViewLink)', pageSize: '5', spaces: 'drive' })}`);
  return (await res.json()).files?.[0] || null;
}

// Folders are found by a key rather than by name, so renaming a job or customer in the app
// renames its Drive folder, and moving a job to another customer moves the folder.
// With `keep`, a folder that's already there stays as it is (for a deleted job or customer).
// The lookup itself is remembered, so copies running at the same time share it instead of
// each making its own folder.
const folders = new Map();
function folder(key, name, parentId, { keep = false } = {}) {
  const cacheKey = `${key}|${name}|${parentId || ''}|${keep}`;
  if (!folders.has(cacheKey)) {
    const found = findOrMakeFolder(key, name, parentId, keep);
    folders.set(cacheKey, found);
    found.catch(() => { if (folders.get(cacheKey) === found) folders.delete(cacheKey); });
  }
  return folders.get(cacheKey);
}

async function findOrMakeFolder(key, name, parentId, keep) {
  let f = await findByKey(key, ` and mimeType='${FOLDER}'`);
  if (!f) {
    f = await (await call(`${API}?fields=id,name,parents`, {
      method: 'POST', ...json({ name, mimeType: FOLDER, ...(parentId ? { parents: [parentId] } : {}), appProperties: { stellarKey: key } }),
    })).json();
  } else if (!keep && (f.name !== name || (parentId && !f.parents?.includes(parentId)))) {
    const params = new URLSearchParams({ fields: 'id,name,parents' });
    if (parentId && !f.parents?.includes(parentId)) {
      params.set('addParents', parentId);
      if (f.parents?.length) params.set('removeParents', f.parents.join(','));
    }
    f = await (await call(`${API}/${f.id}?${params}`, { method: 'PATCH', ...json({ name }) })).json();
  }
  return f.id;
}

const clean = (s, fallback) => String(s || '').replace(/\s+/g, ' ').trim() || fallback;

// The Drive folder for a job, or for one category inside it. Creates whatever is missing.
// `customerId` is the job's customer even when that customer has been deleted (then `customer` is empty);
// a deleted job is marked `deleted`. Either one keeps the folder it already has, under its old name.
export async function jobFolder({ companyId, companyName, job, customer, customerId, category }) {
  const root = await folder(`${companyId}:root`, `${clean(companyName, 'Stellar Glass').replace(/,?\s+(LLC|L\.L\.C\.|Inc\.?|Corp\.?|Co\.?)$/i, '')} Jobs`);
  const custKey = customer?.id || customerId || 'none';
  const cust = await folder(`${companyId}:customer:${custKey}`,
    customer ? clean(customer.name + (customer.company ? ` (${customer.company})` : ''), 'Customer') : custKey === 'none' ? 'No customer' : 'Deleted customer',
    root, { keep: !customer && custKey !== 'none' });
  const jobId = await folder(`${companyId}:job:${job.id}`, clean(job.name, 'Untitled job'), cust, { keep: !!job.deleted });
  return category ? folder(`${companyId}:job:${job.id}:${category.key}`, category.label, jobId) : jobId;
}

export const folderLink = (id) => `https://drive.google.com/drive/folders/${id}`;

// Uploads a file into a folder, unless a copy with this key is already there.
// The same file asked for twice at once (an automatic copy and "Copy all") goes up once.
const saving = new Map();
export function saveFile(key, getBlob, details) {
  if (!saving.has(key)) saving.set(key, upload(key, getBlob, details).finally(() => saving.delete(key)));
  return saving.get(key);
}

async function upload(key, getBlob, { name, mimeType, folderId, description }) {
  const existing = await findByKey(key);
  if (existing) return existing;
  const blob = await getBlob();
  const type = mimeType || blob.type || 'application/octet-stream';
  const meta = { name, mimeType: type, parents: [folderId], description: description || '', appProperties: { stellarKey: key } };
  // Big files (videos, large PDFs) use a resumable upload, which hands back an upload address.
  if (blob.size > 5 * 1024 * 1024) {
    const start = await call(`${UPLOAD}?uploadType=resumable&fields=id,name,webViewLink`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type }, body: JSON.stringify(meta),
    });
    const location = start.headers.get('Location');
    if (location) return (await call(location, { method: 'PUT', headers: { 'Content-Type': type }, body: blob })).json();
  }
  // Everything else goes in one request: the details and the file together.
  const boundary = `stellar${Math.random().toString(36).slice(2)}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`,
    blob, `\r\n--${boundary}--`,
  ]);
  return (await call(`${UPLOAD}?uploadType=multipart&fields=id,name,webViewLink`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).json();
}
