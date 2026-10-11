// Runs under `npm test` against the Firestore emulator, with a fake Stripe client.
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import {
  requireBiller, companyAllowed, stripeStatus, createStripeInvoice, voidStripeInvoice, syncStripeInvoice, handleStripeEvent, applyStripeInvoice,
} from '../stripe-invoices.js';

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
    }),
    invoices: Object.assign(invoices, {
      create: async (p) => {
        log('invoices.create', p);
        const si = { id: `in_${++n}`, status: 'draft', lines: [], livemode: fake.livemode, ...p, number: p.number || null };
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
        Object.assign(si, {
          status: 'open', number: si.number || `AUTO-${++n}`, amount_due: total(si),
          customer_email: c.email || null, customer_name: c.name || null, customer_phone: c.phone || null, customer_address: c.address || null,
          hosted_invoice_url: `https://invoice.stripe.test/${id}`, invoice_pdf: `https://invoice.stripe.test/${id}.pdf`,
        });
        return { ...si };
      },
      sendInvoice: async (id) => { log('invoices.sendInvoice', id); return { ...get(id) }; },
      voidInvoice: async (id) => { log('invoices.voidInvoice', id); Object.assign(get(id), { status: 'void' }); return { ...get(id) }; },
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
    // The customer pays on Stripe's page.
    pay(id, paidAt = Date.parse('2026-10-20T15:00:00Z') / 1000) {
      Object.assign(get(id), { status: 'paid', amount_paid: total(get(id)), status_transitions: { paid_at: paidAt } });
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
    await db.doc(`companies/${C}`).set({ name: 'Stellar Glass', ownerUid: 'wes' });
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

    const d = await data();
    assert.equal(d.stripe.status, 'open');
    assert.equal(d.stripe.issued, 1);
    assert.equal(d.stripe.createdBy, 'cpa');
    assert.equal(d.stripe.hostedUrl, `https://invoice.stripe.test/${d.stripe.invoiceId}`);
    // What it was made from, so the app can tell when the bill is edited afterwards.
    assert.deepEqual(d.stripe.sent, {
      number: 1003, jobId: 'j1', taxPct: 7, dueDate: '2099-01-01', notes: 'Thank you for your business.',
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

  // A first try whose answer from Stripe is lost after Stripe finalized the invoice, so it's never saved.
  const lostTry = async () => {
    const finalize = stripe.invoices.finalizeInvoice;
    stripe.invoices.finalizeInvoice = async (...args) => {
      await finalize(...args);
      throw stripeError('StripeConnectionError', 'socket hang up');
    };
    await assert.rejects(create(), { code: 'unavailable' });
    stripe.invoices.finalizeInvoice = finalize;
    const orphan = [...stripe.invoices.values()].at(-1);
    assert.equal(orphan.status, 'open');
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

  it('doesn\'t let an older read of the Stripe invoice undo its payment', async () => {
    const { invoiceId } = await create();
    const stale = await stripe.invoices.retrieve(invoiceId); // a check that read it just before the payment
    stripe.pay(invoiceId);
    const event = { type: 'invoice.paid', data: { object: { id: invoiceId, metadata: { companyId: C, invoiceId: 'i1' } } } };
    assert.equal(await handleStripeEvent({ db, stripe, event, allowed: C }), 'updated');
    assert.equal(await applyStripeInvoice(db, stale), false);
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
    const d = await data();
    assert.equal(d.stripe.invoiceId, live.invoiceId);
    assert.equal(d.stripe.status, 'open');
    assert.equal(stripe.called('invoices.create').length, 1);
  });

  it('sets a test invoice aside once the live key is in', async () => {
    await create();
    const v = await voidStripeInvoice({ db, stripe, livemode: true, companyId: C, invoiceId: 'i1' });
    assert.equal(v.status, 'void');
    assert.equal(stripe.called('invoices.voidInvoice').length, 0);
    assert.equal((await create({ livemode: true })).status, 'open');
  });
});
