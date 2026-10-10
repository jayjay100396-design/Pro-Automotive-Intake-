const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment, assertSucceeds, assertFails,
} = require('@firebase/rules-unit-testing');
const { doc, setDoc, Timestamp } = require('firebase/firestore');
const { ref, uploadBytes, getBytes, deleteObject } = require('firebase/storage');

let env;
const st = (uid) => env.authenticatedContext(uid).storage();
const pdf = { contentType: 'application/pdf' };
const bytes = new Uint8Array([37, 80, 68, 70]);

describe('Storage rules', function () {
  this.timeout(30000);
  before(async () => {
    env = await initializeTestEnvironment({
      projectId: 'demo-stellar-glass',
      firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8') },
      storage: { rules: fs.readFileSync(path.join(__dirname, '..', 'storage.rules'), 'utf8') },
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      const f = ctx.firestore();
      await setDoc(doc(f, 'companies/stellar'), { name: 'Stellar Glass', ownerUid: 'wes' });
      await setDoc(doc(f, 'companies/stellar/members/wes'), { role: 'owner' });
      await setDoc(doc(f, 'companies/stellar/members/cpa'), { role: 'accountant' });
      await setDoc(doc(f, 'companies/stellar/members/crew'), { role: 'staff' });
      await setDoc(doc(f, 'companies/stellar/members/admin1'), { role: 'admin' });
    });
  });
  after(() => env.cleanup());

  it('lets the accountant upload to documents and forms, but not delete', async () => {
    await assertSucceeds(uploadBytes(ref(st('cpa'), 'companies/stellar/documents/notarized.pdf'), bytes, pdf));
    await assertSucceeds(uploadBytes(ref(st('cpa'), 'companies/stellar/forms/g702.pdf'), bytes, pdf));
    await assertSucceeds(getBytes(ref(st('cpa'), 'companies/stellar/documents/notarized.pdf')));
    await assertFails(deleteObject(ref(st('cpa'), 'companies/stellar/documents/notarized.pdf')));
    await assertFails(uploadBytes(ref(st('cpa'), 'companies/stellar/documents/notarized.pdf'), bytes, pdf));
  });

  it('keeps the accountant out of other folders', async () => {
    await assertFails(uploadBytes(ref(st('cpa'), 'companies/stellar/photos/a.pdf'), bytes, pdf));
  });

  it('lets the owner upload and delete anywhere in the company', async () => {
    await assertSucceeds(uploadBytes(ref(st('wes'), 'companies/stellar/photos/a.pdf'), bytes, pdf));
    await assertSucceeds(deleteObject(ref(st('wes'), 'companies/stellar/photos/a.pdf')));
  });

  it('lets staff delete or replace only what they uploaded', async () => {
    const mine = { contentType: 'image/jpeg', customMetadata: { uploadedBy: 'crew' } };
    await assertSucceeds(uploadBytes(ref(st('crew'), 'companies/stellar/photos/j1/f1/a.jpg'), bytes, mine));
    await assertSucceeds(uploadBytes(ref(st('wes'), 'companies/stellar/photos/j1/f2/b.jpg'), bytes, { contentType: 'image/jpeg', customMetadata: { uploadedBy: 'wes' } }));
    await assertFails(uploadBytes(ref(st('crew'), 'companies/stellar/photos/j1/f2/b.jpg'), bytes, mine));
    await assertFails(deleteObject(ref(st('crew'), 'companies/stellar/photos/j1/f2/b.jpg')));
    await assertSucceeds(deleteObject(ref(st('crew'), 'companies/stellar/photos/j1/f1/a.jpg')));
    await assertSucceeds(deleteObject(ref(st('admin1'), 'companies/stellar/photos/j1/f2/b.jpg')));
  });

  it('takes photos, videos, PDFs, Office files and saved emails, within size limits', async () => {
    const up = (name, contentType, size = 4) => uploadBytes(ref(st('crew'), `companies/stellar/plans/j1/f/${name}`), new Uint8Array(size), { contentType });
    for (const [name, type] of [['a.heic', 'image/heic'], ['b.mov', 'video/quicktime'], ['c.pdf', 'application/pdf'],
      ['d.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['e.xls', 'application/vnd.ms-excel'],
      ['f.csv', 'text/csv'], ['g.eml', 'message/rfc822'], ['h.dwg', 'image/vnd.dwg']]) {
      await assertSucceeds(up(name, type));
    }
    await assertFails(up('x.html', 'text/html'));
    await assertFails(up('x.zip', 'application/zip'));
    await assertFails(up('big.pdf', 'application/pdf', 25 * 1024 * 1024));
    await assertSucceeds(up('clip.mp4', 'video/mp4', 30 * 1024 * 1024));
  });

  it('takes photos and plans for a fresh quote request from anyone, within limits', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const f = ctx.firestore();
      await setDoc(doc(f, 'companies/stellar/requests/r1'), { files: 2, createdAt: Timestamp.now() });
      await setDoc(doc(f, 'companies/stellar/requests/old'), { files: 2, createdAt: Timestamp.fromMillis(Date.now() - 2 * 3600e3) });
    });
    const anon = env.unauthenticatedContext().storage();
    const up = (path, contentType = 'image/jpeg', size = 4, s = anon) => uploadBytes(ref(s, `companies/stellar/requests/${path}`), new Uint8Array(size), { contentType });
    await assertSucceeds(up('r1/0-kitchen.jpg'));
    await assertSucceeds(up('r1/1-plans.pdf', 'application/pdf'));
    // Never more than the request said, never over an existing file, never something that isn't a photo or PDF.
    await assertFails(up('r1/2-extra.jpg'));
    await assertFails(up('r1/0-kitchen.jpg'));
    await assertFails(up('r1/x-name.jpg'));
    await assertFails(up('r1/1-page.html', 'text/html'));
    await assertFails(up('r1/1-big.jpg', 'image/jpeg', 20 * 1024 * 1024));
    await assertFails(up('r1/sub/0-a.jpg'));
    // Not for a request that doesn't exist or is more than an hour old.
    await assertFails(up('nope/0-a.jpg'));
    await assertFails(up('old/0-a.jpg'));
    // Only the team can see them.
    await assertFails(getBytes(ref(anon, 'companies/stellar/requests/r1/0-kitchen.jpg')));
    await assertFails(getBytes(ref(st('stranger'), 'companies/stellar/requests/r1/0-kitchen.jpg')));
    await assertSucceeds(getBytes(ref(st('cpa'), 'companies/stellar/requests/r1/0-kitchen.jpg')));
    await assertFails(deleteObject(ref(anon, 'companies/stellar/requests/r1/0-kitchen.jpg')));
    await assertFails(deleteObject(ref(st('crew'), 'companies/stellar/requests/r1/0-kitchen.jpg')));
    await assertSucceeds(deleteObject(ref(st('wes'), 'companies/stellar/requests/r1/0-kitchen.jpg')));
  });

  it('lets owners and admins put photos on the website, which anyone can see', async () => {
    const anon = env.unauthenticatedContext().storage();
    const jpg = { contentType: 'image/jpeg' };
    const w = (s, name, meta = jpg, size = 4) => uploadBytes(ref(s, `companies/stellar/website/${name}`), new Uint8Array(size), meta);
    await assertSucceeds(w(st('wes'), 'hero-1.jpg'));
    await assertSucceeds(w(st('admin1'), 'g_2.webp', { contentType: 'image/webp' }));
    await assertSucceeds(getBytes(ref(anon, 'companies/stellar/website/hero-1.jpg')));
    await assertFails(w(anon, 'x.jpg'));
    await assertFails(w(st('cpa'), 'x.jpg'));
    await assertFails(w(st('crew'), 'x.jpg'));
    await assertFails(w(st('stranger'), 'x.jpg'));
    await assertFails(w(st('wes'), 'x.pdf', pdf));
    await assertFails(w(st('wes'), 'page.html', { contentType: 'text/html' }));
    await assertFails(w(st('wes'), 'big.jpg', jpg, 15 * 1024 * 1024));
    await assertFails(deleteObject(ref(anon, 'companies/stellar/website/hero-1.jpg')));
    await assertSucceeds(deleteObject(ref(st('admin1'), 'companies/stellar/website/hero-1.jpg')));
    // Other company files stay private.
    await assertFails(getBytes(ref(anon, 'companies/stellar/documents/notarized.pdf')));
  });

  it('blocks outsiders and bad file types', async () => {
    await assertFails(getBytes(ref(st('stranger'), 'companies/stellar/documents/notarized.pdf')));
    await assertFails(uploadBytes(ref(st('stranger'), 'companies/stellar/documents/x.pdf'), bytes, pdf));
    await assertFails(uploadBytes(ref(st('cpa'), 'companies/stellar/documents/x.exe'), bytes,
      { contentType: 'application/octet-stream' }));
  });
});
