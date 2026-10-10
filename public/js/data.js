// Company-scoped Firestore access. Every record lives at companies/{companyId}/{collection}/{id}.
import { db } from './firebase.js';
import { SITE_ID } from './brand.js';
import {
  doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, collection, onSnapshot, writeBatch, serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

export const COLLECTIONS = ['customers', 'jobs', 'estimates', 'contracts', 'changeOrders', 'payApps', 'invoices', 'requests'];

export const state = {
  user: null,
  profile: {},
  companyId: null,
  company: null,
  role: null,
  data: Object.fromEntries(COLLECTIONS.map((c) => [c, []])),
};

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn());

let unsubs = [];

// Finds the user's company from their profile. Returns null if they don't have one yet.
export async function loadCompany(user) {
  state.user = user;
  const profile = await getDoc(doc(db, 'users', user.uid));
  state.profile = profile.exists() ? profile.data() : {};
  const companyId = state.profile.companyId || null;
  if (!companyId) return null;
  const member = await getDoc(doc(db, 'companies', companyId, 'members', user.uid)).catch(() => null);
  if (!member || !member.exists()) return null;
  state.companyId = companyId;
  state.role = member.data().role;
  watchCompany();
  return companyId;
}

// Creates a company with the signed-in user as owner (one batch, as the rules require).
export async function createCompany(fields) {
  const user = state.user;
  const ref = doc(collection(db, 'companies'));
  const b = writeBatch(db);
  b.set(ref, { ...fields, ownerUid: user.uid, createdAt: serverTimestamp() });
  b.set(doc(db, 'companies', ref.id, 'members', user.uid), {
    role: 'owner', name: user.displayName || '', email: user.email || '', phone: user.phoneNumber || '', addedAt: serverTimestamp(),
  });
  await b.commit();
  await setDoc(doc(db, 'users', user.uid), { companyId: ref.id }, { merge: true });
  return loadCompany(user);
}

function watchCompany() {
  unsubs.forEach((u) => u());
  unsubs = [];
  const id = state.companyId;
  unsubs.push(onSnapshot(doc(db, 'companies', id), (s) => { state.company = { id: s.id, ...s.data() }; emit(); }));
  for (const c of COLLECTIONS) {
    unsubs.push(onSnapshot(collection(db, 'companies', id, c), (snap) => {
      state.data[c] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      emit();
    }, (err) => console.error(c, err)));
  }
}

export function stopWatching() {
  unsubs.forEach((u) => u());
  unsubs = [];
  state.companyId = null; state.company = null; state.role = null;
  for (const c of COLLECTIONS) state.data[c] = [];
}

const col = (c) => collection(db, 'companies', state.companyId, c);
const ref = (c, id) => doc(db, 'companies', state.companyId, c, id);

export const add = (c, data) => addDoc(col(c), { ...data, createdAt: serverTimestamp(), createdBy: state.user.uid });
export const update = (c, id, data) => updateDoc(ref(c, id), { ...data, updatedAt: serverTimestamp() });
export const remove = (c, id) => deleteDoc(ref(c, id));
// For records whose id is needed before they're written, e.g. a file's storage path.
export const newId = (c) => doc(col(c)).id;
export const put = (c, id, data) => setDoc(ref(c, id), { ...data, createdAt: serverTimestamp(), createdBy: state.user.uid });
export const updateCompany = (data) => updateDoc(doc(db, 'companies', state.companyId), data);

// Remembers who prepares proposals, so the next one is pre-filled. Private to this user.
export function savePreparedBy(preparedBy) {
  state.profile = { ...state.profile, preparedBy };
  return setDoc(doc(db, 'users', state.user.uid), { preparedBy }, { merge: true }).catch((e) => console.warn(e));
}

// Saves a setting on the user's own profile, e.g. whether new uploads also go to Google Drive.
export function saveProfile(fields) {
  state.profile = { ...state.profile, ...fields };
  return setDoc(doc(db, 'users', state.user.uid), fields, { merge: true }).catch((e) => console.warn(e));
}

export async function listMembers() {
  const snap = await getDocs(collection(db, 'companies', state.companyId, 'members'));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

// Hands the company to another member: they become owner, the current owner becomes admin.
// One batch, which is what the security rules require.
export async function transferOwnership(toUid) {
  const id = state.companyId;
  const me = state.user.uid;
  const b = writeBatch(db);
  b.update(doc(db, 'companies', id), { ownerUid: toUid });
  b.update(doc(db, 'companies', id, 'members', toUid), { role: 'owner' });
  b.update(doc(db, 'companies', id, 'members', me), { role: 'admin' });
  await b.commit();
  state.role = 'admin';
}

// ---------- Team: invites and members ----------
const INVITE_DAYS = 7;

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}

export const inviteLink = (inviteId) => `${location.origin}${location.pathname}#/join/${state.companyId}/${inviteId}`;

// Creates a single-use invite link for a role. The random id is the secret in the link.
export async function createInvite(role, label) {
  const id = randomId();
  await setDoc(doc(db, 'companies', state.companyId, 'invites', id), {
    role, label: label || '', companyName: state.company?.name || '',
    createdBy: state.user.uid, createdAt: serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + INVITE_DAYS * 864e5),
  });
  return id;
}

export async function listInvites() {
  const snap = await getDocs(collection(db, 'companies', state.companyId, 'invites'));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export const revokeInvite = (id) => deleteDoc(doc(db, 'companies', state.companyId, 'invites', id));
export const setMemberRole = (uid, role) => updateDoc(doc(db, 'companies', state.companyId, 'members', uid), { role });
export const removeMember = (uid) => deleteDoc(doc(db, 'companies', state.companyId, 'members', uid));

// Reads an invite before joining. Returns null if it's used up, revoked or expired.
export async function readInvite(companyId, inviteId) {
  const snap = await getDoc(doc(db, 'companies', companyId, 'invites', inviteId)).catch(() => null);
  if (!snap || !snap.exists()) return null;
  const inv = snap.data();
  return inv.expiresAt?.toMillis() > Date.now() ? inv : null;
}

// Joins a company with an invite: adds the member record and uses up the invite in one batch.
export async function joinCompany(companyId, inviteId) {
  const user = state.user;
  const inv = await readInvite(companyId, inviteId);
  if (!inv) throw new Error('This invite link has expired or was already used. Ask for a new one.');
  const b = writeBatch(db);
  b.set(doc(db, 'companies', companyId, 'members', user.uid), {
    role: inv.role, inviteId, name: user.displayName || '', email: user.email || '', phone: user.phoneNumber || '', addedAt: serverTimestamp(),
  });
  b.delete(doc(db, 'companies', companyId, 'invites', inviteId));
  await b.commit();
  await setDoc(doc(db, 'users', user.uid), { companyId }, { merge: true });
  return loadCompany(user);
}

// ---------- Public quote page ----------
// sites/{SITE_ID} says which business the public page (quote.html) sends requests to. Anyone can read it.
export async function readSite() {
  const snap = await getDoc(doc(db, 'sites', SITE_ID));
  return snap.exists() ? snap.data() : null;
}

// Owner only: send website requests to this business, or pause them.
export const setSiteOpen = (open) => setDoc(doc(db, 'sites', SITE_ID), { companyId: state.companyId, open, updatedAt: serverTimestamp() });

export const siteLink = () => `${location.origin}/quote`;

export const get = (c, id) => state.data[c].find((r) => r.id === id);
export const where = (c, field, value) => state.data[c].filter((r) => r[field] === value);

// Next document number in a collection, e.g. estimate 1001, 1002...
export function nextNumber(c, start = 1001) {
  const nums = state.data[c].map((r) => Number(r.number) || 0);
  return Math.max(start - 1, ...nums) + 1;
}

export const can = {
  edit: () => ['owner', 'admin', 'staff'].includes(state.role),
  bill: () => ['owner', 'admin', 'staff', 'accountant'].includes(state.role),
  remove: () => ['owner', 'admin'].includes(state.role),
  manage: () => state.role === 'owner',
};
