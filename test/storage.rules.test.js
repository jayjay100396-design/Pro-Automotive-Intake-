const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment, assertSucceeds, assertFails,
} = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');
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
    });
  });
  after(() => env.cleanup());

  it('lets the accountant upload to documents and forms, but not delete', async () => {
    await assertSucceeds(uploadBytes(ref(st('cpa'), 'companies/stellar/documents/notarized.pdf'), bytes, pdf));
    await assertSucceeds(uploadBytes(ref(st('cpa'), 'companies/stellar/forms/g702.pdf'), bytes, pdf));
    await assertSucceeds(getBytes(ref(st('cpa'), 'companies/stellar/documents/notarized.pdf')));
    await assertFails(deleteObject(ref(st('cpa'), 'companies/stellar/documents/notarized.pdf')));
  });

  it('keeps the accountant out of other folders', async () => {
    await assertFails(uploadBytes(ref(st('cpa'), 'companies/stellar/photos/a.pdf'), bytes, pdf));
  });

  it('lets the owner upload and delete anywhere in the company', async () => {
    await assertSucceeds(uploadBytes(ref(st('wes'), 'companies/stellar/photos/a.pdf'), bytes, pdf));
    await assertSucceeds(deleteObject(ref(st('wes'), 'companies/stellar/photos/a.pdf')));
  });

  it('blocks outsiders and bad file types', async () => {
    await assertFails(getBytes(ref(st('stranger'), 'companies/stellar/documents/notarized.pdf')));
    await assertFails(uploadBytes(ref(st('stranger'), 'companies/stellar/documents/x.pdf'), bytes, pdf));
    await assertFails(uploadBytes(ref(st('cpa'), 'companies/stellar/documents/x.exe'), bytes,
      { contentType: 'application/octet-stream' }));
  });
});
