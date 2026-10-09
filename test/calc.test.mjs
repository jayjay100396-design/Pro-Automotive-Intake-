import assert from 'node:assert/strict';
import {
  sqft, lineTotal, estimateTotals, proposalOptions, estimateAmount, invoiceTotals, contractSum, g702, nextPayAppLines,
  proposalBill, depositLine,
} from '../public/js/calc.js';

describe('money math', () => {
  it('bills glass by square foot with a per-lite minimum', () => {
    assert.equal(sqft(48, 96), 32);
    assert.equal(lineTotal({ unit: 'sqft', qty: 2, widthIn: 48, heightIn: 96, price: 10 }), 640);
    // 12" x 12" is 1 sq ft but bills at the 3 sq ft minimum.
    assert.equal(lineTotal({ unit: 'sqft', qty: 4, widthIn: 12, heightIn: 12, minSqft: 3, price: 10 }), 120);
    assert.equal(lineTotal({ unit: 'each', qty: 3, price: 99.99 }), 299.97);
  });

  it('applies markup, minimum charge and tax only on taxable lines', () => {
    const t = estimateTotals({ markupPct: 10, taxPct: 7, minCharge: 0, lines: [
      { unit: 'each', qty: 1, price: 1000, taxable: true },
      { unit: 'hour', qty: 10, price: 100, taxable: false },
    ] });
    assert.deepEqual([t.subtotal, t.markup, t.beforeTax, t.tax, t.total], [2000, 200, 2200, 77, 2277]);
    const small = estimateTotals({ minCharge: 250, taxPct: 0, lines: [{ unit: 'each', qty: 1, price: 80 }] });
    assert.equal(small.minApplied, true);
    assert.equal(small.total, 250);
  });

  it('prices proposal options from lines or as lump sums', () => {
    const lines = [{ unit: 'each', qty: 1, price: 1000 }];
    assert.deepEqual(proposalOptions({ lines }).map((o) => o.price), [1000]);
    const est = { lines, taxPct: 0, options: [{ fromLines: true }, { name: 'Akela', price: 1234.5 }] };
    assert.deepEqual(proposalOptions(est).map((o) => [o.number, o.price]), [[1, 1000], [2, 1234.5]]);
    assert.equal(estimateAmount(est), 1000);
    assert.equal(estimateAmount({ ...est, acceptedOption: 1 }), 1234.5);
  });

  it('totals invoices', () => {
    assert.deepEqual(invoiceTotals({ taxPct: 7, lines: [{ qty: 2, price: 50 }] }), { subtotal: 100, tax: 7, total: 107 });
    // Lines marked not taxable (labor, a deposit credit) stay out of the tax.
    const t = invoiceTotals({ taxPct: 7, lines: [{ qty: 1, price: 1000 }, { qty: 2, price: 100, taxable: false }, { qty: 1, price: -300, taxable: false }] });
    assert.deepEqual(t, { subtotal: 900, tax: 70, total: 970 });
  });

  it('adds only approved change orders to the contract sum', () => {
    const s = contractSum({ amount: 10000 }, [
      { amount: 1500, status: 'approved' }, { amount: -500, status: 'approved' }, { amount: 9999, status: 'pending' },
    ]);
    assert.deepEqual(s, { original: 10000, additions: 1500, deductions: 500, netChange: 1000, toDate: 11000 });
  });

  it('computes a G702 / G703 pay app with retainage and previous certificates', () => {
    const contract = { amount: 100000 };
    const cos = [{ amount: 10000, status: 'approved' }];
    const app1 = { retainagePct: 10, lines: [
      { item: 1, value: 60000, prevWork: 0, thisWork: 30000, stored: 0 },
      { item: 2, value: 40000, prevWork: 0, thisWork: 0, stored: 10000 },
      { item: 'CO1', value: 10000, prevWork: 0, thisWork: 0, stored: 0 },
    ] };
    const s1 = g702(app1, contract, cos, 0);
    assert.equal(s1.contractSumToDate, 110000);
    assert.equal(s1.totalCompleted, 40000);
    assert.equal(s1.totalRetainage, 4000);
    assert.equal(s1.earnedLessRetainage, 36000);
    assert.equal(s1.currentDue, 36000);
    assert.equal(s1.balanceToFinish, 74000);
    assert.equal(s1.rows[0].pct, 0.5);

    // Next app: previous = prior D + E; stored carries over until it is billed as work.
    const lines = nextPayAppLines(app1.lines, app1);
    assert.deepEqual(lines.map((l) => [l.prevWork, l.stored]), [[30000, 0], [0, 10000], [0, 0]]);
    lines[0].thisWork = 30000; // line 1 done
    lines[1].thisWork = 10000; lines[1].stored = 0; // stored glass installed
    const s2 = g702({ retainagePct: 10, lines }, contract, cos, s1.earnedLessRetainage);
    assert.equal(s2.totalCompleted, 70000);
    assert.equal(s2.earnedLessRetainage, 63000);
    assert.equal(s2.currentDue, 27000);
  });

  it('bills a proposal line by line to the cent', () => {
    const est = { number: 1005, markupPct: 15, minCharge: 0, taxPct: 7, lines: [
      { desc: 'Clear tempered 1/4"', unit: 'sqft', qty: 3, widthIn: 36, heightIn: 80, minSqft: 3, price: 18.5 },
      { desc: 'Door closer', unit: 'each', qty: 2, price: 245 },
      { desc: 'Install labor', unit: 'hour', qty: 6.5, price: 85, taxable: false },
      { desc: '', unit: 'each', qty: 1, price: 0 },
    ] };
    const bill = proposalBill(est);
    const t = estimateTotals(est);
    const inv = invoiceTotals({ taxPct: bill.taxPct, lines: bill.lines });
    assert.deepEqual([inv.subtotal, inv.tax, inv.total], [t.beforeTax, t.tax, t.total]);
    assert.equal(bill.lines.length, 3); // the blank line is dropped
    assert.equal(bill.lines[0].desc, 'Clear tempered 1/4", 36" × 80" (20 sq ft each)');
    assert.equal(bill.lines[0].qty, 3);
    assert.equal(bill.lines[1].desc, 'Door closer');
    assert.equal(bill.lines[2].taxable, false);
    assert.match(bill.lines[2].desc, /^Install labor/);
  });

  it('keeps random proposals exact when billed', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    for (let i = 0; i < 500; i++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => {
        const unit = pick(['sqft', 'each', 'lf', 'hour']);
        return {
          desc: 'Item', unit, qty: unit === 'hour' ? Math.round(rnd() * 400) / 10 : 1 + Math.floor(rnd() * 8),
          widthIn: 12 + Math.round(rnd() * 960) / 8, heightIn: 12 + Math.round(rnd() * 960) / 8, minSqft: pick([0, 3]),
          price: Math.round(rnd() * 50000) / 100, taxable: rnd() > 0.3,
        };
      });
      const est = { number: 1000 + i, lines, markupPct: pick([0, 10, 12.5, 33]), minCharge: pick([0, 250, 5000]), taxPct: pick([0, 6, 7, 7.5]) };
      const t = estimateTotals(est);
      const bill = proposalBill(est);
      const inv = invoiceTotals({ taxPct: bill.taxPct, lines: bill.lines });
      assert.deepEqual([inv.subtotal, inv.tax, inv.total], [t.beforeTax, t.tax, t.total], JSON.stringify(est));
    }
  });

  it('bills a lump-sum price as one line, and deposits on the accepted price', () => {
    const est = { number: 1006, taxPct: 7, lines: [{ desc: 'Door', unit: 'each', qty: 1, price: 1000 }],
      options: [{ fromLines: true }, { name: 'Akela', price: 4200, specs: 'Frameless shower\n3/8" clear' }], acceptedOption: 1 };
    const bill = proposalBill(est);
    assert.equal(bill.taxPct, 0);
    assert.deepEqual(bill.lines, [{ desc: 'Supply and install per proposal 1006, Price 2 (Akela): Frameless shower; 3/8" clear', qty: 1, price: 4200, taxable: false }]);
    assert.deepEqual(depositLine(est, 50), { desc: 'Deposit (50%) on proposal 1006, Price 2 (Akela)', qty: 1, price: 2100, taxable: false });
    assert.equal(depositLine({ ...est, acceptedOption: 0 }, 50).price, 535); // half of $1,070 with tax
  });

  it('can hold a different retainage on stored materials', () => {
    const s = g702({ retainagePct: 10, storedRetainagePct: 0, lines: [{ value: 1000, thisWork: 500, stored: 200 }] }, { amount: 1000 });
    assert.equal(s.totalRetainage, 50);
  });
});
