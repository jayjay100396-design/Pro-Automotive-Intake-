// Printable documents. Each opens as a clean page; "Print / Save PDF" uses the browser's print dialog.
import { state, get, where } from './data.js';
import { estimateTotals, invoiceTotals, lineTotal, lineQty, contractSum, money, pctFmt, proposalOptions } from './calc.js';
import { payAppSummary, g702Table } from './views.js';
import { esc, fmtDate } from './ui.js';
import { websiteUrl } from './brand.js';

const nl = (s) => esc(s).replace(/\n/g, '<br>');

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

function party(jobId, customerId) {
  const j = get('jobs', jobId) || {};
  const cu = get('customers', customerId || j.customerId) || {};
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

function page(title, inner, cls = '') {
  return {
    html: `<div class="print-bar no-print"><button class="btn" onclick="history.back()">← Back</button><button class="btn primary" onclick="window.print()">Print / Save PDF</button></div>
    <article class="doc ${cls}">${inner}</article>`,
    title,
  };
}

// The proposal, laid out like Stellar Glass's own (LCP Bldg 300): letterhead, To/Attn/Project,
// openings, priced options with specs, price note, exclusions, deposit terms, and signatures.
export function estimateDoc(id) {
  const e = get('estimates', id);
  if (!e) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const c = state.company || {};
  const j = get('jobs', e.jobId) || {};
  const cu = get('customers', e.customerId || j.customerId) || {};
  const t = estimateTotals(e);
  const factor = t.subtotal ? t.beforeTax / t.subtotal : 1;
  const to = cu.company || cu.name || '';
  const attn = e.attn || (cu.company ? cu.name : '');
  const star = (e.priceNote ?? '').trim().startsWith('*') ? '*' : '';
  const specLines = (text) => String(text || '').split('\n').filter((l) => l.trim())
    .map((l) => `<div class="${/^\s/.test(l) ? 'indent' : ''}">${esc(l.trim())}</div>`).join('');
  const addr = String(c.address || '').replace(/,\s*(?=[^,]+,\s*[A-Z]{2}\b)/, '<br>');
  const phones = [c.phone && `Office ${esc(c.phone)}`, c.cell && `Cell ${esc(c.cell)}`].filter(Boolean).join(' · ');
  const opts = proposalOptions(e);

  return page(`Proposal ${e.number}`, `
    <header class="prop-band">
      <img src="img/logo.png" alt="${esc(c.name || 'Stellar Glass')}" class="prop-logo">
      <div class="prop-title"><h1>Proposal</h1><div>No. ${esc(e.number)}</div></div>
    </header>
    <section class="prop-meta">
      <div class="prop-co">${addr}${phones ? '<br>' + phones : ''}${c.email ? '<br>' + esc(c.email) : ''}${c.website ? '<br>' + esc(c.website) : ''}${c.license ? '<br>License ' + esc(c.license) : ''}</div>
      <div class="prop-date"><div><span class="label">Date</span> ${fmtDate(e.date)}</div>${e.validUntil ? `<div class="small">Valid through ${fmtDate(e.validUntil)}</div>` : ''}</div>
    </section>
    <section class="prop-to">
      <div><span class="label">To</span> ${esc(to)}</div>
      ${attn ? `<div><span class="label">Attn</span> ${esc(attn)}</div>` : ''}
      <div class="prop-project"><span class="label">Project</span> ${esc(e.projectTitle || j.name || '')}${j.siteAddress ? `<span class="small">, ${esc(j.siteAddress)}</span>` : ''}</div>
    </section>
    <p class="prop-intro">${esc(e.intro ?? 'We propose to supply and install the following in prepared openings:')}</p>
    ${e.scope ? `<p class="prop-scope">${esc(e.scope).replace(/\n/g, '<br>')}</p>` : ''}
    ${e.showLines ? `<table class="doc-table"><thead><tr><th>Description</th><th class="num">Qty</th><th>Size</th><th class="num">Amount</th></tr></thead><tbody>
      ${(e.lines || []).map((l) => `<tr><td>${esc(l.desc)}</td><td class="num">${l.unit === 'sqft' ? `${esc(l.qty)} lite${Number(l.qty) === 1 ? '' : 's'}<br><span class="small">${lineQty(l).toFixed(1)} sq ft</span>` : `${esc(l.qty)} ${esc(l.unit === 'each' ? '' : l.unit)}`}</td><td>${l.unit === 'sqft' ? `${esc(l.widthIn)}" × ${esc(l.heightIn)}"` : ''}</td><td class="num">${money(lineTotal(l) * factor)}</td></tr>`).join('')}
      ${t.tax ? `<tr><td colspan="3">Sales tax</td><td class="num">${money(t.tax)}</td></tr>` : ''}
    </tbody></table>` : ''}
    ${opts.map((o) => `<div class="prop-option">
      ${o.name ? `<div class="prop-opt-name">${esc(o.name)}</div>` : ''}
      <div class="prop-price">Price ${o.number}: ${money(o.price)}${star}</div>
      <div class="prop-specs">${specLines(o.specs)}</div>
    </div>`).join('')}
    ${e.priceNote ? `<p class="prop-note">${esc(e.priceNote)}</p>` : ''}
    ${e.exclusions ? `<p class="prop-excl"><b>Exclude:</b> ${esc(e.exclusions)}</p>` : ''}
    ${e.terms ? `<div class="prop-terms">${esc(e.terms).replace(/\n/g, '<br>')}</div>` : ''}
    <section class="prop-sign">
      <div>
        <div class="label">Proposal prepared by</div>
        <div class="sig-line"></div>
        ${esc(e.preparedName || c.contactName || '')}${e.preparedTitle || (!e.preparedName && c.contactTitle) ? `<br>${esc(e.preparedTitle || c.contactTitle)}` : ''}
        <br>${esc(c.name || 'Stellar Glass')}
        ${e.preparedPhone || c.cell ? `<br>${esc(e.preparedPhone || c.cell)}` : ''}
        ${e.preparedEmail || c.email ? `<br>${esc(e.preparedEmail || c.email)}` : ''}
      </div>
      <div>
        <div class="label">Proposal accepted by</div>
        <div class="sig-line"></div>
        <div class="sig-row"><span>Printed name</span><span class="blank"></span></div>
        <div class="sig-row"><span>Title</span><span class="blank"></span></div>
        <div class="sig-row"><span>Date</span><span class="blank"></span></div>
        ${opts.length > 1 ? '<div class="sig-row"><span>Option accepted</span><span class="blank"></span></div>' : ''}
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

export function payAppDoc(id) {
  const p = get('payApps', id);
  if (!p) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const s = payAppSummary(p);
  const c = get('contracts', p.contractId) || {};
  const j = get('jobs', p.jobId) || {};
  const cu = get('customers', p.customerId || j.customerId) || {};
  const t = s.totals;
  const cos = where('changeOrders', 'contractId', p.contractId).filter((x) => x.status === 'approved');
  return page(`Pay app ${p.number}`, `
    ${letterhead('Application and Certificate for Payment', `<div class="small">AIA G702 format</div><div>Application No. ${esc(p.number)}</div><div>Period to ${fmtDate(p.periodTo)}</div><div class="small">Application date ${fmtDate(p.date)}</div>`)}
    <div class="doc-parties three">
      <div><div class="label">To owner</div>${esc(cu.name || '')}${cu.company ? '<br>' + esc(cu.company) : ''}<br>${esc(cu.address || '')}</div>
      <div><div class="label">Project</div>${esc(j.name || '')}<br>${esc(j.siteAddress || '')}</div>
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
        <p class="small">The undersigned contractor certifies that, to the best of the contractor's knowledge, the work covered by this application has been completed in accordance with the contract documents, that all amounts have been paid by the contractor for work for which previous certificates for payment were issued, and that current payment shown herein is now due.</p>
        <p class="small">Contractor: ${esc(state.company?.name || 'Stellar Glass')}<br><br>By ____________________________ Date __________${state.company?.contactName ? `<br>${esc(state.company.contactName)}${state.company.contactTitle ? ', ' + esc(state.company.contactTitle) : ''}` : ''}</p>
        <p class="small">State of ____________ County of ____________<br>Subscribed and sworn before me this ____ day of ____________, 20__<br>Notary public ____________________________ My commission expires __________</p>
      </div>
    </div>
    <div class="page-break"></div>
    ${letterhead('Continuation Sheet', `<div class="small">AIA G703 format</div><div>Application No. ${esc(p.number)}</div><div>Period to ${fmtDate(p.periodTo)}</div>`)}
    <table class="doc-table g703 small"><thead><tr><th>A<br>Item</th><th>B<br>Description of work</th><th class="num">C<br>Scheduled value</th><th class="num">D<br>From previous application</th><th class="num">E<br>This period</th><th class="num">F<br>Materials presently stored</th><th class="num">G<br>Total completed and stored to date</th><th class="num">%<br>(G÷C)</th><th class="num">H<br>Balance to finish</th><th class="num">I<br>Retainage</th></tr></thead><tbody>
    ${(p.lines || []).map((l, i) => { const r = s.rows[i]; return `<tr><td>${esc(l.item)}</td><td>${esc(l.desc)}</td><td class="num">${money(r.value)}</td><td class="num">${money(r.prevWork)}</td><td class="num">${money(r.thisWork)}</td><td class="num">${money(r.stored)}</td><td class="num">${money(r.completed)}</td><td class="num">${pctFmt(r.pct)}</td><td class="num">${money(r.balance)}</td><td class="num">${money(r.retainage)}</td></tr>`; }).join('')}
    </tbody><tfoot><tr><td></td><td><b>Grand totals</b></td><td class="num">${money(t.value)}</td><td class="num">${money(t.prevWork)}</td><td class="num">${money(t.thisWork)}</td><td class="num">${money(t.stored)}</td><td class="num">${money(t.completed)}</td><td class="num">${pctFmt(t.pct)}</td><td class="num">${money(t.balance)}</td><td class="num">${money(t.retainage)}</td></tr></tfoot></table>`, 'wide');
}

export function invoiceDoc(id) {
  const inv = get('invoices', id);
  if (!inv) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const t = invoiceTotals(inv);
  return page(`Invoice ${inv.number}`, `
    ${letterhead('Invoice', `<div>No. ${esc(inv.number)}</div><div>${fmtDate(inv.date)}</div>${inv.dueDate ? `<div class="small">Due ${fmtDate(inv.dueDate)}</div>` : ''}${inv.status === 'paid' ? `<div class="paid-stamp">PAID ${fmtDate(inv.paidDate)}</div>` : ''}`)}
    ${party(inv.jobId, inv.customerId)}
    <table class="doc-table"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>
    ${(inv.lines || []).map((l) => `<tr><td>${esc(l.desc)}</td><td class="num">${esc(l.qty)}</td><td class="num">${money(l.price)}</td><td class="num">${money((Number(l.qty) || 0) * (Number(l.price) || 0))}</td></tr>`).join('')}
    </tbody></table>
    <div class="doc-totals"><div class="tr"><span>Subtotal</span><span>${money(t.subtotal)}</span></div><div class="tr"><span>Sales tax</span><span>${money(t.tax)}</span></div><div class="tr grand"><span>Total due</span><span>${money(inv.status === 'paid' ? 0 : t.total)}</span></div></div>
    ${inv.notes ? `<div class="doc-terms">${nl(inv.notes)}</div>` : ''}`);
}
