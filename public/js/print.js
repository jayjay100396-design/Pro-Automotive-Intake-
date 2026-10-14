// Printable documents. Each opens as a clean page; "Print / Save PDF" uses the browser's print dialog.
import { state, get, where } from './data.js';
import { invoiceTotals, contractSum, money, pctFmt, paidOn, creditedOn, round2 } from './calc.js';
import { payAppSummary, g702Table } from './views.js';
import { howPaid, frozen } from './billing.js';
import { esc, fmtDate } from './ui.js';
import { websiteUrl } from './brand.js';
import { proposalContent } from './proposal-doc.js';
import { DEFAULT_NOTARY, ADMIN_SIGNERS, WAIVER_TYPES, formatOrdinalDate, buildLienWaiverData } from './accounting-calc.js';

const nl = (s) => esc(s).replace(/\n/g, '<br>');

function readStoredNotary() {
  try {
    const raw = localStorage.getItem('stellar-notary-profile');
    if (raw) return { ...DEFAULT_NOTARY, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_NOTARY };
}

function notarySealHtml(nt = DEFAULT_NOTARY) {
  return `<div class="notary-seal-box" aria-label="Florida Notary Public Seal">
    <div class="notary-seal-name">${esc(nt.sealName || nt.name || 'MELINA ARIAS')}</div>
    <div>Notary Public - State of ${esc(nt.state || 'Florida')}</div>
    <div>Commission # ${esc(nt.commissionNumber || 'HH 427582')}</div>
    <div>My Comm. Expires ${esc(nt.commissionExpiresText || 'Oct 21, 2027')}</div>
  </div>`;
}

function letterhead(title, meta) {
  const c = state.company || {};
  const phones = [c.phone && `Office ${esc(c.phone)}`, c.cell && `Cell ${esc(c.cell)}`].filter(Boolean).join(' · ');
  const web = [c.email && esc(c.email), c.website && `<a href="${esc(websiteUrl(c.website))}">${esc(c.website)}</a>`].filter(Boolean).join(' · ');
  return `<div class="doc-head">
    <div><img src="img/logo.png" alt="${esc(c.name || 'Stellar Glass')}" class="doc-logo">
      <div class="small">${esc(c.address || '')}${phones ? '<br>' + phones : ''}${web ? '<br>' + web : ''}${c.license ? '<br>License ' + esc(c.license) : ''}</div></div>
    <div class="doc-title"><h1>${title}</h1>${meta}</div>
  </div>`;
}

// snap: who and what an invoice paid through Stripe was billed to, as it was then (functions/stripe-invoices.js
// keeps it), so its printout matches Stripe's receipt even if the customer or job changed later.
function party(jobId, customerId, snap = null) {
  const j = snap?.job || get('jobs', jobId) || {};
  const cu = snap?.customer || get('customers', customerId || j.customerId) || {};
  return `<div class="doc-parties">
    <div><div class="label">Bill to</div>${esc(cu.name || '')}${cu.company ? '<br>' + esc(cu.company) : ''}<br>${esc(cu.address || '')}<br>${esc(cu.phone || '')} ${esc(cu.email || '')}</div>
    <div><div class="label">Project</div>${esc(j.name || '')}<br>${esc(j.siteAddress || '')}${j.poNumber ? '<br>PO / project # ' + esc(j.poNumber) : ''}${j.architect ? '<br>GC / Architect: ' + esc(j.architect) : ''}</div>
  </div>`;
}

const signatures = (left, right) => {
  const c = state.company || {};
  const signer = c.contactName ? `<br>${esc(c.contactName)}${c.contactTitle ? ', ' + esc(c.contactTitle) : ''}` : '';
  return `<div class="doc-sign"><div>${left}<br><br>Signature ____________________________ Date __________</div><div>${right}<br><br>Signature ____________________________ Date __________${signer}</div></div>`;
};

function page(title, inner, cls = '', extraBar = '', mount = null) {
  return {
    html: `<div class="print-bar no-print"><button class="btn" onclick="history.back()">← Back</button>${extraBar}<button class="btn primary" onclick="window.print()">Print / Save PDF</button></div>
    <article class="doc ${cls}">${inner}</article>`,
    title,
    ...(mount ? { mount } : {}),
  };
}

// The proposal, laid out like Stellar Glass's own (LCP Bldg 300): letterhead, To/Attn/Project,
// openings, priced options with specs, price note, exclusions, deposit terms, and signatures.
// What it says comes from proposal-doc.js, which makes the PDF that's emailed to the customer from the same content.
export function estimateDoc(id) {
  const e = get('estimates', id);
  if (!e) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const j = get('jobs', e.jobId) || {};
  const p = proposalContent({ estimate: e, company: state.company || {}, job: j, customer: get('customers', e.customerId || j.customerId) || {} });
  const c = p.company;
  const pp = p.prepared;

  return page(`Proposal ${p.number}`, `
    <header class="prop-band">
      <img src="img/logo.png" alt="${esc(c.name)}" class="prop-logo">
      <div class="prop-title"><h1>Proposal</h1><div>No. ${esc(p.number)}</div></div>
    </header>
    <section class="prop-meta">
      <div class="prop-co">${[c.address.map(esc).join('<br>'), esc(c.phones), esc(c.email), esc(c.website), c.license && `License ${esc(c.license)}`].filter(Boolean).join('<br>')}</div>
      <div class="prop-date"><div><span class="label">Date</span> ${fmtDate(p.date)}</div>${p.validUntil ? `<div class="small">Valid through ${fmtDate(p.validUntil)}</div>` : ''}</div>
    </section>
    <section class="prop-to">
      <div><span class="label">To</span> ${esc(p.to)}</div>
      ${p.attn ? `<div><span class="label">Attn</span> ${esc(p.attn)}</div>` : ''}
      <div class="prop-project"><span class="label">Project</span> ${esc(p.project)}${p.site ? `<span class="small">, ${esc(p.site)}</span>` : ''}</div>
    </section>
    <p class="prop-intro">${esc(p.intro)}</p>
    ${p.scope ? `<p class="prop-scope">${nl(p.scope)}</p>` : ''}
    ${p.lines ? `<table class="doc-table"><thead><tr><th>Description</th><th class="num">Qty</th><th>Size</th><th class="num">Amount</th></tr></thead><tbody>
      ${p.lines.map((l) => `<tr><td>${esc(l.desc)}</td><td class="num">${l.sqft ? `${esc(l.qty)} lite${Number(l.qty) === 1 ? '' : 's'}<br><span class="small">${l.area} sq ft</span>` : `${esc(l.qty)} ${esc(l.unit)}`}</td><td>${l.sqft ? `${esc(l.width)}" × ${esc(l.height)}"` : ''}</td><td class="num">${l.amount}</td></tr>`).join('')}
      ${p.tax ? `<tr><td colspan="3">Sales tax</td><td class="num">${money(p.tax)}</td></tr>` : ''}
    </tbody></table>` : ''}
    ${p.options.map((o) => `<div class="prop-option">
      ${o.name ? `<div class="prop-opt-name">${esc(o.name)}</div>` : ''}
      <div class="prop-price">Price ${o.number}: ${money(o.price)}${p.star}</div>
      <div class="prop-specs">${o.specs.map((l) => `<div class="${l.indent ? 'indent' : ''}">${esc(l.text)}</div>`).join('')}</div>
    </div>`).join('')}
    ${p.priceNote ? `<p class="prop-note">${esc(p.priceNote)}</p>` : ''}
    ${p.exclusions ? `<p class="prop-excl"><b>Exclude:</b> ${esc(p.exclusions)}</p>` : ''}
    ${p.terms ? `<div class="prop-terms">${nl(p.terms)}</div>` : ''}
    <section class="prop-sign">
      <div>
        <div class="label">Proposal prepared by</div>
        <div class="sig-line"></div>
        ${esc(pp.name)}${pp.title ? `<br>${esc(pp.title)}` : ''}
        <br>${esc(pp.company)}
        ${pp.phone ? `<br>${esc(pp.phone)}` : ''}
        ${pp.email ? `<br>${esc(pp.email)}` : ''}
      </div>
      <div>
        <div class="label">Proposal accepted by</div>
        <div class="sig-line"></div>
        <div class="sig-row"><span>Printed name</span><span class="blank"></span></div>
        <div class="sig-row"><span>Title</span><span class="blank"></span></div>
        <div class="sig-row"><span>Date</span><span class="blank"></span></div>
        ${p.pickOption ? '<div class="sig-row"><span>Option accepted</span><span class="blank"></span></div>' : ''}
      </div>
    </section>
    <footer class="prop-foot">Thank you for your business.</footer>`, 'proposal');
}

export function contractDoc(id) {
  const c = get('contracts', id);
  if (!c) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const s = contractSum(c, where('changeOrders', 'contractId', id));
  return page(`Contract ${c.number}`, `
    ${letterhead('Contract', `<div>No. ${esc(c.number)}</div><div>${fmtDate(c.date)}</div>`)}
    ${party(c.jobId, c.customerId)}
    <table class="doc-table"><thead><tr><th>Item</th><th>Schedule of values</th><th class="num">Value</th></tr></thead><tbody>
    ${(c.sov || []).map((l) => `<tr><td>${esc(l.item)}</td><td>${esc(l.desc)}</td><td class="num">${money(l.value)}</td></tr>`).join('')}
    </tbody></table>
    <div class="doc-totals"><div class="tr grand"><span>Contract sum</span><span>${money(s.original)}</span></div><div class="tr"><span>Retainage</span><span>${esc(c.retainagePct ?? 0)}%</span></div></div>
    ${c.terms ? `<div class="doc-terms"><div class="label">Terms</div>${nl(c.terms)}</div>` : ''}
    ${signatures('Owner / Customer', `Contractor: ${esc(state.company?.name || 'Stellar Glass')}`)}`);
}

export function changeOrderDoc(id) {
  const co = get('changeOrders', id);
  if (!co) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const c = get('contracts', co.contractId) || {};
  const all = where('changeOrders', 'contractId', co.contractId).filter((x) => x.status === 'approved' && x.id !== co.id && Number(x.number) < Number(co.number));
  const before = contractSum(c, all).toDate;
  return page(`Change order ${co.number}`, `
    ${letterhead('Change Order', `<div>No. ${esc(co.number)}</div><div>${fmtDate(co.date)}</div><div class="small">Contract ${esc(c.number || '')}</div>`)}
    ${party(co.jobId, c.customerId)}
    <div class="doc-terms"><div class="label">Description of change</div>${nl(co.desc)}</div>
    <div class="doc-totals">
      <div class="tr"><span>Contract sum before this change</span><span>${money(before)}</span></div>
      <div class="tr"><span>This change order</span><span>${money(co.amount)}</span></div>
      <div class="tr grand"><span>New contract sum</span><span>${money(before + (Number(co.amount) || 0))}</span></div>
    </div>
    ${signatures('Owner / Customer', `Contractor: ${esc(state.company?.name || 'Stellar Glass')}`)}`);
}

export function payAppDoc(id, params = new URLSearchParams()) {
  const p = get('payApps', id);
  if (!p) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const s = payAppSummary(p);
  const c = get('contracts', p.contractId) || {};
  const j = get('jobs', p.jobId) || {};
  const cu = get('customers', p.customerId || j.customerId) || {};
  const t = s.totals;
  const cos = where('changeOrders', 'contractId', p.contractId).filter((x) => x.status === 'approved');
  const nt = readStoredNotary();
  const useNotary = params?.get?.('notary') !== 'blank';
  const signerParam = params?.get?.('signer') || state.company?.contactName || ADMIN_SIGNERS[0].name;
  const matchedAdmin = ADMIN_SIGNERS.find((a) => a.name.toLowerCase() === String(signerParam).toLowerCase());
  const signerTitle = matchedAdmin?.title || state.company?.contactTitle || 'President';
  const ord = formatOrdinalDate(p.date || p.periodTo);

  const extraBar = `
    <a class="btn" href="#/accounting/waiver/print?payApp=${esc(id)}&amp;kind=progress">⚖️ Partial Lien Waiver (§ 713.20)</a>
    <a class="btn" href="#/accounting/waiver/print?payApp=${esc(id)}&amp;kind=final">⚖️ Final Lien Waiver</a>
    <button type="button" class="btn" data-toggle-notary aria-pressed="${useNotary ? 'true' : 'false'}">${useNotary ? `✓ Notary: ${esc(nt.name)} (#${esc(nt.commissionNumber)})` : 'Blank Notary Block'}</button>
    <select class="print-select" data-signer-pick aria-label="Contractor Signer">
      ${ADMIN_SIGNERS.map((a) => `<option value="${esc(a.name)}" ${a.name === signerParam ? 'selected' : ''}>Signer: ${esc(a.name)} (${esc(a.title)})</option>`).join('')}
    </select>
  `;

  const notaryHtml = useNotary
    ? `<div class="notary-cert-block" data-notary-block>
        <p class="small">State of: <b>${esc(nt.state)}</b> &nbsp;&nbsp; County of: <b>${esc(nt.county)}</b><br>
        Subscribed and sworn to before me this <b>${esc(ord.dayOrdinal)}</b> day of <b>${esc(ord.monthName)} ${esc(ord.year)}</b><br>
        Notary Public: <b>${esc(nt.name)}</b> <span class="muted">(${esc(nt.email)})</span><br>
        My Commission expires: <b>${esc(nt.commissionExpiresText)}</b></p>
        ${notarySealHtml(nt)}
      </div>`
    : `<div class="notary-cert-block" data-notary-block>
        <p class="small">State of ____________ County of ____________<br>Subscribed and sworn before me this ____ day of ____________, 20__<br>Notary public ____________________________ My commission expires __________</p>
      </div>`;

  return page(
    `Pay app ${p.number}`,
    `
    ${letterhead('Application and Certificate for Payment', `<div class="small">AIA G702 format</div><div>Application No. ${esc(p.number)}</div><div>Period to ${fmtDate(p.periodTo)}</div><div class="small">Application date ${fmtDate(p.date)}</div>`)}
    <div class="doc-parties three">
      <div><div class="label">To owner</div>${esc(cu.name || '')}${cu.company ? '<br>' + esc(cu.company) : ''}<br>${esc(cu.address || '')}</div>
      <div><div class="label">Project</div>${esc(j.name || '')}<br>${esc(j.siteAddress || '')}${j.poNumber ? '<br>Job # ' + esc(j.poNumber) : ''}</div>
      <div><div class="label">Contract</div>No. ${esc(c.number || '')}, dated ${fmtDate(c.date)}${j.architect ? '<br>Architect: ' + esc(j.architect) : ''}</div>
    </div>
    <div class="doc-cols">
      <div class="g702">${g702Table(s)}</div>
      <div>
        <table class="doc-table small"><thead><tr><th>Change order summary</th><th class="num">Additions</th><th class="num">Deductions</th></tr></thead><tbody>
          ${cos.map((x) => `<tr><td>No. ${esc(x.number)}: ${esc(x.desc)}</td><td class="num">${Number(x.amount) > 0 ? money(x.amount) : ''}</td><td class="num">${Number(x.amount) < 0 ? money(-x.amount) : ''}</td></tr>`).join('') || '<tr><td colspan="3">None</td></tr>'}
          <tr><td><b>Totals</b></td><td class="num">${money(s.additions)}</td><td class="num">${money(s.deductions)}</td></tr>
          <tr><td><b>Net change</b></td><td class="num" colspan="2">${money(s.netChange)}</td></tr>
        </tbody></table>
        <p class="small">The undersigned contractor certifies that, to the best of the contractor's knowledge, information and belief the work covered by this application for payment has been completed in accordance with the contract documents, that all amounts have been paid by the contractor for work for which previous certificates for payment were issued and payments received from the owner, and that current payment shown herein is now due.</p>
        <p class="small" data-contractor-sig>Contractor: <b>${esc(state.company?.name || 'Stellar Glass, LLC')}</b><br><br>By ____________________________ Date <u>&nbsp;${esc(ord.usDate || fmtDate(p.date))}&nbsp;</u><br><b>${esc(signerParam)}</b>, ${esc(signerTitle)}</p>
        ${notaryHtml}
        <div class="arch-cert-block small">
          <div class="label">Architect's Certificate for Payment</div>
          <p class="small">In accordance with the Contract Documents, based on on-site observations and the data comprising this application, the Architect certifies to the Owner that to the best of their knowledge, information and belief the Work has progressed as indicated, and the Contractor is entitled to payment of the AMOUNT CERTIFIED.</p>
          <p class="small"><b>AMOUNT CERTIFIED:</b> <u>&nbsp;${money(s.currentDue)}&nbsp;</u> &nbsp;&nbsp; By ______________________ Date ________</p>
        </div>
      </div>
    </div>
    <div class="page-break"></div>
    ${letterhead('Continuation Sheet', `<div class="small">AIA G703 format</div><div>Application No. ${esc(p.number)}</div><div>Period to ${fmtDate(p.periodTo)}</div>`)}
    <table class="doc-table g703 small"><thead><tr><th>A<br>Item</th><th>B<br>Description of work</th><th class="num">C<br>Scheduled value</th><th class="num">D<br>From previous application</th><th class="num">E<br>This period</th><th class="num">F<br>Materials presently stored</th><th class="num">G<br>Total completed and stored to date</th><th class="num">%<br>(G÷C)</th><th class="num">H<br>Balance to finish</th><th class="num">I<br>Retainage</th></tr></thead><tbody>
    ${(p.lines || []).map((l, i) => { const r = s.rows[i]; return `<tr><td>${esc(l.item)}</td><td>${esc(l.desc)}</td><td class="num">${money(r.value)}</td><td class="num">${money(r.prevWork)}</td><td class="num">${money(r.thisWork)}</td><td class="num">${money(r.stored)}</td><td class="num">${money(r.completed)}</td><td class="num">${pctFmt(r.pct)}</td><td class="num">${money(r.balance)}</td><td class="num">${money(r.retainage)}</td></tr>`; }).join('')}
    </tbody><tfoot><tr><td></td><td><b>Grand totals</b></td><td class="num">${money(t.value)}</td><td class="num">${money(t.prevWork)}</td><td class="num">${money(t.thisWork)}</td><td class="num">${money(t.stored)}</td><td class="num">${money(t.completed)}</td><td class="num">${pctFmt(t.pct)}</td><td class="num">${money(t.balance)}</td><td class="num">${money(t.retainage)}</td></tr></tfoot></table>`,
    'wide',
    extraBar,
    (root) => {
      const updateQuery = (nextNotary, nextSigner) => {
        const q = new URLSearchParams(location.hash.split('?')[1] || '');
        if (nextNotary !== undefined) q.set('notary', nextNotary ? 'melina' : 'blank');
        if (nextSigner !== undefined) q.set('signer', nextSigner);
        location.hash = `#/payapps/${id}/print?${q.toString()}`;
      };
      root.querySelector('[data-toggle-notary]')?.addEventListener('click', () => {
        updateQuery(!useNotary, undefined);
      });
      root.querySelector('[data-signer-pick]')?.addEventListener('change', (ev) => {
        updateQuery(undefined, ev.target.value);
      });
    },
  );
}

export function invoiceDoc(id) {
  const inv = get('invoices', id);
  if (!inv) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const t = invoiceTotals(inv);
  const st = inv.stripe || {};
  // What comes off the total: a credit note in Stripe, each payment recorded here (cash, check or other),
  // and what was paid online (credit on the customer's Stripe account used on it included). A bill marked
  // paid without payments recorded, or paid through Stripe, shows as paid in full.
  const pays = [...(inv.payments || [])].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const rows = [];
  if (inv.status !== 'paid' || (pays.length && st.status !== 'paid')) {
    const credited = creditedOn(inv);
    if (credited > 0) rows.push(['Credit note', credited]);
    for (const p of pays) rows.push([`Paid ${fmtDate(p.date)}, ${howPaid(p)}`, Number(p.amount) || 0]);
    const online = round2(paidOn(inv) - pays.reduce((sum, p) => sum + (Number(p.amount) || 0), 0));
    const credit = Number(st.balanceApplied) > 0;
    if (online > 0) rows.push([!credit ? 'Paid online' : Number(st.paidOnline) > 0 ? 'Paid and credited' : 'Credit applied', online]);
  }
  const due = inv.status === 'paid' ? 0 : Math.max(0, round2(t.total - rows.reduce((sum, [, amount]) => sum + amount, 0)));
  // Paid through Stripe for real, or out for payment on a live Stripe invoice: billed to whoever the Stripe
  // invoice was made out to, as it shows them.
  const snap = frozen(st) ? st.party : null;
  const extraBar = `<a class="btn" href="#/accounting/waiver/print?invoice=${esc(id)}&amp;kind=progress">⚖️ Lien Waiver (§ 713.20)</a>`;
  return page(`Invoice ${inv.number}`, `
    ${letterhead('Invoice', `<div>No. ${esc(inv.number)}</div><div>${fmtDate(inv.date)}</div>${inv.dueDate ? `<div class="small">Due ${fmtDate(inv.dueDate)}</div>` : ''}${inv.status === 'paid' ? `<div class="paid-stamp">PAID ${fmtDate(inv.paidDate)}</div>` : ''}`)}
    ${party(inv.jobId, inv.customerId, snap)}
    <table class="doc-table"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>
    ${(inv.lines || []).map((l) => `<tr><td>${esc(l.desc)}</td><td class="num">${esc(l.qty)}</td><td class="num">${money(l.price)}</td><td class="num">${money((Number(l.qty) || 0) * (Number(l.price) || 0))}</td></tr>`).join('')}
    </tbody></table>
    <div class="doc-totals"><div class="tr"><span>Subtotal</span><span>${money(t.subtotal)}</span></div><div class="tr"><span>Sales tax</span><span>${money(t.tax)}</span></div>${rows.length ? `<div class="tr"><span>Total</span><span>${money(t.total)}</span></div>${rows.map(([label, amount]) => `<div class="tr"><span>${esc(label)}</span><span>${money(-amount)}</span></div>`).join('')}` : ''}<div class="tr grand"><span>${rows.length ? 'Balance due' : 'Total due'}</span><span>${money(due)}</span></div></div>
    ${inv.notes ? `<div class="doc-terms">${nl(inv.notes)}</div>` : ''}`, '', extraBar);
}

// Printable Florida Statutory Lien Waivers (§ 713.20(4) Progress, § 713.20(5) Final),
// Notarized Final Affidavit & Waiver of Lien, and NTO Vendor Sworn Statement.
export function lienWaiverDoc(params = new URLSearchParams()) {
  const payAppId = params.get('payApp') || '';
  const invoiceId = params.get('invoice') || '';
  const contractId = params.get('contract') || '';
  const jobIdParam = params.get('job') || '';
  const kindParam = params.get('kind') || 'progress';

  const p = payAppId ? get('payApps', payAppId) : null;
  const inv = invoiceId ? get('invoices', invoiceId) : null;
  const c = contractId ? get('contracts', contractId) : (p ? get('contracts', p.contractId) : null);
  const jId = p?.jobId || inv?.jobId || c?.jobId || jobIdParam;
  const j = jId ? get('jobs', jId) : null;
  const cuId = p?.customerId || inv?.customerId || c?.customerId || j?.customerId || '';
  const cu = cuId ? get('customers', cuId) : null;

  if ((payAppId && !p) || (invoiceId && !inv) || (contractId && !c)) {
    return { waiting: true, html: '<p class="muted">Loading document…</p>' };
  }

  const paSum = p ? payAppSummary(p) : null;
  const nt = readStoredNotary();

  const initial = buildLienWaiverData({
    kind: kindParam,
    payApp: p,
    payAppSummaryData: paSum,
    invoice: inv,
    contract: c,
    job: j,
    customer: cu,
    company: state.company || {},
    notary: nt,
    overrides: {
      amount: params.get('amount') ?? undefined,
      throughDate: params.get('throughDate') ?? undefined,
      signedDate: params.get('signedDate') ?? undefined,
      customerName: params.get('customer') ?? undefined,
      ownerName: params.get('owner') ?? undefined,
      propertyDesc: params.get('property') ?? undefined,
      signerName: params.get('signer') ?? undefined,
      includeNotary: params.get('notary') ?? '1',
    },
  });

  const renderWaiverArticle = (w) => {
    const notaryCert = w.includeNotary ? `
      <div class="waiver-notary-box">
        <div class="label">State of ${esc(w.notary.state)} · County of ${esc(w.notary.county)}</div>
        <p class="small">Sworn to (or affirmed) and subscribed before me by means of ☑ physical presence or ☐ online notarization, this <b>${esc(w.signedOrd.dayOrdinal)}</b> day of <b>${esc(w.signedOrd.monthName)}</b>, <b>${esc(w.signedOrd.year)}</b>, by <b>${esc(w.signerName)}</b>, ${esc(w.signerTitle)} of <b>${esc(w.lienorName)}</b>, who is personally known to me or has produced identification.</p>
        <div class="waiver-notary-row">
          <div>
            <div>Notary Public Signature: ____________________________</div>
            <div>Printed Name: <b>${esc(w.notary.name)}</b> (${esc(w.notary.email)})</div>
            <div>Commission # <b>${esc(w.notary.commissionNumber)}</b> · My Commission Expires: <b>${esc(w.notary.commissionExpiresText)}</b></div>
          </div>
          ${notarySealHtml(w.notary)}
        </div>
      </div>
    ` : '';

    if (w.kind === 'sworn') {
      return `
        ${letterhead('Request for Sworn Statement', `<div class="small">Florida Mechanics' Lien Law · Notice to Owner (NTO) Compliance</div><div>${esc(w.docRef)}</div>`)}
        <div class="waiver-body">
          <p>In order to fulfill our obligation to all suppliers who filed a <b>"NOTICE TO OWNER"</b> on a project prior to issuing payment, the following sworn accounting is provided to protect the <b>OWNER &amp; CONTRACTOR</b> (${esc(w.customerName)} / ${esc(w.ownerName)}) against claims arising under the Florida Construction Lien Law.</p>
          <div class="waiver-grid">
            <div><span class="label">Project / Property</span><b>${esc(w.propertyDesc)}</b></div>
            <div><span class="label">Subcontractor</span><b>${esc(w.lienorName)}</b></div>
            <div><span class="label">NTO Supplier / Vendor</span><b>${esc(w.vendorName)}</b></div>
            <div><span class="label">General Contractor / Customer</span><b>${esc(w.customerName)}</b></div>
          </div>
          <p class="waiver-line"><b>1. Balance on project as of</b> <u>&nbsp;${esc(w.throughUsDate)}&nbsp;</u> <span class="small muted">(Billed Through Date)</span> is <b><u>&nbsp;${money(w.vendorBalanceThru)}&nbsp;</u></b>.</p>
          <p class="waiver-line"><b>2. Balance of all unpaid purchases, invoiced and not yet invoiced, including #1 above, as of</b> <u>&nbsp;${esc(w.signedOrd.usDate || w.throughUsDate)}&nbsp;</u> <span class="small muted">(Current Date of Current Month)</span> is <b><u>&nbsp;${money(w.vendorBalanceCurrent)}&nbsp;</u></b>.</p>
          <p>I attest this to be a true and accurate accounting for the above to be relied upon in accordance with the Florida Construction Lien Law.</p>
          <div class="waiver-sign-block">
            <div><span class="label">Company:</span> <b>${esc(w.lienorName)}</b></div>
            <div><span class="label">Address:</span> ${esc(w.lienorAddress)}</div>
            <div class="waiver-sig-line"><span>By (Signature):</span> <span class="blank"></span></div>
            <div><span class="label">Printed Name &amp; Title:</span> <b>${esc(w.signerName)}, ${esc(w.signerTitle)}</b></div>
          </div>
          ${notaryCert}
        </div>
      `;
    }

    if (w.kind === 'affidavit') {
      return `
        ${letterhead('Final Affidavit & Waiver of Lien', `<div class="small">Owner / Contractor / Subcontractor / Supplier</div><div>${esc(w.docRef)}</div>`)}
        <div class="waiver-body">
          <p>We, the undersigned Contractor / Subcontractor (<b>${esc(w.lienorName)}</b>), having performed labor or furnished material or services in the construction, alteration, or improvement of the buildings located at:</p>
          <div class="waiver-prop-box">
            <b>JOB / PROPERTY:</b> ${esc(w.propertyDesc)}<br>
            <b>CUSTOMER / GC:</b> ${esc(w.customerName)} &nbsp;·&nbsp; <b>OWNER:</b> ${esc(w.ownerName)}
          </div>
          <p>do hereby release and discharge any claim, lien, or otherwise, which we might have against the above described property, we having been paid in full (Final Payment: <b>${w.amountFormatted}</b>) and all parties performing labor, furnishing materials or services on the site of improvement through us (including any Notice to Owner filers) have been <b>PAID IN FULL</b>.</p>
          <p>We do hereby release, discharge, and waive any claim, lien, or otherwise.</p>
          <div class="waiver-sign-block">
            <div class="waiver-sig-line"><span>Signature:</span> <span class="blank"></span></div>
            <div><span class="label">Printed Name:</span> <b>${esc(w.signerName)}</b> &nbsp;·&nbsp; <span class="label">Title:</span> <b>${esc(w.signerTitle)}</b></div>
            <div><span class="label">Company:</span> <b>${esc(w.lienorName)}</b>, ${esc(w.lienorAddress)}</div>
            <div><span class="label">Date:</span> <b>${esc(w.signedOrd.usDate || `${w.signedOrd.monthName} ${w.signedOrd.day}, ${w.signedOrd.year}`)}</b></div>
          </div>
          ${notaryCert}
        </div>
      `;
    }

    const isFinal = w.kind === 'final';
    const heading = isFinal
      ? 'FINAL WAIVER AND RELEASE OF LIEN UPON FINAL PAYMENT'
      : 'PARTIAL WAIVER AND RELEASE OF LIEN UPON PROGRESS PAYMENT';
    const subheading = isFinal
      ? '(SECTION 713.20(5), FLORIDA STATUTES)'
      : '(SECTION 713.20(4), FLORIDA STATUTES)';

    return `
      ${letterhead(heading, `<div class="small">${subheading}</div><div>${esc(w.docRef)}</div>`)}
      <div class="waiver-body">
        <p class="waiver-lead">
          The undersigned lienor, in consideration of the ${isFinal ? 'Final Payment' : 'Progress Payment'} in the amount of
          <b><u>&nbsp;${w.amountFormatted}&nbsp;</u></b>, hereby waives and releases its lien and right to claim a lien
          for labor, services, or materials furnished ${isFinal ? '' : `through (date) <b><u>&nbsp;${esc(w.throughUsDate)}&nbsp;</u></b> `}to
          (customer) <b><u>&nbsp;${esc(w.customerName)}&nbsp;</u></b> on the job of (Owner of property)
          <b><u>&nbsp;${esc(w.ownerName)}&nbsp;</u></b> to the following described property:
        </p>
        <div class="waiver-prop-box">
          <b>${nl(w.propertyDesc)}</b>
        </div>
        ${isFinal ? '' : '<p>This waiver and release does not cover any retention or labor, services, or materials furnished after the date specified.</p>'}
        <p class="waiver-dated">
          DATED on <b><u>&nbsp;${esc(w.signedOrd.dayOrdinal)}&nbsp;</u></b> day of <b><u>&nbsp;${esc(w.signedOrd.monthName)}&nbsp;</u></b>, 20<b><u>${esc(w.signedOrd.yearShort)}</u></b>
        </p>
        <div class="waiver-sign-block">
          <div><span class="label">Lienor's Name:</span> <b><u>&nbsp;${esc(w.lienorName)}&nbsp;</u></b></div>
          <div><span class="label">Address:</span> <u>&nbsp;${esc(w.lienorAddress)}&nbsp;</u></div>
          <div class="waiver-sig-line"><span>By:</span> <span class="blank"></span></div>
          <div><span class="label">Printed Name:</span> <b><u>&nbsp;${esc(w.signerName)}${w.signerTitle ? `, ${esc(w.signerTitle)}` : ''}&nbsp;</u></b></div>
        </div>
        ${notaryCert}
        <footer class="waiver-statutory-note">
          <i>NOTE: This is a statutory form prescribed by Section 713.20, Florida Statutes (1996). Effective October 1, 1996, a person may not require a lienor to furnish a waiver or release of lien that is different from the statutory form.</i>
        </footer>
      </div>
    `;
  };

  return {
    title: `Lien Waiver · ${initial.docRef}`,
    html: `
      <div class="print-bar no-print">
        <button class="btn" onclick="history.back()">← Back</button>
        <a class="btn" href="#/accounting">⚖️ Accounting &amp; Notary Hub</a>
        <button class="btn primary" onclick="window.print()">Print / Save PDF</button>
      </div>
      <section class="card no-print waiver-controls" aria-label="Customize Lien Waiver & Notary Certificate before printing">
        <div class="row between">
          <strong>⚖️ Customize Florida Lien Waiver &amp; Notary Certificate (Melina S. Arias · #${esc(nt.commissionNumber)})</strong>
          <span class="small muted">Changes update the printable sheet below immediately</span>
        </div>
        <div class="grid4 top-gap" id="waiverForm">
          <label class="span2">Form Type
            <select name="kind">${WAIVER_TYPES.map(([k, lbl]) => `<option value="${esc(k)}" ${k === initial.kind ? 'selected' : ''}>${esc(lbl)}</option>`).join('')}</select>
          </label>
          <label>Payment Amount ($)
            <input type="number" step="0.01" name="amount" value="${esc(initial.amount)}">
          </label>
          <label>Through Date
            <input type="date" name="throughDate" value="${esc(initial.throughDate)}">
          </label>
          <label>Customer / GC (e.g. Marcobay Construction)
            <input name="customerName" value="${esc(initial.customerName)}">
          </label>
          <label>Owner of Property (e.g. Ruthven Green LLC)
            <input name="ownerName" value="${esc(initial.ownerName)}">
          </label>
          <label class="span2">Property Description / Job Address &amp; #
            <input name="propertyDesc" value="${esc(initial.propertyDesc)}">
          </label>
          <label>Contractor Signer
            <select name="signerName">
              ${ADMIN_SIGNERS.map((a) => `<option value="${esc(a.name)}" ${a.name === initial.signerName ? 'selected' : ''}>${esc(a.name)} (${esc(a.title)})</option>`).join('')}
            </select>
          </label>
          <label>Signed / Notarized Date
            <input type="date" name="signedDate" value="${esc(initial.signedDate)}">
          </label>
          <label class="span2"><input type="checkbox" name="includeNotary" ${initial.includeNotary ? 'checked' : ''}> Include Florida Notary Acknowledgment &amp; Seal (${esc(nt.name)} · #${esc(nt.commissionNumber)})</label>
        </div>
      </section>
      <article class="doc" id="waiverDocArticle">${renderWaiverArticle(initial)}</article>
    `,
    mount(root) {
      const box = root.querySelector('#waiverForm');
      const article = root.querySelector('#waiverDocArticle');
      if (!box || !article) return;
      const redraw = () => {
        const getVal = (name) => box.querySelector(`[name="${name}"]`)?.value ?? '';
        const incNotary = box.querySelector('[name="includeNotary"]')?.checked ?? true;
        const w = buildLienWaiverData({
          kind: getVal('kind'),
          payApp: p,
          payAppSummaryData: paSum,
          invoice: inv,
          contract: c,
          job: j,
          customer: cu,
          company: state.company || {},
          notary: nt,
          overrides: {
            amount: getVal('amount'),
            throughDate: getVal('throughDate'),
            signedDate: getVal('signedDate'),
            customerName: getVal('customerName'),
            ownerName: getVal('ownerName'),
            propertyDesc: getVal('propertyDesc'),
            signerName: getVal('signerName'),
            includeNotary: incNotary,
          },
        });
        article.innerHTML = renderWaiverArticle(w);
      };
      box.addEventListener('input', redraw);
      box.addEventListener('change', redraw);
    },
  };
}
