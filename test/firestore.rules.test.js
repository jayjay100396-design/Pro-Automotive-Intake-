// Run with: npm test  (starts the Firestore emulator, needs Java)
const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment, assertSucceeds, assertFails,
} = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, deleteField, writeBatch, Timestamp, serverTimestamp } = require('firebase/firestore');

let env;
const db = (uid) => env.authenticatedContext(uid).firestore();

async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const f = ctx.firestore();
    await setDoc(doc(f, 'companies/stellar'), { name: 'Stellar Glass', ownerUid: 'wes' });
    await setDoc(doc(f, 'companies/stellar/members/wes'), { role: 'owner' });
    await setDoc(doc(f, 'companies/stellar/members/admin1'), { role: 'admin' });
    await setDoc(doc(f, 'companies/stellar/members/crew'), { role: 'staff' });
    await setDoc(doc(f, 'companies/stellar/members/cpa'), { role: 'accountant' });
    await setDoc(doc(f, 'companies/stellar/jobs/j1'), { name: 'Storefront' });
    await setDoc(doc(f, 'companies/other'), { name: 'Other Co', ownerUid: 'bob' });
    await setDoc(doc(f, 'companies/other/members/bob'), { role: 'owner' });
    await setDoc(doc(f, 'companies/other/jobs/j9'), { name: 'Secret' });
  });
}

describe('Firestore rules', function () {
  this.timeout(20000);
  before(async () => {
    env = await initializeTestEnvironment({
      projectId: 'demo-stellar-glass',
      firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8') },
    });
  });
  after(() => env.cleanup());
  beforeEach(async () => { await env.clearFirestore(); await seed(); });

  it('blocks signed-out users', async () => {
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, 'companies/stellar/jobs/j1')));
    await assertFails(getDoc(doc(anon, 'companies/stellar')));
  });

  it('keeps companies apart', async () => {
    await assertFails(getDoc(doc(db('wes'), 'companies/other/jobs/j9')));
    await assertFails(setDoc(doc(db('wes'), 'companies/other/jobs/x'), { a: 1 }));
    await assertFails(getDoc(doc(db('bob'), 'companies/stellar/jobs/j1')));
    await assertFails(getDoc(doc(db('stranger'), 'companies/stellar')));
  });

  it('lets members read and editors write', async () => {
    for (const uid of ['wes', 'admin1', 'crew', 'cpa']) {
      await assertSucceeds(getDoc(doc(db(uid), 'companies/stellar/jobs/j1')));
    }
    await assertSucceeds(setDoc(doc(db('crew'), 'companies/stellar/estimates/e1'), { total: 100 }));
    await assertSucceeds(setDoc(doc(db('crew'), 'companies/stellar/estimates/e1/lines/l1'), { qty: 2 }));
    await assertFails(deleteDoc(doc(db('crew'), 'companies/stellar/jobs/j1')));
    await assertSucceeds(deleteDoc(doc(db('admin1'), 'companies/stellar/jobs/j1')));
  });

  it('lets the accountant handle billing but nothing else', async () => {
    const f = db('cpa');
    for (const c of ['invoices', 'payApps', 'billing', 'documents', 'forms']) {
      await assertSucceeds(setDoc(doc(f, `companies/stellar/${c}/x1`), { total: 5 }));
      await assertSucceeds(updateDoc(doc(f, `companies/stellar/${c}/x1`), { total: 6 }));
      await assertFails(deleteDoc(doc(f, `companies/stellar/${c}/x1`)));
    }
    // G703 continuation lines under a pay app
    await assertSucceeds(setDoc(doc(f, 'companies/stellar/payApps/x1/lines/l1'), { pct: 50 }));
    await assertFails(deleteDoc(doc(f, 'companies/stellar/payApps/x1/lines/l1')));
    for (const c of ['jobs', 'contracts', 'changeOrders', 'estimates', 'customers']) {
      await assertSucceeds(getDoc(doc(f, `companies/stellar/${c}/j1`)));
      await assertFails(setDoc(doc(f, `companies/stellar/${c}/new`), { a: 1 }));
    }
    await assertFails(updateDoc(doc(f, 'companies/stellar/jobs/j1'), { name: 'x' }));
    await assertFails(deleteDoc(doc(f, 'companies/stellar/jobs/j1')));
    await assertFails(setDoc(doc(f, 'companies/stellar/members/someone'), { role: 'staff' }));
    await assertFails(updateDoc(doc(f, 'companies/stellar/members/crew'), { role: 'accountant' }));
    await assertFails(deleteDoc(doc(f, 'companies/stellar/members/crew')));
    await assertFails(updateDoc(doc(f, 'companies/stellar/members/cpa'), { role: 'admin' }));
    await assertFails(updateDoc(doc(f, 'companies/stellar'), { name: 'x' }));
    await assertFails(setDoc(doc(f, 'companies/other/invoices/x'), { total: 1 }));
  });

  it('keeps the Stripe fields for the server', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const f = ctx.firestore();
      await setDoc(doc(f, 'companies/stellar/invoices/i1'), { number: 1001, status: 'unpaid', stripe: { status: 'open', invoiceId: 'in_1' } });
      await setDoc(doc(f, 'companies/stellar/customers/c1'), { name: 'GC', stripeCustomerIds: { test: 'cus_1' } });
    });
    for (const uid of ['wes', 'cpa']) {
      const f = db(uid);
      // Normal edits still work, and leave the Stripe fields alone.
      await assertSucceeds(updateDoc(doc(f, 'companies/stellar/invoices/i1'), { notes: 'Thanks', status: 'paid' }));
      await assertFails(updateDoc(doc(f, 'companies/stellar/invoices/i1'), { 'stripe.status': 'paid' }));
      await assertFails(updateDoc(doc(f, 'companies/stellar/invoices/i1'), { stripe: null }));
      await assertFails(setDoc(doc(f, `companies/stellar/invoices/new-${uid}`), { number: 1002, stripe: { status: 'paid' } }));
      await assertSucceeds(setDoc(doc(f, `companies/stellar/invoices/ok-${uid}`), { number: 1003 }));
    }
    await assertSucceeds(updateDoc(doc(db('crew'), 'companies/stellar/customers/c1'), { email: 'gc@example.com' }));
    await assertFails(updateDoc(doc(db('crew'), 'companies/stellar/customers/c1'), { 'stripeCustomerIds.test': 'cus_2' }));
    await assertFails(setDoc(doc(db('crew'), 'companies/stellar/customers/c2'), { name: 'X', stripeCustomerIds: { live: 'cus_3' } }));
  });

  it('keeps an invoice paid through Stripe as it was paid, and keeps it', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const f = ctx.firestore();
      await setDoc(doc(f, 'companies/stellar/invoices/live'), { number: 1001, status: 'paid', stripe: { status: 'paid', livemode: true } });
      await setDoc(doc(f, 'companies/stellar/invoices/test'), { number: 1002, status: 'paid', stripe: { status: 'paid', livemode: false } });
      await setDoc(doc(f, 'companies/stellar/invoices/check'), { number: 1003, status: 'paid', stripe: { status: 'void', livemode: true } });
    });
    for (const uid of ['wes', 'cpa']) {
      const f = db(uid);
      // A save that changes nothing goes through (data.js stamps updatedAt); the bill stays as it was paid.
      await assertSucceeds(updateDoc(doc(f, 'companies/stellar/invoices/live'), { number: 1001, status: 'paid', updatedAt: serverTimestamp() }));
      for (const change of [{ status: 'unpaid' }, { status: 'void' }, { notes: 'Thanks' }, { number: 1009 }, { lines: [{ desc: 'Glass', qty: 1, price: 5 }] }]) {
        await assertFails(updateDoc(doc(f, 'companies/stellar/invoices/live'), change));
      }
    }
    await assertFails(deleteDoc(doc(db('wes'), 'companies/stellar/invoices/live')));
    await assertFails(deleteDoc(doc(db('admin1'), 'companies/stellar/invoices/live')));
    // Paid in test mode, or paid by check after its Stripe invoice was voided: those can change.
    await assertSucceeds(updateDoc(doc(db('wes'), 'companies/stellar/invoices/test'), { notes: 'Thanks', status: 'void' }));
    await assertSucceeds(deleteDoc(doc(db('wes'), 'companies/stellar/invoices/test')));
    await assertSucceeds(updateDoc(doc(db('cpa'), 'companies/stellar/invoices/check'), { status: 'unpaid' }));
    await assertSucceeds(deleteDoc(doc(db('wes'), 'companies/stellar/invoices/check')));
  });

  it('keeps an invoice with a payable live Stripe invoice as it is until that is voided', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const f = ctx.firestore();
      await setDoc(doc(f, 'companies/stellar/invoices/out'), { number: 1004, status: 'unpaid', stripe: { status: 'open', livemode: true } });
      await setDoc(doc(f, 'companies/stellar/invoices/testout'), { number: 1005, status: 'unpaid', stripe: { status: 'open', livemode: false } });
      // Marked uncollectible in Stripe after $500 was paid on it: Stripe still takes payment on it.
      await setDoc(doc(f, 'companies/stellar/invoices/written'), { number: 1006, status: 'unpaid', stripe: { status: 'uncollectible', livemode: true, amountPaid: 500 } });
    });
    // Say from a tab that was offline when the Stripe invoice went out: the customer is paying the Stripe
    // invoice made from the bill, so the bill can't change under it (a payment would mark a different bill paid).
    for (const uid of ['wes', 'cpa']) {
      const f = db(uid);
      for (const id of ['out', 'written']) {
        const r = doc(f, `companies/stellar/invoices/${id}`);
        await assertSucceeds(updateDoc(r, { status: 'unpaid', updatedAt: serverTimestamp() })); // a save that changes nothing
        await assertFails(updateDoc(r, { notes: 'Thanks' }));
        await assertFails(updateDoc(r, { lines: [{ desc: 'More glass', qty: 1, price: 900 }] }));
        await assertFails(updateDoc(r, { payments: [{ id: 'p1', method: 'check', amount: 500, date: '2026-10-12' }] }));
        await assertFails(updateDoc(r, { status: 'paid' }));
        await assertFails(updateDoc(r, { status: 'void' }));
      }
    }
    await assertFails(deleteDoc(doc(db('wes'), 'companies/stellar/invoices/out')));
    await assertFails(deleteDoc(doc(db('wes'), 'companies/stellar/invoices/written')));
    // Once the Cloud Function has voided it, the bill can change.
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'companies/stellar/invoices/out'), { 'stripe.status': 'void' }));
    await assertSucceeds(updateDoc(doc(db('cpa'), 'companies/stellar/invoices/out'), { status: 'paid' }));
    // A test-mode payment link isn't real money.
    await assertSucceeds(updateDoc(doc(db('wes'), 'companies/stellar/invoices/testout'), { status: 'void' }));
    await assertSucceeds(deleteDoc(doc(db('wes'), 'companies/stellar/invoices/testout')));
  });

  it('lets only the owner and admins take a recorded payment off an invoice', async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'companies/stellar/invoices/bypay'), {
      number: 1010, status: 'unpaid', lines: [{ desc: 'Glass', qty: 1, price: 1000 }],
    }));
    const p1 = { id: 'p1', method: 'check', amount: 400, date: '2026-10-01', ref: '1201', note: '', by: 'cpa', at: '2026-10-01T15:00:00Z' };
    const p2 = { ...p1, id: 'p2', amount: 600, ref: '1202' };
    const r = (uid) => doc(db(uid), 'companies/stellar/invoices/bypay');
    // Anyone who bills can add one, on its own or with the status it makes.
    await assertSucceeds(updateDoc(r('cpa'), { payments: [p1] }));
    await assertSucceeds(updateDoc(r('crew'), { payments: [p1, p2], status: 'paid', paidDate: '2026-10-05' }));
    await assertSucceeds(updateDoc(r('cpa'), { notes: 'Thank you', payments: [p1, p2] }));
    // Only the owner and admins can take one off or change one.
    await assertFails(updateDoc(r('cpa'), { payments: [p1], status: 'unpaid', paidDate: '' }));
    await assertFails(updateDoc(r('crew'), { payments: [p1, { ...p2, amount: 6000 }] }));
    await assertFails(updateDoc(r('cpa'), { payments: [p2, p1] }));
    await assertFails(updateDoc(r('cpa'), { payments: [] }));
    await assertFails(updateDoc(r('cpa'), { payments: 'none' }));
    await assertSucceeds(updateDoc(r('admin1'), { payments: [p1], status: 'unpaid', paidDate: '' }));
    await assertSucceeds(updateDoc(r('wes'), { payments: [] }));
    // A new invoice can come with payments (one saved as paid).
    await assertSucceeds(setDoc(doc(db('cpa'), 'companies/stellar/invoices/paidnew'), { number: 1011, status: 'paid', payments: [p1] }));
  });

  it('lets a new pay app note on its contract that the pay apps have started, and keeps that note', async () => {
    const contract = { number: 3001, estimateId: 'e1', amount: 5000, status: 'draft' };
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'companies/stellar/contracts/k1'), contract);
      await setDoc(doc(ctx.firestore(), 'companies/stellar/contracts/k2'), contract);
    });
    const k = (uid, id = 'k1') => doc(db(uid), `companies/stellar/contracts/${id}`);
    // The accountant, who makes pay apps, notes it with each one, and changes nothing else on a contract.
    const f = db('cpa');
    const first = writeBatch(f);
    first.update(doc(f, 'companies/stellar/contracts/k1'), { payAppsStarted: true, updatedAt: serverTimestamp() });
    first.set(doc(f, 'companies/stellar/payApps/k1-1'), { contractId: 'k1', number: 1 });
    await assertSucceeds(first.commit());
    await assertSucceeds(updateDoc(k('cpa'), { payAppsStarted: true, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(k('cpa', 'k2'), { payAppsStarted: true, amount: 1 }));
    await assertFails(updateDoc(k('cpa', 'k2'), { payAppsStarted: false }));
    await assertFails(updateDoc(k('cpa', 'k2'), { amount: 1 }));
    await assertFails(setDoc(k('cpa', 'k3'), { ...contract, payAppsStarted: true }));
    await assertSucceeds(updateDoc(k('crew', 'k2'), { payAppsStarted: true, updatedAt: serverTimestamp() }));
    // Once noted, nobody takes it off; the contract can still be edited, and deleted by the owner or an admin.
    for (const uid of ['wes', 'admin1', 'crew', 'cpa']) {
      await assertFails(updateDoc(k(uid), { payAppsStarted: false }));
      await assertFails(updateDoc(k(uid), { payAppsStarted: deleteField() }));
      await assertFails(setDoc(k(uid), contract));
    }
    for (const uid of ['wes', 'admin1', 'crew']) await assertSucceeds(updateDoc(k(uid), { status: 'signed', updatedAt: serverTimestamp() }));
    await assertSucceeds(getDoc(k('wes')).then((d) => { if (d.data().payAppsStarted !== true) throw new Error('note lost'); }));
    await assertSucceeds(deleteDoc(k('wes')));
  });

  it('lets the owner invite an accountant', async () => {
    await assertSucceeds(setDoc(doc(db('wes'), 'companies/stellar/members/newcpa'), { role: 'accountant' }));
  });

  it('lets people join by a single-use invite link', async () => {
    const later = Timestamp.fromMillis(Date.now() + 7 * 864e5);
    const join = (uid, inviteId, role = 'accountant') => {
      const f = db(uid);
      const b = writeBatch(f);
      b.set(doc(f, `companies/stellar/members/${uid}`), { role, inviteId });
      b.delete(doc(f, `companies/stellar/invites/${inviteId}`));
      return b.commit();
    };
    // Only owners/admins create invites; only the owner invites an admin; staff can't.
    await assertFails(setDoc(doc(db('crew'), 'companies/stellar/invites/x'), { role: 'staff', expiresAt: later }));
    await assertFails(setDoc(doc(db('admin1'), 'companies/stellar/invites/x'), { role: 'admin', expiresAt: later }));
    await assertFails(setDoc(doc(db('wes'), 'companies/stellar/invites/x'), { role: 'owner', expiresAt: later }));
    await assertSucceeds(setDoc(doc(db('wes'), 'companies/stellar/invites/abc'), { role: 'accountant', expiresAt: later }));
    // Can read the one invite with its id, but not list them.
    await assertSucceeds(getDoc(doc(db('newcpa'), 'companies/stellar/invites/abc')));
    await assertFails(getDocs(collection(db('newcpa'), 'companies/stellar/invites')));
    await assertSucceeds(getDocs(collection(db('wes'), 'companies/stellar/invites')));
    // Must take the invite's role, and must use up the invite.
    await assertFails(join('newcpa', 'abc', 'admin'));
    await assertFails(setDoc(doc(db('newcpa'), 'companies/stellar/members/newcpa'), { role: 'accountant', inviteId: 'abc' }));
    await assertSucceeds(join('newcpa', 'abc'));
    await assertSucceeds(getDoc(doc(db('newcpa'), 'companies/stellar/jobs/j1')));
    // The link doesn't work twice.
    await assertFails(join('another', 'abc'));
    // Expired invites don't work.
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'companies/stellar/invites/old'), { role: 'staff', expiresAt: Timestamp.fromMillis(Date.now() - 1000) }));
    await assertFails(join('late', 'old', 'staff'));
    // Staff can't sneak invites in through the generic record rules.
    await assertFails(setDoc(doc(db('crew'), 'companies/stellar/invites/y/x/z'), { role: 'admin' }));
  });

  it('lets a new user create their own company in one batch', async () => {
    const f = db('newbie');
    const b = writeBatch(f);
    b.set(doc(f, 'companies/newco'), { name: 'New Co', ownerUid: 'newbie' });
    b.set(doc(f, 'companies/newco/members/newbie'), { role: 'owner' });
    await assertSucceeds(b.commit());
  });

  it('stops anyone claiming an existing company', async () => {
    const f = db('stranger');
    await assertFails(setDoc(doc(f, 'companies/stellar/members/stranger'), { role: 'owner' }));
    await assertFails(setDoc(doc(f, 'companies/stellar/members/stranger'), { role: 'staff' }));
    await assertFails(setDoc(doc(f, 'companies/fake'), { name: 'X', ownerUid: 'wes' }));
  });

  it('enforces role changes', async () => {
    await assertFails(updateDoc(doc(db('crew'), 'companies/stellar/members/crew'), { role: 'admin' }));
    await assertFails(updateDoc(doc(db('admin1'), 'companies/stellar/members/admin1'), { role: 'owner' }));
    await assertFails(updateDoc(doc(db('admin1'), 'companies/stellar/members/crew'), { role: 'admin' }));
    await assertFails(setDoc(doc(db('admin1'), 'companies/stellar/members/x'), { role: 'owner' }));
    await assertSucceeds(setDoc(doc(db('admin1'), 'companies/stellar/members/helper'), { role: 'staff' }));
    await assertSucceeds(updateDoc(doc(db('wes'), 'companies/stellar/members/crew'), { role: 'admin' }));
    await assertFails(deleteDoc(doc(db('admin1'), 'companies/stellar/members/wes')));
    await assertFails(updateDoc(doc(db('wes'), 'companies/stellar'), { ownerUid: 'crew' }));
    await assertFails(deleteDoc(doc(db('wes'), 'companies/stellar')));
  });

  it('lets the owner transfer ownership to a member in one batch', async () => {
    const transfer = (f, from, to) => {
      const b = writeBatch(f);
      b.update(doc(f, 'companies/stellar'), { ownerUid: to });
      b.update(doc(f, `companies/stellar/members/${to}`), { role: 'owner' });
      b.update(doc(f, `companies/stellar/members/${from}`), { role: 'admin' });
      return b.commit();
    };
    // Not the owner, or to a non-member, or only part of the batch: denied.
    await assertFails(transfer(db('admin1'), 'admin1', 'crew'));
    await assertFails(transfer(db('wes'), 'wes', 'stranger'));
    await assertFails(updateDoc(doc(db('wes'), 'companies/stellar'), { ownerUid: 'cpa' }));
    await assertFails(updateDoc(doc(db('wes'), 'companies/stellar/members/cpa'), { role: 'owner' }));
    await assertFails(updateDoc(doc(db('wes'), 'companies/stellar/members/wes'), { role: 'admin' }));
    // Can't sneak in other changes with the transfer.
    const f = db('wes');
    const b = writeBatch(f);
    b.update(doc(f, 'companies/stellar'), { ownerUid: 'cpa', name: 'Mine now' });
    b.update(doc(f, 'companies/stellar/members/cpa'), { role: 'owner' });
    b.update(doc(f, 'companies/stellar/members/wes'), { role: 'admin' });
    await assertFails(b.commit());
    // The real thing works, and the new owner is in charge afterwards.
    await assertSucceeds(transfer(db('wes'), 'wes', 'cpa'));
    await assertSucceeds(updateDoc(doc(db('cpa'), 'companies/stellar'), { name: 'Stellar Glass LLC' }));
    await assertFails(updateDoc(doc(db('wes'), 'companies/stellar'), { name: 'Nope' }));
    await assertSucceeds(transfer(db('cpa'), 'cpa', 'wes'));
  });

  it('handles job file records by role', async () => {
    const url = 'https://firebasestorage.googleapis.com/v0/b/stellar-glass-jobs.firebasestorage.app/o/companies%2Fstellar%2Fphotos%2Fj1%2Fx%2Fa.jpg?alt=media&token=t';
    const file = (by, category = 'photos', over = {}) => ({
      jobId: 'j1', category, name: 'a.jpg', path: `companies/stellar/${category}/j1/x/a.jpg`, url, thumbPath: '', thumbUrl: '', createdBy: by, ...over,
    });
    // Staff add files and can delete only their own; admins delete any.
    await assertSucceeds(setDoc(doc(db('crew'), 'companies/stellar/files/f1'), file('crew')));
    await assertSucceeds(setDoc(doc(db('wes'), 'companies/stellar/files/f2'), file('wes')));
    await assertFails(deleteDoc(doc(db('crew'), 'companies/stellar/files/f2')));
    await assertSucceeds(deleteDoc(doc(db('crew'), 'companies/stellar/files/f1')));
    await assertSucceeds(deleteDoc(doc(db('admin1'), 'companies/stellar/files/f2')));
    // A record only ever points at a file in this business's storage, through a storage link.
    const crew = db('crew');
    await assertFails(setDoc(doc(crew, 'companies/stellar/files/x1'), file('crew', 'photos', { url: 'javascript:alert(1)' })));
    await assertFails(setDoc(doc(crew, 'companies/stellar/files/x2'), file('crew', 'photos', { thumbUrl: 'https://evil.example/a.jpg' })));
    await assertFails(setDoc(doc(crew, 'companies/stellar/files/x3'), file('crew', 'photos', { path: 'companies/other/photos/a.jpg' })));
    await assertFails(setDoc(doc(crew, 'companies/stellar/files/x4'), file('crew', 'gifs')));
    await assertFails(setDoc(doc(crew, 'companies/stellar/files/x5'), file('wes')));
    await assertFails(setDoc(doc(crew, 'companies/stellar/files/x6'), file('crew', 'photos', { url: url.replace('stellar-glass-jobs.firebasestorage.app', 'someone-else.appspot.com') })));
    await assertFails(setDoc(doc(crew, 'companies/stellar/files/x7'), file('crew', 'photos', { url: url.replace('companies%2Fstellar%2F', 'companies%2Fother%2F') })));
    await assertFails(setDoc(doc(crew, 'companies/stellar/files/x8'), file('crew', 'photos', { drive: { wes: { id: 'd', link: 'https://docs.google.com/x' } } })));
    await assertSucceeds(setDoc(doc(crew, 'companies/stellar/files/x9'),
      file('crew', 'photos', { url: 'http://127.0.0.1:9199/v0/b/demo-stellar-glass.appspot.com/o/companies%2Fstellar%2Fphotos%2Fa.jpg?alt=media&token=t' })));
    // Staff rename and re-sort anyone's files, but where a file is stored, its links and who added it stay put.
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'companies/stellar/files/o1'), file('wes')));
    await assertSucceeds(updateDoc(doc(crew, 'companies/stellar/files/o1'), { name: 'Front door.jpg', category: 'other', note: 'Before' }));
    await assertFails(updateDoc(doc(crew, 'companies/stellar/files/o1'), { category: 'gifs' }));
    await assertFails(updateDoc(doc(crew, 'companies/stellar/files/o1'), { url: 'javascript:alert(1)' }));
    await assertFails(updateDoc(doc(crew, 'companies/stellar/files/o1'), { thumbUrl: url }));
    await assertFails(updateDoc(doc(crew, 'companies/stellar/files/o1'), { path: 'companies/stellar/photos/j1/y/b.jpg' }));
    await assertFails(updateDoc(doc(crew, 'companies/stellar/files/o1'), { createdBy: 'crew' }));
    await assertFails(updateDoc(doc(crew, 'companies/stellar/files/o1'), { 'drive.wes': { id: 'd0' } }));
    await assertFails(deleteDoc(doc(crew, 'companies/stellar/files/o1')));
    // Photos from a website quote request: staff who made the job can't remove them; admins can.
    await assertSucceeds(setDoc(doc(crew, 'companies/stellar/files/r1'), file('crew', 'photos', { path: 'companies/stellar/requests/q1/0-a.jpg' })));
    await assertFails(deleteDoc(doc(crew, 'companies/stellar/files/r1')));
    await assertSucceeds(deleteDoc(doc(db('admin1'), 'companies/stellar/files/r1')));
    // The accountant adds contracts, documents, permits and forms, as themself, and fixes up their own.
    const f = db('cpa');
    await assertSucceeds(setDoc(doc(f, 'companies/stellar/files/c1'), file('cpa', 'forms')));
    await assertSucceeds(setDoc(doc(f, 'companies/stellar/files/c2'), file('cpa', 'documents')));
    await assertFails(setDoc(doc(f, 'companies/stellar/files/c3'), file('cpa', 'photos')));
    await assertFails(setDoc(doc(f, 'companies/stellar/files/c4'), file('crew', 'forms')));
    await assertSucceeds(updateDoc(doc(f, 'companies/stellar/files/c1'), { name: 'Notarized lien waiver.pdf', category: 'documents', note: 'Signed' }));
    await assertFails(updateDoc(doc(f, 'companies/stellar/files/c1'), { category: 'photos' }));
    await assertFails(updateDoc(doc(f, 'companies/stellar/files/c1'), { jobId: 'j9' }));
    await assertFails(deleteDoc(doc(f, 'companies/stellar/files/c1')));
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'companies/stellar/files/w1'), file('wes')));
    await assertFails(updateDoc(doc(f, 'companies/stellar/files/w1'), { name: 'x' }));
    // Anyone on the team can note their own Google Drive copy, and only their own.
    await assertSucceeds(updateDoc(doc(f, 'companies/stellar/files/w1'), { 'drive.cpa': { id: 'd1' } }));
    await assertFails(updateDoc(doc(f, 'companies/stellar/files/w1'), { 'drive.wes': { id: 'd2' } }));
    await assertFails(updateDoc(doc(f, 'companies/stellar/files/w1'), { 'drive.cpa': { id: 'd3' }, name: 'x' }));
    // Other businesses can't see them.
    await assertFails(getDoc(doc(db('bob'), 'companies/stellar/files/w1')));
    await assertFails(updateDoc(doc(db('bob'), 'companies/stellar/files/w1'), { 'drive.bob': { id: 'd4' } }));
  });

  describe('quote requests from the public page', () => {
    const { serverTimestamp, addDoc } = require('firebase/firestore');
    const anon = () => env.unauthenticatedContext().firestore();
    const form = (over = {}) => ({
      name: 'Pat Customer', company: '', phone: '(863) 555-0100', email: '', contactBy: 'phone',
      service: 'shower', timeline: 'soon', siteAddress: '12 Lake Ave, Lakeland', details: 'Frameless door and panel, 60 inch opening.',
      files: 2, site: 'stellar-glass', source: 'website', status: 'new', createdAt: serverTimestamp(), ...over,
    });
    const send = (data, company = 'stellar') => setDoc(doc(collection(anon(), `companies/${company}/requests`)), data);
    const site = (data) => env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'sites/stellar-glass'), data));

    it('takes a valid request from anyone once the owner turns the page on', async () => {
      await assertFails(send(form()));
      await site({ companyId: 'stellar', open: true });
      await assertSucceeds(send(form()));
      await assertSucceeds(send(form({ phone: '', email: 'pat@example.com', contactBy: 'email', timeline: '', files: 0 })));
      await assertSucceeds(addDoc(collection(db('stranger'), 'companies/stellar/requests'), form()));
    });

    it('refuses requests that are off, misdirected or malformed', async () => {
      await site({ companyId: 'stellar', open: false });
      await assertFails(send(form()));
      await site({ companyId: 'stellar', open: true });
      await assertFails(send(form(), 'other'));
      await assertFails(send(form({ site: 'nope' })));
      await assertFails(send(form({ status: 'converted' })));
      await assertFails(send(form({ source: 'import' })));
      await assertFails(send(form({ createdAt: Timestamp.fromMillis(Date.now() - 864e5) })));
      await assertFails(send(form({ name: '' })));
      await assertFails(send(form({ details: 'x'.repeat(4001) })));
      await assertFails(send(form({ name: 'x'.repeat(101) })));
      await assertFails(send(form({ phone: '', email: '' })));
      await assertFails(send(form({ phone: '', email: 'not-an-email' })));
      await assertFails(send(form({ service: 'windows' })));
      await assertFails(send(form({ contactBy: 'fax' })));
      await assertFails(send(form({ files: 9 })));
      await assertFails(send(form({ files: '2' })));
      await assertFails(send(form({ customerId: 'c1' })));
      await assertFails(send(form({ extra: 'x' })));
      const { timeline, ...missing } = form();
      await assertFails(send(missing));
    });

    it('lets only the team see and work requests', async () => {
      await site({ companyId: 'stellar', open: true });
      await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'companies/stellar/requests/r1'), { ...form(), createdAt: Timestamp.now() }));
      const r = (f) => doc(f, 'companies/stellar/requests/r1');
      await assertFails(getDoc(r(anon())));
      await assertFails(getDocs(collection(anon(), 'companies/stellar/requests')));
      await assertFails(updateDoc(r(anon()), { status: 'closed' }));
      await assertFails(deleteDoc(r(anon())));
      await assertFails(getDoc(r(db('bob'))));
      for (const uid of ['wes', 'crew', 'cpa']) await assertSucceeds(getDoc(r(db(uid))));
      await assertSucceeds(getDocs(collection(db('cpa'), 'companies/stellar/requests')));
      // Staff follow up; what the customer wrote stays as sent.
      await assertSucceeds(updateDoc(r(db('crew')), { status: 'contacted', notes: 'Called, measuring Tuesday', updatedAt: serverTimestamp() }));
      await assertSucceeds(updateDoc(r(db('crew')), { status: 'converted', customerId: 'c1', jobId: 'j1', updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(r(db('crew')), { details: 'changed', updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(r(db('crew')), { status: 'won', updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(r(db('crew')), { notes: 'x'.repeat(4001), updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(r(db('cpa')), { status: 'closed', updatedAt: serverTimestamp() }));
      await assertFails(deleteDoc(r(db('crew'))));
      await assertSucceeds(deleteDoc(r(db('admin1'))));
    });

    it('keeps the email status for the server, and lets only the owner say who gets the emails', async () => {
      await site({ companyId: 'stellar', open: true });
      await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'companies/stellar/requests/r2'), {
        ...form(), createdAt: Timestamp.now(), alert: { status: 'sent', to: ['wes@stellarglassllc.com'] },
      }));
      const r = (f) => doc(f, 'companies/stellar/requests/r2');
      await assertSucceeds(updateDoc(r(db('crew')), { status: 'contacted', updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(r(db('crew')), { 'alert.status': 'failed', updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(r(db('wes')), { alert: null, updatedAt: serverTimestamp() }));
      await assertFails(send(form({ alert: { status: 'sent' } })));
      await assertSucceeds(updateDoc(doc(db('wes'), 'companies/stellar'), { requestAlertEmails: ['wes@stellarglassllc.com', 'office@example.com'] }));
      await assertFails(updateDoc(doc(db('admin1'), 'companies/stellar'), { requestAlertEmails: ['admin@example.com'] }));
      await assertFails(updateDoc(doc(db('crew'), 'companies/stellar'), { requestAlertEmails: [] }));
    });

    it('lets only the owner connect the page to their business', async () => {
      const s = (f) => doc(f, 'sites/stellar-glass');
      const on = (companyId, open = true) => ({ companyId, open, updatedAt: serverTimestamp() });
      await assertFails(setDoc(s(anon()), on('stellar')));
      await assertFails(setDoc(s(db('admin1')), on('stellar')));
      await assertFails(setDoc(s(db('stranger')), on('stellar')));
      await assertFails(setDoc(s(db('wes')), { ...on('stellar'), extra: 1 }));
      await assertSucceeds(setDoc(s(db('wes')), on('stellar')));
      await assertSucceeds(getDoc(s(anon())));
      await assertFails(getDocs(collection(anon(), 'sites')));
      // Another business's owner can't take it over; the owner can pause it.
      await assertFails(setDoc(s(db('bob')), on('other')));
      await assertFails(updateDoc(s(db('wes')), { companyId: 'other', updatedAt: serverTimestamp() }));
      await assertSucceeds(updateDoc(s(db('wes')), { open: false, updatedAt: serverTimestamp() }));
      await assertFails(deleteDoc(s(db('bob'))));
      await assertSucceeds(deleteDoc(s(db('wes'))));
    });

    it('shows website photos to everyone and lets the owner or an admin change them', async () => {
      const photo = (over = {}) => ({
        place: 'gallery', caption: 'Bank storefront', url: 'https://firebasestorage.googleapis.com/v0/b/x/o/a?alt=media',
        path: 'companies/stellar/website/p1.jpg', order: 0, updatedAt: serverTimestamp(), ...over,
      });
      const p = (f, id = 'p1') => doc(f, `sites/stellar-glass/photos/${id}`);
      // Not before the page belongs to a business.
      await assertFails(setDoc(p(db('wes')), photo()));
      await site({ companyId: 'stellar', open: true });
      await assertSucceeds(setDoc(p(db('wes')), photo()));
      await assertSucceeds(setDoc(p(db('admin1'), 'hero'), photo({ place: 'hero', path: 'companies/stellar/website/hero-1.jpg' })));
      await assertSucceeds(getDocs(collection(anon(), 'sites/stellar-glass/photos')));
      await assertSucceeds(getDoc(p(anon())));
      for (const uid of ['crew', 'cpa', 'bob', 'stranger']) await assertFails(setDoc(p(db(uid), 'p2'), photo()));
      await assertFails(setDoc(p(anon(), 'p2'), photo()));
      // Shape: known places, slot photos stored under their own name, files from this business only.
      await assertFails(setDoc(p(db('wes'), 'p2'), photo({ place: 'banner' })));
      await assertFails(setDoc(p(db('wes'), 'p2'), photo({ place: 'hero' })));
      await assertFails(setDoc(p(db('wes'), 'p2'), photo({ path: 'companies/other/website/p2.jpg' })));
      await assertFails(setDoc(p(db('wes'), 'p2'), photo({ path: 'companies/stellar/photos/j1/p2.jpg' })));
      await assertFails(setDoc(p(db('wes'), 'p2'), photo({ url: 'javascript:alert(1)' })));
      await assertFails(setDoc(p(db('wes'), 'p2'), photo({ caption: 'x'.repeat(81) })));
      await assertFails(setDoc(p(db('wes'), 'p2'), photo({ order: 1.5 })));
      await assertFails(setDoc(p(db('wes'), 'p2'), photo({ extra: 1 })));
      await assertSucceeds(updateDoc(p(db('admin1')), { caption: 'Lakeland bank', order: 3, updatedAt: serverTimestamp() }));
      await assertFails(deleteDoc(p(db('crew'))));
      await assertFails(deleteDoc(p(anon())));
      await assertSucceeds(deleteDoc(p(db('wes'))));
    });
  });

  describe('suppliers and parts orders', () => {
    const { serverTimestamp, arrayUnion } = require('firebase/firestore');
    const supplier = (over = {}) => ({
      name: 'Trulite Glass & Aluminum Solutions', plugin: 'trulite', branch: 'Plant City', branchAddress: '4106 Rice Road, Plant City, FL 33566',
      branchPhone: '(863) 323-2548', contactName: 'Pat', emails: ['pat@trulite.example'], cc: [], phone: '', account: 'STE-1001',
      website: 'https://www.trulite.com', kind: 'quote', listType: 'parts', delivery: 'site', notes: '', createdAt: serverTimestamp(), createdBy: 'wes', ...over,
    });
    const parts = (by, over = {}) => ({
      number: 1, jobId: 'j1', supplierId: 's1', status: 'draft', kind: 'quote', listType: 'parts',
      items: [{ heading: 'Stock lengths' }, { qty: 5, unit: 'S/L', partNo: 'CG451-1', desc: 'Head/jamb', got: 0 }], attachments: [],
      events: [{ at: '2026-10-11T21:00:00.000Z', status: 'draft', note: 'Started', by: 'Crew' }], createdAt: serverTimestamp(), createdBy: by, ...over,
    });
    const s = (f, id = 's1') => doc(f, `companies/stellar/suppliers/${id}`);
    const pr = (f, id = 'p1') => doc(f, `companies/stellar/partsRequests/${id}`);

    it('lets the owner and admins choose who parts requests are emailed to', async () => {
      await assertSucceeds(setDoc(s(db('wes')), supplier()));
      await assertSucceeds(setDoc(s(db('admin1'), 's2'), supplier({ name: 'C.R. Laurence (CRL)', plugin: 'crl', createdBy: 'admin1' })));
      await assertSucceeds(updateDoc(s(db('admin1')), { emails: ['orders@trulite.example', 'pat@trulite.example'], updatedAt: serverTimestamp() }));
      // Staff and the accountant see suppliers, but can't add one or change where the emails go.
      for (const uid of ['crew', 'cpa']) {
        await assertSucceeds(getDoc(s(db(uid))));
        await assertSucceeds(getDocs(collection(db(uid), 'companies/stellar/suppliers')));
        await assertFails(setDoc(s(db(uid), 's3'), supplier({ createdBy: uid })));
        await assertFails(updateDoc(s(db(uid)), { emails: ['me@example.com'] }));
        await assertFails(deleteDoc(s(db(uid))));
      }
      await assertFails(getDoc(s(db('bob'))));
      await assertFails(setDoc(doc(db('bob'), 'companies/stellar/suppliers/s4'), supplier({ createdBy: 'bob' })));
      // Shape.
      const w = db('wes');
      await assertFails(setDoc(s(w, 'x1'), supplier({ name: '' })));
      await assertFails(setDoc(s(w, 'x2'), supplier({ name: 'x'.repeat(121) })));
      await assertFails(setDoc(s(w, 'x3'), supplier({ emails: ['1@x.co', '2@x.co', '3@x.co', '4@x.co', '5@x.co', '6@x.co'] })));
      await assertFails(setDoc(s(w, 'x4'), supplier({ emails: 'pat@trulite.example' })));
      await assertFails(setDoc(s(w, 'x5'), supplier({ cc: ['1@x.co', '2@x.co', '3@x.co', '4@x.co', '5@x.co', '6@x.co'] })));
      await assertFails(setDoc(s(w, 'x6'), supplier({ account: 'x'.repeat(41) })));
      await assertFails(setDoc(s(w, 'x7'), supplier({ notes: 'x'.repeat(1001) })));
      await assertFails(setDoc(s(w, 'x8'), supplier({ bcc: ['someone@example.com'] })));
      // Nothing hides under a supplier, out of these rules' reach.
      await assertFails(setDoc(doc(w, 'companies/stellar/suppliers/s1/contacts/c1'), { email: 'x@example.com' }));
      await assertFails(deleteDoc(s(db('crew'))));
      await assertSucceeds(deleteDoc(s(db('admin1'))));
    });

    it('lets the team write parts requests, and only the server note how its email went', async () => {
      const crew = db('crew');
      await assertSucceeds(setDoc(pr(crew), parts('crew')));
      await assertSucceeds(updateDoc(pr(crew), {
        status: 'quoted', quoteRef: 'Q-7731', quoteTotal: 1840.5, quotedOn: '2026-10-14', updatedAt: serverTimestamp(),
        events: arrayUnion({ at: '2026-10-14T13:00:00.000Z', status: 'quoted', note: 'Quote #Q-7731', by: 'Crew' }),
      }));
      await assertSucceeds(updateDoc(pr(db('wes')), { status: 'ordered', kind: 'order', orderedOn: '2026-10-15', lastEmail: { what: 'order', via: 'gmail', at: '2026-10-15T12:00:00Z' } }));
      // The accountant can follow orders but not change them.
      await assertSucceeds(getDoc(pr(db('cpa'))));
      await assertSucceeds(getDocs(collection(db('cpa'), 'companies/stellar/partsRequests')));
      await assertFails(setDoc(pr(db('cpa'), 'p2'), parts('cpa')));
      await assertFails(updateDoc(pr(db('cpa')), { status: 'received' }));
      await assertFails(getDoc(pr(db('bob'))));
      // Who started it is who's signed in, and stays put.
      await assertFails(setDoc(pr(crew, 'p3'), parts('wes')));
      await assertFails(updateDoc(pr(crew), { createdBy: 'crew2' }));
      await assertFails(updateDoc(pr(crew), { createdAt: serverTimestamp() }));
      // How the app's email went is the server's to say (functions-parts/parts-request.js).
      await assertFails(setDoc(pr(crew, 'p4'), parts('crew', { appEmail: { status: 'sent', sendId: 'x', to: ['a@b.co'] } })));
      await assertFails(updateDoc(pr(crew), { appEmail: { status: 'sent' } }));
      await assertFails(updateDoc(pr(db('wes')), { 'appEmail.status': 'failed' }));
      await env.withSecurityRulesDisabled((ctx) => updateDoc(pr(ctx.firestore()), { appEmail: { status: 'sent', sendId: 'abc12345' } }));
      await assertSucceeds(updateDoc(pr(crew), { status: 'received', receivedOn: '2026-10-20' }));
      await assertFails(updateDoc(pr(crew), { appEmail: { status: 'sending', sendId: 'abc12345' } }));
      // Shape.
      for (const [i, over] of [
        { status: 'lost' }, { kind: 'rush' }, { listType: 'photos' }, { items: 'CG451-1' },
        { items: Array.from({ length: 201 }, () => ({ qty: 1, desc: 'x' })) }, { attachments: Array.from({ length: 11 }, (_, n) => `f${n}`) },
        { jobId: 'x'.repeat(65) }, { supplierId: 5 },
      ].entries()) await assertFails(setDoc(pr(crew, `bad${i}`), parts('crew', over)));
      const { status, ...noStatus } = parts('crew');
      await assertFails(setDoc(pr(crew, 'bad9'), noStatus));
      // Nothing hides under a request either.
      await assertFails(setDoc(doc(crew, 'companies/stellar/partsRequests/p1/lines/l1'), { qty: 1 }));
      // Staff don't delete requests; the owner and admins do.
      await assertFails(deleteDoc(pr(crew)));
      await assertFails(deleteDoc(pr(db('cpa'))));
      await assertSucceeds(deleteDoc(pr(db('admin1'))));
    });

    it('keeps the app\'s daily email count to the server', async () => {
      for (const uid of ['wes', 'crew', 'bob']) {
        await assertFails(getDoc(doc(db(uid), 'emailUsage/stellar')));
        await assertFails(setDoc(doc(db(uid), 'emailUsage/stellar'), { day: '2026-10-11', count: 0 }));
      }
    });
  });

  it('keeps user profiles private', async () => {
    await assertSucceeds(setDoc(doc(db('wes'), 'users/wes'), { name: 'Wes' }));
    await assertFails(getDoc(doc(db('crew'), 'users/wes')));
  });
});
