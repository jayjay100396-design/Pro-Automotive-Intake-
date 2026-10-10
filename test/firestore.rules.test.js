// Run with: npm test  (starts the Firestore emulator, needs Java)
const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment, assertSucceeds, assertFails,
} = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, writeBatch, Timestamp } = require('firebase/firestore');

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
    const file = (by, category = 'photos') => ({ jobId: 'j1', category, name: 'a.jpg', path: 'p', createdBy: by });
    // Staff add files and can delete only their own; admins delete any.
    await assertSucceeds(setDoc(doc(db('crew'), 'companies/stellar/files/f1'), file('crew')));
    await assertSucceeds(setDoc(doc(db('wes'), 'companies/stellar/files/f2'), file('wes')));
    await assertFails(deleteDoc(doc(db('crew'), 'companies/stellar/files/f2')));
    await assertSucceeds(deleteDoc(doc(db('crew'), 'companies/stellar/files/f1')));
    await assertSucceeds(deleteDoc(doc(db('admin1'), 'companies/stellar/files/f2')));
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

  it('keeps user profiles private', async () => {
    await assertSucceeds(setDoc(doc(db('wes'), 'users/wes'), { name: 'Wes' }));
    await assertFails(getDoc(doc(db('crew'), 'users/wes')));
  });
});
