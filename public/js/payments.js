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

// Firebase adds the HTTP status to the server's sentence ("That invoice no longer exists. [404]"). People see the sentence alone.
const messageOf = (e) => String(e?.message || '').replace(/\s*\[\d{1,3}\]$/, '');

// The function's own sentences come through as they are. A call that didn't get one fails with a bare code:
// "internal" (or "not-found") before the function is deployed, with no connection or when it ran out of time,
// and "INTERNAL" when it crashed.
export function paymentsError(e) {
  const code = String(e?.code || '').replace(/^functions\//, '');
  const msg = messageOf(e);
  if (msg && msg !== code && msg !== 'INTERNAL') return msg;
  if (navigator.onLine === false) return 'You\'re offline. Try again once you\'re connected.';
  // Online payments only go on once the function answers (Settings), so while they're off it's most likely not deployed.
  if (['internal', 'not-found'].includes(code) && msg === code && !state.company?.onlinePayments) {
    return 'Online payments aren\'t set up yet (STRIPE_SETUP.md has the steps).';
  }
  return 'Stripe didn\'t answer, or something went wrong. Wait a moment, then try again.';
}
