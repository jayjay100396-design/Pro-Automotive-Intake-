// Runs under `npm test` against the Firestore emulator, with a fake Stripe client.
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  requireBiller, companyAllowed, stripeStatus, createStripeInvoice, voidStripeInvoice, syncStripeInvoice, handleStripeEvent,
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
        Object.assign(si, {
          status: 'open', number: si.number || `AUTO-${++n}`, amount_due: total(si),
          hosted_invoice_url: `https://invoice.stripe.test/${id}`, invoice_pdf: `https://invoice.stripe.test/${id}.pdf`,
        });
        return { ...si };
      },
      sendInvoice: async (id) => { log('invoices.sendInvoice', id); return { ...get(id) }; },
      voidInvoice: async (id) => { log('invoices.voidInvoice', id); Object.assign(get(id), { status: 'void' }); return { ...get(id) }; },
      del: async (id) => { log('invoices.del', id); invoices.delete(id); return { deleted: true }; },
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
    assert.deepEqual(params.metadata, { companyId: C, invoiceId: 'i1', appNumber: '1003' });
    assert.deepEqual(params.custom_fields.map((f) => f.name), ['Project', 'Site', 'PO / project #']);
    assert.deepEqual(stripe.called('invoiceItems.create').map(([, p]) => p.description),
      ['Storefront glass', 'Install labor (6.5 × $85.00)', 'Sales tax (7% on $1,250.00)']);
    assert.equal(stripe.called('invoices.sendInvoice').length, 1);

    const d = await data();
    assert.equal(d.stripe.status, 'open');
    assert.equal(d.stripe.issued, 1);
    assert.equal(d.stripe.createdBy, 'cpa');
    assert.equal(d.stripe.hostedUrl, `https://invoice.stripe.test/${d.stripe.invoiceId}`);
    assert.equal((await data(db.doc(`companies/${C}/customers/c1`))).stripeCustomerIds.test, [...stripe.customers.values()][0].id);
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

  it('picks up a Stripe invoice an earlier try made but never saved', async () => {
    const cus = await stripe.customers.create({ name: 'x' });
    await db.doc(`companies/${C}/customers/c1`).update({ stripeCustomerIds: { test: cus.id } });
    const orphan = await stripe.invoices.create({ customer: cus.id, metadata: { companyId: C, invoiceId: 'i1' } });
    await stripe.invoices.finalizeInvoice(orphan.id);
    const r = await create();
    assert.equal(r.invoiceId, orphan.id);
    assert.equal(stripe.called('invoices.create').length, 1); // only the orphan
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

  it('sets a test invoice aside once the live key is in', async () => {
    await create();
    const v = await voidStripeInvoice({ db, stripe, livemode: true, companyId: C, invoiceId: 'i1' });
    assert.equal(v.status, 'void');
    assert.equal(stripe.called('invoices.voidInvoice').length, 0);
    assert.equal((await create({ livemode: true })).status, 'open');
  });
});
