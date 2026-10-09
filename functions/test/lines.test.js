import assert from 'node:assert/strict';
import { stripeItems, itemsTotalCents, invoiceTotals, daysUntilDue, floridaDate, clip } from '../lines.js';
import { invoiceTotals as appTotals, estimateTotals, proposalBill } from '../../public/js/calc.js';

describe('Stripe invoice items', () => {
  it('sends whole quantities as quantity x unit price, and tax as its own line', () => {
    const { items, totalCents } = stripeItems({ taxPct: 7, lines: [
      { desc: 'Door closer', qty: 2, price: 245 },
      { desc: 'Install labor', qty: 6.5, price: 85, taxable: false },
      { desc: 'Less deposit, invoice 1007', qty: 1, price: -500, taxable: false },
      { desc: '', qty: 1, price: 0 },
    ] });
    assert.deepEqual(items, [
      { description: 'Door closer', quantity: 2, unit_amount_decimal: '24500' },
      { description: 'Install labor (6.5 × $85.00)', amount: 55250 },
      { description: 'Less deposit, invoice 1007', amount: -50000 },
      { description: 'Sales tax (7% on $490.00)', amount: 3430 },
    ]);
    assert.equal(totalCents, 49000 + 55250 - 50000 + 3430);
    assert.equal(itemsTotalCents(items), totalCents);
  });

  it('writes the quantity into the description when the unit price has fractions of a cent', () => {
    const { items } = stripeItems({ taxPct: 0, lines: [{ desc: 'Glass', qty: 3, price: 33.333 }] });
    assert.deepEqual(items, [{ description: 'Glass (3 × $33.33)', amount: 10000 }]);
  });

  it('always comes to the same cent as the invoice in the app', () => {
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 1000; i++) {
      const inv = {
        taxPct: [0, 6, 7, 7.5][i % 4],
        lines: Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => ({
          desc: 'Line', qty: rnd() > 0.5 ? 1 + Math.floor(rnd() * 20) : Math.round(rnd() * 1000) / 100,
          price: Math.round((rnd() - 0.1) * 1e6) / 100 + (rnd() > 0.9 ? 0.005 : 0), taxable: rnd() > 0.3,
        })),
      };
      const { items, totalCents } = stripeItems(inv);
      const app = appTotals(inv);
      assert.equal(totalCents, Math.round(app.total * 100), JSON.stringify(inv));
      assert.equal(itemsTotalCents(items), totalCents, JSON.stringify(inv));
      assert.deepEqual(invoiceTotals(inv), { ...app, taxable: invoiceTotals(inv).taxable });
    }
  });

  it('bills a proposal through Stripe for exactly its price', () => {
    const est = { number: 1005, markupPct: 12.5, minCharge: 0, taxPct: 7, lines: [
      { desc: 'Storefront glass', unit: 'sqft', qty: 4, widthIn: 47.25, heightIn: 95.5, minSqft: 3, price: 21.75 },
      { desc: 'Aluminum framing', unit: 'lf', qty: 63.5, price: 38.1 },
      { desc: 'Install labor', unit: 'hour', qty: 14, price: 85, taxable: false },
    ] };
    const bill = proposalBill(est);
    const { items, totalCents } = stripeItems({ taxPct: bill.taxPct, lines: bill.lines });
    assert.equal(totalCents, Math.round(estimateTotals(est).total * 100));
    assert.equal(itemsTotalCents(items), totalCents);
  });
});

describe('Stripe invoice details', () => {
  it('counts days to the due date from today in Florida', () => {
    const lateEvening = new Date('2026-10-10T01:00:00Z'); // 9 pm on Oct 9 in Lakeland
    assert.equal(floridaDate(lateEvening), '2026-10-09');
    assert.equal(daysUntilDue('2026-11-08', lateEvening), 30);
    assert.equal(daysUntilDue('2026-10-09', lateEvening), 1); // due today: Stripe needs at least a day
    assert.equal(daysUntilDue('', lateEvening), 30);
  });

  it('clips text to Stripe limits', () => {
    assert.equal(clip('  Lakeland  ', 40), 'Lakeland');
    assert.equal(clip('x'.repeat(30), 26).length, 26);
    assert.equal(clip(null, 10), '');
  });
});
