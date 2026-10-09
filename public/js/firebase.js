// Firebase setup for Stellar Glass (project stellar-glass-jobs).
// On Firebase Hosting the web config comes from /__/firebase/init.json, so no keys live in the repo.
// On localhost the app talks to the local emulators (npm run dev) unless the URL has ?live.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const local = ['localhost', '127.0.0.1'].includes(location.hostname);
export const useEmulators = local && !new URLSearchParams(location.search).has('live');

async function loadConfig() {
  if (useEmulators) {
    return { apiKey: 'demo-key', authDomain: 'demo-stellar-glass.firebaseapp.com', projectId: 'demo-stellar-glass', appId: 'demo-app' };
  }
  const res = await fetch('/__/firebase/init.json');
  if (!res.ok) throw new Error('Firebase config not found. Deploy with Firebase Hosting, or run locally with npm run dev.');
  const cfg = await res.json();
  // The registered web app (stellar-glass-web).
  cfg.appId = cfg.appId || '1:983625532359:web:5660f743e2850fb52e0fe2';
  return cfg;
}

export const app = initializeApp(await loadConfig());
export const auth = getAuth(app);
export const db = getFirestore(app);

if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
