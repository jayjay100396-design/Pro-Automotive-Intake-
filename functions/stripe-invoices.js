// Stripe invoices for the app's invoices. index.js wires these to Cloud Functions; tests call them
// directly with a Firestore emulator and a fake Stripe client.
//
// The app invoice at companies/{companyId}/invoices/{invoiceId} gets a `stripe` map:
//   status      'creating' | 'open' | 'paid' | 'void' | 'uncollectible' (Stripe's invoice status)
//   invoiceId   Stripe invoice id; number, hostedUrl (payment page), pdfUrl, amountDue, livemode
//   amountPaid  what counts as paid on the bill: payments, plus credit on the customer's Stripe account
//               used on it, less credit notes after payment (refunds or credits) and less any overpayment
//               (Stripe makes that credit for the customer's next invoice). credited is that credit note
//               total, paidOnline the payments alone, overpaid the overpayment, and balanceApplied the
//               customer's Stripe balance used on it (negative: a balance they owed, added to it)
//   preCredited what credit notes took off before payment (Stripe asks for that much less)
//   issued      how many Stripe invoices have been finalized for this bill (numbers 1003, 1003-2, ...)
//   sent        what the Stripe invoice was made from (number, lines, tax, notes, due date, and the job's
//               name, site and PO), so the app can tell when the bill or its job is edited afterwards
//   party       who and what it was billed to when it was made (the customer's name, company, address,
//               phone and email; the job's name, site, PO and architect), for the printed invoice once paid
//   sentTo, sentAt, error
//   sending     { token, at } while Stripe is being asked to email it, so another device doesn't email it too
//   claimedAt   while 'creating': when the try making its Stripe invoice claimed the bill (createStripeInvoice)
//   pending     ids of Stripe invoices a try made that aren't saved here yet, kept from before each is
//               finalized until the try ends, so a later try can find one whatever happened
// and the customer gets stripeCustomerIds: { test, live }. Only this server code writes those
// fields; firestore.rules keeps the app from changing them.
import { createHash, randomUUID } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { stripeItems, invoiceTotals, paidOn, proposalStatusText, daysUntilDue, floridaDate, clip } from './lines.js';

export const BILLING_ROLES = ['owner', 'admin', 'staff', 'accountant'];
const CLAIM_MS = 180e3; // longer than the function's 120 s timeout
const MAX_ITEMS = 250; // the most items Stripe takes on one invoice
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

// What Stripe's key page calls the permissions the app uses, by their names in Stripe's errors (rak_invoice_write).
const PERMISSIONS = { customer: 'Customers', invoice: 'Invoices', invoiceitem: 'Invoice items', invoice_item: 'Invoice items', credit_note: 'Credit notes' };

// Turns a Stripe error into a message the app can show.
export function friendlyError(e) {
  if (e instanceof HttpsError) return e;
  if (e?.type === 'StripeAuthenticationError') return new HttpsError('failed-precondition', 'Stripe rejected the API key. Check the STRIPE_SECRET_KEY secret.');
  if (e?.type === 'StripePermissionError') {
    const [, what] = /\brak_([a-z_]+?)_(?:read|write)\b/.exec(e.message || '') || [];
    const missing = what ? ` Stripe says it's missing ${PERMISSIONS[what] || what.replace(/_/g, ' ')}.` : '';
    return new HttpsError('failed-precondition', `The Stripe key needs Customers, Invoices and Credit notes set to Write (and Invoice items, if Stripe lists it).${missing}`);
  }
  if (e?.type === 'StripeConnectionError' || e?.type === 'StripeAPIError') return new HttpsError('unavailable', 'Couldn\'t reach Stripe. Try again in a minute.');
  if (typeof e?.type === 'string' && e.type.startsWith('Stripe')) return new HttpsError('failed-precondition', `Stripe: ${e.message}`);
  return new HttpsError('internal', 'Something went wrong while talking to Stripe. Try again.');
}

// Checks that the key works and can get at what the app uses: customers, invoices, their items and credit
// notes. Listing them needs Read, which the Write that setup asks for includes, so a permission left at
// None shows up here rather than on the first invoice.
export async function stripeStatus({ stripe, livemode }) {
  try {
    await Promise.all([
      stripe.customers.list({ limit: 1 }), stripe.invoices.list({ limit: 1 }),
      stripe.invoiceItems.list({ limit: 1 }), stripe.creditNotes.list({ limit: 1 }),
    ]);
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

// Credit on the customer's Stripe account (say from a credit note that credited their balance) is used
// on their next invoice when it's finalized: Stripe asks for less, or marks it paid outright. A balance
// they owe is added the same way. That amount counts toward what's paid on the bill, and a void
// invoice gives it back. A credit note after payment (a refund, or a credit) takes back part of it.
// A credit note before payment takes that much off what Stripe asks for (preCredited). A customer who
// pays more than it asks for gets the extra as credit on their Stripe account, which counts on the
// invoice it's used on, so it doesn't count here too.
const fromStripe = (si) => {
  const applied = si.status === 'void' || si.ending_balance == null ? 0 : si.ending_balance - (si.starting_balance ?? 0);
  const credited = si.post_payment_credit_notes_amount ?? 0;
  const overpaid = si.amount_overpaid ?? 0;
  return {
    status: si.status, invoiceId: si.id, number: si.number || null, hostedUrl: si.hosted_invoice_url || null,
    pdfUrl: si.invoice_pdf || null, amountDue: (si.amount_due ?? 0) / 100, livemode: !!si.livemode,
    paidOnline: (si.amount_paid ?? 0) / 100, balanceApplied: applied / 100,
    amountPaid: Math.max(0, (si.amount_paid ?? 0) - overpaid + applied - credited) / 100, credited: credited / 100,
    preCredited: (si.pre_payment_credit_notes_amount ?? 0) / 100, overpaid: overpaid / 100,
  };
};

// When Stripe recorded the payment.
const paidAtOf = (si) => new Date((si.status_transitions?.paid_at || Math.floor(Date.now() / 1000)) * 1000);

const prefixed = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [`stripe.${k}`, v]));

// Writes on the bill only while it still has the Stripe invoice read before asking Stripe (s: its id and
// mode), so a write that lands late doesn't go on a newer Stripe invoice another device made meanwhile.
// True if it wrote.
const updateIfSame = (db, ref, s, fields) => db.runTransaction(async (tx) => {
  const cur = (await tx.get(ref)).data()?.stripe;
  if (cur?.invoiceId !== s.invoiceId || !!cur?.livemode !== !!s.livemode) return false;
  tx.update(ref, fields);
  return true;
});
const SENT_AGAIN = 'this invoice was sent with Stripe again meanwhile. Reopen it to see its new Stripe invoice.';

// Whether the bill is still claimed by the try that claimed it at `now` to make its Stripe invoice
// (createStripeInvoice), rather than by a try that took it over after that claim ran out.
const holdsClaim = (s, now) => s?.status === 'creating' && s.claimedAt?.toMillis?.() === now.getTime();

const sameEmail = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// What a Stripe invoice is made from: the bill, and its job's name, site and PO (custom fields).
// A bill without notes of its own gets the business's default notes, as the app shows it.
// The app compares it with the bill and its job (billing.js stripeSig).
const sentFrom = (inv, job = {}, defaultNotes = '') => ({
  number: inv.number ?? null, jobId: inv.jobId ?? null, date: inv.date ?? null, taxPct: inv.taxPct ?? null, dueDate: inv.dueDate ?? null,
  notes: inv.notes ?? defaultNotes,
  lines: (inv.lines || []).map((l) => ({ desc: l.desc ?? '', qty: l.qty ?? null, price: l.price ?? null, taxable: l.taxable !== false })),
  job: { name: job.name ?? '', siteAddress: job.siteAddress ?? '', poNumber: job.poNumber ?? '' },
});

// The business's default invoice notes, which the app shows on a bill without notes of its own.
const defaultNotesOf = async (db, companyId) => (await db.doc(`companies/${companyId}`).get()).data()?.invoiceNotes ?? '';

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

const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();

// Whether a Stripe invoice shows these bill-to details (customerFields). Stripe copies the customer's
// name, phone and address onto an invoice when it's finalized, and its email, which is checked apart.
const sameBillTo = (si, want) => same(si.customer_name, want.name) && same(si.customer_phone, want.phone)
  && same(si.customer_address?.line1, want.address?.line1);

// Who and what a Stripe invoice bills, as the printed invoice shows them (public/js/print.js party).
const partyOf = (cust, job) => ({
  customer: { name: cust.name ?? '', company: cust.company ?? '', address: cust.address ?? '', phone: cust.phone ?? '', email: cust.email ?? '' },
  job: { name: job.name ?? '', siteAddress: job.siteAddress ?? '', poNumber: job.poNumber ?? '', architect: job.architect ?? '' },
});

// A fingerprint of what a Stripe invoice is made from: the bill and its job (sentFrom), and who it's to.
const fingerprint = (sent, cust, companyId, customerId) => createHash('sha256')
  .update(JSON.stringify([sent, customerFields(cust, companyId, customerId)])).digest('hex').slice(0, 40);

// Finds or makes the Stripe customer for an app customer, and refreshes their details.
// Test-mode and live-mode customers are separate in Stripe, so each mode keeps its own id.
async function ensureCustomer({ db, stripe, livemode, companyId, customerId, cust }) {
  const mode = livemode ? 'live' : 'test';
  const fields = customerFields(cust, companyId, customerId);
  const known = cust.stripeCustomerIds?.[mode];
  if (known) {
    try {
      // Details cleared in the app are cleared in Stripe too (an empty value unsets a Stripe field).
      await stripe.customers.update(known, { email: '', phone: '', address: '', ...fields });
      return known;
    } catch (e) {
      if (e?.code !== 'resource_missing') throw e;
    }
  }
  const created = await stripe.customers.create(fields);
  // Two invoices for a new customer sent at the same moment each make a Stripe customer. The first one
  // saved is kept and the other is deleted, so all of the customer's invoices go to one Stripe customer.
  const ref = db.doc(`companies/${companyId}/customers/${customerId}`);
  const kept = await db.runTransaction(async (tx) => {
    const saved = (await tx.get(ref)).data()?.stripeCustomerIds?.[mode];
    if (saved && saved !== known) return saved;
    tx.update(ref, { [`stripeCustomerIds.${mode}`]: created.id });
    return created.id;
  });
  if (kept !== created.id) {
    await stripe.customers.del(created.id).catch(() => {});
    // The kept one has the details the other invoice read, and these may be newer (the customer was edited
    // in between). If they're older instead, the other invoice's Stripe invoice shows the wrong details,
    // and the check before it's saved finds that and cancels it.
    await stripe.customers.update(kept, { email: '', phone: '', address: '', ...fields });
  }
  return kept;
}

// Cancels a Stripe invoice that mustn't be paid or kept: voids it, or if credit on the customer's Stripe
// account paid it when it was finalized (a paid invoice can't be voided), gives that credit back to their
// balance with a credit note, for their next invoice. Stripe doesn't email the customer about it.
async function cancelStripeInvoice(stripe, si) {
  if (si.status !== 'paid') return stripe.invoices.voidInvoice(si.id);
  const left = (si.total ?? 0) - (si.pre_payment_credit_notes_amount ?? 0) - (si.post_payment_credit_notes_amount ?? 0);
  if (left > 0) {
    await stripe.creditNotes.create({
      invoice: si.id, amount: left, credit_amount: left, email_type: 'none', metadata: si.metadata || {},
      memo: 'This invoice was cancelled, so the credit it used is back on your account.',
    });
  }
  return null;
}

const REMINDERS_OFF = 'Stripe emailed the invoice, but couldn\'t turn on its payment reminders.';

// For a bill made from a proposal (deposit or final invoice): the proposal's price, what's been paid
// on it so far (other paid invoices from it) and what this invoice leaves. '' for other bills.
async function proposalStatus(db, companyId, invoiceId, inv) {
  const price = Number(inv.proposalPrice);
  if (typeof inv.estimateId !== 'string' || !ID.test(inv.estimateId) || !(price > 0)) return '';
  const snap = await db.collection(`companies/${companyId}/invoices`).where('estimateId', '==', inv.estimateId).get();
  const paidBefore = snap.docs.filter((d) => d.id !== invoiceId && d.data().status !== 'void')
    .reduce((sum, d) => sum + paidOn(d.data()), 0);
  return proposalStatusText({ number: inv.proposalNumber ?? '', price, paidBefore, thisInvoice: invoiceTotals(inv).total });
}

// Payments recorded in the app (cash, check or other) and Stripe don't mix on one bill.
const RECORDED = 'Payments are recorded on this invoice in the app, so it can\'t go out with Stripe: Stripe would ask for the whole amount.';

// Has Stripe email the invoice. It's noted as emailed first, in a transaction that checks the bill is
// still the one to send (still this open Stripe invoice, and check(tx, bill) for one emailed again): a note
// written after Stripe emailed it could fail and leave it looking unsent, inviting a second email. The
// same transaction claims the send (stripe.sending), so two devices emailing it at once send one email.
// If Stripe says it couldn't email it, the note is put back. made: the Stripe invoice was just made; a
// problem then is returned (the invoice is made either way), else it's thrown. Returns a warning or null.
async function sendEmail({ db, stripe, ref, stripeInvoiceId, email, made = false, check = null }) {
  const lead = made ? 'Made the Stripe invoice, but ' : '';
  const token = randomUUID();
  let before;
  try {
    before = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const st = snap.data()?.stripe || {};
      if (!snap.exists || st.invoiceId !== stripeInvoiceId || st.status !== 'open') {
        throw new HttpsError('failed-precondition', 'This invoice\'s Stripe invoice changed just now. Reopen the invoice to see where it stands.');
      }
      // A claim older than the function's timeout was left by a try that stopped, so it's taken over.
      const claimed = st.sending?.at?.toMillis?.();
      if (claimed && Date.now() - claimed < CLAIM_MS) {
        throw new HttpsError('aborted', 'This invoice is being emailed right now. Reopen it in a moment to see whether it went.');
      }
      if (check) await check(tx, snap.data());
      tx.update(ref, { 'stripe.sentTo': email || null, 'stripe.sentAt': new Date(), 'stripe.error': null, 'stripe.sending': { token, at: new Date() } });
      return { sentTo: st.sentTo ?? null, sentAt: st.sentAt ?? null, livemode: !!st.livemode };
    });
  } catch (e) {
    const err = friendlyError(e);
    if (!made) throw err;
    return `${lead}it wasn't emailed. ${err.message}`;
  }
  // Ends the claim, with what to note about how it went (unless a later try took the claim over).
  const finish = (fields = {}) => db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).data()?.stripe?.sending?.token === token) tx.update(ref, { ...fields, 'stripe.sending': FieldValue.delete() });
  }).catch(() => {});
  try {
    await stripe.invoices.sendInvoice(stripeInvoiceId);
  } catch (e) {
    // No answer from Stripe: it may have emailed it, so it stays noted as emailed rather than invite a second email.
    if (e?.type === 'StripeConnectionError') {
      const message = `${made ? 'Made the Stripe invoice, but couldn\'t tell whether Stripe emailed it' : 'Couldn\'t tell whether Stripe emailed this invoice'} (Stripe didn't answer). Check it in Stripe's dashboard before emailing it again.`;
      await finish({ 'stripe.error': message });
      return message;
    }
    const message = `${lead}Stripe couldn't email it. ${friendlyError(e).message}`;
    await finish({ 'stripe.sentTo': before.sentTo, 'stripe.sentAt': before.sentAt, 'stripe.error': message });
    return message;
  }
  await finish();
  // Stripe's reminders for unpaid invoices (if they're on in its settings) need automatic collection.
  // It stays off until here, so Stripe never emails an invoice by itself (a payment link isn't emailed).
  // If turning it on fails, checking the invoice (opening it in the app does) tries again.
  try {
    await stripe.invoices.update(stripeInvoiceId, { auto_advance: true });
  } catch (e) {
    const message = `${REMINDERS_OFF} ${friendlyError(e).message} Opening the invoice in the app tries again.`;
    await updateIfSame(db, ref, { invoiceId: stripeInvoiceId, livemode: before.livemode }, { 'stripe.error': message }).catch(() => {});
    return message;
  }
  return null;
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
    if (inv.payments?.length) throw new HttpsError('failed-precondition', RECORDED);
    if (prev.status === 'open' && !!prev.livemode === livemode) return { inv, prev, existing: true };
    // A live Stripe invoice that can still be paid stays linked, or its payment couldn't be recorded.
    if (prev.status === 'open' && prev.livemode) {
      throw new HttpsError('failed-precondition', 'This invoice has a live Stripe invoice that can still be paid, but the app is using a test key right now.');
    }
    // So does one Stripe marked uncollectible: it can still be paid, so it's voided before another
    // is made (unless it's from test mode and the live key is in).
    if (prev.status === 'uncollectible' && (prev.livemode || !livemode)) {
      throw new HttpsError('failed-precondition', 'Stripe marked this invoice\'s Stripe invoice uncollectible, but it can still be paid. Void it first (Online payment), then send a new one.');
    }
    const claimedAt = prev.claimedAt?.toDate?.() || null;
    if (prev.status === 'creating' && claimedAt && now - claimedAt < CLAIM_MS) {
      throw new HttpsError('aborted', 'The Stripe invoice is already being made. Wait a moment, then reopen the invoice.');
    }
    // Online payments stay off until the owner turns them on in Settings (one already out can still be
    // emailed again, above).
    if ((await tx.get(db.doc(`companies/${companyId}`))).data()?.onlinePayments !== true) {
      throw new HttpsError('failed-precondition', 'Online payments are off. The owner can turn them on in Settings > Online payments.');
    }
    tx.update(ref, { stripe: { ...prev, status: 'creating', claimedAt: now, error: null } });
    return { inv, prev };
  });
  const { inv, prev } = claim;

  // Already open in Stripe: just (re)send it if asked.
  if (claim.existing) {
    let warning = null;
    if (send) {
      const bill = await billTo(db, companyId, inv);
      if (!bill.cust?.email) throw new HttpsError('failed-precondition', 'Add an email address for this customer first (Customers page).');
      let si;
      let customer;
      try {
        customer = await ensureCustomer({ db, stripe, livemode, companyId, customerId: bill.customerId, cust: bill.cust });
        si = await stripe.invoices.retrieve(prev.invoiceId);
      } catch (e) {
        throw friendlyError(e);
      }
      // Paid, voided or marked uncollectible in Stripe since the app last heard: that's recorded instead.
      if (si.status !== 'open') {
        await applyStripeInvoice(db, stripe, si).catch(() => {});
        throw new HttpsError('failed-precondition', si.status === 'paid' ? 'The customer already paid this Stripe invoice.'
          : `This Stripe invoice is ${si.status === 'void' ? 'void' : 'marked uncollectible'} now, so it wasn't emailed.`);
      }
      const otherCustomer = () => new HttpsError('failed-precondition', 'This invoice now goes to a different customer. Void the Stripe invoice, then send it again.');
      if ((si.customer?.id ?? si.customer) !== customer) throw otherCustomer();
      const mode = livemode ? 'live' : 'test';
      // Checked against the bill, its job and customer as they're saved when it's noted as emailed, so a
      // change made meanwhile on another device (or a payment recorded) stops it.
      const check = async (tx, cur) => {
        const read = async (path) => (await tx.get(db.doc(`companies/${companyId}${path}`))).data();
        if (cur.status === 'paid' || cur.status === 'void') throw new HttpsError('failed-precondition', `This invoice was marked ${cur.status}, so it wasn't emailed.`);
        if (cur.payments?.length) throw new HttpsError('failed-precondition', RECORDED);
        const job = (cur.jobId && await read(`/jobs/${cur.jobId}`)) || {};
        const customerId = cur.customerId || job.customerId || null;
        const cust = customerId ? await read(`/customers/${customerId}`) : null;
        const defaultNotes = (await read(''))?.invoiceNotes ?? '';
        if (!cust || customerId !== bill.customerId || (cust.stripeCustomerIds?.[mode] ?? customer) !== customer) throw otherCustomer();
        if (!cust.email) throw new HttpsError('failed-precondition', 'Add an email address for this customer first (Customers page).');
        // Changed since the Stripe invoice was made (the app hides Email it again then): the Stripe invoice
        // still shows the old details.
        const sent = cur.stripe.sent;
        if (sent && JSON.stringify(sentFrom(cur, job, defaultNotes)) !== JSON.stringify(sentFrom(sent, sent.job))) {
          throw new HttpsError('failed-precondition', 'This invoice changed after its Stripe invoice was made. Void the Stripe invoice and send a new one so the customer sees the changes.');
        }
        // A Stripe invoice keeps the customer's email from when it was made, and Stripe emails that
        // address. If the email changed, it needs a new one.
        if (!sameEmail(si.customer_email, cust.email)) {
          const to = si.customer_email ? `is addressed to ${si.customer_email}` : 'was made without an email address';
          throw new HttpsError('failed-precondition', `This Stripe invoice ${to}. Void it and send a new one so it goes to ${String(cust.email).trim()}.`);
        }
        // It keeps the bill-to name, phone and address from then too.
        if (!sameBillTo(si, customerFields(cust, companyId, customerId))) {
          throw new HttpsError('failed-precondition', 'This customer\'s name, phone or address changed after the Stripe invoice was made. Void it and send a new one so it shows the new details.');
        }
      };
      warning = await sendEmail({ db, stripe, ref, stripeInvoiceId: prev.invoiceId, email: si.customer_email, check });
    }
    return { ...summary((await ref.get()).data().stripe), warning };
  }

  // Stripe invoices already made for this bill in this mode (test-mode tries don't count).
  let issued = !!prev.livemode === livemode ? prev.issued || 0 : 0;
  let cust = null;
  let finalized = null;
  let draftId = null;
  // Earlier tries' Stripe invoices that this one cancels, deletes or finds gone, so they're no longer pending.
  const settled = new Set();
  try {
    const bill = await billTo(db, companyId, inv);
    cust = bill.cust;
    const { job, customerId } = bill;
    const defaultNotes = await defaultNotesOf(db, companyId);
    if (!cust) throw new HttpsError('failed-precondition', 'Pick a job with a customer for this invoice first.');
    if (send && !cust.email) throw new HttpsError('failed-precondition', `Add an email address for ${cust.name || 'this customer'} first (Customers page), or use Get a payment link.`);

    const { items, totalCents } = stripeItems(inv);
    if (totalCents < 50) throw new HttpsError('failed-precondition', 'Stripe can only collect invoices of $0.50 or more.');
    if (items.length > MAX_ITEMS) {
      throw new HttpsError('failed-precondition', `Stripe takes up to ${MAX_ITEMS} lines on an invoice, counting sales tax as one. This one has ${items.length}.`);
    }

    const customer = await ensureCustomer({ db, stripe, livemode, companyId, customerId, cust });
    // What this Stripe invoice is made from. It goes on the invoice too, so a later try can tell
    // whether an invoice it finds there is still right.
    const sent = sentFrom(inv, job, defaultNotes);
    const madeFrom = fingerprint(sent, cust, companyId, customerId);

    // An earlier try may have made a Stripe invoice that never got saved here (its id is pending on the
    // bill). One made from the bill as it is now, for this Stripe customer, is used, even if credit on the
    // customer's account already paid it, unless it has a credit note (a try began cancelling it). Any
    // other is cancelled; if that fails, so does the send, rather than leave two for one bill. A draft is deleted.
    for (const id of prev.pending || []) {
      const si = await stripe.invoices.retrieve(id).catch((e) => {
        if (e?.code === 'resource_missing') return null; // a deleted draft, or one from the other mode
        throw e;
      });
      const credited = si?.pre_payment_credit_notes_amount || si?.post_payment_credit_notes_amount;
      if (!finalized && ['open', 'paid'].includes(si?.status) && !credited && si.metadata?.madeFrom === madeFrom && (si.customer?.id ?? si.customer) === customer) {
        finalized = si;
        continue;
      }
      if (si?.status === 'draft') {
        await stripe.invoices.del(id);
      } else if (si) {
        if (si.status !== 'void') await cancelStripeInvoice(stripe, si);
        issued += 1; // its number is used either way
      }
      settled.add(id);
    }

    if (!finalized) {
      // The app's number (1003), or 1003-2, 1003-3 ... when a bill is sent again after a void.
      let number = inv.number ? clip(issued ? `${inv.number}-${issued + 1}` : String(inv.number), 26) : '';
      const custom = [['Project', job.name], ['Site', job.siteAddress], ['PO / project #', job.poNumber]]
        .filter(([, v]) => v).map(([name, value]) => ({ name, value: clip(value, 140) }));
      // If Stripe won't take the number (say it was already used), Stripe numbers the invoice
      // and the app's number goes in a custom field instead.
      const numberField = () => ({ custom_fields: [...custom, { name: 'Invoice #', value: clip(String(inv.number), 140) }] });
      const memo = [await proposalStatus(db, companyId, invoiceId, inv), String(sent.notes || '').trim()].filter(Boolean).join('\n\n');
      // An invoice dated before today keeps its date as Stripe's date of issue (else it's the day it's
      // finalized). Midday in Florida, so it's that day in any US time zone.
      const backdated = /^\d{4}-\d{2}-\d{2}$/.test(inv.date || '') && inv.date < floridaDate(now.getTime());
      const params = {
        customer,
        collection_method: 'send_invoice',
        days_until_due: daysUntilDue(inv.dueDate, now),
        auto_advance: false,
        pending_invoice_items_behavior: 'exclude',
        currency: 'usd',
        metadata: { companyId, invoiceId, appNumber: String(inv.number ?? ''), madeFrom },
        ...(custom.length ? { custom_fields: custom } : {}),
        ...(memo ? { description: clip(memo, 1500) } : {}),
        ...(backdated ? { effective_at: Date.parse(`${inv.date}T16:00:00Z`) / 1000 } : {}),
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
      // Its id goes on the bill before it's finalized, so a later try finds it whatever happens next. Only
      // while this try's claim stands, so a try that takes the bill over afterwards always finds it there.
      const lost = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError('not-found', 'That invoice no longer exists.'); // deleted meanwhile
        const cur = snap.data();
        if (!holdsClaim(cur.stripe, now)) return cur.status === 'paid' || cur.stripe?.status === 'paid' ? 'paid' : 'taken';
        tx.update(ref, { 'stripe.pending': FieldValue.arrayUnion(draft.id) });
        return null;
      });
      if (lost === 'paid') throw new HttpsError('failed-precondition', 'This invoice is already paid.');
      if (lost) throw new HttpsError('aborted', `Nothing was sent: ${SENT_AGAIN}`);
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

    // Credit on the customer's Stripe account can cover the whole invoice when it's finalized. Then it's
    // paid already, so the bill is too.
    const paidAt = finalized.status === 'paid' ? paidAtOf(finalized) : null;
    // Save it, unless the bill was deleted, paid, voided or edited meanwhile (say on another device),
    // or its job, customer or the default notes were, or the Stripe invoice doesn't show the customer's
    // details as they're saved (another invoice for them changed their Stripe customer meanwhile). Then
    // the Stripe invoice is wrong or shouldn't be paid, so it's cancelled (one credit paid gives the credit back).
    const changed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return 'deleted';
      const cur = snap.data();
      // A try that took the bill over after this one's claim ran out found this Stripe invoice pending and
      // saved it already.
      if (cur.stripe?.invoiceId === finalized.id) return 'saved';
      if (['paid', 'void'].includes(cur.status)) return `marked ${cur.status}`;
      // Or it has the bill now. This Stripe invoice is pending on it from before (above), so that try uses
      // or cancels it, and it's left alone here.
      if (!holdsClaim(cur.stripe, now)) return 'taken';
      const read = async (path) => (await tx.get(db.doc(`companies/${companyId}${path}`))).data();
      const curJob = (cur.jobId && await read(`/jobs/${cur.jobId}`)) || {};
      const curCustomerId = cur.customerId || curJob.customerId || null;
      const curCust = curCustomerId && await read(`/customers/${curCustomerId}`);
      const curNotes = (await read(''))?.invoiceNotes ?? '';
      if (!curCust || fingerprint(sentFrom(cur, curJob, curNotes), curCust, companyId, curCustomerId) !== madeFrom) return 'changed';
      const want = customerFields(curCust, companyId, curCustomerId);
      if (!sameEmail(finalized.customer_email, want.email) || !sameBillTo(finalized, want)) return 'changed';
      tx.update(ref, {
        stripe: {
          ...fromStripe(finalized), issued: issued + 1, createdAt: now, createdBy: uid, sent, party: partyOf(curCust, curJob),
          sentTo: null, sentAt: null, error: null, claimedAt: null, ...(paidAt ? { paidAt } : {}),
        },
        ...(paidAt ? { status: 'paid', paidDate: floridaDate(paidAt.getTime()) } : {}),
      });
      return null;
    });
    if (changed === 'saved' || changed === 'taken') throw new HttpsError('aborted', `Nothing was sent: ${SENT_AGAIN}`);
    if (changed) {
      const what = changed === 'changed' ? 'This invoice, its job or its customer was changed' : `This invoice was ${changed}`;
      // If Stripe can't cancel it now, its id stays pending on the bill, so the next try does.
      const cancelled = await cancelStripeInvoice(stripe, finalized).then(() => settled.add(finalized.id), () => false);
      const credit = paidAt ? ', and the credit it used is back on the customer\'s Stripe account' : '';
      // A deleted, paid or void bill isn't sent again, so that's left to Stripe's dashboard.
      const fix = changed === 'changed' ? 'Sending this invoice again cancels it first.'
        : paidAt ? 'In Stripe\'s dashboard, issue a credit note for it that credits the customer\'s balance.' : 'Void it in Stripe\'s dashboard.';
      throw new HttpsError(changed === 'deleted' ? 'not-found' : 'failed-precondition', cancelled
        ? `${what} while its Stripe invoice was being made, so the Stripe invoice was cancelled${credit}.`
        : `${what} while its Stripe invoice was being made, and Stripe couldn't cancel that Stripe invoice (${finalized.number}) just now. ${fix}`);
    }
  } catch (e) {
    // A half-made draft is never sent; remove it so it doesn't clutter Stripe.
    if (draftId) await stripe.invoices.del(draftId).then(() => settled.add(draftId), () => {});
    const err = friendlyError(e);
    if (err.code === 'internal') console.error('Stripe invoice failed', e);
    // Put back what was there, unless something recorded a newer state meanwhile (say the webhook
    // heard the earlier Stripe invoice was paid): that stays. Stripe invoices made and not settled stay pending.
    const restored = { ...prev, status: prev.status === 'creating' ? null : (prev.status ?? null), claimedAt: null, error: err.message, errorAt: new Date() };
    await db.runTransaction(async (tx) => {
      const s = (await tx.get(ref)).data()?.stripe;
      if (holdsClaim(s, now)) {
        tx.update(ref, { stripe: { ...restored, pending: (s.pending || []).filter((id) => !settled.has(id)) } });
      }
    }).catch(() => {});
    throw err;
  }
  // Paid already: there's nothing for the customer to pay, so nothing is emailed.
  const warning = finalized.status === 'paid'
    ? 'Credit on this customer\'s Stripe account covered the whole invoice, so Stripe marked it paid and there was nothing to send.'
    : send ? await sendEmail({ db, stripe, ref, stripeInvoiceId: finalized.id, email: finalized.customer_email || cust.email, made: true }) : null;
  return { ...summary((await ref.get()).data().stripe), warning };
}

// Voids the Stripe invoice that can still be paid (to correct it, or because it was paid by check):
// an open one, or one Stripe marked uncollectible.
export async function voidStripeInvoice({ db, stripe, livemode, companyId, invoiceId }) {
  const ref = invoiceRef(db, companyId, invoiceId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That invoice no longer exists.');
  const s = snap.data().stripe || {};
  if (!s.invoiceId || !['open', 'uncollectible'].includes(s.status)) throw new HttpsError('failed-precondition', 'There\'s no open Stripe invoice to void.');
  if (!!s.livemode !== livemode) {
    if (s.livemode) throw new HttpsError('failed-precondition', 'That Stripe invoice is live, but the app is using a test key right now.');
    // Made with the test key: the live key can't see it, and nobody can pay it for real. Nothing on it
    // counts as paid any more (say test credit that Stripe used on it).
    const wrote = await updateIfSame(db, ref, s, {
      'stripe.status': 'void', 'stripe.voidedAt': new Date(), 'stripe.amountPaid': 0, 'stripe.paidOnline': 0, 'stripe.balanceApplied': 0, 'stripe.preCredited': 0,
    });
    if (!wrote) throw new HttpsError('aborted', `Nothing was voided: ${SENT_AGAIN}`);
    return summary({ ...s, status: 'void' });
  }
  let voided;
  try {
    voided = await stripe.invoices.voidInvoice(s.invoiceId);
  } catch (e) {
    // Most likely the customer just paid it: record that instead.
    const current = await stripe.invoices.retrieve(s.invoiceId).catch(() => null);
    if (current?.status === 'paid' || current?.status === 'void') {
      await applyStripeInvoice(db, stripe, current);
      throw new HttpsError('failed-precondition', current.status === 'paid' ? 'The customer already paid this Stripe invoice.' : 'The Stripe invoice is already void.');
    }
    throw friendlyError(e);
  }
  // Its void notice may already be saved, and another device may have sent the bill with Stripe again since.
  if (!(await updateIfSame(db, ref, s, { ...prefixed(fromStripe(voided)), 'stripe.voidedAt': new Date(), 'stripe.error': null }))) {
    throw new HttpsError('aborted', `The Stripe invoice was voided, but ${SENT_AGAIN}`);
  }
  return summary({ ...s, ...fromStripe(voided), error: null });
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
    await applyStripeInvoice(db, stripe, current);
    // Stripe emailed it, but its reminders couldn't be turned on then: try again. (Only then, so if
    // someone turns them off in Stripe later, they stay off.)
    let { error } = s;
    if (current.status === 'open' && String(error || '').startsWith(REMINDERS_OFF)) {
      await stripe.invoices.update(current.id, { auto_advance: true })
        .then(() => updateIfSame(db, ref, s, { 'stripe.error': null }))
        .then(() => { error = null; }, () => {});
    }
    return summary({ ...s, ...fromStripe(current), error });
  } catch (e) {
    throw friendlyError(e);
  }
}

// Records a Stripe invoice's state on its app invoice. When Stripe says paid, the app invoice
// becomes paid on the date Stripe recorded. Older Stripe invoices for the same bill are ignored.
// The Stripe invoice is read again inside the transaction, which holds the bill until it's saved, so of
// two checks that cross, the one saved last read it last: a payment or credit note one of them records
// isn't undone by the other's older read.
export async function applyStripeInvoice(db, stripe, found) {
  const { companyId, invoiceId } = found.metadata || {};
  if (!ID.test(companyId || '') || !ID.test(invoiceId || '')) return false;
  const ref = db.doc(`companies/${companyId}/invoices/${invoiceId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const inv = snap.data();
    if (inv.stripe?.invoiceId !== found.id) return false;
    const si = await stripe.invoices.retrieve(found.id);
    // Stripe never moves an invoice out of paid or void, so anything else is an older read.
    const was = inv.stripe.status;
    if ((was === 'paid' || was === 'void') && si.status !== was) return false;
    // While a new Stripe invoice is being made for the bill, it still names the one before (say a voided
    // one). Only a payment on that one is recorded then: a late notice that it was voided would end the
    // claim, so another try could make a second new one meanwhile.
    if (was === 'creating' && si.status !== 'paid') return false;
    const update = { ...prefixed(fromStripe(si)), 'stripe.updatedAt': new Date() };
    if (si.status === 'paid') {
      const paidAt = paidAtOf(si);
      update['stripe.paidAt'] = paidAt;
      if (inv.status !== 'paid') {
        update.status = 'paid';
        update.paidDate = floridaDate(paidAt.getTime());
      }
    }
    tx.update(ref, update);
    return true;
  });
}

// Webhook events about an invoice, a payment on one (invoice_payment.paid, which also comes for a payment
// of part of it, when the invoice stays open) or a credit note on one (made or voided): re-read the
// invoice from Stripe rather than trusting the event body, then record it.
export async function handleStripeEvent({ db, stripe, event, allowed, emulated = false }) {
  const type = String(event?.type || '');
  const obj = event.data?.object || {};
  const id = type.startsWith('invoice.') ? obj.id
    : type.startsWith('credit_note.') || type.startsWith('invoice_payment.') ? (obj.invoice?.id ?? obj.invoice) : null;
  if (!id || (type.startsWith('invoice.') && (!obj.metadata?.invoiceId || !companyAllowed(obj.metadata.companyId, allowed, emulated)))) return 'ignored';
  let current;
  try {
    current = await stripe.invoices.retrieve(id);
  } catch (e) {
    if (e?.code === 'resource_missing') return 'ignored'; // a deleted draft
    throw e;
  }
  if (!companyAllowed(current.metadata?.companyId, allowed, emulated)) return 'ignored';
  return (await applyStripeInvoice(db, stripe, current)) ? 'updated' : 'ignored';
}
