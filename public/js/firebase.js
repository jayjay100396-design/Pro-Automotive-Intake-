// Firebase setup for Stellar Glass (project stellar-glass-jobs). Config and emulator switch: config.js.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getStorage, connectStorageEmulator } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { useEmulators, loadConfig } from './config.js';

export { useEmulators };

export const app = initializeApp(await loadConfig());
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
}

// Server functions (functions-alerts), loaded the first time one is called: callFunction('sendPartsEmail', {...}).
let functions;
export async function callFunction(name, data) {
  if (!functions) {
    const mod = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js');
    const f = mod.getFunctions(app, 'us-central1');
    if (useEmulators) mod.connectFunctionsEmulator(f, '127.0.0.1', 5001);
    functions = { f, httpsCallable: mod.httpsCallable };
  }
  return (await functions.httpsCallable(functions.f, name, { timeout: 150000 })(data)).data;
}
