// Cloud Functions for the Stellar Glass app: Stripe invoices. Setup steps are in STRIPE_SETUP.md.
//   stripeInvoices  callable from the app: status, create, void, sync
//   stripeWebhook   Stripe's events (invoice paid, voided, uncollectible)
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret, defineString } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import Stripe from 'stripe';
import {
  requireBiller, companyAllowed, stripeStatus, createStripeInvoice, voidStripeInvoice, syncStripeInvoice, handleStripeEvent,
} from './stripe-invoices.js';

initializeApp();
const db = getFirestore();

// Scale to zero when idle and cap at two instances, which keeps the cost at or near $0.
setGlobalOptions({ region: 'us-central1', maxInstances: 2, memory: '256MiB' });

// Stored in Google Secret Manager with `firebase functions:secrets:set`.
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
// Saved in functions/.env.<project id>; the deploy asks for it the first time.
const STRIPE_COMPANY_ID = defineString('STRIPE_COMPANY_ID', {
  description: 'Business ID from the app (Settings > Online payments). Only this business can bill through the Stripe account.',
});

const emulated = process.env.FUNCTIONS_EMULATOR === 'true';

function stripeClient() {
  const key = STRIPE_SECRET_KEY.value();
  const options = { maxNetworkRetries: 2 };
  // Local testing against stripe-mock (STRIPE_MOCK_HOST=localhost:12111 in functions/.env.local).
  const mock = emulated && process.env.STRIPE_MOCK_HOST;
  if (mock) {
    const [host, port] = mock.split(':');
    Object.assign(options, { host, port: Number(port) || 12111, protocol: 'http' });
  }
  return { stripe: new Stripe(key, options), livemode: /^(sk|rk)_live_/.test(key) };
}

export const stripeInvoices = onCall({ secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 120 }, async (request) => {
  const { action, companyId, invoiceId, send } = request.data || {};
  await requireBiller(db, request.auth?.uid, companyId);
  const allowed = companyAllowed(companyId, STRIPE_COMPANY_ID.value(), emulated);
  const { stripe, livemode } = stripeClient();

  if (action === 'status') {
    if (!allowed) return { connected: false, livemode, problem: 'Stripe is set up for a different business.' };
    return stripeStatus({ stripe, livemode });
  }
  if (!allowed) throw new HttpsError('permission-denied', 'Online payments aren\'t set up for this business.');
  const args = { db, stripe, livemode, companyId, invoiceId };
  if (action === 'create') return createStripeInvoice({ ...args, uid: request.auth.uid, send: send === true });
  if (action === 'void') return voidStripeInvoice(args);
  if (action === 'sync') return syncStripeInvoice(args);
  throw new HttpsError('invalid-argument', 'Unknown action.');
});

export const stripeWebhook = onRequest({ secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('POST only');
    return;
  }
  const { stripe } = stripeClient();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.get('stripe-signature'), STRIPE_WEBHOOK_SECRET.value());
  } catch (e) {
    logger.warn('Stripe webhook signature check failed', e.message);
    res.status(400).send('Bad signature');
    return;
  }
  try {
    const result = await handleStripeEvent({ db, stripe, event, allowed: STRIPE_COMPANY_ID.value(), emulated });
    logger.info('Stripe event', { id: event.id, type: event.type, result });
    res.json({ received: true });
  } catch (e) {
    // A 500 makes Stripe retry later.
    logger.error('Stripe webhook failed', { id: event.id, type: event.type, error: e.message });
    res.status(500).send('Error');
  }
});
