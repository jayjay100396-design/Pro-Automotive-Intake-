// Note and description boxes grow with what's in them, so a long note reads in full on the page instead of in a
// small box with its own scrollbar. Every <textarea> gets this, in the app and on the quote page, including ones
// drawn later or kept hidden until something opens (the file viewer, the paste box). A box's rows="" is the
// smallest it gets; a CSS max-height (the paste box has one) is the tallest, past which it scrolls inside.

const sized = new WeakMap(); // textarea -> { width, text } when it was last sized

const shown = (el) => el.isConnected && el.getClientRects().length > 0;
const widthOf = (el) => el.getBoundingClientRect().width;
const boxesIn = (node) => (node.nodeType !== 1 ? [] : node.matches('textarea') ? [node] : [...node.querySelectorAll('textarea')]);

// Sizes a box to its text. Measuring shrinks it for a moment, which can pull the page (or a panel that scrolls,
// or the box itself once it's at its max-height) up when the box is near the bottom, so scroll positions are put back.
function fit(el) {
  if (!shown(el)) return;
  const scrolled = [];
  for (let p = el; p; p = p.parentElement) if (p.scrollTop) scrolled.push([p, p.scrollTop]);
  const css = getComputedStyle(el);
  const edges = css.boxSizing === 'border-box'
    ? parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth)
    : -(parseFloat(css.paddingTop) + parseFloat(css.paddingBottom));
  // Measured without a scrollbar, which would narrow the text and make it wrap taller than it is.
  el.style.overflowY = 'hidden';
  el.style.height = '';
  el.style.height = `${el.scrollHeight + edges}px`;
  // Shrunk to measure, the page can lose its scrollbar (where scrollbars take room, as on Windows), so the text
  // was measured a little wider than it ends up: grow it the rest of the way.
  if (el.scrollHeight > el.clientHeight) el.style.height = `${el.scrollHeight + edges}px`;
  // Held back by its max-height: it scrolls inside from there.
  if (el.scrollHeight - el.clientHeight > 1) el.style.overflowY = 'auto';
  for (const [p, top] of scrolled) if (p.scrollTop !== top) p.scrollTop = top;
  sized.set(el, { width: widthOf(el), text: el.value });
}

// Sizes a box again when it hasn't been yet (it was hidden), its width changed, or its text changed without typing.
const stale = (el) => {
  const was = sized.get(el);
  return !was || was.width !== widthOf(el) || was.text !== el.value;
};
const refit = (el) => { if (shown(el) && stale(el)) fit(el); };

export function autosize(root = document.body) {
  // A box changes width when the window does, when the page grows a scrollbar, and when it's shown or hidden.
  // It's sized on the next frame: changing its size while that's being reported loops the browser's reporting.
  const widths = new ResizeObserver((entries) => {
    const boxes = entries.map((e) => e.target).filter(stale);
    if (boxes.length) requestAnimationFrame(() => boxes.forEach(refit));
  });
  const watch = (el) => { widths.observe(el); refit(el); };
  boxesIn(root).forEach(watch);
  // Boxes drawn into the page later (ones taken out aren't watched any longer), and boxes shown by opening or
  // unhiding what they're in, sized before they're drawn.
  new MutationObserver((records) => {
    for (const r of records) {
      r.removedNodes.forEach((node) => boxesIn(node).forEach((el) => widths.unobserve(el)));
      r.addedNodes.forEach((node) => boxesIn(node).forEach(watch));
      if (r.type === 'attributes') boxesIn(r.target).forEach(refit);
    }
  }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'] });
  // Listened for on the way down, so a page's own handlers can't keep it from a box.
  root.addEventListener('input', (e) => { if (e.target instanceof HTMLTextAreaElement) fit(e.target); }, true);
  // A form's reset puts its text back after this event, so check once it has.
  root.addEventListener('reset', (e) => setTimeout(() => boxesIn(e.target).forEach(refit)), true);
  // Text first drawn in a stand-in font wraps differently once the web font arrives; a box hidden right now
  // is sized again when it shows.
  document.fonts?.addEventListener?.('loadingdone', () => boxesIn(root).forEach((el) => { sized.delete(el); refit(el); }));
}
