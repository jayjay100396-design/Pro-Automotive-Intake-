// Parts lists, sizes, order tracking and the supplier emails (public/js/parts-email.js). Needs nothing running.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as P from '../public/js/parts-email.js';
import { PLUGINS, pluginFor } from '../public/js/supplier-plugins.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// Wes's own Trulite quote request for the Anchuca job (November 2025), as he typed it.
const ANCHUCA = `Metal CG451 #04 Clear Anodized 1" infill.

ED450-2 End Dam. 2pkg.
FAS 14-2. Assembly screw. 10PKG.
RSB-3     Setting block.     2pkg.
WD451-1. Water deflector. 2 pkg

RG-1 Glazing Gasket 15 rolls.

Stock lengths.

5 S/L CG451-1 HEAD/JAMB/VERT MULL.
22 S/L CG451-11 WALL JAMB/HEAD DP POCKET
13 S/L CG451-3 GLASS STOP.
7 S/L CG451-36 INTERMEDIATE HOR.
7 S/L CG451-39 HIGH PERFORMANCE SUBSILL.
7 S/L CG451-4 SILL/HEAD
8 S/L CG451-5 VERTICAL FILLER

1-3/4" X 4-1/2"N #04 CLEAR ANODIZED 1/4" INFILL.
RSB-1 Set block 1pkg
ED 450-1 End Dam 1pkg.

9 S/L CG450-11 WALL JAMB/ HEAD DP POCKET
3 S/L CG450-3 GLASS STOP
3 S/L CG450-4 SILL/HEAD
3 S/L CG 450-28 hIGH PERFORMANCE SILL FLASHING.`;

const company = { name: 'Stellar Glass LLC', address: '2850 Mine and Mill Road, Suite 4, Lakeland FL 33801', phone: '(863) 255-5731', email: 'wes@stellarglassllc.com' };
const supplier = { name: 'Trulite Glass & Aluminum Solutions', contactName: 'Pat Rep', emails: ['pat@trulite.example'], cc: [], account: 'STE-1001', branch: 'Plant City', plugin: 'trulite' };
const job = { name: 'Shell Warehouse', siteAddress: '3955 Anchuca Dr, Lakeland FL' };
const short = (it) => ('heading' in it ? { heading: it.heading } : { qty: it.qty, unit: it.unit, partNo: it.partNo, desc: it.desc });

describe('Parts requests: sizes', () => {
  it('reads inches the way a glazier writes them', () => {
    const cases = [['35 7/8', 35.875], ['35-7/8', 35.875], ['35.875', 35.875], ['7/8', 0.875], ['36"', 36], ['36 in', 36], ['3\' 4-1/2"', 40.5],
      ['4\'', 48], ['83 3/4"', 83.75], [48, 48], ['', null], ['abc', null], ['-5', null], ['1/0', null], [null, null], ['12 1/2 x', null]];
    for (const [v, want] of cases) assert.equal(P.parseInches(v), want, `parseInches(${JSON.stringify(v)})`);
  });

  it('writes sizes in sixteenths, Wes\'s way', () => {
    assert.equal(P.fmtInches(35.875), '35-7/8');
    assert.equal(P.fmtInches('83 3/4'), '83-3/4');
    assert.equal(P.fmtInches(36), '36');
    assert.equal(P.fmtInches(0.5), '1/2');
    assert.equal(P.fmtInches(24.0625), '24-1/16');
    assert.equal(P.fmtInches(35.97), '36', 'rounds to the nearest 1/16');
    assert.equal(P.fmtInches(''), '');
  });
});

describe('Parts requests: the list', () => {
  it('turns Wes\'s typed Trulite list into part numbers, quantities and headings', () => {
    const items = P.parsePasted(ANCHUCA, 'parts').map(short);
    assert.deepEqual(items, [
      { heading: 'Metal CG451 #04 Clear Anodized 1" infill' },
      { qty: 2, unit: 'pkg', partNo: 'ED450-2', desc: 'End Dam' },
      { qty: 10, unit: 'pkg', partNo: 'FAS 14-2', desc: 'Assembly screw' },
      { qty: 2, unit: 'pkg', partNo: 'RSB-3', desc: 'Setting block' },
      { qty: 2, unit: 'pkg', partNo: 'WD451-1', desc: 'Water deflector' },
      { qty: 15, unit: 'roll', partNo: 'RG-1', desc: 'Glazing Gasket' },
      { heading: 'Stock lengths' },
      { qty: 5, unit: 'S/L', partNo: 'CG451-1', desc: 'HEAD/JAMB/VERT MULL' },
      { qty: 22, unit: 'S/L', partNo: 'CG451-11', desc: 'WALL JAMB/HEAD DP POCKET' },
      { qty: 13, unit: 'S/L', partNo: 'CG451-3', desc: 'GLASS STOP' },
      { qty: 7, unit: 'S/L', partNo: 'CG451-36', desc: 'INTERMEDIATE HOR' },
      { qty: 7, unit: 'S/L', partNo: 'CG451-39', desc: 'HIGH PERFORMANCE SUBSILL' },
      { qty: 7, unit: 'S/L', partNo: 'CG451-4', desc: 'SILL/HEAD' },
      { qty: 8, unit: 'S/L', partNo: 'CG451-5', desc: 'VERTICAL FILLER' },
      { heading: '1-3/4" X 4-1/2"N #04 CLEAR ANODIZED 1/4" INFILL' },
      { qty: 1, unit: 'pkg', partNo: 'RSB-1', desc: 'Set block' },
      { qty: 1, unit: 'pkg', partNo: 'ED 450-1', desc: 'End Dam' },
      { qty: 9, unit: 'S/L', partNo: 'CG450-11', desc: 'WALL JAMB/ HEAD DP POCKET' },
      { qty: 3, unit: 'S/L', partNo: 'CG450-3', desc: 'GLASS STOP' },
      { qty: 3, unit: 'S/L', partNo: 'CG450-4', desc: 'SILL/HEAD' },
      { qty: 3, unit: 'S/L', partNo: 'CG 450-28', desc: 'hIGH PERFORMANCE SILL FLASHING' },
    ]);
  });

  it('reads glass sizes typed or pasted from a takeoff', () => {
    const got = P.parsePasted('4 @ 35 7/8 x 83 3/4 1/4" clear tempered\n(2) 24 x 36 GL2\n2 pcs 24-1/2" x 36-3/4"\n1 x 48 x 96 1" IG\nLobby', 'glass');
    assert.deepEqual(got.map((it) => ('heading' in it ? it : [it.qty, it.width, it.height, it.desc])), [
      [4, 35.875, 83.75, '1/4" clear tempered'], [2, 24, 36, 'GL2'], [2, 24.5, 36.75, ''], [1, 48, 96, '1" IG'], { heading: 'Lobby' },
    ]);
  });

  it('reads a list pasted from a spreadsheet, skipping its heading row', () => {
    const got = P.parsePasted('Qty\tUnit\tPart #\tDescription\n5\tS/L\tCG451-1\tHead\nFraming\t\t\t\n2\tpackages\tED450-2\tEnd dam', 'parts');
    assert.deepEqual(got.map(short), [
      { qty: 5, unit: 'S/L', partNo: 'CG451-1', desc: 'Head' }, { heading: 'Framing' }, { qty: 2, unit: 'pkg', partNo: 'ED450-2', desc: 'End dam' },
    ]);
  });

  it('knows a quantity from a size or a heading', () => {
    const got = P.parsePasted('5 Door closers\n2 1/4" glass stop\n(3) Panic devices\n- 2 pkg ED450-2 End Dam', 'parts');
    assert.deepEqual(got.map(short), [
      { qty: 5, unit: 'ea', partNo: '', desc: 'Door closers' }, { heading: '2 1/4" glass stop' },
      { qty: 3, unit: 'ea', partNo: '', desc: 'Panic devices' }, { qty: 2, unit: 'pkg', partNo: 'ED450-2', desc: 'End Dam' },
    ]);
  });

  it('brings a proposal\'s materials over without labor or prices', () => {
    const est = {
      lines: [
        { desc: '1" insulated clear tempered glass', kind: 'Glass', unit: 'sqft', qty: 3, widthIn: 48, heightIn: 96, price: 28 },
        { desc: '4-1/2" storefront framing', kind: 'Framing', unit: 'lf', qty: 40, price: 32 },
        { desc: 'Medium stile door', kind: 'Door', unit: 'each', qty: 1, price: 2400 },
        { desc: 'Caulking', kind: 'Materials', unit: 'lot', qty: 1, price: 150 },
        { desc: 'Installation labor', kind: 'Labor', unit: 'hour', qty: 16, price: 75 },
        { desc: '', kind: 'Glass', unit: 'each', qty: 1 },
      ],
    };
    const parts = P.itemsFromEstimate(est, 'parts');
    assert.deepEqual(parts.map((it) => [it.qty, it.unit, it.desc, it.width, it.height]), [
      [3, 'pcs', '1" insulated clear tempered glass', 48, 96], [40, 'lf', '4-1/2" storefront framing', null, null],
      [1, 'ea', 'Medium stile door', null, null], [1, 'lot', 'Caulking', null, null],
    ]);
    assert.ok(parts.every((it) => !('price' in it)));
    assert.deepEqual(P.itemsFromEstimate(est, 'glass').map((it) => [it.qty, it.width, it.height, it.desc]), [[3, 48, 96, '1" insulated clear tempered glass']]);
    assert.deepEqual(P.itemsFromEstimate({}, 'parts'), []);
  });

  it('says what stops a request from going out', () => {
    assert.deepEqual(P.requestProblems({ items: [] }), ['Add at least one line to the parts list.']);
    assert.deepEqual(P.requestProblems({ items: [{ heading: 'Stock lengths' }] }), ['Add at least one line to the parts list.']);
    assert.deepEqual(P.requestProblems({ items: [{ qty: 0, desc: 'Door' }, { qty: 1, desc: '' }] }), ['Line 1 needs a quantity.'], 'a blank row is skipped');
    assert.deepEqual(P.requestProblems({ listType: 'glass', items: [{ qty: 2, desc: '1/4" clear', width: '24' }] }), ['Line 1 needs a width and a height.']);
    assert.deepEqual(P.requestProblems({ listType: 'glass', items: [{ qty: 2, width: '24', height: 'tall' }] }), ['Line 1 height "tall" isn\'t a size in inches.']);
    assert.deepEqual(P.requestProblems({ listType: 'parts', items: [{ qty: 5, unit: 'S/L', partNo: 'CG451-1' }] }), []);
  });

  it('keeps every field when the list type changes, and drops empty rows', () => {
    const items = P.cleanItems([{ qty: '2', unit: 'ea', partNo: 'X1', desc: ' Door  closer ', width: '36', height: '', edge: '', mark: 'D1', got: '1' }, { qty: 1 }, { heading: '  ' }, null, 'junk']);
    assert.deepEqual(items, [{ qty: 2, unit: 'ea', partNo: 'X1', desc: 'Door closer', width: 36, height: null, edge: '', mark: 'D1', got: 1 }]);
    assert.equal(P.cleanItems(Array.from({ length: 250 }, () => ({ qty: 1, desc: 'x' }))).length, P.MAX_ITEMS);
  });
});

describe('Parts requests: where an order stands', () => {
  const today = '2026-10-20';

  it('goes through quote, order, delivery and receiving', () => {
    assert.deepEqual(P.stagesFor({ kind: 'quote' }), ['sent', 'quoted', 'ordered', 'confirmed', 'shipped', 'received']);
    assert.deepEqual(P.stagesFor({ kind: 'order', status: 'ordered' }), ['ordered', 'confirmed', 'shipped', 'received'], 'ordered straight away');
    assert.equal(P.stagesFor({ kind: 'order', status: 'ordered', requestedOn: '2026-10-01' }).length, 6, 'ordered after a quote');
    assert.equal(P.stageOf('partial'), 'received');
    assert.ok(P.isOpen({ status: 'partial' }) && !P.isOpen({ status: 'draft' }) && !P.isOpen({ status: 'received' }) && !P.isOpen({ status: 'cancelled' }));
  });

  it('flags late orders and dates that miss the need date', () => {
    assert.equal(P.isLate({ status: 'confirmed', expectedOn: '2026-10-19' }, today), true);
    assert.equal(P.isLate({ status: 'confirmed', expectedOn: '2026-10-20' }, today), false, 'due today is not late yet');
    assert.equal(P.isLate({ status: 'received', expectedOn: '2026-10-01' }, today), false);
    const note = (r) => P.trackingNote(r, today);
    assert.deepEqual(note({ status: 'confirmed', expectedOn: '2026-10-19' }), { text: 'Late: expected Oct 19', level: 'late' });
    assert.deepEqual(note({ status: 'confirmed', expectedOn: '2026-10-28', neededBy: '2026-10-25' }), { text: 'Expected Oct 28, after the Oct 25 need date', level: 'warn' });
    assert.deepEqual(note({ status: 'shipped', expectedOn: '2026-10-22' }), { text: 'Expected Oct 22', level: '' });
    assert.deepEqual(note({ status: 'sent', requestedOn: '2026-10-16' }), { text: 'Waiting 4 days for the quote', level: 'warn' });
    assert.deepEqual(note({ status: 'sent', requestedOn: '2026-10-19' }), { text: 'Waiting 1 day for the quote', level: '' });
    assert.deepEqual(note({ status: 'quoted', quotedOn: '2026-10-18' }), { text: 'Quote in Oct 18, not ordered yet', level: '' });
    assert.deepEqual(note({ status: 'ordered' }), { text: 'No delivery date yet', level: '' });
    assert.deepEqual(note({ status: 'partial' }), { text: 'Some parts still to come', level: 'warn' });
    assert.deepEqual(note({ status: 'received', receivedOn: '2026-10-21' }), { text: 'All in Oct 21', level: '' });
    assert.deepEqual(note({ status: 'draft' }), { text: 'Not sent yet', level: '' });
  });

  it('tracks what has come in', () => {
    const items = [{ heading: 'Stock lengths' }, { qty: 5, unit: 'S/L', partNo: 'CG451-1', got: 5 }, { heading: 'Doors' }, { qty: 2, unit: 'ea', desc: 'Door', got: 1 }];
    assert.equal(P.receivedState(items), 'some');
    assert.equal(P.receivedState(items.map((it) => ('qty' in it ? { ...it, got: it.qty } : it))), 'all');
    assert.equal(P.receivedState(items.map((it) => ('qty' in it ? { ...it, got: 0 } : it))), 'none');
    assert.deepEqual(P.outstanding(items).map((it) => ('heading' in it ? it.heading : [it.qty, it.desc])), ['Doors', [1, 'Door']], 'only what\'s still to come, under its heading');
  });
});

describe('Parts requests: the email', () => {
  const request = {
    kind: 'quote', listType: 'parts', items: P.parsePasted(ANCHUCA, 'parts'), po: '4512', neededBy: '2026-11-14', delivery: 'site',
    deliverTo: job.siteAddress, notes: 'Can you quote the doors separately?\nWe need those first.', signature: 'Wes Stel\nStellar Glass LLC\n(863) 255-5731',
  };

  it('reads like Wes\'s own quote requests, with the job and account', () => {
    const m = P.buildPartsEmail({ request, supplier, job, company, attachments: ['Door order form.pdf'] });
    assert.equal(m.subject, 'Quote request: Shell Warehouse, PO 4512 (Stellar Glass)');
    for (const s of ['Hi Pat,', 'Kindly quote the following for us.', 'Job: Shell Warehouse', 'Job site: 3955 Anchuca Dr, Lakeland FL', 'PO #: 4512',
      'Account #: STE-1001', 'Needed by: Sat, Nov 14, 2026', 'Delivery: Deliver to the job site: 3955 Anchuca Dr, Lakeland FL',
      '\nStock lengths\n5 S/L – CG451-1 – HEAD/JAMB/VERT MULL\n', '15 rolls – RG-1 – Glazing Gasket', 'Can you quote the doors separately?\nWe need those first.',
      'Attached: Door order form.pdf', 'Please send pricing and lead time.', 'Thank you,\nWes Stel\nStellar Glass LLC\n(863) 255-5731']) {
      assert.ok(m.text.includes(s), `text has ${JSON.stringify(s)}`);
    }
    assert.ok(!/\$|price: /i.test(m.text.replace('Please send pricing', '')), 'no prices');
    for (const s of ['<th', 'CG451-11', 'WALL JAMB/HEAD DP POCKET', 'Account #', 'STE-1001', 'Can you quote the doors separately?<br>We need those first.']) {
      assert.ok(m.html.includes(s), `html has ${s}`);
    }
  });

  it('places the order a supplier quoted, and asks for updates', () => {
    const quoted = { ...request, status: 'quoted', quoteRef: '#Q-7731', requestedOn: '2026-10-01' };
    const order = P.buildPartsEmail({ request: quoted, supplier, job, company }, 'order');
    assert.equal(order.subject, 'Order: Shell Warehouse, PO 4512 (Stellar Glass)');
    assert.ok(order.text.includes('Please enter the following order per your quote #Q-7731.'));
    assert.ok(order.text.includes('Please confirm the order, pricing and delivery date.'));
    assert.ok(order.text.includes('5 S/L – CG451-1'));
    assert.ok(!order.text.includes('Can you quote the doors separately?'), 'the quote request\'s notes stay with the request');
    const noted = P.buildPartsEmail({ request: quoted, supplier, job, company, note: 'Deliver before 10 AM.\nCall Mike at the site.' }, 'order');
    assert.ok(noted.text.includes('Deliver before 10 AM.\nCall Mike at the site.'));
    assert.ok(noted.html.includes('Deliver before 10 AM.<br>Call Mike at the site.'));
    assert.ok(!P.buildPartsEmail({ request, supplier, job, company, note: 'Only for orders' }).text.includes('Only for orders'), 'the request itself uses its own notes');

    const waiting = P.buildPartsEmail({ request: { ...request, status: 'sent', requestedOn: '2026-10-01' }, supplier, job, company }, 'followup');
    assert.equal(waiting.subject, 'Checking on our quote request: Shell Warehouse, PO 4512 (Stellar Glass)');
    assert.ok(waiting.text.startsWith('Hi Pat,\n\nChecking on our quote request for Shell Warehouse (PO 4512), sent Thu, Oct 1, 2026.\n\nCan you send pricing and lead time when you have it?'));
    assert.ok(!waiting.text.includes('Kindly quote'), 'not the whole request again');

    const items = [{ qty: 5, unit: 'S/L', partNo: 'CG451-1', desc: 'Head', got: 5 }, { qty: 2, unit: 'ea', partNo: 'MS-300', desc: 'Door', got: 0 }];
    const partial = P.buildPartsEmail({ request: { ...request, items, status: 'partial', kind: 'order', orderRef: 'SO-88', orderedOn: '2026-10-05' }, supplier, job, company }, 'followup');
    assert.equal(partial.subject, 'Checking on our order: Shell Warehouse, PO 4512 (Stellar Glass)');
    assert.ok(partial.text.includes('Checking on our order for Shell Warehouse (PO 4512, your order #SO-88), ordered Mon, Oct 5, 2026. We got part of it. We need it by Sat, Nov 14, 2026.'));
    assert.ok(partial.text.includes('Still to come:\n2 ea – MS-300 – Door\n'));
    assert.ok(!partial.text.includes('CG451-1'), 'leaves out what came in');
    const dated = P.buildPartsEmail({ request: { ...request, status: 'confirmed', kind: 'order', orderedOn: '2026-10-05', expectedOn: '2026-10-19' }, supplier, job, company }, 'followup');
    assert.ok(dated.text.includes('The last date we had was Mon, Oct 19, 2026.') && dated.text.includes('Is it still on track?'));
  });

  it('writes glass sizes out in full', () => {
    const glass = P.buildPartsEmail({ request: { listType: 'glass', items: [{ qty: 4, width: 35.875, height: '83 3/4', desc: '1/4" clear tempered', edge: 'polished, 2 holes', mark: 'GL2' }] }, supplier: {}, job, company });
    assert.ok(glass.text.includes('Hello,'), 'no rep name, no first name');
    assert.ok(glass.text.includes('4 pcs @ 35-7/8" x 83-3/4" – 1/4" clear tempered – polished, 2 holes – mark GL2'));
    assert.ok(glass.html.includes('35-7/8&quot; x 83-3/4&quot;'));
  });

  it('escapes what anyone typed, and keeps the subject to one line', () => {
    const evil = '<img src=x onerror=alert(1)> & "q"';
    const m = P.buildPartsEmail({
      request: { items: [{ qty: 1, desc: evil, partNo: '<b>' }], notes: evil, subject: 'Order\r\nBcc: victim@example.com', intro: '<script>x</script>', signature: evil },
      supplier: { contactName: '<i>Pat</i>', account: evil }, job: { name: evil }, company,
    });
    assert.ok(!/<img|<script|<b>|<i>/.test(m.html));
    assert.ok(m.html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;'));
    assert.equal(m.subject, 'Order Bcc: victim@example.com');
    assert.ok(!/[\r\n]/.test(m.subject));
    assert.ok(!/[\r\n]/.test(P.defaultSubject({ request: { po: 'A\nB' }, job: { name: 'X\r\nY' }, company })));
  });

  it('goes only to the supplier\'s saved addresses, with copies as asked', () => {
    const s = { emails: ['pat@trulite.example', 'PAT@trulite.example', 'not an email'], cc: ['desk@trulite.example', 'pat@trulite.example'] };
    assert.deepEqual(P.recipients({ request: {}, supplier: s, company, senderEmail: 'wes@stellarglassllc.com' }),
      { to: ['pat@trulite.example'], cc: ['desk@trulite.example', 'wes@stellarglassllc.com'] });
    assert.deepEqual(P.recipients({ request: { ccMe: false, ccOffice: true }, supplier: s, company, senderEmail: 'crew@example.com' }),
      { to: ['pat@trulite.example'], cc: ['desk@trulite.example', 'wes@stellarglassllc.com'] });
    assert.deepEqual(P.recipients({ request: {}, supplier: {}, company }), { to: [], cc: [] });
    assert.equal(P.emailList(['1@x.co', '2@x.co', '3@x.co', '4@x.co', '5@x.co', '6@x.co']).length, 5);
  });

  it('fills in Gmail and the email app', () => {
    const m = { to: ['pat@trulite.example', 'bad@x.com?bcc=y@z.com'], cc: ['wes@stellarglassllc.com'], subject: 'Quote request: Shell & Co', text: 'Hi Pat,\n\n5 S/L – CG451-1' };
    const g = P.gmailLink({ ...m, account: 'wes@stellarglassllc.com' });
    assert.ok(g.startsWith('https://mail.google.com/mail/?view=cm&fs=1&to=pat%40trulite.example&cc=wes%40stellarglassllc.com&su=Quote%20request%3A%20Shell%20%26%20Co&body=Hi%20Pat%2C%0A%0A5%20S%2FL%20%E2%80%93%20CG451-1'));
    assert.ok(g.endsWith('&authuser=wes%40stellarglassllc.com'));
    assert.ok(!g.includes('bcc'), 'an address that would add to the link is left out');
    const mail = P.mailtoLink(m);
    assert.ok(mail.startsWith('mailto:pat@trulite.example?cc=wes@stellarglassllc.com&subject=Quote%20request%3A%20Shell%20%26%20Co&body=Hi%20Pat%2C%0D%0A%0D%0A5'));
    assert.equal(P.fromName('Wes Stel', company), 'Wes Stel at Stellar Glass');
    assert.equal(P.fromName('', company), 'Stellar Glass');
  });
});

describe('Supplier plugins', () => {
  it('each fills in what a supplier needs', () => {
    const ids = new Set();
    for (const p of PLUGINS) {
      assert.ok(p.id && !ids.has(p.id), `unique id ${p.id}`);
      ids.add(p.id);
      assert.ok(p.name && p.short && p.what, p.id);
      assert.ok(P.COLUMNS[p.listType], `${p.id} list type`);
      assert.ok(['quote', 'order'].includes(p.kind));
      assert.ok(P.DELIVERY.some(([k]) => k === p.delivery));
      for (const b of p.branches) assert.ok(b.city && b.label && /, FL 3\d{4}(-\d{4})?$/.test(b.address) && /^\(\d{3}\) \d{3}-\d{4}$/.test(b.phone), `${p.id} ${b.label}`);
      for (const c of p.common) assert.ok(c.desc || c.partNo);
    }
    assert.equal(pluginFor('nope').id, 'other');
    assert.equal(pluginFor('trulite').branches[0].city, 'Plant City');
  });
});

describe('The server\'s copy of the email code', () => {
  it('matches the app\'s (npm run sync:email copies it)', () => {
    assert.equal(fs.readFileSync(here('../functions-alerts/parts-email.js'), 'utf8'), fs.readFileSync(here('../public/js/parts-email.js'), 'utf8'));
  });
});
