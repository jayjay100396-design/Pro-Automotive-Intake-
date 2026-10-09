// Stripe invoices for the app's invoices. index.js wires these to Cloud Functions; tests call them
// directly with a Firestore emulator and a fake Stripe client.
//
// The app invoice at companies/{companyId}/invoices/{invoiceId} gets a `stripe` map:
//   status      'creating' | 'open' | 'paid' | 'void' | 'uncollectible' (Stripe's invoice status)
//   invoiceId   Stripe invoice id; number, hostedUrl (payment page), pdfUrl, amountDue, livemode
//   issued      how many Stripe invoices have been finalized for this bill (numbers 1003, 1003-2, ...)
//   sentTo, sentAt, error
// and the customer gets stripeCustomerIds: { test, live }. Only this server code writes those
// fields; firestore.rules keeps the app from changing them.
import { HttpsError } from 'firebase-functions/v2/https';
import { stripeItems, invoiceTotals, proposalStatusText, daysUntilDue, floridaDate, clip } from './lines.js';

export const BILLING_ROLES = ['owner', 'admin', 'staff', 'accountant'];
const CLAIM_MS = 180e3; // longer than the function's 120 s timeout
const ID = /^[\w-]{1,128}$/;

// Only the business named in STRIPE_COMPANY_ID can bill through the Stripe account. '*' (any
// business) is allowed only in the local emulator.
export const companyAllowed = (companyId, allowed, emulated = false) => !!companyId
  && (companyId === allowed || (emulated && allowed === '*'));

// The caller must be signed in and a member of the business with a billing role.
export async function requireBiller(db, uid, companyId) {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (typeof companyId !== 'string' || !ID.test(companyId)) throw new HttpsError('invalid-argument', 'Missing business.');
  const member = await db.doc(`companies/${companyId}/members/${uid}`).get();
  const role = member.exists ? member.data().role : null;
  if (!BILLING_ROLES.includes(role)) throw new HttpsError('permission-denied', 'Your role can\'t send invoices.');
  return role;
}

// Turns a Stripe error into a message the app can show.
export function friendlyError(e) {
  if (e instanceof HttpsError) return e;
  if (e?.type === 'StripeAuthenticationError') return new HttpsError('failed-precondition', 'Stripe rejected the API key. Check the STRIPE_SECRET_KEY secret.');
  if (e?.type === 'StripePermissionError') return new HttpsError('failed-precondition', 'The Stripe key needs Customers and Invoices set to Write.');
  if (e?.type === 'StripeConnectionError' || e?.type === 'StripeAPIError') return new HttpsError('unavailable', 'Couldn\'t reach Stripe. Try again in a minute.');
  if (typeof e?.type === 'string' && e.type.startsWith('Stripe')) return new HttpsError('failed-precondition', `Stripe: ${e.message}`);
  return new HttpsError('internal', 'Something went wrong while talking to Stripe. Try again.');
}

// Checks that the key works. A restricted key with Customers: Write can list customers.
export async function stripeStatus({ stripe, livemode }) {
  try {
    await stripe.customers.list({ limit: 1 });
    return { connected: true, livemode };
  } catch (e) {
    return { connected: false, livemode, problem: friendlyError(e).message };
  }
}

function invoiceRef(db, companyId, invoiceId) {
  if (typeof invoiceId !== 'string' || !ID.test(invoiceId)) throw new HttpsError('invalid-argument', 'Missing invoice.');
  return db.doc(`companies/${companyId}/invoices/${invoiceId}`);
}

// What the app needs back after an action (the timestamps stay on the document).
const summary = (s) => ({
  status: s.status ?? null, invoiceId: s.invoiceId ?? null, number: s.number ?? null, hostedUrl: s.hostedUrl ?? null,
  pdfUrl: s.pdfUrl ?? null, amountDue: s.amountDue ?? null, livemode: !!s.livemode, sentTo: s.sentTo ?? null, error: s.error ?? null,
});

const fromStripe = (si) => ({
  status: si.status, invoiceId: si.id, number: si.number || null, hostedUrl: si.hosted_invoice_url || null,
  pdfUrl: si.invoice_pdf || null, amountDue: (si.amount_due ?? 0) / 100, livemode: !!si.livemode,
});

const prefixed = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [`stripe.${k}`, v]));

// The bill's job and customer. The customer comes from the invoice, or else from its job.
async function billTo(db, companyId, inv) {
  const job = inv.jobId ? (await db.doc(`companies/${companyId}/jobs/${inv.jobId}`).get()).data() || {} : {};
  const customerId = inv.customerId || job.customerId || null;
  const cust = customerId ? (await db.doc(`companies/${companyId}/customers/${customerId}`).get()).data() || null : null;
  return { job, customerId, cust };
}

// The bill-to name Stripe shows: the company (a GC or business) with the contact person.
function customerFields(cust, companyId, customerId) {
  const name = cust.company ? `${cust.company}${cust.name ? ` (Attn: ${cust.name})` : ''}` : (cust.name || 'Customer');
  const fields = { name: clip(name, 256), metadata: { companyId, customerId } };
  if (cust.email) fields.email = String(cust.email).trim();
  if (cust.phone) fields.phone = clip(cust.phone, 20);
  if (cust.address) fields.address = { line1: clip(cust.address, 200) };
  return fields;
}

// Finds or makes the Stripe customer for an app customer, and refreshes their details.
// Test-mode and live-mode customers are separate in Stripe, so each mode keeps its own id.
async function ensureCustomer({ db, stripe, livemode, companyId, customerId, cust }) {
  const mode = livemode ? 'live' : 'test';
  const fields = customerFields(cust, companyId, customerId);
  const known = cust.stripeCustomerIds?.[mode];
  if (known) {
    try {
      await stripe.customers.update(known, fields);
      return known;
    } catch (e) {
      if (e?.code !== 'resource_missing') throw e;
    }
  }
  const created = await stripe.customers.create(fields);
  await db.doc(`companies/${companyId}/customers/${customerId}`).update({ [`stripeCustomerIds.${mode}`]: created.id });
  return created.id;
}

// For a bill made from a proposal (deposit or final invoice): the proposal's price, what's been paid
// on it so far (other paid invoices from it) and what this invoice leaves. '' for other bills.
async function proposalStatus(db, companyId, invoiceId, inv) {
  const price = Number(inv.proposalPrice);
  if (typeof inv.estimateId !== 'string' || !ID.test(inv.estimateId) || !(price > 0)) return '';
  const snap = await db.collection(`companies/${companyId}/invoices`).where('estimateId', '==', inv.estimateId).get();
  const paidBefore = snap.docs.filter((d) => d.id !== invoiceId && d.data().status !== 'void').reduce((sum, d) => {
    const other = d.data();
    return sum + (other.status === 'paid' ? invoiceTotals(other).total : Number(other.stripe?.amountPaid) || 0);
  }, 0);
  return proposalStatusText({ number: inv.proposalNumber ?? '', price, paidBefore, thisInvoice: invoiceTotals(inv).total });
}

// Has Stripe email the invoice. A failure here leaves the invoice made, with a note to send it again.
async function sendEmail(stripe, ref, stripeInvoiceId, email) {
  try {
    await stripe.invoices.sendInvoice(stripeInvoiceId);
    await ref.update({ 'stripe.sentTo': email || null, 'stripe.sentAt': new Date(), 'stripe.error': null });
    return null;
  } catch (e) {
    const message = `Made the Stripe invoice, but Stripe couldn't email it. ${friendlyError(e).message}`;
    await ref.update({ 'stripe.error': message });
    return message;
  }
}

// Makes (or reuses) the Stripe invoice for an app invoice: same number, one item per line plus
// sales tax, due on the app's due date. With send, Stripe emails it to the customer.
export async function createStripeInvoice({ db, stripe, livemode, companyId, invoiceId, uid = null, send = false, now = new Date() }) {
  const ref = invoiceRef(db, companyId, invoiceId);

  // Claim the invoice first, so a double click can't make two Stripe invoices.
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'That invoice no longer exists.');
    const inv = snap.data();
    const prev = inv.stripe || {};
    if (inv.status === 'paid' || prev.status === 'paid') throw new HttpsError('failed-precondition', 'This invoice is already paid.');
    if (inv.status === 'void') throw new HttpsError('failed-precondition', 'This invoice is void.');
    if (prev.status === 'open' && !!prev.livemode === livemode) return { inv, prev, existing: true };
    const claimedAt = prev.claimedAt?.toDate?.() || null;
    if (prev.status === 'creating' && claimedAt && now - claimedAt < CLAIM_MS) {
      throw new HttpsError('aborted', 'The Stripe invoice is already being made. Wait a moment, then reopen the invoice.');
    }
    tx.update(ref, { stripe: { ...prev, status: 'creating', claimedAt: now, error: null } });
    return { inv, prev };
  });
  const { inv, prev } = claim;

  // Already open in Stripe: just (re)send it if asked.
  if (claim.existing) {
    let warning = null;
    if (send) {
      const { cust } = await billTo(db, companyId, inv);
      if (!cust?.email) throw new HttpsError('failed-precondition', 'Add an email address for this customer first (Customers page).');
      warning = await sendEmail(stripe, ref, prev.invoiceId, cust.email);
    }
    return { ...summary((await ref.get()).data().stripe), warning };
  }

  // Stripe invoices already made for this bill in this mode (test-mode tries don't count).
  const issued = !!prev.livemode === livemode ? prev.issued || 0 : 0;
  let cust = null;
  let finalized = null;
  let draftId = null;
  try {
    const bill = await billTo(db, companyId, inv);
    cust = bill.cust;
    const { job, customerId } = bill;
    if (!cust) throw new HttpsError('failed-precondition', 'Pick a job with a customer for this invoice first.');
    if (send && !cust.email) throw new HttpsError('failed-precondition', `Add an email address for ${cust.name || 'this customer'} first (Customers page), or use Get a payment link.`);

    const { items, totalCents } = stripeItems(inv);
    if (totalCents < 50) throw new HttpsError('failed-precondition', 'Stripe can only collect invoices of $0.50 or more.');

    const customer = await ensureCustomer({ db, stripe, livemode, companyId, customerId, cust });

    // If an earlier try finished in Stripe but never got saved here, use that invoice.
    const open = await stripe.invoices.list({ customer, status: 'open', limit: 100 });
    finalized = open.data.find((si) => si.metadata?.companyId === companyId && si.metadata?.invoiceId === invoiceId) || null;

    if (!finalized) {
      // The app's number (1003), or 1003-2, 1003-3 ... when a bill is sent again after a void.
      let number = inv.number ? clip(issued ? `${inv.number}-${issued + 1}` : String(inv.number), 26) : '';
      const custom = [['Project', job.name], ['Site', job.siteAddress], ['PO / project #', job.poNumber]]
        .filter(([, v]) => v).map(([name, value]) => ({ name, value: clip(value, 140) }));
      // If Stripe won't take the number (say it was already used), Stripe numbers the invoice
      // and the app's number goes in a custom field instead.
      const numberField = () => ({ custom_fields: [...custom, { name: 'Invoice #', value: clip(String(inv.number), 140) }] });
      const memo = [await proposalStatus(db, companyId, invoiceId, inv), String(inv.notes || '').trim()].filter(Boolean).join('\n\n');
      const params = {
        customer,
        collection_method: 'send_invoice',
        days_until_due: daysUntilDue(inv.dueDate, now),
        auto_advance: false,
        pending_invoice_items_behavior: 'exclude',
        currency: 'usd',
        metadata: { companyId, invoiceId, appNumber: String(inv.number ?? '') },
        ...(custom.length ? { custom_fields: custom } : {}),
        ...(memo ? { description: clip(memo, 1500) } : {}),
      };
      let draft;
      try {
        draft = await stripe.invoices.create(number ? { ...params, number } : params);
      } catch (e) {
        if (!number || e?.type !== 'StripeInvalidRequestError') throw e;
        number = '';
        draft = await stripe.invoices.create({ ...params, ...numberField() });
      }
      draftId = draft.id;
      // One at a time, so the lines keep the invoice's order.
      for (const item of items) {
        await stripe.invoiceItems.create({ customer, invoice: draft.id, currency: 'usd', ...item });
      }
      try {
        finalized = await stripe.invoices.finalizeInvoice(draft.id, { auto_advance: false });
      } catch (e) {
        if (!number || e?.type !== 'StripeInvalidRequestError') throw e;
        await stripe.invoices.update(draft.id, { number: '', ...numberField() });
        finalized = await stripe.invoices.finalizeInvoice(draft.id, { auto_advance: false });
      }
      draftId = null;
    }

    await ref.update({
      stripe: {
        ...fromStripe(finalized), issued: issued + 1, createdAt: now, createdBy: uid,
        sentTo: null, sentAt: null, error: null, claimedAt: null,
      },
    });
  } catch (e) {
    // A half-made draft is never sent; remove it so it doesn't clutter Stripe.
    if (draftId) await stripe.invoices.del(draftId).catch(() => {});
    const err = friendlyError(e);
    if (err.code === 'internal') console.error('Stripe invoice failed', e);
    const restored = { ...prev, status: prev.status === 'creating' ? null : (prev.status ?? null), claimedAt: null, error: err.message, errorAt: new Date() };
    await ref.update({ stripe: restored }).catch(() => {});
    throw err;
  }
  const warning = send ? await sendEmail(stripe, ref, finalized.id, cust.email) : null;
  return { ...summary((await ref.get()).data().stripe), warning };
}

// Voids the open Stripe invoice (to correct it, or because it was paid by check).
export async function voidStripeInvoice({ db, stripe, livemode, companyId, invoiceId }) {
  const ref = invoiceRef(db, companyId, invoiceId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That invoice no longer exists.');
  const s = snap.data().stripe || {};
  if (!s.invoiceId || s.status !== 'open') throw new HttpsError('failed-precondition', 'There\'s no open Stripe invoice to void.');
  if (!!s.livemode !== livemode) {
    if (s.livemode) throw new HttpsError('failed-precondition', 'That Stripe invoice is live, but the app is using a test key right now.');
    // Made with the test key: the live key can't see it, and nobody can pay it for real.
    await ref.update({ 'stripe.status': 'void', 'stripe.voidedAt': new Date() });
    return summary({ ...s, status: 'void' });
  }
  try {
    const voided = await stripe.invoices.voidInvoice(s.invoiceId);
    await ref.update({ ...prefixed(fromStripe(voided)), 'stripe.voidedAt': new Date(), 'stripe.error': null });
    return summary({ ...s, ...fromStripe(voided), error: null });
  } catch (e) {
    // Most likely the customer just paid it: record that instead.
    const current = await stripe.invoices.retrieve(s.invoiceId).catch(() => null);
    if (current && current.status !== 'open') {
      await applyStripeInvoice(db, current);
      throw new HttpsError('failed-precondition', current.status === 'paid' ? 'The customer already paid this Stripe invoice.' : `The Stripe invoice is already ${current.status}.`);
    }
    throw friendlyError(e);
  }
}

// Asks Stripe for the current state of the bill's Stripe invoice and records it.
export async function syncStripeInvoice({ db, stripe, livemode, companyId, invoiceId }) {
  const ref = invoiceRef(db, companyId, invoiceId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That invoice no longer exists.');
  const s = snap.data().stripe || {};
  if (!s.invoiceId) throw new HttpsError('failed-precondition', 'This invoice hasn\'t been sent with Stripe yet.');
  if (!!s.livemode !== livemode) return summary(s);
  try {
    const current = await stripe.invoices.retrieve(s.invoiceId);
    await applyStripeInvoice(db, current);
    return summary({ ...s, ...fromStripe(current) });
  } catch (e) {
    throw friendlyError(e);
  }
}

// Records a Stripe invoice's state on its app invoice. When Stripe says paid, the app invoice
// becomes paid on the date Stripe recorded. Older Stripe invoices for the same bill are ignored.
export async function applyStripeInvoice(db, si) {
  const { companyId, invoiceId } = si.metadata || {};
  if (!ID.test(companyId || '') || !ID.test(invoiceId || '')) return false;
  const ref = db.doc(`companies/${companyId}/invoices/${invoiceId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const inv = snap.data();
    if (inv.stripe?.invoiceId !== si.id) return false;
    const update = { ...prefixed(fromStripe(si)), 'stripe.amountPaid': (si.amount_paid ?? 0) / 100, 'stripe.updatedAt': new Date() };
    if (si.status === 'paid') {
      const paidMs = (si.status_transitions?.paid_at || Math.floor(Date.now() / 1000)) * 1000;
      update['stripe.paidAt'] = new Date(paidMs);
      if (inv.status !== 'paid') {
        update.status = 'paid';
        update.paidDate = floridaDate(paidMs);
      }
    }
    tx.update(ref, update);
    return true;
  });
}

// Webhook events: re-read the invoice from Stripe rather than trusting the event body, then record it.
export async function handleStripeEvent({ db, stripe, event, allowed, emulated = false }) {
  if (!String(event?.type || '').startsWith('invoice.')) return 'ignored';
  const obj = event.data?.object || {};
  if (!obj.id || !obj.metadata?.invoiceId || !companyAllowed(obj.metadata.companyId, allowed, emulated)) return 'ignored';
  let current;
  try {
    current = await stripe.invoices.retrieve(obj.id);
  } catch (e) {
    if (e?.code === 'resource_missing') return 'ignored'; // a deleted draft
    throw e;
  }
  return (await applyStripeInvoice(db, current)) ? 'updated' : 'ignored';
}
