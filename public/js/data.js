// Company-scoped Firestore access. Every record lives at companies/{companyId}/{collection}/{id}.
import { db } from './firebase.js';
import {
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, onSnapshot, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

export const COLLECTIONS = ['customers', 'jobs', 'estimates', 'contracts', 'changeOrders', 'payApps', 'invoices'];

export const state = {
  user: null,
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
  const companyId = profile.exists() ? profile.data().companyId : null;
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
export const updateCompany = (data) => updateDoc(doc(db, 'companies', state.companyId), data);

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
