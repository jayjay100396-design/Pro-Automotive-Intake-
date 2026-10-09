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

export function invoiceTotals(inv) {
  const lines = inv.lines || [];
  const subtotal = round2(lines.reduce((s, l) => s + round2(num(l.qty) * num(l.price)), 0));
  const tax = round2(subtotal * num(inv.taxPct) / 100);
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
