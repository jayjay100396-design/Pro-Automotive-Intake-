// Billing pieces added to the proposal and invoice editors and to Settings:
//   - Billing card on a proposal: deposit and final invoices, line by line from the proposal.
//   - Payments card on an invoice: payments recorded by hand (cash, check or other).
//   - Online payment card on an invoice: send it with Stripe, copy the link, check, void.
//   - Online payments card in Settings: the switch for Stripe, whether it's connected, and the Business ID.
import { state, putOnce, get, where, nextNumber, can, onChange, updateWith, updateCompany } from './data.js';
import {
  invoiceTotals, proposalBill, depositLine, proposalDeposit, proposalPayment, proposalOptions, estimateAmount, money, round2,
  paidOn, billedOn, dueOn, creditedOn,
} from './calc.js';
import { esc, today, addDays, fmtDate, badge, toast, formData } from './ui.js';
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
// Invoices made here take the next id in the proposal's own series (its id, then -1, -2, …),
// and putOnce only makes one if that id is free. So two devices clicking at the same moment
// can't both bill the same balance: the second finds its id taken.
const nextProposalId = (estimateId) => {
  const seq = (id) => (id.startsWith(`${estimateId}-`) && /^\d+$/.test(id.slice(estimateId.length + 1)) ? Number(id.slice(estimateId.length + 1)) : 0);
  return `${estimateId}-${Math.max(0, ...fromProposal(estimateId).map((i) => seq(i.id))) + 1}`;
};

const proposalSig = (e) => {
  const d = proposalDeposit(e);
  return JSON.stringify([
    s(e.number), s(e.jobId), n(e.markupPct), n(e.minCharge), n(e.taxPct), n(e.acceptedOption), d.type, d.value,
    (e.options || []).map((o) => [s(o.name), !!o.fromLines, o.fromLines ? 0 : n(o.price), s(o.specs)]),
    (e.lines || []).filter((l) => l.desc || l.price)
      .map((l) => [s(l.desc), s(l.unit), n(l.qty), n(l.widthIn), n(l.heightIn), n(l.minSqft), n(l.price), l.taxable !== false]),
  ]);
};

// A Stripe invoice that can still be paid: an open one, or one marked uncollectible in Stripe (Stripe
// still takes payment on it).
const payable = (st) => st?.status === 'open' || st?.status === 'uncollectible';

// Where an invoice stands, in a few words.
function invoiceNote(inv) {
  const st = inv.stripe || {};
  if (inv.status === 'paid') {
    if (st.status !== 'paid') return `paid${inv.paidDate ? ` ${fmtDate(inv.paidDate)}` : ''}`;
    // Credit on the customer's Stripe account, or a credit note, can settle it all with no payment.
    const how = n(st.paidOnline) > 0 ? 'paid online' : n(st.balanceApplied) > 0 ? 'paid from credit in Stripe'
      : n(st.preCredited) > 0 ? 'credited in Stripe' : 'paid online';
    return `${how}${st.paidAt ? ` ${when(st.paidAt)}` : ''}`;
  }
  if (payable(st)) {
    if (n(st.paidOnline) > 0) return `${money(st.paidOnline)} paid online`;
    const credit = Math.max(0, n(st.balanceApplied)) + n(st.preCredited);
    if (credit > 0) return `${money(credit)} credited in Stripe`;
    if (st.status === 'uncollectible') return 'uncollectible in Stripe';
    return st.sentTo ? `emailed with Stripe${st.sentAt ? ` ${when(st.sentAt)}` : ''}` : 'payment link ready';
  }
  if (inv.status === 'unpaid' && paidOn(inv) > 0) return `${money(paidOn(inv))} paid`;
  return '';
}

// The contract a proposal became, if any, and whether its pay apps have started billing. A contract's
// pay apps bill the rest of the job and take off what the proposal's invoices billed (payAppSummary),
// so there's no final invoice from the proposal then, and no deposit invoice once a pay app exists.
function contractOf(estimateId) {
  const contract = where('contracts', 'estimateId', estimateId)[0] || null;
  return { contract, billing: !!contract && where('payApps', 'contractId', contract.id).length > 0 };
}

// e: the proposal as the editor has it (for the deposit); the invoices and payments come from the data.
function billingHtml(estimateId, e) {
  const invs = fromProposal(estimateId);
  const pay = proposalPayment(e, invs);
  const opts = proposalOptions(e);
  const opt = opts[n(e.acceptedOption)] || opts[0];
  const dep = proposalDeposit(e, opt);
  const { contract, billing } = contractOf(estimateId);
  const open = state.company?.onlinePayments ? 'record a payment or email it with Stripe' : 'record a payment';
  return `<div class="row between"><h2>Billing</h2>${pay.status === 'not billed' || contract ? '' : badge(pay.status)}</div>
    ${contract ? `<p class="hint">This proposal became <a href="#/contracts/${esc(contract.id)}">contract ${esc(contract.number)}</a>, so its pay apps bill the rest of the job, less what the invoices here bill. ${billing ? 'Its pay apps have started, so bill anything more on them (a deposit, for example, as materials stored).' : 'A deposit invoice made here before its first pay app comes off the pay apps too.'}</p>` : ''}
    <div class="totals">
      <div class="tr"><span>${opts.length > 1 ? `Accepted price (Price ${opt.number})` : 'Price'}</span><span>${money(pay.price)}</span></div>
      <div class="tr"><span>Paid</span><span>${money(pay.paid)}</span></div>
      ${contract ? '' : `<div class="tr grand"><span>Balance</span><span>${money(pay.balance)}</span></div>`}
    </div>
    ${invs.length ? `<ul class="links top-gap">${invs.map((i) => `<li><a href="#/invoices/${esc(i.id)}">Invoice ${esc(i.number)}</a> ${esc(KIND[i.kind] || '')} ${badge(i.status)}<span class="small muted">${esc(invoiceNote(i))}</span><span class="num">${money(invoiceTotals(i).total)}</span></li>`).join('')}</ul>`
    : '<p class="muted top-gap">No invoices from this proposal yet.</p>'}
    ${can.bill() && !billing ? `<div class="row top-gap">
      <button type="button" class="btn" id="mkdeposit" ${dep.amount > 0 ? '' : 'disabled'}>Deposit invoice${dep.amount > 0 ? `: ${money(dep.amount)}` : ''}</button>
      ${contract ? '' : '<button type="button" class="btn primary" id="mkfinal">Final invoice</button>'}
    </div>
    <p class="hint">The deposit (${dep.value ? (dep.type === 'percent' ? `${dep.value}% of the price` : money(dep.value)) : 'none'}) is set under Terms above.${contract ? '' : ' The final invoice lists each line of the accepted price, priced as the printed proposal shows it, with tax only on taxable lines, and subtracts deposit invoices.'} Open an invoice to ${open}.</p>` : ''}`;
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
    const { contract, billing } = contractOf(estimateId);
    if (billing) return toast(`Contract ${contract.number}'s pay apps have started, so bill this on them.`, true);
    if (kind === 'final' && contract) return toast(`This proposal became contract ${contract.number}, so its pay apps bill the rest.`, true);
    const earlier = fromProposal(estimateId).filter((i) => i.status !== 'void');
    const same = earlier.filter((i) => i.kind === kind);
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
      const prior = earlier.filter((i) => i.kind === 'deposit' || i.kind === 'final');
      // One edited after its Stripe invoice went out: the customer would still pay the Stripe amount,
      // so that gets sorted out first.
      const stale = prior.find((d) => d.status === 'unpaid' && payable(d.stripe)
        && Math.round(invoiceTotals(d).total * 100) !== Math.round(stripeBilled(d.stripe) * 100));
      if (stale) {
        return toast(`Invoice ${stale.number} comes to ${money(invoiceTotals(stale).total)}, but its Stripe invoice is for ${money(stripeBilled(stale.stripe))}. Void that Stripe invoice and send a new one first.`, true);
      }
      // Deposits and any earlier final invoice come off: what was paid on them (payments recorded, or
      // Stripe's amount less refunds), or what they ask for while unpaid (less credit notes on their
      // Stripe invoice). One refunded in full takes nothing off.
      const credits = prior.map((d) => ({
        desc: `Less ${d.kind === 'final' ? 'final invoice' : 'deposit, invoice'} ${d.number}`, qty: 1,
        price: -billedOn(d), taxable: false,
      })).filter((l) => l.price);
      inv = { ...base, kind, dueDate: addDays(today(), 30), taxPct: bill.taxPct, lines: [...bill.lines, ...credits] };
    }
    inv.total = invoiceTotals(inv).total;
    if (inv.total <= 0) return toast('There\'s nothing left to bill on this proposal.', true);
    const more = kind === 'final' ? ` for the ${money(inv.total)} left` : '';
    if (same.length && !confirm(`This proposal already has ${kind} invoice ${same.map((i) => i.number).join(', ')}. Make another one${more}?`)) return;
    try {
      const id = nextProposalId(estimateId);
      if (!(await putOnce('invoices', id, inv))) {
        return toast('Someone just made an invoice from this proposal. It shows in the Billing card; make another only if it\'s still needed.', true);
      }
      toast(`${KIND[kind]} invoice ${inv.number} created`);
      go(`#/invoices/${id}`);
    } catch (err) {
      console.error(err);
      toast(err.code === 'permission-denied' ? 'Your role can\'t make invoices.'
        : err.code === 'unavailable' ? 'You\'re offline. Connect to the internet, then make the invoice.' : err.message, true);
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
// Everything a Stripe invoice shows from the bill, and from its job (i.job: name, site and PO).
// The server keeps what it sent in stripe.sent.
const stripeSig = (i) => JSON.stringify([
  s(i.number), s(i.jobId), s(i.date), n(i.taxPct), s(i.dueDate), s(i.notes ?? state.company?.invoiceNotes),
  (i.lines || []).filter((l) => l.desc || l.price).map((l) => [s(l.desc), n(l.qty), n(l.price), l.taxable !== false]),
  [s(i.job?.name), s(i.job?.siteAddress), s(i.job?.poNumber)],
]);
// Unsaved changes that matter before sending: the above, and the status (paid or void bills aren't sent).
const invoiceSig = (i) => `${stripeSig(i)}${s(i.status)}`;

const customerOf = (inv) => get('customers', inv.customerId || get('jobs', inv.jobId)?.customerId) || null;

// The server gives up on a half-made Stripe invoice after 3 minutes, so it can be tried again.
const stillCreating = (st) => st.status === 'creating' && Date.now() - (st.claimedAt?.toMillis?.() || 0) < 180e3;

// A refund through a credit note on the Stripe invoice comes back to the app (the webhook hears of it).
const GIVE_BACK = 'To give money back, open the invoice in Stripe and issue a credit note with a refund; it then shows here.';

// What a Stripe invoice bills: what it asks for, plus credit on the customer's Stripe account that Stripe
// used on it (less a balance they owed that it added) and what credit notes took off before payment.
const stripeBilled = (st) => n(st.amountDue) + n(st.balanceApplied) + n(st.preCredited);

// Paid through Stripe for real, or out for payment on a live Stripe invoice: the bill stays as it is
// (firestore.rules), so its form is locked. A test-mode one isn't real money.
export const frozen = (st) => !!st?.livemode && (st.status === 'paid' || payable(st));
export const lockNote = (st) => (!frozen(st) ? '' : st.status === 'paid' ? 'Paid through Stripe, so this invoice stays as it was paid.'
  : 'Sent with Stripe, so this invoice can\'t change while the customer can pay it. To change it, void the Stripe invoice (Online payment, below), then send it again.');

// Part paid online: Stripe won't void an invoice that has payments on it. (A credit note for the whole
// invoice turns it paid, with what was paid refunded; Stripe's dashboard has none for uncollectible ones.)
// Credit from the customer's Stripe account isn't a payment: a void gives it back to them.
const partPaid = (st) => (payable(st) && n(st.paidOnline) > 0
  ? `${money(st.paidOnline)} of this invoice was paid online, and Stripe can't void an invoice with a payment on it. If the rest came another way, mark the invoice paid in Stripe's dashboard and it turns Paid here.${st.status === 'open' ? ' To cancel it, issue a credit note there for the whole invoice, refunding what was paid.' : ''}`
  : '');

function stripeHtml(inv, busy) {
  const st = inv.stripe || {};
  const email = customerOf(inv)?.email || '';
  const test = st.invoiceId && !st.livemode ? ' <span class="badge">test mode</span>' : '';
  let body;
  if (busy || stillCreating(st)) {
    body = '<p class="muted">Working with Stripe…</p>';
  } else if (st.status === 'paid') {
    body = `<p class="ok">Paid through Stripe${st.paidAt ? ` on ${when(st.paidAt)}` : ''}${test}.</p>
      ${n(st.preCredited) > 0 ? `<p class="small">A credit note in Stripe took ${money(st.preCredited)} off it before it was paid.</p>` : ''}
      ${n(st.balanceApplied) > 0 ? `<p class="small">${money(st.balanceApplied)} of it came from credit on the customer's Stripe account.</p>` : ''}
      ${n(st.credited) > 0 ? `<p class="small">${money(st.credited)} of it was refunded or credited back in Stripe, so ${money(st.amountPaid)} counts as paid.</p>` : ''}
      ${n(st.overpaid) > 0 ? `<p class="small">The customer paid ${money(st.overpaid)} more than it asked for. Stripe put that on their account as credit for their next invoice, so it counts there.</p>` : ''}
      ${st.hostedUrl || st.pdfUrl ? `<div class="row">${st.hostedUrl ? `<a class="btn small" href="${esc(st.hostedUrl)}" target="_blank" rel="noopener">Receipt page</a>` : ''}${st.pdfUrl ? `<a class="btn small" href="${esc(st.pdfUrl)}" target="_blank" rel="noopener">Stripe PDF</a>` : ''}</div>` : ''}`;
  } else if (payable(st)) {
    const now = invoiceTotals(inv).total;
    const changed = Math.round(now * 100) !== Math.round(stripeBilled(st) * 100);
    // Edited since the Stripe invoice was made: lines, tax, notes, date, due date, number, job, or the
    // job's name, site or PO.
    const edited = changed || (!!st.sent && stripeSig({ ...inv, job: get('jobs', inv.jobId) }) !== stripeSig(st.sent));
    const part = n(st.paidOnline) > 0 ? ` ${money(st.paidOnline)} is paid so far, ${money(n(st.amountDue) - n(st.paidOnline))} to go.` : '';
    const credit = (n(st.balanceApplied) > 0 ? ` Stripe took off ${money(st.balanceApplied)} of credit on the customer's account.`
      : n(st.balanceApplied) < 0 ? ` Stripe added ${money(-n(st.balanceApplied))} the customer owed from before.` : '')
      + (n(st.preCredited) > 0 ? ` A credit note in Stripe took off ${money(st.preCredited)}.` : '');
    // Marked uncollectible in Stripe's dashboard: it isn't emailed again, and a new one waits for a void.
    const written = st.status === 'uncollectible';
    body = `<p>Stripe invoice ${esc(st.number || '')}${test} ${written ? 'was marked uncollectible in Stripe, but it can still be paid' : 'is waiting for payment'}: <b>${money(st.amountDue)}</b>.${credit}${part}
      ${written ? (n(st.paidOnline) > 0 ? '' : 'Void it before sending a new one.')
    : !st.sentTo ? 'It hasn\'t been emailed; send the link yourself, or email it from here.'
      : st.livemode ? `Stripe emailed it to ${esc(st.sentTo)}${st.sentAt ? ` on ${when(st.sentAt)}` : ''}.`
        : `Marked as emailed to ${esc(st.sentTo)}, but Stripe doesn't send emails in test mode.`}</p>
      ${changed ? `<p class="warn small">This invoice now comes to ${money(now)}. Void the Stripe invoice and send a new one so the customer sees the new amount.</p>`
    : edited ? '<p class="warn small">This invoice or its job changed after the Stripe invoice was made. Void the Stripe invoice and send a new one so the customer sees the changes.</p>' : ''}
      <div class="row">
        ${st.hostedUrl ? `<a class="btn small" href="${esc(st.hostedUrl)}" target="_blank" rel="noopener">Open payment page</a>
        <button type="button" class="btn small" data-act="copy">Copy payment link</button>` : ''}
        ${st.pdfUrl ? `<a class="btn small" href="${esc(st.pdfUrl)}" target="_blank" rel="noopener">Stripe PDF</a>` : ''}
        ${email && !edited && !written ? `<button type="button" class="btn small" data-act="email">${st.sentTo ? 'Email it again' : 'Email it'}</button>` : ''}
        <button type="button" class="btn small" data-act="sync">Check payment</button>
        <button type="button" class="btn small danger" data-act="void">Void Stripe invoice</button>
      </div>`;
  } else if (inv.status === 'paid') {
    body = '<p class="muted">Paid here (not through Stripe).</p>';
  } else if (inv.status === 'void') {
    body = '<p class="muted">This invoice is void.</p>';
  } else if (inv.payments?.length) {
    // Stripe would ask for the whole invoice, so payments recorded here and Stripe don't mix on one bill.
    body = `${st.status === 'void' && st.number ? `<p class="small muted">The earlier Stripe invoice ${esc(st.number)} was voided.</p>` : ''}
      <p class="small muted">Payments are recorded on this invoice, so it can't also go out with Stripe: Stripe would ask for the whole amount. To collect the rest online, make a new invoice for what's left.</p>`;
  } else if (!state.company?.onlinePayments) {
    body = `${st.status === 'void' && st.number ? `<p class="small muted">The earlier Stripe invoice ${esc(st.number)} was voided.</p>` : ''}
      <p class="small muted">Online payments are off, so this invoice can't go out with Stripe. The owner can turn them on in Settings.</p>`;
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

// Online payments stay off until the owner turns them on in Settings. An invoice whose Stripe invoice can
// still be paid (or was paid, or is being made) keeps its card either way, so it can be checked or voided.
export const stripeCard = (inv) => {
  const st = inv?.stripe || {};
  return can.bill() && (state.company?.onlinePayments || payable(st) || ['creating', 'paid'].includes(st.status))
    ? '<div class="card top-gap" id="stripe-card"></div>' : '';
};

// Locks the invoice form while the bill is frozen (see frozen), saying why, and unlocks it once it isn't
// (say its Stripe invoice was voided).
function lockForm(root, st) {
  const lock = frozen(st);
  root.querySelectorAll('#f fieldset, #f button').forEach((el) => { el.disabled = lock; });
  const note = root.querySelector('#locknote');
  if (!note) return;
  note.hidden = !lock;
  note.textContent = lockNote(st);
}

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
    // Paid through Stripe while open here (the Payments card puts the form's status in step).
    if (inv.status === 'paid' && !wasPaid && inv.stripe?.status === 'paid') toast(`Invoice ${inv.number} is paid`);
    wasPaid = inv.status === 'paid';
    lockForm(root, inv.stripe || {});
  };

  const act = async (fn, ok) => {
    busy = true;
    draw();
    try {
      const r = await fn();
      if (r?.warning) toast(r.warning, true);
      else if (ok) toast(typeof ok === 'function' ? ok(r) : ok);
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
      // In test mode Stripe marks the invoice sent but doesn't email anyone.
      const sent = (r) => (r?.livemode ? `Stripe emailed it to ${r.sentTo || email}` : 'Test mode: Stripe doesn\'t send emails, so use Open payment page to try it.');
      act(() => sendWithStripe(invoiceId, kind === 'email'), kind === 'email' ? sent : 'Payment link ready');
    } else if (kind === 'copy') {
      copy(inv.stripe.hostedUrl);
    } else if (kind === 'sync') {
      act(() => checkWithStripe(invoiceId), null);
    } else if (kind === 'void') {
      if (partPaid(inv.stripe)) return toast(partPaid(inv.stripe), true);
      if (confirm('Void the Stripe invoice? Its payment link stops working.')) act(() => voidWithStripe(invoiceId), 'Stripe invoice voided');
    }
  });

  // Deleting the bill would leave its Stripe invoice payable, with nowhere to record the payment.
  // Once paid through Stripe for real, the bill is the record of that payment (firestore.rules too);
  // a test-mode one can go.
  const guard = (ev) => {
    if (!card.isConnected) return root.removeEventListener('click', guard, true);
    if (!ev.target.closest('#del')) return;
    const st = get('invoices', invoiceId)?.stripe || {};
    const why = busy || stillCreating(st) ? 'Wait until Stripe has finished with this invoice.'
      : payable(st) ? partPaid(st) || 'Void the Stripe invoice first (Online payment, below), then delete this invoice.'
        : st.status === 'paid' && st.livemode ? `This invoice was paid through Stripe, so it stays as the record of that payment. ${GIVE_BACK}` : '';
    if (!why) return;
    ev.stopPropagation();
    toast(why, true);
  };
  root.addEventListener('click', guard, true);

  draw();
  const off = onChange(() => {
    if (!card.isConnected) return off();
    if (!busy) draw();
  });
  // Opening an invoice that's out for payment asks Stripe whether it has been paid.
  const inv = get('invoices', invoiceId);
  if (payable(inv?.stripe) && inv.status !== 'paid') checkWithStripe(invoiceId).catch(() => {});
}

// A Stripe invoice that can still be paid is voided first (after asking), so the customer can't also pay
// it online, unless it has a payment on it. False: stop.
async function voidFirst(invoiceId, question) {
  const st = get('invoices', invoiceId)?.stripe || {};
  if (stillCreating(st)) {
    toast('Wait until Stripe has finished with this invoice.', true);
    return false;
  }
  if (!payable(st)) return true;
  if (partPaid(st)) {
    toast(partPaid(st), true);
    return false;
  }
  if (!confirm(question)) return false;
  try {
    await voidWithStripe(invoiceId);
    toast('Stripe invoice voided');
    return true;
  } catch (e) {
    toast(paymentsError(e), true);
    return false;
  }
}

// Saving a bill as paid or void with the Status field while its Stripe invoice can still be paid: void
// that first. False: don't save.
export async function settleStripeFirst(invoiceId, status) {
  const inv = get('invoices', invoiceId);
  if (!inv || inv.status === status) return true;
  // Paid through Stripe: the money came in, so the bill stays paid.
  if (inv.stripe?.status === 'paid' && status !== 'paid') {
    toast(`This invoice was paid through Stripe, so it stays paid. ${GIVE_BACK}`, true);
    return false;
  }
  if (!['paid', 'void'].includes(status)) return true;
  return voidFirst(invoiceId, status === 'paid'
    ? 'Marking this invoice paid voids its Stripe invoice, so the customer can\'t pay it online too. Go ahead?'
    : 'Voiding this invoice voids its Stripe invoice too, so the payment link stops working. Go ahead?');
}

// ---------- Invoice: payments recorded by hand ----------
// payments: [{ id, method: 'cash' | 'check' | 'other', amount, date, ref (check # or reference), note, by, at }]
const METHODS = [['cash', 'Cash'], ['check', 'Check'], ['other', 'Other']];
const REF_LABEL = { check: 'Check #', cash: 'Receipt # (optional)', other: 'Reference (optional)' };
export const howPaid = (p) => (p.method === 'check' ? `Check${p.ref ? ` #${p.ref}` : ''}`
  : `${p.method === 'cash' ? 'Cash' : 'Other'}${p.ref ? ` (${p.ref})` : ''}`);
const newPayment = (fields) => ({ id: crypto.randomUUID(), ref: '', note: '', ...fields, by: state.user?.uid || null, at: new Date().toISOString() });
const problem = (message) => Object.assign(new Error(message), { code: 'app' });

// The status and paid date that go with these payments: paid once they cover what the bill asks for
// (on the latest one's date), else unpaid. A void bill stays void.
function withPayments(inv, payments) {
  if (inv.status === 'void') return { payments };
  const probe = { ...inv, payments, status: 'unpaid' };
  const covered = paidOn(probe) >= billedOn(probe);
  const last = payments.map((p) => p.date).filter(Boolean).sort().pop() || today();
  return { payments, status: covered ? 'paid' : 'unpaid', paidDate: covered ? last : '' };
}

// Saving the invoice form: paid goes with payments. Choosing Paid records a payment for what's left
// ("Other"), so the amount paid is kept if the bill is edited later, and a bill with payments recorded
// stays paid or partly paid to match them. Returns what to save, and a note when the status isn't the
// one chosen.
export function paidFields(cur, data) {
  if (data.status === 'void' || cur.stripe?.status === 'paid') return { data };
  const next = { ...cur, ...data };
  if (data.status === 'paid' && cur.status !== 'paid') {
    const left = dueOn({ ...next, status: 'unpaid' });
    if (!(left > 0)) return { data };
    const date = data.paidDate || today();
    return { data: { ...data, ...withPayments(next, [...(cur.payments || []), newPayment({ method: 'other', amount: left, date, note: 'Marked paid' })]), paidDate: date } };
  }
  if (!cur.payments?.length) return { data };
  const fields = withPayments(next, cur.payments);
  const probe = { ...next, ...fields, status: 'unpaid' };
  const note = fields.status === data.status ? ''
    : fields.status === 'paid' ? 'The payments recorded on this invoice cover it, so it stays paid. To change that, remove a payment under Payments.'
      : `The payments recorded on this invoice come to ${money(paidOn(probe))} of ${money(billedOn(probe))}, so it's partly paid.`;
  return { data: { ...data, ...fields, paidDate: fields.status === 'paid' ? data.paidDate || fields.paidDate : '' }, note };
}

function paymentsHtml(inv, busy) {
  const st = inv.stripe || {};
  const pays = [...(inv.payments || [])].sort((a, b) => s(a.date).localeCompare(s(b.date)));
  const list = pays.length ? `<ul class="links">${pays.map((p) => `<li>${fmtDate(p.date)} · ${esc(howPaid(p))}${p.note ? ` <span class="small muted">${esc(p.note)}</span>` : ''}<span class="num">${money(p.amount)}</span>${can.remove() && !frozen(st) ? `<button type="button" class="icon" data-unpay="${esc(p.id)}" title="Remove this payment" aria-label="Remove this payment">✕</button>` : ''}</li>`).join('')}</ul>` : '';
  const credit = creditedOn(inv);
  const totals = `<div class="totals">
      <div class="tr"><span>Invoice total</span><span>${money(invoiceTotals(inv).total)}</span></div>
      ${credit > 0 ? `<div class="tr"><span>Credit note in Stripe</span><span>${money(-credit)}</span></div>` : ''}
      <div class="tr"><span>Paid</span><span>${money(paidOn(inv))}</span></div>
      <div class="tr grand"><span>Balance due</span><span>${money(inv.status === 'paid' ? 0 : dueOn(inv))}</span></div>
    </div>`;
  let body;
  if (inv.status === 'void') body = `${list}<p class="muted">This invoice is void.</p>`;
  else if (st.status === 'paid') body = `${list}<p class="muted">Paid through Stripe (Online payment, below).</p>`;
  else if (inv.status === 'paid') {
    body = pays.length ? `${list}${totals}` : `<p class="muted">Marked paid${inv.paidDate ? ` ${fmtDate(inv.paidDate)}` : ''}. To undo that, set Status to unpaid above and save.</p>`;
  } else {
    const due = dueOn(inv);
    body = `${pays.length ? '' : '<p class="small muted">Record cash, check or other payments here as they come in. The invoice turns Paid once they cover it.</p>'}
      ${list}${pays.length || paidOn(inv) > 0 || credit > 0 ? totals : ''}
      ${can.bill() ? `<form id="payform" class="grid4 top-gap">
        <label>Paid by <select name="method">${METHODS.map(([v, t]) => `<option value="${v}" ${v === 'check' ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Amount <input name="amount" type="number" step="0.01" min="0.01" value="${due > 0 ? due : ''}" required></label>
        <label>Date received <input name="date" type="date" value="${today()}" required></label>
        <label><span data-reflabel>${REF_LABEL.check}</span> <input name="ref" maxlength="80"></label>
        <label class="span2">Note <input name="note" maxlength="300" placeholder="Optional"></label>
        <label>&nbsp;<button class="btn primary" ${busy ? 'disabled' : ''}>Record payment</button></label>
      </form>` : ''}`;
  }
  return `<h2>Payments</h2>${body}`;
}

export const paymentsCard = () => '<div class="card top-gap" id="pay-card"></div>';

// current(): the invoice as the editor has it now (unsaved changes included).
export function mountPaymentsCard(root, invoiceId, current) {
  const card = root.querySelector('#pay-card');
  if (!card) return;
  const unsaved = unsavedCheck(current, () => get('invoices', invoiceId), invoiceSig);
  let busy = false;
  let shown = null;
  const first = get('invoices', invoiceId) || {};
  let saved = { status: first.status, paidDate: first.paidDate || '' };
  const draw = () => {
    const inv = get('invoices', invoiceId);
    if (!inv) return;
    const html = paymentsHtml(inv, busy);
    if (html !== shown) card.innerHTML = shown = html;
    // Payments (recorded here, on another device, or through Stripe) change the status: the form's Status
    // and Paid on follow, unless they were changed by hand, so a later Save doesn't undo it.
    const f = root.querySelector('#f');
    const now = { status: inv.status, paidDate: inv.paidDate || '' };
    const button = root.querySelector('#paid');
    if (button) button.hidden = inv.status !== 'unpaid' || inv.stripe?.status === 'paid';
    if (f?.elements.status && f.elements.status.value === saved.status) f.elements.status.value = now.status;
    if (f?.elements.paidDate && f.elements.paidDate.value === saved.paidDate) f.elements.paidDate.value = now.paidDate;
    saved = now;
  };

  const run = async (fn, ok) => {
    busy = true;
    draw();
    try {
      const r = await fn();
      toast(typeof ok === 'function' ? ok(r) : ok);
    } catch (e) {
      console.error(e);
      toast(e.code === 'permission-denied' ? 'This invoice can\'t change right now. Reopen it and try again.'
        : e.code === 'unavailable' ? 'You\'re offline. Connect to the internet, then try again.' : e.message, true);
    } finally {
      busy = false;
      draw();
    }
  };

  card.addEventListener('change', (ev) => {
    const sel = ev.target.closest('select[name=method]');
    if (!sel) return;
    card.querySelector('[data-reflabel]').textContent = REF_LABEL[sel.value];
    card.querySelector('#payform [name=ref]').placeholder = sel.value === 'other' ? 'e.g. Zelle, card or money order' : '';
  });

  card.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('#payform');
    if (!form) return;
    ev.preventDefault();
    if (busy) return;
    if (unsaved()) return toast('Save the invoice first, then record the payment.', true);
    const d = formData(form);
    const amount = round2(d.amount);
    if (!(amount > 0)) return toast('Enter the amount that was paid.', true);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) return toast('Enter the date it was paid.', true);
    const due = dueOn(get('invoices', invoiceId) || {});
    if (amount > due && !confirm(`That's ${money(round2(amount - due))} more than the ${money(due)} owed. Record it anyway?`)) return;
    if (get('invoices', invoiceId)?.stripe?.status === 'paid') return toast(`This invoice was paid through Stripe. ${GIVE_BACK}`, true);
    if (!(await voidFirst(invoiceId, 'Recording a payment here voids the Stripe invoice, so the customer can\'t also pay it online. Go ahead?'))) return;
    const rec = newPayment({ method: d.method, amount, date: d.date, ref: d.ref, note: d.note });
    run(() => updateWith('invoices', invoiceId, (cur) => {
      if (cur.status === 'void') throw problem('This invoice is void.');
      if (cur.stripe?.status === 'paid') throw problem('This invoice was paid through Stripe.');
      if (stillCreating(cur.stripe || {})) throw problem('Wait until Stripe has finished with this invoice.');
      if (payable(cur.stripe)) throw problem('Its Stripe invoice can still be paid. Void it first (Online payment, below).');
      return withPayments(cur, [...(cur.payments || []), rec]);
    }), (r) => (r.status === 'paid' ? `Payment recorded. Invoice ${r.number} is paid.` : `Payment recorded. ${money(dueOn(r))} left to pay.`));
  });

  card.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-unpay]');
    if (!b || busy) return;
    const p = (get('invoices', invoiceId)?.payments || []).find((x) => x.id === b.dataset.unpay);
    if (!p || !confirm(`Remove the ${money(p.amount)} payment (${howPaid(p)}, ${fmtDate(p.date)})?`)) return;
    run(() => updateWith('invoices', invoiceId, (cur) => withPayments(cur, (cur.payments || []).filter((x) => x.id !== p.id))), 'Payment removed');
  });

  draw();
  const off = onChange(() => {
    if (!card.isConnected) return off();
    if (!busy) draw();
  });
}

// ---------- Settings ----------
export function paymentsSettings() {
  if (!can.bill()) return '';
  const on = !!state.company?.onlinePayments;
  return `<div class="card" id="payments"><h2>Online payments (Stripe)</h2>
    <label class="inline"><span><input type="checkbox" id="onlinepay" ${on ? 'checked' : ''} ${can.manage() ? '' : 'disabled'}> Let customers pay invoices online with Stripe</span></label>
    <p id="paystatus" class="muted">Checking Stripe…</p>
    ${can.manage() ? `<p class="small">Business ID for the Stripe setup: <code>${esc(state.companyId)}</code> <button type="button" class="btn small" id="copyid">Copy</button></p>` : ''}
    <p class="hint">While this is off, record cash, check and other payments on each invoice. Once the business's Stripe account is connected (STRIPE_SETUP.md has the steps), the owner turns this on and invoices get an Online payment card, so customers can pay by card or bank transfer.</p>
  </div>`;
}

export function mountPaymentsSettings(root) {
  const el = root.querySelector('#paystatus');
  if (!el) return;
  root.querySelector('#copyid')?.addEventListener('click', () => copy(state.companyId, 'Business ID copied'));
  const status = paymentsStatus().catch((e) => ({ connected: false, problem: paymentsError(e) }));
  status.then((st) => {
    el.className = st.connected ? 'ok' : 'warn';
    el.textContent = st.connected
      ? `Connected to Stripe${st.livemode ? '.' : ' (test mode: nothing is really charged).'}`
      : st.problem || 'Not connected to Stripe.';
  });
  // Turning it on checks that Stripe is connected first, so invoices don't offer something that can't work.
  const box = root.querySelector('#onlinepay');
  box?.addEventListener('change', async () => {
    const on = box.checked;
    box.disabled = true;
    try {
      const st = on ? await paymentsStatus().catch((e) => ({ connected: false, problem: paymentsError(e) })) : null;
      if (st && !st.connected) {
        box.checked = false;
        return toast(`Online payments can't go on yet. ${st.problem || 'Stripe isn\'t connected.'}`, true);
      }
      await updateCompany({ onlinePayments: on });
      toast(on ? 'Online payments are on' : 'Online payments are off');
    } catch (e) {
      box.checked = !on;
      toast(e.code === 'permission-denied' ? 'Only the owner can change this.' : e.message, true);
    } finally {
      box.disabled = !can.manage();
    }
  });
}
