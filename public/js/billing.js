// Billing pieces added to the proposal and invoice editors and to Settings:
//   - Billing card on a proposal: deposit and final invoices, line by line from the proposal.
//   - Online payment card on an invoice: send it with Stripe, copy the link, check, void.
//   - Online payments card in Settings: is Stripe connected, and the Business ID for setup.
import { state, add, get, where, nextNumber, can, onChange } from './data.js';
import {
  invoiceTotals, proposalBill, depositLine, proposalDeposit, proposalPayment, proposalOptions, estimateAmount, money,
} from './calc.js';
import { esc, today, addDays, fmtDate, badge, toast } from './ui.js';
import { paymentsStatus, sendWithStripe, voidWithStripe, checkWithStripe, paymentsError } from './payments.js';

const go = (hash) => { location.hash = hash; };
const n = (v) => Number(v) || 0;
const s = (v) => String(v ?? '').trim();
const when = (ts) => (ts?.toDate ? ts.toDate().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

async function copy(text, ok = 'Link copied') {
  try { await navigator.clipboard.writeText(text); toast(ok); } catch { prompt('Copy this:', text); }
}

// Unsaved changes: the editor differs both from what it first showed and from what's saved.
// (Comparing with the first render too avoids false alarms from defaults the editor fills in.)
function unsavedCheck(current, saved, sig) {
  const initial = sig(current());
  return () => {
    const now = sig(current());
    return now !== initial && now !== sig(saved() || {});
  };
}

// ---------- Proposal: deposit and final invoices, and what's been paid ----------
const KIND = { deposit: 'Deposit', final: 'Final' };
const fromProposal = (estimateId) => where('invoices', 'estimateId', estimateId)
  .sort((a, b) => n(a.number) - n(b.number));

const proposalSig = (e) => {
  const d = proposalDeposit(e);
  return JSON.stringify([
    s(e.jobId), n(e.markupPct), n(e.minCharge), n(e.taxPct), n(e.acceptedOption), d.type, d.value,
    (e.options || []).map((o) => [s(o.name), !!o.fromLines, o.fromLines ? 0 : n(o.price), s(o.specs)]),
    (e.lines || []).filter((l) => l.desc || l.price)
      .map((l) => [s(l.desc), s(l.unit), n(l.qty), n(l.widthIn), n(l.heightIn), n(l.minSqft), n(l.price), l.taxable !== false]),
  ]);
};

// Where an invoice stands, in a few words.
function invoiceNote(inv) {
  const st = inv.stripe || {};
  if (inv.status === 'paid') return st.status === 'paid' ? `paid online${st.paidAt ? ` ${when(st.paidAt)}` : ''}` : `paid${inv.paidDate ? ` ${fmtDate(inv.paidDate)}` : ''}`;
  if (st.status === 'open') {
    if (n(st.amountPaid) > 0) return `${money(st.amountPaid)} paid online`;
    return st.sentTo ? `emailed with Stripe${st.sentAt ? ` ${when(st.sentAt)}` : ''}` : 'payment link ready';
  }
  return '';
}

// e: the proposal as the editor has it (for the deposit); the invoices and payments come from the data.
function billingHtml(estimateId, e) {
  const invs = fromProposal(estimateId);
  const pay = proposalPayment(e, invs);
  const opts = proposalOptions(e);
  const opt = opts[n(e.acceptedOption)] || opts[0];
  const dep = proposalDeposit(e, opt);
  const contract = where('contracts', 'estimateId', estimateId)[0];
  return `<div class="row between"><h2>Billing</h2>${pay.status === 'not billed' ? '' : badge(pay.status)}</div>
    ${contract ? `<p class="hint">This proposal became <a href="#/contracts/${esc(contract.id)}">contract ${esc(contract.number)}</a>, so progress billing goes through its pay apps. A deposit invoice still works here.</p>` : ''}
    <div class="totals">
      <div class="tr"><span>${opts.length > 1 ? `Accepted price (Price ${opt.number})` : 'Price'}</span><span>${money(pay.price)}</span></div>
      <div class="tr"><span>Paid</span><span>${money(pay.paid)}</span></div>
      <div class="tr grand"><span>Balance</span><span>${money(pay.balance)}</span></div>
    </div>
    ${invs.length ? `<ul class="links top-gap">${invs.map((i) => `<li><a href="#/invoices/${esc(i.id)}">Invoice ${esc(i.number)}</a> ${esc(KIND[i.kind] || '')} ${badge(i.status)}<span class="small muted">${esc(invoiceNote(i))}</span><span class="num">${money(invoiceTotals(i).total)}</span></li>`).join('')}</ul>`
    : '<p class="muted top-gap">No invoices from this proposal yet.</p>'}
    ${can.bill() ? `<div class="row top-gap">
      <button type="button" class="btn" id="mkdeposit" ${dep.amount > 0 ? '' : 'disabled'}>Deposit invoice${dep.amount > 0 ? `: ${money(dep.amount)}` : ''}</button>
      <button type="button" class="btn primary" id="mkfinal">Final invoice</button>
    </div>
    <p class="hint">The deposit (${dep.value ? (dep.type === 'percent' ? `${dep.value}% of the price` : money(dep.value)) : 'none'}) is set under Terms above. The final invoice lists each line of the accepted price, priced as the printed proposal shows it, with tax only on taxable lines, and subtracts deposit invoices. Open an invoice to email it with Stripe.</p>` : ''}`;
}

export function proposalBilling(estimateId) {
  const e = get('estimates', estimateId);
  return e ? `<div class="card top-gap" id="billing">${billingHtml(estimateId, e)}</div>` : '';
}

// current(): the proposal as the editor has it now (unsaved changes included).
export function mountProposalBilling(root, estimateId, current) {
  const card = root.querySelector('#billing');
  if (!card) return;
  const unsaved = unsavedCheck(current, () => get('estimates', estimateId), proposalSig);
  // Redraw only when something shows differently, so a click isn't lost to a redraw (leaving the
  // deposit field fires a change event between the button's mousedown and mouseup).
  let shown = null;
  const draw = () => {
    const html = billingHtml(estimateId, { ...get('estimates', estimateId), ...current() });
    if (html !== shown) card.innerHTML = shown = html;
  };

  const make = async (kind) => {
    if (unsaved()) return toast('Save the proposal first, then make the invoice.', true);
    const e = get('estimates', estimateId);
    if (!e?.jobId) return toast('Pick a job for this proposal and save it first.', true);
    const earlier = fromProposal(estimateId).filter((i) => i.status !== 'void');
    const same = earlier.filter((i) => i.kind === kind);
    if (same.length && !confirm(`This proposal already has ${kind} invoice ${same.map((i) => i.number).join(', ')}. Make another one?`)) return;
    const base = {
      number: nextNumber('invoices'), jobId: e.jobId, customerId: e.customerId || get('jobs', e.jobId)?.customerId || '',
      estimateId, payAppId: '', date: today(), status: 'unpaid', notes: state.company?.invoiceNotes || '',
      // Shown on the Stripe invoice with what's been paid so far (functions/stripe-invoices.js).
      proposalNumber: e.number ?? '', proposalPrice: estimateAmount(e),
    };
    let inv;
    if (kind === 'deposit') {
      const line = depositLine(e);
      if (!(line.price > 0)) return toast('This proposal has no deposit. Set one under Terms and save.', true);
      inv = { ...base, kind, dueDate: today(), taxPct: 0, lines: [line] };
    } else {
      const bill = proposalBill(e);
      const credits = earlier.filter((i) => i.kind === 'deposit')
        .map((d) => ({ desc: `Less deposit, invoice ${d.number}`, qty: 1, price: -invoiceTotals(d).total, taxable: false }));
      inv = { ...base, kind, dueDate: addDays(today(), 30), taxPct: bill.taxPct, lines: [...bill.lines, ...credits] };
    }
    inv.total = invoiceTotals(inv).total;
    if (inv.total <= 0) return toast('There\'s nothing left to bill on this proposal.', true);
    try {
      const r = await add('invoices', inv);
      toast(`${KIND[kind]} invoice ${inv.number} created`);
      go(`#/invoices/${r.id}`);
    } catch (err) {
      console.error(err);
      toast(err.code === 'permission-denied' ? 'Your role can\'t make invoices.' : err.message, true);
    }
  };
  card.addEventListener('click', (ev) => {
    if (ev.target.closest('#mkdeposit')) make('deposit');
    else if (ev.target.closest('#mkfinal')) make('final');
  });
  // The deposit follows the form as you type; payments show up as they come in.
  root.querySelector('#f')?.addEventListener('input', draw);
  root.querySelector('#f')?.addEventListener('change', draw);
  const off = onChange(() => {
    if (!card.isConnected) return off();
    draw();
  });
  draw();
}

// ---------- Invoice: send with Stripe ----------
const invoiceSig = (i) => JSON.stringify([
  s(i.jobId), n(i.taxPct), s(i.dueDate), s(i.notes ?? state.company?.invoiceNotes),
  (i.lines || []).filter((l) => l.desc || l.price).map((l) => [s(l.desc), n(l.qty), n(l.price), l.taxable !== false]),
]);

const customerOf = (inv) => get('customers', inv.customerId || get('jobs', inv.jobId)?.customerId) || null;

// The server gives up on a half-made Stripe invoice after 3 minutes, so it can be tried again.
const stillCreating = (st) => st.status === 'creating' && Date.now() - (st.claimedAt?.toMillis?.() || 0) < 180e3;

function stripeHtml(inv, busy) {
  const st = inv.stripe || {};
  const email = customerOf(inv)?.email || '';
  const test = st.invoiceId && !st.livemode ? ' <span class="badge">test mode</span>' : '';
  let body;
  if (busy || stillCreating(st)) {
    body = '<p class="muted">Working with Stripe…</p>';
  } else if (st.status === 'paid') {
    body = `<p class="ok">Paid through Stripe${st.paidAt ? ` on ${when(st.paidAt)}` : ''}${test}.</p>
      ${st.hostedUrl || st.pdfUrl ? `<div class="row">${st.hostedUrl ? `<a class="btn small" href="${esc(st.hostedUrl)}" target="_blank" rel="noopener">Receipt page</a>` : ''}${st.pdfUrl ? `<a class="btn small" href="${esc(st.pdfUrl)}" target="_blank" rel="noopener">Stripe PDF</a>` : ''}</div>` : ''}`;
  } else if (st.status === 'open') {
    const now = invoiceTotals(inv).total;
    const changed = Math.round(now * 100) !== Math.round(n(st.amountDue) * 100);
    const part = n(st.amountPaid) > 0 ? ` ${money(st.amountPaid)} is paid so far, ${money(n(st.amountDue) - n(st.amountPaid))} to go.` : '';
    body = `<p>Stripe invoice ${esc(st.number || '')}${test} is waiting for payment: <b>${money(st.amountDue)}</b>.${part}
      ${st.sentTo ? `Stripe emailed it to ${esc(st.sentTo)}${st.sentAt ? ` on ${when(st.sentAt)}` : ''}.` : 'It hasn\'t been emailed; send the link yourself, or email it from here.'}</p>
      ${changed ? `<p class="warn small">This invoice now comes to ${money(now)}. Void the Stripe invoice and send a new one so the customer sees the new amount.</p>` : ''}
      <div class="row">
        ${st.hostedUrl ? `<a class="btn small" href="${esc(st.hostedUrl)}" target="_blank" rel="noopener">Open payment page</a>
        <button type="button" class="btn small" data-act="copy">Copy payment link</button>` : ''}
        ${st.pdfUrl ? `<a class="btn small" href="${esc(st.pdfUrl)}" target="_blank" rel="noopener">Stripe PDF</a>` : ''}
        ${email ? `<button type="button" class="btn small" data-act="email">${st.sentTo ? 'Email it again' : 'Email it'}</button>` : ''}
        <button type="button" class="btn small" data-act="sync">Check payment</button>
        <button type="button" class="btn small danger" data-act="void">Void Stripe invoice</button>
      </div>`;
  } else if (inv.status === 'paid') {
    body = '<p class="muted">Marked paid here (not through Stripe).</p>';
  } else if (inv.status === 'void') {
    body = '<p class="muted">This invoice is void.</p>';
  } else {
    body = `<p class="small muted">Stripe emails ${email ? esc(email) : 'the customer'} this invoice with every line on it and a Pay button for card or bank transfer. It turns Paid here when they pay.</p>
      ${st.status === 'void' && st.number ? `<p class="small muted">The earlier Stripe invoice ${esc(st.number)} was voided.</p>` : ''}
      <div class="row">
        <button type="button" class="btn primary" data-act="email" ${email ? '' : 'disabled'}>Email it with Stripe</button>
        <button type="button" class="btn" data-act="link">Get a payment link</button>
      </div>
      ${email ? '' : '<p class="hint">Add an email address to this customer to have Stripe email it, or get the link and send it yourself.</p>'}`;
  }
  return `<h2>Online payment</h2>${body}${st.error && !busy ? `<p class="warn small">${esc(st.error)}</p>` : ''}`;
}

export const stripeCard = () => (can.bill() ? '<div class="card top-gap" id="stripe-card"></div>' : '');

// current(): the invoice as the editor has it now (unsaved changes included).
export function mountStripeCard(root, invoiceId, current) {
  const card = root.querySelector('#stripe-card');
  if (!card) return;
  const unsaved = unsavedCheck(current, () => get('invoices', invoiceId), invoiceSig);
  let busy = false;
  let wasPaid = get('invoices', invoiceId)?.status === 'paid';

  let shown = null;
  const draw = () => {
    const inv = get('invoices', invoiceId);
    if (!inv) return;
    const html = stripeHtml(inv, busy);
    if (html !== shown) card.innerHTML = shown = html;
    // Paid through Stripe while open here: match the form, so a later Save keeps it paid.
    if (inv.status === 'paid' && !wasPaid) {
      const f = root.querySelector('#f');
      if (f?.elements.status) f.elements.status.value = 'paid';
      if (f?.elements.paidDate && inv.paidDate) f.elements.paidDate.value = inv.paidDate;
      root.querySelector('#paid')?.remove();
      toast(`Invoice ${inv.number} is paid`);
    }
    wasPaid = inv.status === 'paid';
  };

  const act = async (fn, ok) => {
    busy = true;
    draw();
    try {
      const r = await fn();
      if (r?.warning) toast(r.warning, true);
      else if (ok) toast(ok);
    } catch (e) {
      console.error(e);
      toast(paymentsError(e), true);
    } finally {
      busy = false;
      draw();
    }
  };

  card.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b || busy) return;
    const inv = get('invoices', invoiceId);
    const kind = b.dataset.act;
    if (kind === 'email' || kind === 'link') {
      if (unsaved()) return toast('Save the invoice first, then send it with Stripe.', true);
      const email = customerOf(inv)?.email;
      if (kind === 'email' && !confirm(`Have Stripe email invoice ${inv.number} for ${money(invoiceTotals(inv).total)} to ${email}?`)) return;
      act(() => sendWithStripe(invoiceId, kind === 'email'), kind === 'email' ? `Stripe emailed it to ${email}` : 'Payment link ready');
    } else if (kind === 'copy') {
      copy(inv.stripe.hostedUrl);
    } else if (kind === 'sync') {
      act(() => checkWithStripe(invoiceId), null);
    } else if (kind === 'void') {
      if (confirm('Void the Stripe invoice? Its payment link stops working.')) act(() => voidWithStripe(invoiceId), 'Stripe invoice voided');
    }
  });

  // Deleting the bill would leave its Stripe invoice payable, with nowhere to record the payment.
  const guard = (ev) => {
    if (!card.isConnected) return root.removeEventListener('click', guard, true);
    if (!ev.target.closest('#del') || get('invoices', invoiceId)?.stripe?.status !== 'open') return;
    ev.stopPropagation();
    toast('Void the Stripe invoice first (Online payment, below), then delete this invoice.', true);
  };
  root.addEventListener('click', guard, true);

  // Marked paid by hand (say a check came): void the Stripe invoice too, so nobody pays twice.
  root.querySelector('#paid')?.addEventListener('click', () => {
    if (get('invoices', invoiceId)?.stripe?.status !== 'open') return;
    if (confirm('Also void the Stripe invoice, so the customer can\'t pay it online too?')) {
      voidWithStripe(invoiceId).then(() => toast('Stripe invoice voided')).catch((e) => toast(paymentsError(e), true));
    }
  });

  draw();
  const off = onChange(() => {
    if (!card.isConnected) return off();
    if (!busy) draw();
  });
  // Opening an invoice that's out for payment asks Stripe whether it has been paid.
  const inv = get('invoices', invoiceId);
  if (inv?.stripe?.status === 'open' && inv.status !== 'paid') checkWithStripe(invoiceId).catch(() => {});
}

// ---------- Settings ----------
export function paymentsSettings() {
  if (!can.bill()) return '';
  return `<div class="card" id="payments"><h2>Online payments (Stripe)</h2>
    <p id="paystatus" class="muted">Checking Stripe…</p>
    ${can.manage() ? `<p class="small">Business ID for the Stripe setup: <code>${esc(state.companyId)}</code> <button type="button" class="btn small" id="copyid">Copy</button></p>` : ''}
    <p class="hint">Customers can pay invoices by card or bank transfer through Stripe. The setup steps are in STRIPE_SETUP.md with the app's code.</p>
  </div>`;
}

export function mountPaymentsSettings(root) {
  const el = root.querySelector('#paystatus');
  if (!el) return;
  root.querySelector('#copyid')?.addEventListener('click', () => copy(state.companyId, 'Business ID copied'));
  paymentsStatus().then((st) => {
    el.className = st.connected ? 'ok' : 'warn';
    el.textContent = st.connected
      ? `Connected to Stripe${st.livemode ? '.' : ' (test mode: nothing is really charged).'}`
      : st.problem || 'Not connected to Stripe.';
  }).catch((e) => {
    el.className = 'muted';
    el.textContent = paymentsError(e);
  });
}
