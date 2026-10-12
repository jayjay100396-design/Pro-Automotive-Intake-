// Runs under `npm test` against the Firestore emulator, with a fake Stripe client.
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import {
  requireBiller, companyAllowed, stripeStatus, createStripeInvoice, voidStripeInvoice, syncStripeInvoice, handleStripeEvent, applyStripeInvoice,
} from '../stripe-invoices.js';
import { paidOn } from '../lines.js';

const stripeError = (type, message, extra = {}) => Object.assign(new Error(message), { type, ...extra });

// Just enough of the Stripe API for these tests. fail[name] = error makes that call throw once.
function fakeStripe() {
  let n = 0;
  const customers = new Map();
  const invoices = new Map();
  const calls = [];
  const fail = {};
  const log = (name, ...args) => {
    calls.push([name, ...args]);
    const e = fail[name];
    if (e) { delete fail[name]; throw e; }
  };
  const total = (si) => si.lines.reduce((s, l) => s + (l.amount ?? l.quantity * Number(l.unit_amount_decimal)), 0);
  const get = (id) => {
    const si = invoices.get(id);
    if (!si) throw stripeError('StripeInvalidRequestError', 'No such invoice', { code: 'resource_missing' });
    return si;
  };
  const fake = {
    calls, fail, livemode: false,
    called: (name) => calls.filter((c) => c[0] === name),
    customers: Object.assign(customers, {
      list: async (p) => { log('customers.list', p); return { data: [...customers.values()].slice(0, p.limit) }; },
      create: async (p) => { log('customers.create', p); const c = { id: `cus_${++n}`, ...p }; customers.set(c.id, c); return c; },
      update: async (id, p) => {
        log('customers.update', id, p);
        if (!customers.has(id)) throw stripeError('StripeInvalidRequestError', 'No such customer', { code: 'resource_missing' });
        return Object.assign(customers.get(id), p);
      },
      del: async (id) => { log('customers.del', id); customers.delete(id); return { id, deleted: true }; },
    }),
    invoices: Object.assign(invoices, {
      create: async (p) => {
        log('invoices.create', p);
        const si = { id: `in_${++n}`, status: 'draft', lines: [], livemode: fake.livemode, created: Math.floor(Date.now() / 1000), ...p, number: p.number || null };
        invoices.set(si.id, si);
        return { ...si };
      },
      update: async (id, p) => {
        log('invoices.update', id, p);
        Object.assign(get(id), p);
        if ('number' in p) get(id).number = p.number || null;
        return { ...get(id) };
      },
      list: async (p) => { log('invoices.list', p); return { data: [...invoices.values()].filter((si) => si.customer === p.customer && si.status === p.status) }; },
      retrieve: async (id) => { log('invoices.retrieve', id); return { ...get(id) }; },
      finalizeInvoice: async (id, p) => {
        log('invoices.finalizeInvoice', id, p);
        const si = get(id);
        const c = customers.get(si.customer) || {};
        // Like Stripe, the customer's balance is used on the invoice: credit (negative) comes off it, and
        // what they owe (positive) is added. Credit that covers it all leaves it paid.
        const start = c.balance || 0;
        const applied = start < 0 ? Math.min(total(si), -start) : start > 0 ? -start : 0;
        c.balance = start + applied;
        const due = total(si) - applied;
        Object.assign(si, {
          status: due ? 'open' : 'paid', number: si.number || `AUTO-${++n}`, total: total(si), amount_due: due, amount_paid: 0,
          starting_balance: start, ending_balance: start + applied,
          ...(due ? {} : { status_transitions: { paid_at: Date.parse('2026-10-12T14:00:00Z') / 1000 } }),
          customer_email: c.email || null, customer_name: c.name || null, customer_phone: c.phone || null, customer_address: c.address || null,
          hosted_invoice_url: `https://invoice.stripe.test/${id}`, invoice_pdf: `https://invoice.stripe.test/${id}.pdf`,
        });
        return { ...si };
      },
      sendInvoice: async (id) => { log('invoices.sendInvoice', id); return { ...get(id) }; },
      voidInvoice: async (id) => {
        log('invoices.voidInvoice', id);
        const si = Object.assign(get(id), { status: 'void' });
        // A void gives back the customer's balance it used.
        const c = customers.get(si.customer);
        if (c && si.ending_balance != null) c.balance = (c.balance || 0) - (si.ending_balance - si.starting_balance);
        return { ...si };
      },
      del: async (id) => {
        log('invoices.del', id);
        if (get(id).status !== 'draft') throw stripeError('StripeInvalidRequestError', 'You can only delete draft invoices.');
        invoices.delete(id);
        return { deleted: true };
      },
    }),
    invoiceItems: {
      create: async (p) => { log('invoiceItems.create', p); get(p.invoice).lines.push(p); return { id: `ii_${++n}` }; },
    },
    // On a paid invoice only: what it credits to the customer's balance goes back on their account.
    creditNotes: {
      create: async (p) => {
        log('creditNotes.create', p);
        const si = get(p.invoice);
        const left = si.total - (si.pre_payment_credit_notes_amount || 0) - (si.post_payment_credit_notes_amount || 0);
        if (si.status !== 'paid' || p.amount > left || p.amount !== (p.credit_amount || 0) + (p.refund_amount || 0) + (p.out_of_band_amount || 0)) {
          throw stripeError('StripeInvalidRequestError', 'Bad credit note');
        }
        si.post_payment_credit_notes_amount = (si.post_payment_credit_notes_amount || 0) + p.amount;
        const c = customers.get(si.customer);
        if (c && p.credit_amount) c.balance = (c.balance || 0) - p.credit_amount;
        return { id: `cn_${++n}`, ...p };
      },
    },
    // The customer pays on Stripe's page.
    pay(id, paidAt = Date.parse('2026-10-20T15:00:00Z') / 1000) {
      Object.assign(get(id), { status: 'paid', amount_paid: get(id).amount_due ?? total(get(id)), status_transitions: { paid_at: paidAt } });
    },
  };
  return fake;
}

describe('Stripe invoices (server)', function () {
  this.timeout(20000);
  let app;
  let db;
  let stripe;
  const C = 'stellar';
  const inv = () => db.doc(`companies/${C}/invoices/i1`);
  const data = async (ref = inv()) => (await ref.get()).data();
  const create = (extra = {}) => createStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1', uid: 'cpa', ...extra });

  before(function () {
    if (!process.env.FIRESTORE_EMULATOR_HOST) this.skip();
    // Its own project, so the rules tests' clearFirestore() doesn't touch this data.
    app = initializeApp({ projectId: 'demo-stellar-stripe' }, 'stripe-tests');
    db = getFirestore(app);
  });
  after(async () => { if (app) await deleteApp(app); });

  beforeEach(async () => {
    stripe = fakeStripe();
    await db.recursiveDelete(db.collection('companies'));
    await db.doc(`companies/${C}`).set({ name: 'Stellar Glass', ownerUid: 'wes', onlinePayments: true });
    await db.doc(`companies/${C}/members/wes`).set({ role: 'owner' });
    await db.doc(`companies/${C}/members/cpa`).set({ role: 'accountant' });
    await db.doc(`companies/${C}/members/viewer`).set({ role: 'viewer' });
    await db.doc(`companies/${C}/customers/c1`).set({ name: 'Pat Lee', company: 'Lakeland Builders', email: 'pat@example.com', phone: '863-555-0100', address: '100 Main St, Lakeland FL' });
    await db.doc(`companies/${C}/jobs/j1`).set({ name: 'LCP Bldg 300', customerId: 'c1', siteAddress: '300 Lake Parker Ave', poNumber: 'PO-77' });
    await inv().set({
      number: 1003, jobId: 'j1', customerId: 'c1', status: 'unpaid', dueDate: '2099-01-01', taxPct: 7, notes: 'Thank you for your business.',
      lines: [
        { desc: 'Storefront glass', qty: 4, price: 312.5 },
        { desc: 'Install labor', qty: 6.5, price: 85, taxable: false },
      ],
    });
  });

  it('only lets billing roles of the business use Stripe', async () => {
    await assert.rejects(requireBiller(db, null, C), { code: 'unauthenticated' });
    await assert.rejects(requireBiller(db, 'stranger', C), { code: 'permission-denied' });
    await assert.rejects(requireBiller(db, 'viewer', C), { code: 'permission-denied' });
    await assert.rejects(requireBiller(db, 'cpa', '../x'), { code: 'invalid-argument' });
    assert.equal(await requireBiller(db, 'cpa', C), 'accountant');
    assert.equal(companyAllowed(C, C), true);
    assert.equal(companyAllowed('other', C), false);
    assert.equal(companyAllowed(C, '*'), false);
    assert.equal(companyAllowed(C, '*', true), true);
  });

  it('reports whether the Stripe key works', async () => {
    assert.deepEqual(await stripeStatus({ stripe, livemode: false }), { connected: true, livemode: false });
    stripe.fail['customers.list'] = stripeError('StripeAuthenticationError', 'Invalid API Key');
    const st = await stripeStatus({ stripe, livemode: false });
    assert.equal(st.connected, false);
    assert.match(st.problem, /rejected the API key/);
  });

  it('makes an itemized Stripe invoice with the app number and emails it', async () => {
    const r = await create({ send: true });
    assert.equal(r.status, 'open');
    assert.equal(r.number, '1003');
    assert.equal(r.amountDue, 1250 + 552.5 + 87.5);
    assert.equal(r.sentTo, 'pat@example.com');
    assert.equal(r.warning, null);

    const [, cust] = stripe.called('customers.create')[0];
    assert.equal(cust.name, 'Lakeland Builders (Attn: Pat Lee)');
    assert.deepEqual(cust.metadata, { companyId: C, customerId: 'c1' });
    const [, params] = stripe.called('invoices.create')[0];
    assert.equal(params.number, '1003');
    assert.equal(params.collection_method, 'send_invoice');
    assert.equal(params.pending_invoice_items_behavior, 'exclude');
    assert.equal(params.description, 'Thank you for your business.');
    const { madeFrom, ...meta } = params.metadata;
    assert.deepEqual(meta, { companyId: C, invoiceId: 'i1', appNumber: '1003' });
    assert.match(madeFrom, /^[0-9a-f]{40}$/);
    assert.deepEqual(params.custom_fields.map((f) => f.name), ['Project', 'Site', 'PO / project #']);
    assert.deepEqual(stripe.called('invoiceItems.create').map(([, p]) => p.description),
      ['Storefront glass', 'Install labor (6.5 × $85.00)', 'Sales tax (7% on $1,250.00)']);
    assert.equal(stripe.called('invoices.sendInvoice').length, 1);
    // Stripe's reminders need automatic collection: off while it's made, on once it's emailed.
    assert.equal(stripe.called('invoices.finalizeInvoice')[0][2].auto_advance, false);
    const names = stripe.calls.map((c) => c[0]);
    assert.ok(names.lastIndexOf('invoices.update') > names.indexOf('invoices.sendInvoice'));
    assert.deepEqual(stripe.called('invoices.update').map((c) => c.slice(1)), [[r.invoiceId, { auto_advance: true }]]);

    const d = await data();
    assert.equal(d.stripe.status, 'open');
    assert.equal(d.stripe.issued, 1);
    assert.equal(d.stripe.createdBy, 'cpa');
    assert.equal(d.stripe.hostedUrl, `https://invoice.stripe.test/${d.stripe.invoiceId}`);
    // What it was made from, so the app can tell when the bill is edited afterwards.
    assert.deepEqual(d.stripe.sent, {
      number: 1003, jobId: 'j1', date: null, taxPct: 7, dueDate: '2099-01-01', notes: 'Thank you for your business.',
      lines: [
        { desc: 'Storefront glass', qty: 4, price: 312.5, taxable: true },
        { desc: 'Install labor', qty: 6.5, price: 85, taxable: false },
      ],
      job: { name: 'LCP Bldg 300', siteAddress: '300 Lake Parker Ave', poNumber: 'PO-77' },
    });
    assert.equal((await data(db.doc(`companies/${C}/customers/c1`))).stripeCustomerIds.test, [...stripe.customers.values()][0].id);
  });

  it('shows on the Stripe invoice what has been paid on the proposal', async () => {
    const lines = (price) => [{ desc: 'Line', qty: 1, price, taxable: false }];
    await db.doc(`companies/${C}/invoices/dep`).set({ number: 1001, estimateId: 'e1', kind: 'deposit', status: 'paid', taxPct: 0, lines: lines(1302.09) });
    await db.doc(`companies/${C}/invoices/old`).set({ number: 1000, estimateId: 'e1', kind: 'deposit', status: 'void', taxPct: 0, lines: lines(999) });
    await inv().update({ estimateId: 'e1', kind: 'final', proposalNumber: 1005, proposalPrice: 2604.18, taxPct: 0, lines: lines(1302.09), notes: 'Thank you.' });
    await create();
    const [, params] = stripe.called('invoices.create')[0];
    assert.equal(params.description, 'Proposal 1005: $2,604.18\nPaid so far: $1,302.09\nThis invoice: $1,302.09\nLeft after this invoice: $0.00\n\nThank you.');
  });

  it('puts the business\'s default notes on a bill without notes of its own', async () => {
    // As the invoice page shows it (pay app invoices are made without notes).
    await db.doc(`companies/${C}`).update({ invoiceNotes: 'Make checks payable to Stellar Glass.' });
    await inv().update({ notes: FieldValue.delete() });
    await create();
    const [, params] = stripe.called('invoices.create')[0];
    assert.equal(params.description, 'Make checks payable to Stellar Glass.');
    assert.equal((await data()).stripe.sent.notes, 'Make checks payable to Stellar Glass.');
  });

  it('clears details taken off the app\'s customer from the Stripe customer', async () => {
    await create();
    await voidStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' });
    await db.doc(`companies/${C}/customers/c1`).update({ phone: '', address: '' });
    await create();
    const [, , fields] = stripe.called('customers.update').at(-1);
    assert.equal(fields.phone, '');
    assert.equal(fields.address, '');
    assert.equal(fields.email, 'pat@example.com');
  });

  it('counts what Stripe collected on a bill edited after it was paid', async () => {
    const lines = (price) => [{ desc: 'Line', qty: 1, price, taxable: false }];
    await db.doc(`companies/${C}/invoices/dep`).set({
      number: 1001, estimateId: 'e1', kind: 'deposit', status: 'paid', taxPct: 0, lines: lines(1302.09),
      stripe: { status: 'paid', amountPaid: 1000 },
    });
    await inv().update({ estimateId: 'e1', kind: 'final', proposalNumber: 1005, proposalPrice: 2604.18, taxPct: 0, lines: lines(1604.18), notes: '' });
    await create();
    const [, params] = stripe.called('invoices.create')[0];
    assert.equal(params.description, 'Proposal 1005: $2,604.18\nPaid so far: $1,000.00\nThis invoice: $1,604.18\nLeft after this invoice: $0.00');
  });

  it('emails an open invoice again only to the customer and address it was made for', async () => {
    await create({ send: true });
    // The email changed: the Stripe invoice keeps the old address, so it needs a new invoice.
    await db.doc(`companies/${C}/customers/c1`).update({ email: 'ap@lakelandbuilders.example' });
    await assert.rejects(create({ send: true }), /addressed to pat@example\.com\. Void it and send a new one so it goes to ap@lakelandbuilders\.example/);
    assert.equal(stripe.called('customers.update').at(-1)[2].email, 'ap@lakelandbuilders.example'); // current for the next one
    assert.equal(stripe.called('invoices.sendInvoice').length, 1);

    // Moved to another customer's job: the open Stripe invoice is for the old customer.
    await db.doc(`companies/${C}/customers/c2`).set({ name: 'Sam Ortiz', email: 'sam@example.com' });
    await inv().update({ customerId: 'c2' });
    await assert.rejects(create({ send: true }), /different customer/);
    assert.equal(stripe.called('invoices.sendInvoice').length, 1);
    assert.equal((await data()).stripe.sentTo, 'pat@example.com');
  });

  it('won\'t email an open Stripe invoice again once the customer\'s name, phone or address changed', async () => {
    await create();
    for (const change of [{ company: 'Lakeland Builders Inc' }, { phone: '863-555-0199' }, { address: '200 Main St, Lakeland FL' }]) {
      await db.doc(`companies/${C}/customers/c1`).update(change);
      await assert.rejects(create({ send: true }), { code: 'failed-precondition', message: /name, phone or address changed after the Stripe invoice was made/ });
      await db.doc(`companies/${C}/customers/c1`).set({ company: 'Lakeland Builders', phone: '863-555-0100', address: '100 Main St, Lakeland FL' }, { merge: true });
    }
    assert.equal(stripe.called('invoices.sendInvoice').length, 0);
    assert.equal((await create({ send: true })).sentTo, 'pat@example.com');
  });

  it('won\'t email an open Stripe invoice again once the bill or its job has changed', async () => {
    await create();
    await inv().update({ dueDate: '2099-02-01' }); // on another device, just before Email it again
    await assert.rejects(create({ send: true }), { code: 'failed-precondition', message: /changed after its Stripe invoice was made/ });
    await inv().update({ dueDate: '2099-01-01' });
    await db.doc(`companies/${C}/jobs/j1`).update({ poNumber: 'PO-78' });
    await assert.rejects(create({ send: true }), /changed after its Stripe invoice was made/);
    assert.equal(stripe.called('invoices.sendInvoice').length, 0);
    // Back as it was made: it goes.
    await db.doc(`companies/${C}/jobs/j1`).update({ poNumber: 'PO-77' });
    assert.equal((await create({ send: true })).sentTo, 'pat@example.com');
  });

  it('reuses the open Stripe invoice instead of making a second one', async () => {
    await create();
    const again = await create({ send: true });
    assert.equal(stripe.called('invoices.create').length, 1);
    assert.equal(stripe.called('invoices.sendInvoice').length, 1);
    assert.equal(again.sentTo, 'pat@example.com');
    assert.deepEqual(stripe.called('invoices.update').map((c) => c[2]), [{ auto_advance: true }]);
  });

  it('refuses while another request is making the invoice, and when paid', async () => {
    await inv().update({ stripe: { status: 'creating', claimedAt: new Date() } });
    await assert.rejects(create(), { code: 'aborted' });
    await inv().update({ stripe: { status: 'creating', claimedAt: new Date(Date.now() - 600e3) } });
    assert.equal((await create()).status, 'open'); // a stale claim is taken over
    await inv().update({ status: 'paid' });
    await assert.rejects(create(), { code: 'failed-precondition' });
  });

  it('needs a customer email to email it, but not for a payment link', async () => {
    await db.doc(`companies/${C}/customers/c1`).update({ email: '' });
    await assert.rejects(create({ send: true }), /Add an email address/);
    assert.equal(stripe.called('invoices.create').length, 0);
    const r = await create({ send: false });
    assert.equal(r.status, 'open');
    assert.equal(r.sentTo, null);
    assert.equal(stripe.called('invoices.update').length, 0); // no reminders for a link sent by hand
  });

  it('keeps the Stripe invoice, and says so, when Stripe can\'t email it', async () => {
    stripe.fail['invoices.sendInvoice'] = stripeError('StripeInvalidRequestError', 'This invoice can\'t be sent.');
    const r = await create({ send: true });
    assert.equal(r.status, 'open');
    assert.match(r.warning, /^Made the Stripe invoice, but Stripe couldn't email it\. Stripe: This invoice can't be sent\.$/);
    assert.equal(stripe.called('invoices.update').length, 0);
    let d = await data();
    assert.match(d.stripe.error, /couldn't email it/);
    assert.equal(d.stripe.sentTo, null); // noted as emailed before Stripe was asked, then put back
    assert.equal(d.stripe.sentAt, null);
    // Emailed, then Email it again fails: it still says when it was last emailed.
    assert.equal((await create({ send: true })).sentTo, 'pat@example.com');
    const sentAt = (await data()).stripe.sentAt.toMillis();
    stripe.fail['invoices.sendInvoice'] = stripeError('StripeInvalidRequestError', 'Nope.');
    assert.match((await create({ send: true })).warning, /^Stripe couldn't email it\. Stripe: Nope\.$/);
    d = await data();
    assert.equal(d.stripe.sentTo, 'pat@example.com');
    assert.equal(d.stripe.sentAt.toMillis(), sentAt);
  });

  it('notes the email before Stripe sends it, so a lost answer doesn\'t invite a second email', async () => {
    const send = stripe.invoices.sendInvoice;
    let noted = null;
    stripe.invoices.sendInvoice = async (id) => { noted = (await data()).stripe.sentTo; return send(id); };
    await create({ send: true });
    assert.equal(noted, 'pat@example.com');
    stripe.invoices.sendInvoice = send;
    // No answer from Stripe: it may have emailed it, so it stays noted as emailed.
    stripe.fail['invoices.sendInvoice'] = stripeError('StripeConnectionError', 'socket hang up');
    const r = await create({ send: true });
    assert.equal(r.warning, 'Couldn\'t tell whether Stripe emailed this invoice (Stripe didn\'t answer). Check it in Stripe\'s dashboard before emailing it again.');
    const d = await data();
    assert.equal(d.stripe.sentTo, 'pat@example.com');
    assert.match(d.stripe.error, /^Couldn't tell whether Stripe emailed/);
    // The same when it was just made.
    await db.doc(`companies/${C}/invoices/i2`).set({ ...(({ stripe: _, ...bill }) => bill)(d), number: 1004 });
    stripe.fail['invoices.sendInvoice'] = stripeError('StripeConnectionError', 'socket hang up');
    const made = await create({ invoiceId: 'i2', send: true });
    assert.match(made.warning, /^Made the Stripe invoice, but couldn't tell whether Stripe emailed it/);
    assert.equal(made.sentTo, 'pat@example.com');
  });

  it('checks the bill again as it emails an open Stripe invoice again', async () => {
    await create();
    const bill = await data();
    const retrieve = stripe.invoices.retrieve;
    // change() runs on another device while Stripe is asked about the invoice, just before it's emailed.
    const during = async (change, expected, undo) => {
      stripe.invoices.retrieve = async (id) => { stripe.invoices.retrieve = retrieve; await change(); return retrieve(id); };
      await assert.rejects(create({ send: true }), { code: 'failed-precondition', message: expected });
      await undo();
      assert.equal(stripe.called('invoices.sendInvoice').length, 0);
      assert.equal((await data()).stripe.sentTo, null);
    };
    await during(() => inv().update({ lines: [{ desc: 'Storefront glass', qty: 5, price: 312.5 }] }), /changed after its Stripe invoice was made/,
      () => inv().update({ lines: bill.lines }));
    await during(() => db.doc(`companies/${C}/jobs/j1`).update({ siteAddress: '301 Lake Parker Ave' }), /changed after its Stripe invoice was made/,
      () => db.doc(`companies/${C}/jobs/j1`).update({ siteAddress: '300 Lake Parker Ave' }));
    await during(() => db.doc(`companies/${C}/customers/c1`).update({ email: 'ap@example.com' }), /addressed to pat@example\.com/,
      () => db.doc(`companies/${C}/customers/c1`).update({ email: 'pat@example.com' }));
    await during(() => db.doc(`companies/${C}/customers/c1`).update({ phone: '863-555-0199' }), /name, phone or address changed/,
      () => db.doc(`companies/${C}/customers/c1`).update({ phone: '863-555-0100' }));
    await during(() => inv().update({ payments: [{ id: 'p1', method: 'check', amount: 500, date: '2026-10-12' }] }), /Payments are recorded/,
      () => inv().update({ payments: FieldValue.delete() }));
    await during(() => inv().update({ 'stripe.status': 'void' }), /changed just now/, () => inv().update({ 'stripe.status': 'open' }));
    // Paid in Stripe meanwhile: that's recorded instead.
    stripe.invoices.retrieve = async (id) => { stripe.invoices.retrieve = retrieve; stripe.pay(bill.stripe.invoiceId); return retrieve(id); };
    await assert.rejects(create({ send: true }), /already paid this Stripe invoice/);
    assert.equal((await data()).status, 'paid');
    assert.equal(stripe.called('invoices.sendInvoice').length, 0);
  });

  it('makes no new Stripe invoice while online payments are off in Settings', async () => {
    await db.doc(`companies/${C}`).update({ onlinePayments: false });
    await assert.rejects(create({ send: true }), { code: 'failed-precondition', message: /Online payments are off\. The owner can turn them on in Settings/ });
    assert.equal(stripe.called('invoices.create').length, 0);
    assert.equal((await data()).stripe, undefined);
    // One made while they were on can still be emailed again (and checked or voided).
    await db.doc(`companies/${C}`).update({ onlinePayments: true });
    await create();
    await db.doc(`companies/${C}`).update({ onlinePayments: FieldValue.delete() });
    assert.equal((await create({ send: true })).sentTo, 'pat@example.com');
    await voidStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' });
    await assert.rejects(create(), /Online payments are off/);
    assert.equal(stripe.called('invoices.create').length, 1);
  });

  it('won\'t put a bill with payments recorded in the app on Stripe', async () => {
    const check = { id: 'p1', method: 'check', amount: 500, date: '2026-10-10', ref: '1201', note: '' };
    await inv().update({ payments: [check] });
    await assert.rejects(create(), { code: 'failed-precondition', message: /Payments are recorded on this invoice in the app/ });
    assert.equal(stripe.called('invoices.create').length, 0);
    // Nor email an open one again once a payment is recorded (the app voids it first).
    await inv().update({ payments: FieldValue.delete() });
    await create();
    await inv().update({ payments: [check] });
    await assert.rejects(create({ send: true }), /Payments are recorded/);
    assert.equal(stripe.called('invoices.sendInvoice').length, 0);
  });

  it('keeps who and what the Stripe invoice billed, for the printed invoice once it\'s paid', async () => {
    await db.doc(`companies/${C}/jobs/j1`).update({ architect: 'Lunz Prebor Fowler' });
    await create();
    assert.deepEqual((await data()).stripe.party, {
      customer: { name: 'Pat Lee', company: 'Lakeland Builders', address: '100 Main St, Lakeland FL', phone: '863-555-0100', email: 'pat@example.com' },
      job: { name: 'LCP Bldg 300', siteAddress: '300 Lake Parker Ave', poNumber: 'PO-77', architect: 'Lunz Prebor Fowler' },
    });
  });

  it('refuses amounts Stripe can\'t collect', async () => {
    await inv().update({ lines: [{ desc: 'Credit', qty: 1, price: 0.25 }] });
    await assert.rejects(create(), /\$0\.50 or more/);
  });

  it('refuses more lines than Stripe takes on one invoice', async () => {
    // 250 taxed lines, plus the sales tax line.
    await inv().update({ lines: Array.from({ length: 250 }, (_, i) => ({ desc: `Pane ${i + 1}`, qty: 1, price: 10 })) });
    await assert.rejects(create(), { code: 'failed-precondition', message: /up to 250 lines.*This one has 251/ });
    assert.equal(stripe.called('invoices.create').length, 0);
  });

  it('cleans up and records the error when Stripe fails halfway', async () => {
    stripe.fail['invoiceItems.create'] = stripeError('StripeConnectionError', 'socket hang up');
    await assert.rejects(create(), { code: 'unavailable' });
    assert.equal(stripe.called('invoices.del').length, 1);
    assert.equal(stripe.invoices.size, 0);
    const d = await data();
    assert.equal(d.stripe.status, null);
    assert.match(d.stripe.error, /Couldn't reach Stripe/);
    // Trying again works.
    assert.equal((await create()).status, 'open');
    assert.equal((await data()).stripe.error, null);
  });

  it('numbers a re-sent invoice 1003-2 after a void', async () => {
    await create();
    const v = await voidStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' });
    assert.equal(v.status, 'void');
    const r = await create();
    assert.equal(r.number, '1003-2');
    assert.equal((await data()).stripe.issued, 2);
  });

  it('lets Stripe number it when the app number is taken', async () => {
    stripe.fail['invoices.create'] = stripeError('StripeInvalidRequestError', 'Invoice number already used', { param: 'number' });
    const r = await create();
    assert.match(r.number, /^AUTO-/);
    const [, retry] = stripe.called('invoices.create')[1];
    assert.equal(retry.number, undefined);
    assert.deepEqual(retry.custom_fields.at(-1), { name: 'Invoice #', value: '1003' });

    stripe.fail['invoices.finalizeInvoice'] = stripeError('StripeInvalidRequestError', 'Invoice number already used');
    await voidStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' });
    const r2 = await create();
    assert.match(r2.number, /^AUTO-/);
    const [, , update] = stripe.called('invoices.update')[0];
    assert.equal(update.number, '');
  });

  it('cancels the Stripe invoice if the bill is deleted while it\'s being made', async () => {
    const finalize = stripe.invoices.finalizeInvoice;
    stripe.invoices.finalizeInvoice = async (...args) => {
      const si = await finalize(...args);
      await inv().delete(); // someone deletes the bill meanwhile
      return si;
    };
    await assert.rejects(create(), { code: 'not-found' });
    const [, voided] = stripe.called('invoices.voidInvoice')[0];
    assert.equal(stripe.invoices.get(voided).status, 'void');
  });

  it('cancels the Stripe invoice if the bill is marked paid while it\'s being made', async () => {
    const finalize = stripe.invoices.finalizeInvoice;
    stripe.invoices.finalizeInvoice = async (...args) => {
      const si = await finalize(...args);
      await inv().update({ status: 'paid' }); // marked paid on another device meanwhile
      return si;
    };
    await assert.rejects(create({ send: true }), { code: 'failed-precondition', message: /marked paid while its Stripe invoice was being made/ });
    const [, voided] = stripe.called('invoices.voidInvoice')[0];
    assert.equal(stripe.invoices.get(voided).status, 'void');
    assert.equal(stripe.called('invoices.sendInvoice').length, 0);
    const d = await data();
    assert.equal(d.status, 'paid');
    assert.notEqual(d.stripe.status, 'open');
    assert.match(d.stripe.error, /marked paid/);
  });

  it('cancels the Stripe invoice if the bill is edited while it\'s being made', async () => {
    const finalize = stripe.invoices.finalizeInvoice;
    stripe.invoices.finalizeInvoice = async (...args) => {
      const si = await finalize(...args);
      // Someone fixes a price meanwhile.
      await inv().update({ lines: [{ desc: 'Storefront glass', qty: 4, price: 350 }, { desc: 'Install labor', qty: 6.5, price: 85, taxable: false }] });
      return si;
    };
    await assert.rejects(create({ send: true }), { code: 'failed-precondition', message: /changed while its Stripe invoice was being made/ });
    const [, voided] = stripe.called('invoices.voidInvoice')[0];
    assert.equal(stripe.invoices.get(voided).status, 'void');
    assert.equal(stripe.called('invoices.sendInvoice').length, 0);
    assert.notEqual((await data()).stripe.status, 'open');
  });

  it('cancels the Stripe invoice if the job\'s details change while it\'s being made', async () => {
    const finalize = stripe.invoices.finalizeInvoice;
    stripe.invoices.finalizeInvoice = async (...args) => {
      const si = await finalize(...args);
      await db.doc(`companies/${C}/jobs/j1`).update({ poNumber: 'PO-78' }); // the PO goes on meanwhile
      return si;
    };
    await assert.rejects(create({ send: true }), { code: 'failed-precondition', message: /changed while its Stripe invoice was being made/ });
    const [, voided] = stripe.called('invoices.voidInvoice')[0];
    assert.equal(stripe.invoices.get(voided).status, 'void');
    assert.equal(stripe.called('invoices.sendInvoice').length, 0);
  });

  it('cancels the Stripe invoice if the customer or the default notes change while it\'s being made', async () => {
    await inv().update({ notes: FieldValue.delete() }); // so the business's default notes go on it
    const finalize = stripe.invoices.finalizeInvoice;
    for (const [path, change] of [['customers/c1', { email: 'ap@lakelandbuilders.example' }], ['', { invoiceNotes: 'Net 30.' }]]) {
      stripe.invoices.finalizeInvoice = async (...args) => {
        const si = await finalize(...args);
        await db.doc(`companies/${C}${path && `/${path}`}`).update(change); // edited on another device meanwhile
        return si;
      };
      await assert.rejects(create({ send: true }), { code: 'failed-precondition', message: /its customer was changed while its Stripe invoice was being made/ });
      const [, voided] = stripe.called('invoices.voidInvoice').at(-1);
      assert.equal(stripe.invoices.get(voided).status, 'void');
    }
    assert.equal(stripe.called('invoices.sendInvoice').length, 0);
    // Tried again, it goes to the new address with the new notes.
    stripe.invoices.finalizeInvoice = finalize;
    assert.equal((await create({ send: true })).sentTo, 'ap@lakelandbuilders.example');
    assert.equal(stripe.called('invoices.create').at(-1)[1].description, 'Net 30.');
  });

  // A first try whose answer from Stripe is lost after Stripe finalized the invoice, so it's never saved.
  const lostTry = async (status = 'open') => {
    const finalize = stripe.invoices.finalizeInvoice;
    stripe.invoices.finalizeInvoice = async (...args) => {
      await finalize(...args);
      throw stripeError('StripeConnectionError', 'socket hang up');
    };
    await assert.rejects(create(), { code: 'unavailable' });
    stripe.invoices.finalizeInvoice = finalize;
    const orphan = [...stripe.invoices.values()].at(-1);
    assert.equal(orphan.status, status);
    return orphan;
  };

  it('picks up a Stripe invoice an earlier try made but never saved', async () => {
    const orphan = await lostTry();
    const r = await create();
    assert.equal(r.invoiceId, orphan.id);
    assert.equal(stripe.called('invoices.create').length, 1); // only the first try's
    assert.equal(stripe.called('invoices.voidInvoice').length, 0);
  });

  it('cancels a Stripe invoice an earlier try made from an older version of the bill', async () => {
    const orphan = await lostTry();
    // The glass price is fixed before the next try.
    await inv().update({ lines: [{ desc: 'Storefront glass', qty: 4, price: 350 }, { desc: 'Install labor', qty: 6.5, price: 85, taxable: false }] });
    const r = await create();
    assert.notEqual(r.invoiceId, orphan.id);
    assert.equal(stripe.invoices.get(orphan.id).status, 'void');
    assert.equal(r.amountDue, 1400 + 98 + 552.5);
    assert.equal(r.number, '1003-2'); // numbered like a re-send after a void
    assert.equal((await data()).stripe.sent.lines[0].price, 350);

    // The same for the job's details that go on the Stripe invoice.
    await voidStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' });
    const orphan2 = await lostTry();
    await db.doc(`companies/${C}/jobs/j1`).update({ poNumber: 'PO-78' });
    const r2 = await create();
    assert.equal(stripe.invoices.get(orphan2.id).status, 'void');
    assert.equal(r2.number, '1003-4');
    assert.equal((await data()).stripe.sent.job.poNumber, 'PO-78');
  });

  it('records a Stripe invoice an earlier try made but never saved that credit on the customer\'s account paid', async () => {
    const cus = await stripe.customers.create({ name: 'Lakeland Builders', balance: -200000 });
    await db.doc(`companies/${C}/customers/c1`).update({ 'stripeCustomerIds.test': cus.id });
    const orphan = await lostTry('paid');
    assert.equal(stripe.customers.get(cus.id).balance, -11000);
    const r = await create({ send: true });
    assert.equal(r.invoiceId, orphan.id);
    assert.match(r.warning, /covered the whole invoice/);
    assert.equal(stripe.called('invoices.create').length, 1); // only the lost try's
    assert.equal(stripe.called('invoices.sendInvoice').length, 0);
    assert.equal(stripe.customers.get(cus.id).balance, -11000); // its credit is used once
    const d = await data();
    assert.equal(d.status, 'paid');
    assert.equal(d.stripe.amountPaid, 1890);
    assert.equal(d.stripe.pending, undefined);
  });

  it('gives back the credit an earlier try\'s out-of-date Stripe invoice used, then sends the bill', async () => {
    const cus = await stripe.customers.create({ name: 'Lakeland Builders', balance: -200000 });
    await db.doc(`companies/${C}/customers/c1`).update({ 'stripeCustomerIds.test': cus.id });
    const orphan = await lostTry('paid');
    await inv().update({ notes: 'Net 30.' }); // edited before the next try
    const r = await create();
    assert.notEqual(r.invoiceId, orphan.id);
    assert.equal(r.number, '1003-2');
    const [[, note]] = stripe.called('creditNotes.create');
    assert.deepEqual([note.invoice, note.amount, note.credit_amount, note.email_type], [orphan.id, 189000, 189000, 'none']);
    // The credit came back and paid the new one.
    const d = await data();
    assert.equal(d.status, 'paid');
    assert.equal(d.stripe.invoiceId, r.invoiceId);
    assert.equal(stripe.customers.get(cus.id).balance, -11000);
  });

  it('cancels a Stripe invoice an earlier try made for the customer the bill had then', async () => {
    const orphan = await lostTry();
    // The bill goes to another customer before the next try.
    await db.doc(`companies/${C}/customers/c2`).set({ name: 'Sam Ortiz', email: 'sam@example.com' });
    await inv().update({ customerId: 'c2' });
    const r = await create();
    assert.equal(stripe.invoices.get(orphan.id).status, 'void');
    assert.notEqual(stripe.invoices.get(r.invoiceId).customer, orphan.customer);
    assert.equal(r.number, '1003-2');
  });

  it('doesn\'t reuse an earlier try\'s Stripe invoice made for a Stripe customer since deleted', async () => {
    const orphan = await lostTry();
    stripe.customers.delete(orphan.customer); // deleted in Stripe's dashboard before the next try
    const r = await create();
    assert.notEqual(r.invoiceId, orphan.id);
    assert.equal(stripe.invoices.get(orphan.id).status, 'void');
    assert.notEqual(stripe.invoices.get(r.invoiceId).customer, orphan.customer);
  });

  it('doesn\'t reuse an earlier try\'s credit-paid Stripe invoice that a try began cancelling', async () => {
    const cus = await stripe.customers.create({ name: 'Lakeland Builders', balance: -200000 });
    await db.doc(`companies/${C}/customers/c1`).update({ 'stripeCustomerIds.test': cus.id });
    const orphan = await lostTry('paid');
    // A try gave its credit back with a credit note, but that was never saved either.
    await stripe.creditNotes.create({ invoice: orphan.id, amount: 189000, credit_amount: 189000 });
    const r = await create();
    assert.notEqual(r.invoiceId, orphan.id);
    assert.equal(r.number, '1003-2');
    assert.equal(stripe.called('creditNotes.create').length, 1); // nothing more to give back
    // The credit paid the new one.
    assert.equal((await data()).status, 'paid');
    assert.equal(stripe.customers.get(cus.id).balance, -11000);
  });

  it('numbers the next Stripe invoice past one an earlier try made and already cancelled', async () => {
    const orphan = await lostTry();
    await stripe.invoices.voidInvoice(orphan.id); // voided, and that was never saved either
    const r = await create();
    assert.notEqual(r.invoiceId, orphan.id);
    assert.equal(r.number, '1003-2');
    assert.equal(stripe.called('invoices.voidInvoice').length, 1);
  });

  it('makes no second Stripe invoice while an out-of-date one can\'t be voided', async () => {
    const orphan = await lostTry();
    await inv().update({ lines: [{ desc: 'Storefront glass', qty: 4, price: 350 }, { desc: 'Install labor', qty: 6.5, price: 85, taxable: false }] });
    stripe.fail['invoices.voidInvoice'] = stripeError('StripeConnectionError', 'socket hang up');
    await assert.rejects(create(), { code: 'unavailable' });
    assert.equal(stripe.called('invoices.create').length, 1); // only the lost try's
    assert.equal(stripe.invoices.get(orphan.id).status, 'open');
    // The next try voids it, then sends the bill.
    const r = await create();
    assert.equal(stripe.invoices.get(orphan.id).status, 'void');
    assert.equal(r.status, 'open');
  });

  it('marks the invoice paid when Stripe says so, and ignores events that aren\'t ours', async () => {
    const { invoiceId } = await create();
    stripe.pay(invoiceId);
    const event = { type: 'invoice.paid', data: { object: { id: invoiceId, metadata: { companyId: C, invoiceId: 'i1' } } } };
    assert.equal(await handleStripeEvent({ db, stripe, event: { ...event, type: 'customer.created' }, allowed: C }), 'ignored');
    assert.equal(await handleStripeEvent({ db, stripe, event, allowed: 'someone-else' }), 'ignored');
    assert.equal((await data()).status, 'unpaid');
    assert.equal(await handleStripeEvent({ db, stripe, event, allowed: C }), 'updated');
    const d = await data();
    assert.equal(d.status, 'paid');
    assert.equal(d.paidDate, '2026-10-20');
    assert.equal(d.stripe.status, 'paid');
    assert.equal(d.stripe.amountPaid, 1890);
    // An event about an older Stripe invoice for this bill changes nothing.
    const old = await stripe.invoices.create({ customer: 'cus_x', metadata: { companyId: C, invoiceId: 'i1' } });
    assert.equal(await handleStripeEvent({ db, stripe, event: { type: 'invoice.voided', data: { object: { ...old } } }, allowed: C }), 'ignored');
  });

  it('counts a refund or credit made with a credit note on a paid Stripe invoice', async () => {
    const { invoiceId } = await create();
    stripe.pay(invoiceId);
    const paid = { type: 'invoice.paid', data: { object: { id: invoiceId, metadata: { companyId: C, invoiceId: 'i1' } } } };
    assert.equal(await handleStripeEvent({ db, stripe, event: paid, allowed: C }), 'updated');
    // $500 refunded through a credit note in Stripe's dashboard.
    stripe.invoices.get(invoiceId).post_payment_credit_notes_amount = 50000;
    const note = (invoice) => ({ type: 'credit_note.created', data: { object: { id: 'cn_1', invoice } } });
    assert.equal(await handleStripeEvent({ db, stripe, event: note(invoiceId), allowed: 'someone-else' }), 'ignored');
    assert.equal((await data()).stripe.amountPaid, 1890);
    assert.equal(await handleStripeEvent({ db, stripe, event: note(invoiceId), allowed: C }), 'updated');
    let d = await data();
    assert.equal(d.status, 'paid');
    assert.equal(d.stripe.amountPaid, 1390);
    assert.equal(d.stripe.credited, 500);
    // Refunded in full (an expanded invoice in the event works too).
    stripe.invoices.get(invoiceId).post_payment_credit_notes_amount = 189000;
    assert.equal(await handleStripeEvent({ db, stripe, event: note({ id: invoiceId }), allowed: C }), 'updated');
    d = await data();
    assert.equal(d.stripe.amountPaid, 0);
    assert.equal(d.stripe.credited, 1890);
    // A credit note on an invoice made some other way is ignored.
    const other = await stripe.invoices.create({ customer: 'cus_x', metadata: {} });
    assert.equal(await handleStripeEvent({ db, stripe, event: note(other.id), allowed: C }), 'ignored');
  });

  it('follows a credit note on an open Stripe invoice, and its void', async () => {
    const { invoiceId } = await create();
    const note = (type) => ({ type, data: { object: { id: 'cn_2', invoice: invoiceId } } });
    // $100 taken off the open invoice in Stripe's dashboard, then that credit note voided.
    Object.assign(stripe.invoices.get(invoiceId), { amount_due: 179000, pre_payment_credit_notes_amount: 10000 });
    assert.equal(await handleStripeEvent({ db, stripe, event: note('credit_note.created'), allowed: C }), 'updated');
    let d = await data();
    assert.equal(d.stripe.amountDue, 1790);
    assert.equal(d.stripe.preCredited, 100);
    assert.equal(d.stripe.amountPaid, 0);
    Object.assign(stripe.invoices.get(invoiceId), { amount_due: 189000, pre_payment_credit_notes_amount: 0 });
    assert.equal(await handleStripeEvent({ db, stripe, event: note('credit_note.voided'), allowed: C }), 'updated');
    d = await data();
    assert.equal(d.stripe.amountDue, 1890);
    assert.equal(d.stripe.preCredited, 0);
    // Credited in full before any payment: Stripe marks it paid with nothing paid, so nothing counts as paid.
    Object.assign(stripe.invoices.get(invoiceId), {
      status: 'paid', amount_due: 0, pre_payment_credit_notes_amount: 189000, status_transitions: { paid_at: Date.parse('2026-10-21T15:00:00Z') / 1000 },
    });
    assert.equal(await handleStripeEvent({ db, stripe, event: note('credit_note.created'), allowed: C }), 'updated');
    d = await data();
    assert.equal(d.status, 'paid');
    assert.equal(d.stripe.preCredited, 1890);
    assert.equal(d.stripe.amountPaid, 0);
    assert.equal(paidOn(d), 0);
  });

  it('doesn\'t count an overpayment, which Stripe makes credit for the customer\'s next invoice', async () => {
    const { invoiceId } = await create();
    stripe.pay(invoiceId);
    Object.assign(stripe.invoices.get(invoiceId), { amount_paid: 199000, amount_overpaid: 10000 });
    await syncStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' });
    const d = await data();
    assert.equal(d.status, 'paid');
    assert.equal(d.stripe.paidOnline, 1990);
    assert.equal(d.stripe.overpaid, 100);
    assert.equal(d.stripe.amountPaid, 1890);
    assert.equal(paidOn(d), 1890);
  });

  it('records a Stripe invoice that credit on the customer\'s Stripe account pays in full', async () => {
    // $2,000 of credit on the customer's Stripe account, say from a credit note that credited it.
    const cus = await stripe.customers.create({ name: 'Lakeland Builders', balance: -200000 });
    await db.doc(`companies/${C}/customers/c1`).update({ 'stripeCustomerIds.test': cus.id });
    const r = await create({ send: true });
    assert.match(r.warning, /covered the whole invoice, so Stripe marked it paid and there was nothing to send/);
    assert.equal(stripe.called('invoices.sendInvoice').length, 0);
    let d = await data();
    assert.equal(d.status, 'paid');
    assert.equal(d.paidDate, '2026-10-12');
    assert.equal(d.stripe.status, 'paid');
    assert.ok(d.stripe.paidAt);
    assert.equal(d.stripe.amountDue, 0);
    assert.equal(d.stripe.balanceApplied, 1890);
    assert.equal(d.stripe.paidOnline, 0);
    assert.equal(d.stripe.amountPaid, 1890);
    assert.equal(paidOn(d), 1890);
    assert.equal(stripe.customers.get(cus.id).balance, -11000);
    // The paid webhook that follows changes nothing.
    const event = { type: 'invoice.paid', data: { object: { id: d.stripe.invoiceId, metadata: { companyId: C, invoiceId: 'i1' } } } };
    assert.equal(await handleStripeEvent({ db, stripe, event, allowed: C }), 'updated');
    d = await data();
    assert.equal(d.status, 'paid');
    assert.equal(d.stripe.amountPaid, 1890);
    // Edited on another device while it's made ($500 more glass), it's cancelled like any other: as
    // credit paid it, the credit goes back to the customer's Stripe account, and the bill isn't paid.
    await inv().update({ status: 'unpaid', paidDate: FieldValue.delete(), stripe: FieldValue.delete() });
    stripe.customers.get(cus.id).balance = -200000;
    const finalize = stripe.invoices.finalizeInvoice;
    stripe.invoices.finalizeInvoice = async (...args) => {
      const si = await finalize(...args);
      await inv().update({ lines: [{ desc: 'Storefront glass', qty: 4, price: 437.5 }, { desc: 'Install labor', qty: 6.5, price: 85, taxable: false }] });
      return si;
    };
    await assert.rejects(create(), { code: 'failed-precondition', message: /changed while its Stripe invoice was being made, so the Stripe invoice was cancelled, and the credit it used is back on the customer's Stripe account\./ });
    d = await data();
    assert.equal(d.status, 'unpaid');
    assert.equal(d.stripe.status, null);
    assert.deepEqual(d.stripe.pending, []);
    assert.equal(stripe.customers.get(cus.id).balance, -200000);
    assert.equal(stripe.called('creditNotes.create').at(-1)[1].credit_amount, 189000);
    // The same when the bill (now $2,425) is deleted meanwhile.
    stripe.customers.get(cus.id).balance = -300000;
    stripe.invoices.finalizeInvoice = async (...args) => {
      const si = await finalize(...args);
      await inv().delete();
      return si;
    };
    await assert.rejects(create(), { code: 'not-found', message: /deleted while its Stripe invoice was being made, so the Stripe invoice was cancelled, and the credit it used is back/ });
    assert.equal(stripe.called('creditNotes.create').at(-1)[1].credit_amount, 242500);
    assert.equal(stripe.customers.get(cus.id).balance, -300000);
  });

  it('cancels a credit-paid Stripe invoice on the next try when Stripe couldn\'t right away', async () => {
    const cus = await stripe.customers.create({ name: 'Lakeland Builders', balance: -200000 });
    await db.doc(`companies/${C}/customers/c1`).update({ 'stripeCustomerIds.test': cus.id });
    const finalize = stripe.invoices.finalizeInvoice;
    stripe.invoices.finalizeInvoice = async (...args) => {
      const si = await finalize(...args);
      await inv().update({ taxPct: 6 }); // edited on another device meanwhile
      return si;
    };
    stripe.fail['creditNotes.create'] = stripeError('StripeConnectionError', 'socket hang up');
    await assert.rejects(create(), { code: 'failed-precondition', message: /Stripe couldn't cancel that Stripe invoice \(1003\) just now\. Sending this invoice again cancels it first\./ });
    stripe.invoices.finalizeInvoice = finalize;
    const [first] = [...stripe.invoices.values()];
    assert.equal(first.status, 'paid');
    assert.deepEqual((await data()).stripe.pending, [first.id]);
    const r = await create();
    assert.equal(stripe.called('creditNotes.create').length, 2);
    assert.notEqual(r.invoiceId, first.id);
    assert.equal(r.number, '1003-2');
    // Its credit came back and paid the new one ($1,250 + 6% + $552.50).
    assert.equal((await data()).status, 'paid');
    assert.equal(stripe.customers.get(cus.id).balance, -200000 + 187750);
  });

  it('says how to cancel it in Stripe when the bill was paid or deleted meanwhile and Stripe couldn\'t', async () => {
    const finalize = stripe.invoices.finalizeInvoice;
    stripe.invoices.finalizeInvoice = async (...args) => {
      const si = await finalize(...args);
      await inv().update({ status: 'paid' }); // a check recorded on another device meanwhile
      return si;
    };
    stripe.fail['invoices.voidInvoice'] = stripeError('StripeConnectionError', 'socket hang up');
    await assert.rejects(create(), { message: /^This invoice was marked paid while its Stripe invoice was being made, and Stripe couldn't cancel that Stripe invoice \(1003\) just now\. Void it in Stripe's dashboard\.$/ });
    // One that credit on the customer's account paid takes a credit note instead.
    await inv().update({ status: 'unpaid' });
    const cus = await stripe.customers.create({ name: 'Lakeland Builders', balance: -200000 });
    await db.doc(`companies/${C}/customers/c1`).update({ 'stripeCustomerIds.test': cus.id });
    stripe.invoices.finalizeInvoice = async (...args) => {
      const si = await finalize(...args);
      await inv().delete();
      return si;
    };
    stripe.fail['creditNotes.create'] = stripeError('StripeConnectionError', 'socket hang up');
    await assert.rejects(create(), { code: 'not-found', message: /just now\. In Stripe's dashboard, issue a credit note for it that credits the customer's balance\.$/ });
  });

  it('counts credit on the customer\'s Stripe account toward what\'s paid, and a void gives it back', async () => {
    const cus = await stripe.customers.create({ name: 'Lakeland Builders', balance: -30000 });
    await db.doc(`companies/${C}/customers/c1`).update({ 'stripeCustomerIds.test': cus.id });
    await create();
    let d = await data();
    assert.equal(d.status, 'unpaid');
    assert.equal(d.stripe.status, 'open');
    assert.equal(d.stripe.amountDue, 1590);
    assert.equal(d.stripe.balanceApplied, 300);
    assert.equal(d.stripe.paidOnline, 0);
    assert.equal(d.stripe.amountPaid, 300);
    assert.equal(paidOn(d), 300);
    // Credit isn't a payment, so the Stripe invoice can be voided, which gives the credit back.
    assert.equal((await voidStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' })).status, 'void');
    d = await data();
    assert.equal(d.stripe.balanceApplied, 0);
    assert.equal(d.stripe.amountPaid, 0);
    assert.equal(paidOn(d), 0);
    assert.equal(stripe.customers.get(cus.id).balance, -30000);
    // What the customer owed from before is added to the next one. Once it's paid, only the bill
    // counts as paid on it.
    stripe.customers.get(cus.id).balance = 10000;
    await create();
    d = await data();
    assert.equal(d.stripe.amountDue, 1990);
    assert.equal(d.stripe.balanceApplied, -100);
    assert.equal(d.stripe.amountPaid, 0);
    stripe.pay(d.stripe.invoiceId);
    await syncStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' });
    d = await data();
    assert.equal(d.status, 'paid');
    assert.equal(d.stripe.paidOnline, 1990);
    assert.equal(d.stripe.amountPaid, 1890);
    assert.equal(paidOn(d), 1890);
  });

  it('uses one Stripe customer when two invoices for a new customer are sent at the same moment', async () => {
    await db.doc(`companies/${C}/invoices/i2`).set({ ...(await data()), number: 1004 });
    // Each call makes a Stripe customer before either is saved.
    const make = stripe.customers.create;
    const waiting = [];
    stripe.customers.create = async (p) => {
      const c = await make(p);
      await new Promise((resolve) => { waiting.push(resolve); if (waiting.length === 2) waiting.forEach((go) => go()); });
      return c;
    };
    const [a, b] = await Promise.all([create(), create({ invoiceId: 'i2' })]);
    assert.equal(stripe.called('customers.create').length, 2);
    assert.equal(stripe.called('customers.del').length, 1);
    const kept = (await data(db.doc(`companies/${C}/customers/c1`))).stripeCustomerIds.test;
    assert.deepEqual([...stripe.customers.keys()], [kept]);
    assert.equal(stripe.invoices.get(a.invoiceId).customer, kept);
    assert.equal(stripe.invoices.get(b.invoiceId).customer, kept);
  });

  it('keeps a Stripe invoice marked uncollectible linked until it\'s voided, since it can still be paid', async () => {
    const { invoiceId } = await create();
    const check = () => syncStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' });
    // Marked uncollectible in Stripe's dashboard after $500 was paid on it.
    Object.assign(stripe.invoices.get(invoiceId), { status: 'uncollectible', amount_paid: 50000 });
    const event = { type: 'invoice.marked_uncollectible', data: { object: { id: invoiceId, metadata: { companyId: C, invoiceId: 'i1' } } } };
    assert.equal(await handleStripeEvent({ db, stripe, event, allowed: C }), 'updated');
    let d = await data();
    assert.equal(d.stripe.status, 'uncollectible');
    assert.equal(d.stripe.amountPaid, 500);
    // A new Stripe invoice would bill that $500 again and leave this one payable.
    await assert.rejects(create({ send: true }), { code: 'failed-precondition', message: /uncollectible, but it can still be paid\. Void it first/ });
    assert.equal(stripe.called('invoices.create').length, 1);
    // Stripe won't void it with a payment on it, so the bill keeps the payment.
    stripe.fail['invoices.voidInvoice'] = stripeError('StripeInvalidRequestError', 'You can\'t void an invoice with a payment on it.');
    await assert.rejects(voidStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' }), /Stripe: You can't void an invoice with a payment on it/);
    d = await data();
    assert.equal(d.stripe.status, 'uncollectible');
    assert.equal(d.stripe.amountPaid, 500);
    // Without one, it's voided from the app, and then a new one goes out.
    stripe.invoices.get(invoiceId).amount_paid = 0;
    await check();
    assert.equal((await voidStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' })).status, 'void');
    assert.equal(stripe.invoices.get(invoiceId).status, 'void');
    const r = await create({ send: true });
    assert.equal(r.number, '1003-2');
    assert.equal(r.sentTo, 'pat@example.com');
  });

  it('keeps a payment recorded while a new Stripe invoice was being made', async () => {
    const { invoiceId: old } = await create();
    Object.assign(stripe.invoices.get(old), { status: 'uncollectible' });
    await syncStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' });
    // Once the live key is in, a test-mode one doesn't hold up a new live invoice. While that's
    // being made, the earlier Stripe invoice is paid and recorded (as the webhook would).
    stripe.livemode = true;
    const finalize = stripe.invoices.finalizeInvoice;
    stripe.invoices.finalizeInvoice = async (...args) => {
      const si = await finalize(...args);
      stripe.pay(old);
      await applyStripeInvoice(db, stripe, await stripe.invoices.retrieve(old));
      return si;
    };
    await assert.rejects(create({ livemode: true }), { code: 'failed-precondition', message: /marked paid while its Stripe invoice was being made/ });
    const d = await data();
    assert.equal(d.status, 'paid');
    assert.equal(d.stripe.status, 'paid');
    assert.equal(d.stripe.invoiceId, old);
    assert.equal(d.stripe.amountPaid, 1890);
    assert.equal([...stripe.invoices.values()].at(-1).status, 'void'); // the new one was cancelled
  });

  it('keeps what a check recorded when an older read of the same Stripe invoice lands after it', async () => {
    const { invoiceId } = await create();
    const check = () => syncStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' });
    const unpaid = await stripe.invoices.retrieve(invoiceId); // read just before $500 was paid on it
    stripe.invoices.get(invoiceId).amount_paid = 50000;
    await check();
    await applyStripeInvoice(db, stripe, unpaid); // that read's check saves last
    let d = await data();
    assert.equal(d.stripe.paidOnline, 500);
    assert.equal(d.stripe.amountPaid, 500);
    // The same for a refund through a credit note on it once it's paid.
    stripe.pay(invoiceId);
    await check();
    const beforeRefund = await stripe.invoices.retrieve(invoiceId);
    stripe.invoices.get(invoiceId).post_payment_credit_notes_amount = 50000;
    const note = { type: 'credit_note.created', data: { object: { id: 'cn_1', invoice: invoiceId } } };
    assert.equal(await handleStripeEvent({ db, stripe, event: note, allowed: C }), 'updated');
    await applyStripeInvoice(db, stripe, beforeRefund);
    d = await data();
    assert.equal(d.stripe.amountPaid, 1390);
    assert.equal(d.stripe.credited, 500);
  });

  it('says so when Stripe\'s reminders can\'t be turned on, and a check tries again', async () => {
    stripe.fail['invoices.update'] = stripeError('StripeConnectionError', 'socket hang up');
    const r = await create({ send: true });
    assert.equal(r.sentTo, 'pat@example.com');
    assert.match(r.warning, /^Stripe emailed the invoice, but couldn't turn on its payment reminders\. Couldn't reach Stripe.*Opening the invoice in the app tries again\.$/);
    assert.match((await data()).stripe.error, /couldn't turn on its payment reminders/);
    assert.equal(stripe.invoices.get(r.invoiceId).auto_advance, false);
    const synced = await syncStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' });
    assert.equal(stripe.invoices.get(r.invoiceId).auto_advance, true);
    assert.equal(synced.error, null);
    assert.equal((await data()).stripe.error, null);
    // Turned off in Stripe afterwards, they stay off.
    stripe.invoices.get(r.invoiceId).auto_advance = false;
    await syncStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' });
    assert.equal(stripe.invoices.get(r.invoiceId).auto_advance, false);
    // One that was only made into a payment link (not emailed) keeps them off.
    const { stripe: _, ...bill } = await data();
    await db.doc(`companies/${C}/invoices/i2`).set({ ...bill, number: 1004 });
    const link = await create({ invoiceId: 'i2' });
    await syncStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i2' });
    assert.equal(stripe.invoices.get(link.invoiceId).auto_advance, false);
  });

  it('dates the Stripe invoice like the bill, and takes a new date for a change', async () => {
    const now = new Date('2026-10-11T15:00:00Z');
    await inv().update({ date: '2026-10-01' });
    await create({ now });
    assert.equal(stripe.called('invoices.create')[0][1].effective_at, Date.parse('2026-10-01T16:00:00Z') / 1000);
    assert.equal((await data()).stripe.sent.date, '2026-10-01');
    // Dated differently afterwards, the Stripe invoice still shows the old date.
    await inv().update({ date: '2026-10-05' });
    await assert.rejects(create({ send: true, now }), /changed after its Stripe invoice was made/);
    // Dated today, it needs no date of its own: Stripe's is the day it's made.
    await voidStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' });
    await inv().update({ date: '2026-10-11' });
    await create({ now });
    assert.equal(stripe.called('invoices.create').at(-1)[1].effective_at, undefined);
  });

  it('doesn\'t let an older read of the Stripe invoice undo its payment', async () => {
    const { invoiceId } = await create();
    const stale = await stripe.invoices.retrieve(invoiceId); // a check that read it just before the payment
    stripe.pay(invoiceId);
    const event = { type: 'invoice.paid', data: { object: { id: invoiceId, metadata: { companyId: C, invoiceId: 'i1' } } } };
    assert.equal(await handleStripeEvent({ db, stripe, event, allowed: C }), 'updated');
    await applyStripeInvoice(db, stripe, stale);
    const d = await data();
    assert.equal(d.status, 'paid');
    assert.equal(d.stripe.status, 'paid');
    assert.equal(d.stripe.amountPaid, 1890);
  });

  it('records a payment found while voiding or checking', async () => {
    const { invoiceId } = await create();
    stripe.pay(invoiceId);
    stripe.fail['invoices.voidInvoice'] = stripeError('StripeInvalidRequestError', 'You can only void open invoices');
    await assert.rejects(voidStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' }), /already paid/);
    assert.equal((await data()).status, 'paid');

    await inv().update({ status: 'unpaid', stripe: { ...(await data()).stripe, status: 'open' } });
    const s = await syncStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' });
    assert.equal(s.status, 'paid');
    assert.equal((await data()).status, 'paid');
  });

  it('keeps test-mode and live-mode Stripe invoices apart', async () => {
    await create();
    // The live key can't see test invoices, so checking changes nothing.
    const s = await syncStripeInvoice({ db, stripe, livemode: true, companyId: C, invoiceId: 'i1' });
    assert.equal(s.status, 'open');
    assert.equal(stripe.called('invoices.retrieve').length, 0);
    stripe.livemode = true;
    const live = await create({ livemode: true });
    assert.equal(live.livemode, true);
    assert.equal(live.number, '1003'); // test tries don't use up live numbers
    const ids = (await data(db.doc(`companies/${C}/customers/c1`))).stripeCustomerIds;
    assert.ok(ids.test && ids.live && ids.test !== ids.live);
    // Back on a test key, the live invoice can't be voided by mistake.
    await assert.rejects(voidStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' }), /live/);
  });

  it('keeps a payable live Stripe invoice linked when the key is back on test', async () => {
    stripe.livemode = true;
    const live = await create({ livemode: true });
    stripe.livemode = false;
    await assert.rejects(create({ livemode: false }), /live Stripe invoice that can still be paid/);
    let d = await data();
    assert.equal(d.stripe.invoiceId, live.invoiceId);
    assert.equal(d.stripe.status, 'open');
    // Marked uncollectible in Stripe, it can still be paid too.
    await inv().update({ 'stripe.status': 'uncollectible' });
    await assert.rejects(create({ livemode: false }), /uncollectible, but it can still be paid/);
    await assert.rejects(voidStripeInvoice({ db, stripe, livemode: false, companyId: C, invoiceId: 'i1' }), /live, but the app is using a test key/);
    d = await data();
    assert.equal(d.stripe.invoiceId, live.invoiceId);
    assert.equal(d.stripe.status, 'uncollectible');
    assert.equal(stripe.called('invoices.create').length, 1);
  });

  it('sets a test invoice aside once the live key is in', async () => {
    // Test credit on the customer's Stripe account came off it.
    const cus = await stripe.customers.create({ name: 'Lakeland Builders', balance: -30000 });
    await db.doc(`companies/${C}/customers/c1`).update({ 'stripeCustomerIds.test': cus.id });
    await create();
    assert.equal(paidOn(await data()), 300);
    const v = await voidStripeInvoice({ db, stripe, livemode: true, companyId: C, invoiceId: 'i1' });
    assert.equal(v.status, 'void');
    assert.equal(stripe.called('invoices.voidInvoice').length, 0);
    const d = await data();
    assert.equal(d.stripe.amountPaid, 0);
    assert.equal(d.stripe.balanceApplied, 0);
    assert.equal(paidOn(d), 0);
    assert.equal((await create({ livemode: true })).status, 'open');
  });
});
