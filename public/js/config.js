// Firebase web config for Stellar Glass (project stellar-glass-jobs), shared by the app and the public quote page.
// On Firebase Hosting the config comes from /__/firebase/init.json, so no keys live in the repo.
// On localhost both talk to the local emulators (npm run dev) unless the URL has ?live.
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
export const useEmulators = local && !new URLSearchParams(location.search).has('live');

export async function loadConfig() {
  if (useEmulators) {
    return { apiKey: 'demo-key', authDomain: 'demo-stellar-glass.firebaseapp.com', projectId: 'demo-stellar-glass', appId: 'demo-app', storageBucket: 'demo-stellar-glass.appspot.com' };
  }
  const res = await fetch('/__/firebase/init.json');
  if (!res.ok) throw new Error('Firebase config not found. Deploy with Firebase Hosting, or run locally with npm run dev.');
  const cfg = await res.json();
  // The registered web app (stellar-glass-web).
  cfg.appId = cfg.appId || '1:983625532359:web:5660f743e2850fb52e0fe2';
  return cfg;
}
