import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { proposalContent, proposalPdf, proposalEmail, pdfName, dayText, DEFAULT_INTRO } from '../public/js/proposal-doc.js';

// pdfmake as the app uses it, with the Roboto it carries; in Node it reads the fonts from its folder and nothing else.
const require = createRequire(import.meta.url);
const pdfmake = require('pdfmake');
const font = (name) => require.resolve(`pdfmake/build/fonts/Roboto/Roboto-${name}.ttf`);
pdfmake.setFonts({ Roboto: { normal: font('Regular'), bold: font('Medium'), italics: font('Italic'), bolditalics: font('MediumItalic') } });
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => path.startsWith(dirname(font('Regular'))));
const logo = `data:image/png;base64,${readFileSync(new URL('../public/img/logo.png', import.meta.url)).toString('base64')}`;

// The PDF's pages, each as its text.
async function pdfText(dd) {
  const bytes = await pdfmake.createPdf(dd).getBuffer();
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.map((i) => i.str).join(' ').replace(/\s+/g, ' '));
  }
  return { pages, bytes };
}

const company = {
  name: 'Stellar Glass LLC', address: '2850 Mine and Mill Road, Suite 4, Lakeland, FL 33801', phone: '(863) 255-5731', cell: '(586) 292-1732',
  email: 'wes@stellarglassllc.com', website: 'www.stellarglassllc.com', contactName: 'Wesley Stel', contactTitle: 'President',
};
const customer = { name: 'Will Yancey', company: 'Marcobay Construction', email: 'will@marcobay.example' };
const job = { name: 'LCP Bldg 300', siteAddress: '3600 Lakeland Park Dr, Lakeland, FL' };
const estimate = {
  number: 1001, date: '2026-10-09', validUntil: '2026-11-08', projectTitle: 'Lakeland Central Park Bldg 300 - Revised', attn: '',
  intro: DEFAULT_INTRO, scope: '(4) F2; (8) F3; (10) F4; (8) F5; (38) F8',
  lines: [
    { desc: 'Storefront glass', unit: 'sqft', qty: 2, widthIn: 48, heightIn: 96, minSqft: 3, price: 50 },
    { desc: 'Door hardware', unit: 'each', qty: 1, price: 400, taxable: false },
  ],
  markupPct: 10, minCharge: 250, taxPct: 7, showLines: false,
  options: [
    { fromLines: false, name: 'Akela', price: 48250, specs: 'Aluminum Framing- Clear anodized; non-thermal\n  Glass: 1" Clear Low E Tempered Insulated' },
    { fromLines: false, name: 'Kawneer', price: 51900, specs: 'Kawneer 451T' },
  ],
  acceptedOption: 0,
  priceNote: '*Prices subject to change due to volatility of pricing in the marketplace.', exclusions: 'Cleaning; Protection; brake metal flashing.',
  depositType: 'percent', depositValue: 50, terms: 'Balance due on completion.',
  preparedName: 'Wes Stel', preparedTitle: 'President', preparedPhone: '(586) 292-1732', preparedEmail: 'wes@stellarglassllc.com',
};

describe('proposal: what it says', () => {
  it('is to the customer, from the business, with its prices and terms', () => {
    const p = proposalContent({ estimate, company, job, customer });
    assert.equal(p.number, 1001);
    assert.deepEqual(p.company.address, ['2850 Mine and Mill Road, Suite 4', 'Lakeland, FL 33801']);
    assert.equal(p.company.phones, 'Office (863) 255-5731 · Cell (586) 292-1732');
    assert.equal(p.to, 'Marcobay Construction');
    // With a company, the Attn is the customer's own name unless one is typed; the email greets them.
    assert.equal(p.attn, 'Will Yancey');
    assert.equal(p.contact, 'Will Yancey');
    assert.equal(p.project, 'Lakeland Central Park Bldg 300 - Revised');
    assert.equal(p.site, job.siteAddress);
    assert.deepEqual(p.options.map((o) => [o.number, o.name, o.price]), [[1, 'Akela', 48250], [2, 'Kawneer', 51900]]);
    assert.deepEqual(p.options[0].specs, [
      { text: 'Aluminum Framing- Clear anodized; non-thermal', indent: false },
      { text: 'Glass: 1" Clear Low E Tempered Insulated', indent: true },
    ]);
    assert.equal(p.star, '*');
    assert.equal(p.lines, null);
    assert.equal(p.terms, 'A 50% deposit is required before materials can be ordered (Price 1 (Akela): $24,125.00; Price 2 (Kawneer): $25,950.00).\nBalance due on completion.');
    assert.deepEqual(p.prepared, { name: 'Wes Stel', title: 'President', company: 'Stellar Glass LLC', phone: '(586) 292-1732', email: 'wes@stellarglassllc.com' });
    assert.equal(p.pickOption, true);
  });

  it('fills in what the proposal leaves blank from the business and the customer', () => {
    const p = proposalContent({
      estimate: { number: 7, options: [{ fromLines: true }], lines: [{ unit: 'each', qty: 1, price: 1000 }], taxPct: 0, intro: null },
      company: { name: 'Stellar Glass LLC', contactName: 'Wesley Stel', contactTitle: 'President', cell: '(586) 292-1732', email: 'wes@stellarglassllc.com' },
      customer: { name: 'Pat Doe' },
      job: { name: 'Doe shower' },
    });
    assert.equal(p.to, 'Pat Doe');
    assert.equal(p.attn, '');
    assert.equal(p.contact, 'Pat Doe');
    assert.equal(p.project, 'Doe shower');
    assert.equal(p.intro, DEFAULT_INTRO);
    assert.equal(p.star, '');
    assert.deepEqual(p.options.map((o) => o.price), [1000]);
    assert.deepEqual(p.prepared, { name: 'Wesley Stel', title: 'President', company: 'Stellar Glass LLC', phone: '(586) 292-1732', email: 'wes@stellarglassllc.com' });
    assert.equal(p.pickOption, false);
    // Someone else's name on it doesn't take the owner's title.
    assert.equal(proposalContent({ estimate: { preparedName: 'Sam' }, company: { contactTitle: 'President' } }).prepared.title, '');
    assert.equal(proposalContent().company.name, 'Stellar Glass');
  });

  it('itemizes the lines at their share of the price before tax when asked', () => {
    const p = proposalContent({ estimate: { ...estimate, showLines: true }, company, job, customer });
    // $3,200 of glass (2 lites of 32 sq ft at $50) and $400 of hardware, plus 10% markup; the hardware isn't taxed.
    assert.deepEqual(p.lines.map((l) => [l.desc, l.sqft, l.qty, l.unit, l.area, l.width, l.height, l.amount]), [
      ['Storefront glass', true, 2, 'sqft', '64.0', 48, 96, '$3,520.00'],
      ['Door hardware', false, 1, '', '1.0', '', '', '$440.00'],
    ]);
    assert.equal(p.tax, 246.4);
  });

  it('writes dates the way the print view does', () => {
    assert.equal(dayText('2026-10-09'), 'Oct 9, 2026');
    assert.equal(dayText(''), '');
    assert.equal(dayText('soon'), 'soon');
  });
});

describe('proposal: the email', () => {
  const sender = { name: 'Wes Stel', title: 'President', phone: '(586) 292-1732', email: 'wes@stellarglassllc.com' };

  it('greets the contact, gives the prices and says how to accept', () => {
    const p = proposalContent({ estimate, company, job, customer });
    const m = proposalEmail(p, { sender, company });
    assert.equal(m.subject, 'Proposal 1001: Lakeland Central Park Bldg 300 - Revised (Stellar Glass)');
    assert.equal(m.text, [
      'Hi Will,',
      '',
      'Attached is our proposal for Lakeland Central Park Bldg 300 - Revised.',
      '',
      'Price 1 (Akela): $48,250.00',
      'Price 2 (Kawneer): $51,900.00',
      '',
      'It\'s good through Nov 8, 2026. Please let me know if you have any questions. To accept, sign the proposal and send it back to me.',
      '',
      'Thank you,',
      'Wes Stel',
      'President',
      'Stellar Glass LLC',
      '2850 Mine and Mill Road, Suite 4, Lakeland, FL 33801',
      '(586) 292-1732 · wes@stellarglassllc.com',
    ].join('\n'));
  });

  it('keeps it simple for one price and no contact', () => {
    const p = proposalContent({ estimate: { number: 7, options: [{ fromLines: false, price: 950 }] }, company: { name: 'Stellar Glass' } });
    const m = proposalEmail(p, { sender: {}, company: { name: 'Stellar Glass' } });
    assert.equal(m.subject, 'Proposal 7 (Stellar Glass)');
    assert.match(m.text, /^Hello,\n\nAttached is our proposal\.\n\nPrice: \$950\.00\n\nPlease let me know/);
    assert.equal(proposalEmail(proposalContent({ estimate: { attn: 'Mr. Yancey' } })).text.split('\n')[0], 'Hi Mr. Yancey,');
  });

  it('names the PDF after the proposal, without characters a file can\'t have', () => {
    assert.equal(pdfName({ number: 1001, project: 'Bldg 300: "North" / Phase 2?' }), 'Proposal 1001 - Bldg 300 North Phase 2.pdf');
    assert.equal(pdfName({ number: 12, project: '' }), 'Proposal 12.pdf');
  });
});

describe('proposal: the PDF', function () {
  this.timeout(20000);

  it('lays out the whole proposal on one letter page', async () => {
    const p = proposalContent({ estimate, company, job, customer });
    const dd = proposalPdf(p, { logo });
    const { pages, bytes } = await pdfText(dd);
    assert.equal(pages.length, 1);
    assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-');
    const text = pages[0];
    for (const bit of [
      'Proposal', 'No. 1001', '2850 Mine and Mill Road, Suite 4', 'Lakeland, FL 33801', 'Office (863) 255-5731 · Cell (586) 292-1732',
      'DATE', 'Oct 9, 2026', 'Valid through Nov 8, 2026', 'TO', 'Marcobay Construction', 'ATTN', 'Will Yancey',
      'Lakeland Central Park Bldg 300 - Revised, 3600 Lakeland Park Dr, Lakeland, FL', DEFAULT_INTRO, '(4) F2; (8) F3',
      'Price 1: $48,250.00*', 'Price 2: $51,900.00*', 'Glass: 1" Clear Low E Tempered Insulated', 'Exclude:', 'Cleaning; Protection',
      'A 50% deposit is required', 'Balance due on completion.', 'PROPOSAL PREPARED BY', 'Wes Stel', 'PROPOSAL ACCEPTED BY',
      'Printed name', 'Option accepted', 'Thank you for your business.',
    ]) assert.ok(text.includes(bit), `missing "${bit}" in: ${text}`);
    assert.ok(!text.includes('Page 1'), 'one page has no page numbers');
    assert.equal(dd.info.title, 'Proposal 1001');
  });

  it('prints the line list when asked, and runs onto more pages with page numbers', async () => {
    const long = { ...estimate, showLines: true, options: Array.from({ length: 6 }, (_, i) => ({ fromLines: false, name: `Option ${i + 1}`, price: 1000 * (i + 1), specs: Array(8).fill('A spec line').join('\n') })) };
    const { pages } = await pdfText(proposalPdf(proposalContent({ estimate: long, company, job, customer }), { logo }));
    assert.ok(pages.length >= 2);
    const all = pages.join(' ');
    for (const bit of ['Description', 'Storefront glass', '2 lites', '64.0 sq ft', '48" × 96"', '$3,520.00', 'Sales tax', '$246.40', 'Price 6: $6,000.00*']) {
      assert.ok(all.includes(bit), `missing "${bit}"`);
    }
    assert.ok(pages[0].includes(`Page 1 of ${pages.length}`));
    // The signatures and the thank-you stay together.
    assert.ok(pages.at(-1).includes('PROPOSAL ACCEPTED BY') && pages.at(-1).includes('Thank you for your business.'));
  });

  it('puts the business name where the logo goes when there isn\'t one', async () => {
    const { pages } = await pdfText(proposalPdf(proposalContent({ estimate: { number: 3, intro: '' }, company: { name: 'Stellar Glass LLC' } })));
    assert.ok(pages[0].startsWith('Stellar Glass LLC'));
    assert.ok(!pages[0].includes(DEFAULT_INTRO));
  });
});
