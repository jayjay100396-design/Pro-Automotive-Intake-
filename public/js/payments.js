// Online payments through Stripe. The app never talks to Stripe itself: it calls the
// stripeInvoices Cloud Function (functions/index.js), which holds the Stripe key.
import { app, useEmulators } from './firebase.js';
import { state } from './data.js';

let callable = null;

// Loads the Functions SDK the first time it's needed, so the rest of the app doesn't wait for it.
async function stripeInvoices() {
  if (!callable) {
    const { getFunctions, httpsCallable, connectFunctionsEmulator } = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js');
    const functions = getFunctions(app, 'us-central1');
    if (useEmulators) connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    callable = httpsCallable(functions, 'stripeInvoices', { timeout: 130000 });
  }
  return callable;
}

const run = async (action, extra = {}) => (await (await stripeInvoices())({ action, companyId: state.companyId, ...extra })).data;

export const paymentsStatus = () => run('status');
// send: true has Stripe email the invoice; false only makes the payment link.
export const sendWithStripe = (invoiceId, send) => run('create', { invoiceId, send });
export const voidWithStripe = (invoiceId) => run('void', { invoiceId });
export const checkWithStripe = (invoiceId) => run('sync', { invoiceId });

// The function's own messages come through as they are. Before it's deployed, a call fails
// with a bare "internal" error.
export function paymentsError(e) {
  const code = String(e?.code || '').replace(/^functions\//, '');
  if (code === 'not-found' || (code === 'internal' && (!e.message || e.message === 'internal'))) {
    return 'Online payments aren\'t set up yet (STRIPE_SETUP.md has the steps).';
  }
  return e?.message || 'Something went wrong.';
}
