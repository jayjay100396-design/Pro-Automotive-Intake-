// A proposal as it goes to the customer: what it says (proposalContent, which the print view in print.js shows too),
// the PDF that's emailed (proposalPdf, a pdfmake document laid out like the print view) and the email that goes with
// it (proposalEmail). Plain functions with no Firebase, so they're unit tested in Node (test/proposal-doc.test.mjs);
// the Send dialog is proposal-send.js.
import { estimateTotals, lineTotal, lineQty, money, proposalOptions, proposalTerms } from './calc.js';
import { defaultSignature } from './parts-email.js';

export const DEFAULT_INTRO = 'We propose to supply and install the following in prepared openings:';

// "2026-10-09" → "Oct 9, 2026", as the print view shows dates (ui.js fmtDate, without the HTML escaping).
export function dayText(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// The street on one line and the town on the next: "2850 Mine and Mill Road, Suite 4" / "Lakeland, FL 33801".
function addressLines(address) {
  const s = String(address || '');
  const m = /,\s*(?=[^,]+,\s*[A-Z]{2}\b)/.exec(s);
  return m ? [s.slice(0, m.index), s.slice(m.index + m[0].length)] : [s];
}

// An option's specs, one per line; a line typed with a space in front prints indented.
const specLines = (text) => String(text || '').split('\n').filter((l) => l.trim()).map((l) => ({ text: l.trim(), indent: /^\s/.test(l) }));

// Everything the proposal prints, worked out once for the print view and the PDF: the estimate, and the business,
// job and customer it's for.
export function proposalContent({ estimate: e = {}, company: c = {}, job: j = {}, customer: cu = {} } = {}) {
  const t = estimateTotals(e);
  // The itemized list shows each line's share of the price before tax (markup and any minimum charge spread over it).
  const factor = t.subtotal ? t.beforeTax / t.subtotal : 1;
  const opts = proposalOptions(e);
  return {
    number: e.number ?? '',
    date: e.date || '',
    validUntil: e.validUntil || '',
    company: {
      name: c.name || 'Stellar Glass',
      address: addressLines(c.address),
      phones: [c.phone && `Office ${c.phone}`, c.cell && `Cell ${c.cell}`].filter(Boolean).join(' · '),
      email: c.email || '',
      website: c.website || '',
      license: c.license || '',
    },
    to: cu.company || cu.name || '',
    attn: e.attn || (cu.company ? cu.name : '') || '',
    // Who the email greets: the Attn, else the customer's own name.
    contact: e.attn || cu.name || '',
    project: e.projectTitle || j.name || '',
    site: j.siteAddress || '',
    intro: e.intro ?? DEFAULT_INTRO,
    scope: e.scope || '',
    lines: e.showLines ? (e.lines || []).map((l) => ({
      desc: l.desc ?? '',
      sqft: l.unit === 'sqft',
      qty: l.qty ?? '',
      unit: l.unit === 'each' ? '' : l.unit ?? '',
      area: lineQty(l).toFixed(1),
      width: l.widthIn ?? '',
      height: l.heightIn ?? '',
      amount: money(lineTotal(l) * factor),
    })) : null,
    tax: e.showLines ? t.tax : 0,
    options: opts.map((o) => ({ number: o.number, name: o.name || '', price: o.price, specs: specLines(o.specs) })),
    // The prices carry the price note's asterisk when it has one.
    star: String(e.priceNote ?? '').trim().startsWith('*') ? '*' : '',
    priceNote: e.priceNote || '',
    exclusions: e.exclusions || '',
    terms: proposalTerms(e),
    prepared: {
      name: e.preparedName || c.contactName || '',
      title: e.preparedTitle || (!e.preparedName && c.contactTitle) || '',
      company: c.name || 'Stellar Glass',
      phone: e.preparedPhone || c.cell || '',
      email: e.preparedEmail || c.email || '',
    },
    // With more than one price, the customer writes in which one they accept.
    pickOption: opts.length > 1,
  };
}

// ---------- The PDF ----------
// Letter paper laid out like the print view (print.js estimateDoc and the .proposal styles in app.css): the band
// with the navy top edge and the logo, the business and the date, who it's to, the priced options with their specs,
// the price note and exclusions, the terms band and the signatures. Sizes are the print view's in points (72 to the
// inch, ¾ of a CSS pixel). The font is Roboto, which comes with pdfmake; its bold is Roboto Medium.
const NAVY = '#123764';
const BLUE = '#0071bc';
const GREY = '#4a5a6e';
const INK = '#111111';
const INCH = 72;
const PAGE_W = 8.5 * INCH;
const SIDE = 0.35 * INCH; // the printed page margin
const INSET = 0.6 * INCH; // how far in from the bands the text starts
const TOP = 0.3 * INCH;
const EDGE = 3; // the band's navy top edge (4px)
const LOGO_H = 52.5; // 70px
const BAND_H = EDGE + 0.3 * INCH + LOGO_H + 0.2 * INCH;
const WIDTH = PAGE_W - 2 * (SIDE + INSET);
const COL = (WIDTH - 0.5 * INCH) / 2; // each signature column
const LABEL_W = 39; // the TO / ATTN labels' width (4.2em of their size) and the space after them
// pdfmake's line height multiplies the font's own, which for Roboto is 1.17 of its size; this matches CSS's.
const lh = (css) => Math.round((css / 1.17) * 100) / 100;

// The band behind the logo: navy top edge, then light blue fading to white.
const band = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
  + '<defs><linearGradient id="band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c5d7ee"/><stop offset="0.55" stop-color="#e7eef8"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs>'
  + `<rect x="0" y="${EDGE}" width="${w}" height="${h - EDGE}" fill="url(#band)"/><rect x="0" y="0" width="${w}" height="${EDGE}" fill="${NAVY}"/></svg>`;

const label = (text) => ({ text, style: 'label' });
// "TO   Marcobay Construction": the small label, then the value lined up after it.
const labeled = (name, value) => ({ columns: [{ ...label(name), width: LABEL_W, margin: [0, 1.3, 0, 0] }, { text: value, width: '*' }], columnGap: 0 });
// A blank to fill in by hand ("Printed name ________"): the line runs to the column's edge.
const blank = (name) => ({
  table: { widths: ['auto', '*'], body: [[{ text: name, border: [false, false, false, false] }, { text: ' ', border: [false, false, false, true] }]] },
  layout: { hLineWidth: (i) => (i ? 0.75 : 0), hLineColor: () => '#888888', vLineWidth: () => 0, paddingLeft: (i) => (i ? 6 : 0), paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
  margin: [0, 0.1 * INCH, 0, 0],
});
// A new one for each place it goes: pdfmake writes its layout into the nodes it's given.
const signLine = () => ({ canvas: [{ type: 'line', x1: 0, y1: 0.4 * INCH, x2: COL, y2: 0.4 * INCH, lineWidth: 0.75, lineColor: '#222222' }], margin: [0, 0, 0, 0.06 * INCH] });

// The pdfmake document for a proposal's content. logo: the logo as a data: URL ('' prints the business name instead).
export function proposalPdf(p, { logo = '' } = {}) {
  const c = p.company;
  const pp = p.prepared;
  const lines = p.lines ? {
    table: {
      headerRows: 1,
      widths: ['*', 'auto', 'auto', 'auto'],
      body: [
        [{ text: 'Description' }, { text: 'Qty', alignment: 'right' }, { text: 'Size' }, { text: 'Amount', alignment: 'right' }].map((h) => ({ ...h, bold: true, fontSize: 9 })),
        ...p.lines.map((l) => [
          l.desc,
          l.sqft
            ? { text: [`${l.qty} lite${Number(l.qty) === 1 ? '' : 's'}\n`, { text: `${l.area} sq ft`, fontSize: 8.5 }], alignment: 'right' }
            : { text: `${l.qty} ${l.unit}`.trim(), alignment: 'right' },
          l.sqft ? `${l.width}" × ${l.height}"` : '',
          { text: l.amount, alignment: 'right' },
        ]),
        ...(p.tax ? [[{ text: 'Sales tax', colSpan: 3 }, {}, {}, { text: money(p.tax), alignment: 'right' }]] : []),
      ],
    },
    layout: {
      hLineWidth: (i) => (i >= 2 ? 0.75 : 0), vLineWidth: () => 0, hLineColor: () => '#e3e7ec', fillColor: (i) => (i === 0 ? '#eef2f6' : null),
      paddingLeft: () => 4.8, paddingRight: () => 4.8, paddingTop: () => 4.8, paddingBottom: () => 4.8,
    },
    lineHeight: 1,
    margin: [0, 6, 0, 12],
  } : null;

  const content = [
    // The band: logo on the left, "Proposal" and its number on the right.
    {
      columns: [
        logo ? { image: logo, fit: [200, LOGO_H], width: 200 } : { text: c.name, width: '*', fontSize: 20, bold: true, color: NAVY },
        { width: '*', stack: [{ text: 'Proposal', style: 'title' }, { text: `No. ${p.number}`, color: NAVY, alignment: 'right' }] },
      ],
      margin: [0, 0, 0, 0.2 * INCH],
    },
    {
      columns: [
        { width: '*', stack: [...c.address, c.phones, c.email, c.website, c.license && `License ${c.license}`].filter(Boolean) },
        {
          width: 'auto',
          stack: [
            { text: [label('DATE'), `  ${dayText(p.date)}`], alignment: 'right' },
            p.validUntil ? { text: `Valid through ${dayText(p.validUntil)}`, alignment: 'right' } : null,
          ].filter(Boolean),
        },
      ],
      columnGap: 12,
      lineHeight: lh(1.45),
      margin: [0, 0.12 * INCH, 0, 0],
    },
    {
      stack: [
        labeled('TO', p.to),
        p.attn ? labeled('ATTN', p.attn) : null,
        { text: [label('PROJECT'), '  ', { text: `${p.project}${p.site ? `, ${p.site}` : ''}`, bold: true }], margin: [0, 0.1 * INCH, 0, 0] },
      ].filter(Boolean),
      lineHeight: lh(1.55),
      margin: [0, 0.14 * INCH, 0, 0],
    },
    p.intro ? { text: p.intro, bold: true, margin: [0, 0.16 * INCH, 0, 0.06 * INCH] } : null,
    p.scope ? { text: p.scope, bold: true, margin: [0.25 * INCH, 0, 0, 0] } : null,
    lines,
    ...p.options.map((o) => ({
      stack: [
        o.name ? { text: o.name, bold: true, decoration: 'underline' } : null,
        { text: `Price ${o.number}: ${money(o.price)}${p.star}`, bold: true, decoration: 'underline', fontSize: 12.6, margin: [0, 0, 0, 0.06 * INCH] },
        ...o.specs.map((s) => ({ text: s.text, bold: true, margin: [s.indent ? 0.4 * INCH : 0, 0, 0, 0] })),
      ].filter(Boolean),
      unbreakable: true,
      margin: [0, 0.15 * INCH, 0, 0],
    })),
    p.priceNote ? { text: p.priceNote, fontSize: 11, margin: [0, 0.16 * INCH, 0, 0] } : null,
    p.exclusions ? { text: [{ text: 'Exclude:', bold: true }, ` ${p.exclusions}`], margin: [0, 0.06 * INCH, 0, 0] } : null,
    // The terms band runs out to the page margin like the top band, with a blue rule under it.
    p.terms ? {
      table: { widths: ['*'], body: [[{ text: p.terms, bold: true }]] },
      layout: {
        hLineWidth: (i, node) => (i === node.table.body.length ? 1.5 : 0), vLineWidth: () => 0, hLineColor: () => BLUE, fillColor: () => '#e7eef8',
        paddingLeft: () => INSET, paddingRight: () => INSET, paddingTop: () => 0.1 * INCH, paddingBottom: () => 0.1 * INCH,
      },
      margin: [-INSET, 0.15 * INCH, -INSET, 0],
    } : null,
    // The signatures and the thank-you stay together, on the next page if they don't fit.
    {
      stack: [
        {
          columns: [
            { width: COL, stack: [label('PROPOSAL PREPARED BY'), signLine(), ...[pp.name, pp.title, pp.company, pp.phone, pp.email].filter(Boolean)] },
            { width: COL, stack: [label('PROPOSAL ACCEPTED BY'), signLine(), blank('Printed name'), blank('Title'), blank('Date'), p.pickOption ? blank('Option accepted') : null].filter(Boolean) },
          ],
          columnGap: 0.5 * INCH,
          lineHeight: lh(1.45),
        },
        { text: 'Thank you for your business.', alignment: 'center', fontSize: 10.2, color: GREY, characterSpacing: 0.4, margin: [0, 0.15 * INCH, 0, 0] },
      ],
      unbreakable: true,
      margin: [0, 0.2 * INCH, 0, 0],
    },
  ].filter(Boolean);

  return {
    pageSize: 'LETTER',
    pageMargins: [SIDE + INSET, TOP + EDGE + 0.3 * INCH, SIDE + INSET, TOP],
    info: { title: `Proposal ${p.number}`, author: c.name, subject: [p.project, p.site].filter(Boolean).join(', '), creator: c.name },
    background: (page) => (page === 1 ? { svg: band(PAGE_W - 2 * SIDE, BAND_H), absolutePosition: { x: SIDE, y: TOP } } : null),
    footer: (page, pages) => (pages > 1 ? { text: `Page ${page} of ${pages}`, alignment: 'center', fontSize: 8, color: GREY, margin: [0, 7, 0, 0] } : null),
    defaultStyle: { font: 'Roboto', fontSize: 10, color: INK, lineHeight: lh(1.5) },
    styles: {
      label: { fontSize: 8.6, bold: true, color: GREY, characterSpacing: 0.5 },
      title: { fontSize: 24, bold: true, color: NAVY, characterSpacing: 0.5, alignment: 'right', lineHeight: 1.2 },
    },
    content,
  };
}

// ---------- The email ----------
const oneLine = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// "Stellar Glass LLC" → "Stellar Glass".
const shortName = (name) => oneLine(name, 80).replace(/,?\s+(LLC|L\.L\.C\.|Inc\.?|Corp\.?|Co\.?)$/i, '') || 'Stellar Glass';

// "Will Yancey" → "Will"; "Mr. Yancey" stays as it is.
function firstName(name) {
  const words = oneLine(name, 80).split(' ').filter(Boolean);
  if (!words.length) return '';
  return words[0].endsWith('.') && words.length > 1 ? words.slice(0, 2).join(' ') : words[0];
}

// The PDF's file name: "Proposal 1001 - Lakeland Central Park Bldg 300.pdf", without characters files can't have.
export function pdfName(p) {
  const base = oneLine(`Proposal ${p.number}${p.project ? ` - ${p.project}` : ''}`, 120).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${base || 'Proposal'}.pdf`;
}

// The email that goes with the PDF: { subject, text }, for the person to change before it goes. sender: who's
// sending it ({ name, title, phone, email }), for the signature; company: the business.
export function proposalEmail(p, { sender = {}, company = {} } = {}) {
  const first = firstName(p.contact);
  const prices = p.options.length === 1
    ? [`Price: ${money(p.options[0].price)}`]
    : p.options.map((o) => `Price ${o.number}${o.name ? ` (${oneLine(o.name, 80)})` : ''}: ${money(o.price)}`);
  const valid = p.validUntil ? `It's good through ${dayText(p.validUntil)}. ` : '';
  const text = [
    first ? `Hi ${first},` : 'Hello,',
    '',
    `Attached is our proposal${p.project ? ` for ${oneLine(p.project, 150)}` : ''}.`,
    '',
    ...prices,
    '',
    `${valid}Please let me know if you have any questions. To accept, sign the proposal and send it back to me.`,
    '',
    'Thank you,',
    defaultSignature(sender, company),
  ].join('\n');
  const subject = oneLine(`Proposal ${p.number}${p.project ? `: ${p.project}` : ''} (${shortName(company.name)})`, 200);
  return { subject, text };
}
