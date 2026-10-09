// Money math for estimates, pay apps and invoices. Pure functions, no Firebase,
// so they can be unit tested in Node (test/calc.test.mjs).

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => Number(n) || 0;

// Square feet of one glass lite from inches, before quantity.
export function sqft(widthIn, heightIn) {
  return (num(widthIn) * num(heightIn)) / 144;
}

// Billable quantity of an estimate line.
// sqft lines: qty x (W x H / 144), with each lite billed at no less than minSqft.
export function lineQty(line) {
  if (line.unit === 'sqft') {
    const each = Math.max(sqft(line.widthIn, line.heightIn), num(line.minSqft));
    return num(line.qty) * each;
  }
  return num(line.qty);
}

export function lineTotal(line) {
  return round2(lineQty(line) * num(line.price));
}

// Estimate totals: subtotal, markup, minimum charge, tax.
export function estimateTotals(est) {
  const lines = est.lines || [];
  const subtotal = round2(lines.reduce((s, l) => s + lineTotal(l), 0));
  const markup = round2(subtotal * num(est.markupPct) / 100);
  let beforeTax = round2(subtotal + markup);
  const minApplied = beforeTax < num(est.minCharge);
  if (minApplied) beforeTax = round2(num(est.minCharge));
  const taxable = round2(lines.filter((l) => l.taxable !== false).reduce((s, l) => s + lineTotal(l), 0));
  // Tax applies to the taxable share of the price after markup / minimum.
  const share = subtotal > 0 ? taxable / subtotal : 1;
  const tax = round2(beforeTax * share * num(est.taxPct) / 100);
  return { subtotal, markup, minApplied, beforeTax, tax, total: round2(beforeTax + tax) };
}

// Priced options on a proposal ("Price 1", "Price 2"...). An option marked fromLines takes
// the line-item total; others carry their own lump-sum price. Estimates saved before options
// existed get one option priced from their lines.
export function proposalOptions(est) {
  const total = estimateTotals(est).total;
  const opts = est.options?.length ? est.options : [{ fromLines: true }];
  return opts.map((o, i) => ({ ...o, number: i + 1, price: o.fromLines ? total : round2(o.price) }));
}

// The amount an estimate is worth: its accepted option, or option 1.
export function estimateAmount(est) {
  const opts = proposalOptions(est);
  const i = Number(est.acceptedOption) || 0;
  return (opts[i] || opts[0]).price;
}

// Lines marked taxable: false (labor, deposits, credits) are left out of the sales tax.
// functions/lines.js does the same math for the Stripe invoice.
export function invoiceTotals(inv) {
  const lines = inv.lines || [];
  const amount = (l) => round2(num(l.qty) * num(l.price));
  const subtotal = round2(lines.reduce((s, l) => s + amount(l), 0));
  const taxable = round2(lines.filter((l) => l.taxable !== false).reduce((s, l) => s + amount(l), 0));
  const tax = round2(taxable * num(inv.taxPct) / 100);
  return { subtotal, tax, total: round2(subtotal + tax) };
}

// Contract sum after approved change orders.
export function contractSum(contract, changeOrders = []) {
  const original = round2(contract.amount);
  const approved = changeOrders.filter((c) => c.status === 'approved');
  const additions = round2(approved.filter((c) => num(c.amount) > 0).reduce((s, c) => s + num(c.amount), 0));
  const deductions = round2(approved.filter((c) => num(c.amount) < 0).reduce((s, c) => s - num(c.amount), 0));
  const netChange = round2(additions - deductions);
  return { original, additions, deductions, netChange, toDate: round2(original + netChange) };
}

// One G703 continuation sheet row.
//   C value, D from previous applications, E this period, F materials presently stored.
export function g703Row(line, retainagePct, storedRetainagePct = retainagePct) {
  const value = num(line.value);
  const prevWork = num(line.prevWork);
  const thisWork = num(line.thisWork);
  const stored = num(line.stored);
  const completed = round2(prevWork + thisWork + stored); // G
  const pct = value ? completed / value : 0;
  const balance = round2(value - completed); // H
  const retainage = round2((prevWork + thisWork) * num(retainagePct) / 100 + stored * num(storedRetainagePct) / 100); // I
  return { value: round2(value), prevWork: round2(prevWork), thisWork: round2(thisWork), stored: round2(stored), completed, pct, balance, retainage };
}

// G702 application summary from the G703 rows.
//   previousCertificates: total earned less retainage on the prior application (its line 6).
export function g702(payApp, contract, changeOrders = [], previousCertificates = 0) {
  const pct = num(payApp.retainagePct);
  const storedPct = payApp.storedRetainagePct == null || payApp.storedRetainagePct === '' ? pct : num(payApp.storedRetainagePct);
  const rows = (payApp.lines || []).map((l) => g703Row(l, pct, storedPct));
  const sum = (k) => round2(rows.reduce((s, r) => s + r[k], 0));
  const cs = contractSum(contract, changeOrders);
  const totalCompleted = sum('completed'); // line 4
  const workRetainage = round2((sum('prevWork') + sum('thisWork')) * pct / 100); // 5a
  const storedRetainage = round2(sum('stored') * storedPct / 100); // 5b
  const totalRetainage = round2(workRetainage + storedRetainage); // 5
  const earnedLessRetainage = round2(totalCompleted - totalRetainage); // 6
  const prev = round2(previousCertificates); // 7
  const currentDue = round2(earnedLessRetainage - prev); // 8
  const balanceToFinish = round2(cs.toDate - earnedLessRetainage); // 9
  return {
    rows,
    totals: {
      value: sum('value'), prevWork: sum('prevWork'), thisWork: sum('thisWork'), stored: sum('stored'),
      completed: totalCompleted, balance: sum('balance'), retainage: sum('retainage'),
      pct: sum('value') ? totalCompleted / sum('value') : 0,
    },
    originalSum: cs.original, netChange: cs.netChange, additions: cs.additions, deductions: cs.deductions,
    contractSumToDate: cs.toDate, totalCompleted, workRetainage, storedRetainage, totalRetainage,
    earnedLessRetainage, previousCertificates: prev, currentDue, balanceToFinish,
  };
}

// Lines for the next pay app: previous column D = prior D + E; stored carries over until billed as work.
export function nextPayAppLines(sov, prior) {
  const priorByItem = new Map((prior?.lines || []).map((l) => [String(l.item), l]));
  return sov.map((s) => {
    const p = priorByItem.get(String(s.item));
    return {
      item: s.item, desc: s.desc, value: round2(s.value),
      prevWork: p ? round2(num(p.prevWork) + num(p.thisWork)) : 0,
      thisWork: 0,
      stored: p ? round2(p.stored) : 0,
    };
  });
}

export const money = (n) => (num(n) < 0 ? '-$' : '$') + Math.abs(num(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const pctFmt = (f) => (num(f) * 100).toFixed(1) + '%';

// ---------- Billing a proposal ----------
const UNIT_WORDS = { lf: ['lin ft', 'lin ft'], hour: ['hour', 'hours'] };
const qtyText = (q) => String(Math.round(num(q) * 10000) / 10000);
const isWholeCents = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

// Rounds amounts to cents so they add up to exactly `target`; the rounding goes on the largest one.
function spread(raws, target) {
  const out = raws.map(round2);
  const diff = round2(target - out.reduce((s, a) => s + a, 0));
  if (diff && out.length) {
    let k = 0;
    out.forEach((a, i) => { if (Math.abs(a) > Math.abs(out[k])) k = i; });
    out[k] = round2(out[k] + diff);
  }
  return out;
}

// An invoice line for a proposal line billed at `amount`: quantity x unit price when that comes
// out to whole cents, otherwise one amount with the quantity written into the description.
function billLine(l, amount) {
  const qty = num(l.qty);
  const taxable = l.taxable !== false;
  const desc = String(l.desc || '').trim();
  if (l.unit === 'sqft') {
    const size = `${qtyText(l.widthIn)}" × ${qtyText(l.heightIn)}"`;
    const each = Math.max(sqft(l.widthIn, l.heightIn), num(l.minSqft));
    const per = qty > 0 ? round2(amount / qty) : 0;
    if (Number.isInteger(qty) && qty > 0 && round2(per * qty) === amount) {
      return { desc: `${desc}, ${size} (${qtyText(round2(each))} sq ft each)`, qty, price: per, taxable };
    }
    return { desc: `${desc}, ${qtyText(qty)} × ${size} (${qtyText(round2(lineQty(l)))} sq ft)`, qty: 1, price: amount, taxable };
  }
  const [one, many] = UNIT_WORDS[l.unit] || [];
  const unitPrice = qty > 0 ? amount / qty : 0;
  if (qty > 0 && qty !== 1 && isWholeCents(unitPrice) && round2(round2(unitPrice) * qty) === amount) {
    return { desc: one ? `${desc} (per ${one})` : desc, qty, price: round2(unitPrice), taxable };
  }
  const detail = qty && qty !== 1 ? ` (${qtyText(qty)}${one ? ` ${many}` : ''})` : '';
  return { desc: desc + detail, qty: 1, price: amount, taxable };
}

const acceptedOption = (est) => {
  const opts = proposalOptions(est);
  return { opts, opt: opts[Number(est.acceptedOption) || 0] || opts[0] };
};
const optionLabel = (o) => `Price ${o.number}${o.name ? ` (${o.name})` : ''}`;

// What to invoice for a proposal's accepted price. A price that comes from the line items is billed
// line by line, priced the way the printed proposal shows them (markup and any minimum charge spread
// across the lines), with labor and other non-taxable lines left out of the tax, so the invoice comes
// to the proposal's price and tax to the cent. A lump-sum price is billed as one line with its specs.
export function proposalBill(est) {
  const { opts, opt } = acceptedOption(est);
  const src = (est.lines || []).filter((l) => String(l.desc || '').trim() || lineTotal(l));
  if (!opt.fromLines || !src.length) {
    const specs = String(opt.specs || '').split('\n').map((x) => x.trim()).filter(Boolean).join('; ');
    const desc = `Supply and install per proposal ${est.number}${opts.length > 1 ? `, ${optionLabel(opt)}` : ''}${specs ? `: ${specs}` : ''}`;
    return { option: opt, taxPct: 0, lines: [{ desc, qty: 1, price: opt.price, taxable: false }] };
  }
  const t = estimateTotals(est);
  const taxPct = num(est.taxPct);
  if (t.subtotal <= 0) {
    return { option: opt, taxPct, lines: [{ desc: `Supply and install per proposal ${est.number}`, qty: 1, price: t.beforeTax, taxable: true }] };
  }
  const factor = t.beforeTax / t.subtotal;
  const isTaxed = (l) => l.taxable !== false;
  const taxedRaw = src.filter(isTaxed).map((l) => lineTotal(l) * factor);
  const untaxedRaw = src.filter((l) => !isTaxed(l)).map((l) => lineTotal(l) * factor);
  // Split the price between taxed and untaxed lines, a cent either way if needed so the
  // invoice's tax equals the proposal's.
  let taxed = t.beforeTax;
  if (!taxedRaw.length) taxed = 0;
  else if (untaxedRaw.length) {
    const raw = round2(taxedRaw.reduce((s, a) => s + a, 0));
    taxed = [0, -0.01, 0.01, -0.02, 0.02].map((d) => round2(raw + d)).find((c) => round2(c * taxPct / 100) === t.tax) ?? raw;
  }
  const taxedAmts = spread(taxedRaw, taxed);
  const untaxedAmts = spread(untaxedRaw, round2(t.beforeTax - taxed));
  let ti = 0;
  let ui = 0;
  const lines = src.map((l) => billLine(l, isTaxed(l) ? taxedAmts[ti++] : untaxedAmts[ui++]));
  return { option: opt, taxPct, lines };
}

// ---------- Deposit and payment status ----------
// The deposit a proposal asks for: a percent of the accepted price (50% to start) or a dollar
// amount, never more than the price. Proposals saved before the deposit field existed take the
// percent from their typed payment terms ("A 50% deposit is required...").
export function proposalDeposit(est, option) {
  const opt = option || acceptedOption(est).opt;
  const legacy = est.depositType == null;
  const type = est.depositType === 'amount' ? 'amount' : 'percent';
  const typed = /(\d{1,3}(?:\.\d+)?)\s*%\s*deposit/i.exec(est.terms || '')?.[1];
  const typedValue = Math.max(0, legacy ? num(typed ?? 50) : num(est.depositValue));
  const value = type === 'percent' ? Math.min(typedValue, 100) : typedValue;
  const amount = type === 'amount' ? Math.min(round2(value), opt.price) : round2(opt.price * value / 100);
  return { type, value, amount: Math.max(0, amount) };
}

// The deposit sentence printed on the proposal ('' for no deposit).
export function depositSentence(est) {
  const d = proposalDeposit(est);
  if (!d.value) return '';
  const end = 'is required before materials can be ordered';
  if (d.type === 'amount') return `A ${money(d.value)} deposit ${end}.`;
  const opts = proposalOptions(est);
  if (opts.length === 1) return `A ${qtyText(d.value)}% deposit (${money(d.amount)}) ${end}.`;
  return `A ${qtyText(d.value)}% deposit ${end} (${opts.map((o) => `${optionLabel(o)}: ${money(proposalDeposit(est, o).amount)}`).join('; ')}).`;
}

// The old typed deposit sentence, which the deposit field now prints.
export const termsWithoutDeposit = (terms) => String(terms || '')
  .replace(/A\s+\d{1,3}(?:\.\d+)?%\s+deposit is required before materials can be ordered\.?\s*/i, '').trim();

// Payment terms as printed: the deposit sentence, then the other terms. Proposals saved before the
// deposit field existed print their terms as typed.
export function proposalTerms(est) {
  if (est.depositType == null) return String(est.terms || '').trim();
  return [depositSentence(est), String(est.terms || '').trim()].filter(Boolean).join('\n');
}

// The deposit invoice line: the proposal's deposit, as one line that isn't taxed again.
export function depositLine(est) {
  const { opts, opt } = acceptedOption(est);
  const d = proposalDeposit(est, opt);
  const pct = d.type === 'percent' ? ` (${qtyText(d.value)}%)` : '';
  return { desc: `Deposit${pct} on proposal ${est.number}${opts.length > 1 ? `, ${optionLabel(opt)}` : ''}`, qty: 1, price: d.amount, taxable: false };
}

// How much of a proposal's accepted price has been paid, from the invoices made from it (void ones
// don't count). status: 'not billed', 'unpaid', 'partly paid' or 'paid'.
export function proposalPayment(est, invoices) {
  const price = estimateAmount(est);
  const live = (invoices || []).filter((i) => i.status !== 'void');
  const paid = round2(live.reduce((s, i) => s + (i.status === 'paid' ? invoiceTotals(i).total : num(i.stripe?.amountPaid)), 0));
  const status = !live.length ? 'not billed' : paid <= 0 ? 'unpaid' : paid >= price ? 'paid' : 'partly paid';
  return { price, paid, balance: round2(Math.max(0, price - paid)), status };
}
