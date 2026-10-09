// Stripe invoice items for an app invoice. Pure functions, no Firebase or Stripe, so they can be
// unit tested. The totals use the same math as invoiceTotals in public/js/calc.js, so the Stripe
// invoice always comes to the same cent as the invoice in the app.

const num = (n) => Number(n) || 0;
const round2 = (n) => Math.round(num(n) * 100) / 100;
const toCents = (dollars) => Math.round(round2(dollars) * 100);

// Same as invoiceTotals in public/js/calc.js: lines marked taxable: false are left out of the tax.
export function invoiceTotals(inv) {
  const lines = inv.lines || [];
  const amount = (l) => round2(num(l.qty) * num(l.price));
  const subtotal = round2(lines.reduce((s, l) => s + amount(l), 0));
  const taxable = round2(lines.filter((l) => l.taxable !== false).reduce((s, l) => s + amount(l), 0));
  const tax = round2(taxable * num(inv.taxPct) / 100);
  return { subtotal, taxable, tax, total: round2(subtotal + tax) };
}

const money = (n) => (num(n) < 0 ? '-$' : '$') + Math.abs(num(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyText = (q) => String(Math.round(q * 10000) / 10000);

// One Stripe invoice item per invoice line, plus sales tax as its own item.
// Whole quantities with whole-cent unit prices go as quantity x unit price, which Stripe shows in
// its Qty and Unit price columns. Anything else (fractional quantities, credits, prices with
// fractions of a cent) goes as a single amount with the quantity written into the description.
export function stripeItems(inv) {
  const items = [];
  for (const l of inv.lines || []) {
    const qty = num(l.qty);
    const price = num(l.price);
    const cents = toCents(qty * price);
    const desc = String(l.desc || '').trim();
    if (!cents && !desc) continue;
    const unitCents = price * 100;
    const whole = Number.isInteger(qty) && qty > 0 && unitCents >= 0
      && Math.abs(unitCents - Math.round(unitCents)) < 1e-6 && qty * Math.round(unitCents) === cents;
    if (whole) {
      items.push({ description: desc || 'Item', quantity: qty, unit_amount_decimal: String(Math.round(unitCents)) });
    } else {
      const detail = qty === 1 || !qty ? '' : ` (${qtyText(qty)} × ${money(price)})`;
      items.push({ description: (desc || 'Item') + detail, amount: cents });
    }
  }
  const t = invoiceTotals(inv);
  const taxCents = toCents(t.tax);
  if (taxCents) {
    const base = t.taxable === t.subtotal ? '' : ` on ${money(t.taxable)}`;
    items.push({ description: `Sales tax (${num(inv.taxPct)}%${base})`, amount: taxCents });
  }
  return { items, totalCents: toCents(t.total) };
}

// Cents Stripe will bill for these items.
export const itemsTotalCents = (items) => items.reduce((s, i) => s + (i.amount ?? i.quantity * Number(i.unit_amount_decimal)), 0);

// Calendar date (YYYY-MM-DD) in Florida time.
export const floridaDate = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

// Days from today in Florida to the invoice's due date, at least 1 (Stripe counts from the moment
// the invoice is finalized, so this lands on the due date). No due date: 30 days.
export function daysUntilDue(dueDate, now = new Date()) {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  if (!dueDate || Number.isNaN(due)) return 30;
  const today = Date.parse(`${floridaDate(now)}T00:00:00Z`);
  return Math.max(1, Math.round((due - today) / 864e5));
}

// Stripe limits: custom field names 40 characters, values 140; the memo 1500.
export const clip = (s, max) => {
  const t = String(s ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
