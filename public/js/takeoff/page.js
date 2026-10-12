// Takeoff page: reads a drawing set for window types, their sizes and how many of each, lets you
// measure by clicking, and turns the openings into a proposal. Opened from a job file
// (#/takeoff/{fileId}) or from a drawing on the computer (#/takeoff/local?job={jobId}).
import { db } from '../firebase.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { state, get, update, can } from '../data.js';
import { esc, toast } from '../ui.js';
import { safeUrl } from '../files.js';
import { sqft } from '../calc.js';
import { openPdf, pdfjs } from './pdfjs.js';
import { loadPage, findViews, viewAt } from './reader.js';
import { analyze, scopeLine, estimateLines, scaleFromDims, DRAFT_KEY } from './takeoff.js';
import { readMarkups, markupOpenings, withMarkups } from './markups.js';
import { ptsPerInchFromScale, calibrate, measure, snap, scaleLabel, snapScale } from './measure.js';
import { parseDim, fmtFtIn, fmtIn } from './dims.js';
import { readPage, geminiAvailable, imagesFor, estimateCents, usageCents, fmtCents, SHEET_PX } from './gemini.js';
import { openingsFrom } from './vision.js';

const MAX_CANVAS = 6000; // pixels on the long side; bigger sheets are drawn a little softer when zoomed in

const header = (title, actions = '') => `<div class="page-head"><div class="page-title"><h1>${title}</h1></div><div class="actions">${actions}</div></div>`;
const inches = (v) => (v ? fmtIn(v) : '');
const scaleSays = (sc) => [sc.text, sc.how].filter(Boolean).join(', ');

export function takeoffPage(fileId, params) {
  if (!can.edit()) return { html: `${header('Takeoff')}<div class="card"><p>Your role can't make estimates, so takeoffs aren't available.</p></div>` };
  const local = fileId === 'local';
  const jobId = params.get('job') || '';
  let el = null;
  let file = null; // the job file's record
  let pdf = null; // pdf.js document
  let img = null; // a photo or scan opened as an image
  let pageNo = 1;
  let zoom = 1;
  const models = new Map(); // page number -> read page
  let result = null; // what reading the drawing found
  let marks = []; // markups on the drawing
  let rows = []; // the openings table
  let selected = -1; // row the next measurement fills in
  const scales = new Map(); // page number -> { ppi, text, how } set by the person
  let tool = 'none'; // none | measure | calibrate
  let pick = null; // first click of a measurement
  let last = null; // { a, b, inches, dir }
  let pendingCal = null; // two clicked points waiting for their real length
  let renderTask = null;
  let gone = false;
  let gem = null; // what Gemini read: { pages: Map(page -> read), cents, busy, abort }

  const job = () => get('jobs', file?.jobId || jobId);
  const isPdf = () => !!pdf;
  const pageCount = () => (pdf ? pdf.numPages : img ? 1 : 0);

  const html = `${header('Takeoff', `<a class="btn" href="${local ? `#/jobs/${esc(jobId)}?tab=files` : '#/files'}" data-back>Back to files</a>`)}
  <div class="takeoff">
    <section class="card bare tk-view">
      <div class="tk-bar">
        <div class="row">
          <button type="button" class="btn small" data-prev aria-label="Previous sheet">‹</button>
          <select data-sheet aria-label="Sheet"></select>
          <button type="button" class="btn small" data-next aria-label="Next sheet">›</button>
        </div>
        <div class="row">
          <button type="button" class="btn small" data-tool="measure" title="Click two points to measure">Measure</button>
          <button type="button" class="btn small" data-tool="calibrate" title="Click both ends of something you know the size of">Set scale</button>
          <button type="button" class="btn small" data-zoom="out" aria-label="Zoom out">−</button>
          <button type="button" class="btn small" data-zoom="fit">Fit</button>
          <button type="button" class="btn small" data-zoom="in" aria-label="Zoom in">+</button>
        </div>
      </div>
      <div class="tk-scroll" data-scroll><div class="tk-stage" data-stage><canvas data-canvas></canvas><svg data-overlay></svg></div></div>
      <p class="small muted tk-tip" data-tip></p>
    </section>
    <aside class="tk-side stack">
      <div class="card" data-open></div>
      <div class="card" data-read></div>
      <div class="card hidden" data-gemini></div>
      <div class="card" data-measure></div>
      <div class="card">
        <div class="row between"><h2>Openings</h2><button type="button" class="btn small" data-addrow>+ Add row</button></div>
        <div class="scroll"><table class="lines tk-rows">
          <thead><tr><th></th><th>Type</th><th>Qty</th><th>Width</th><th>Height</th><th class="num">Sq ft</th><th></th></tr></thead>
          <tbody data-rows></tbody>
          <tfoot data-totals></tfoot>
        </table></div>
        <p class="hint">Sizes take inches or feet and inches: 54, 53 1/4, 4'-6". Pick a row's circle, then measure, to fill it from the drawing.</p>
        <div class="row">
          <button type="button" class="btn primary" data-estimate>Create proposal</button>
          ${local ? '' : '<button type="button" class="btn" data-save>Save takeoff</button>'}
        </div>
      </div>
      <div class="card hidden" data-found></div>
    </aside>
  </div>`;

  // ---------- Loading ----------

  async function loadRecord() {
    if (local) return null;
    const snap = await getDoc(doc(db, 'companies', state.companyId, 'files', fileId));
    if (!snap.exists()) throw new Error('This file was deleted.');
    return { id: snap.id, ...snap.data() };
  }

  // Forgets the drawing that was open, its scales and what was read from it (not the openings table).
  function reset() {
    renderTask?.cancel();
    pdf?.destroy?.();
    if (img?.src?.startsWith('blob:')) URL.revokeObjectURL(img.src);
    pdf = null;
    img = null;
    pageNo = 1;
    models.clear();
    scales.clear();
    result = null;
    marks = [];
    pick = null;
    last = null;
    pendingCal = null;
    gem?.abort?.abort();
    gem = null;
  }

  const loadImage = (src) => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('This picture couldn\'t be opened.'));
    im.src = src;
  });

  async function openBytes(bytes, type, name) {
    const isPdfFile = /pdf/.test(type) || /\.pdf$/i.test(name);
    if (!isPdfFile && !/^image\/(jpeg|png|webp)$/.test(type)) throw new Error('Takeoffs work on PDF drawings and on photos saved as JPG or PNG.');
    reset();
    if (isPdfFile) pdf = await openPdf(bytes);
    else img = await loadImage(URL.createObjectURL(new Blob([bytes], { type })));
    fillSheets();
    await fit();
    renderRead();
    renderGemini();
    renderMeasure();
  }

  async function openStored() {
    const url = safeUrl(file.url);
    if (!url) throw new Error('This file\'s link isn\'t valid.');
    if (/^image\/(jpeg|png|webp)$/.test(file.contentType || '')) {
      reset();
      img = await loadImage(url);
      fillSheets();
      await fit();
      renderRead();
      renderGemini();
      renderMeasure();
      return;
    }
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      console.error(e);
      throw new Error('Couldn\'t download this drawing. Storage may still need its one-time download setting (CORS, see FIREBASE_SETUP.md). You can open the drawing from your computer instead.');
    }
    if (!res.ok) throw new Error(`Couldn't download this drawing (error ${res.status}).`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await openBytes(bytes, file.contentType || '', file.name || '');
  }

  // A page read for its text and lines (needed for snapping, scales and reading). pdf.js's own copy
  // of the page is let go afterwards; a big set would otherwise hold hundreds of MB.
  async function model(n) {
    if (!pdf) return null;
    if (!models.has(n)) {
      const page = await pdf.getPage(n);
      models.set(n, await loadPage(page, (await pdfjs()).OPS));
      page.cleanup();
    }
    return models.get(n);
  }

  // ---------- Drawing the sheet ----------

  function fillSheets() {
    const sel = el.querySelector('[data-sheet]');
    const names = result?.sheets || [];
    sel.innerHTML = Array.from({ length: pageCount() }, (_, i) => {
      const s = names.find((x) => x.page === i + 1);
      const label = s?.sheet ? `${s.sheet}${s.views?.[0] ? ` · ${s.views[0]}` : ''}` : `Sheet ${i + 1}`;
      return `<option value="${i + 1}" ${i + 1 === pageNo ? 'selected' : ''}>${esc(label)} (${i + 1} of ${pageCount()})</option>`;
    }).join('');
    el.querySelector('[data-prev]').disabled = pageNo <= 1;
    el.querySelector('[data-next]').disabled = pageNo >= pageCount();
  }

  function pageSize() {
    if (img) return { w: img.naturalWidth, h: img.naturalHeight };
    return pdfSize;
  }
  let pdfSize = { w: 612, h: 792 };

  async function fit() {
    if (pdf) {
      const p = await pdf.getPage(pageNo);
      const vp = p.getViewport({ scale: 1 });
      pdfSize = { w: vp.width, h: vp.height };
    }
    const box = el.querySelector('[data-scroll]');
    const { w } = pageSize();
    zoom = Math.max(0.05, (box.clientWidth - 4) / w);
    await draw();
  }

  async function draw() {
    if (gone) return;
    const canvas = el.querySelector('[data-canvas]');
    const svg = el.querySelector('[data-overlay]');
    const stage = el.querySelector('[data-stage]');
    const { w, h } = pageSize();
    const cssW = Math.round(w * zoom);
    const cssH = Math.round(h * zoom);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS / Math.max(cssW, cssH), 3);
    stage.style.width = `${cssW}px`;
    stage.style.height = `${cssH}px`;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.style.width = `${cssW}px`;
    svg.style.height = `${cssH}px`;
    overlay();
    const ctx = canvas.getContext('2d');
    if (img) {
      ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);
      ctx.drawImage(img, 0, 0);
    } else if (pdf) {
      renderTask?.cancel();
      const page = await pdf.getPage(pageNo);
      const vp = page.getViewport({ scale: zoom * dpr });
      renderTask = page.render({ canvasContext: ctx, viewport: vp });
      try { await renderTask.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') console.error(e); }
    }
    tip();
  }

  // Found tags, markups and the current measurement, drawn over the sheet in page units.
  function overlay() {
    const svg = el.querySelector('[data-overlay]');
    const u = 1 / zoom; // one screen pixel in page units
    const parts = [];
    const main = result?.main;
    if (main) {
      for (const [label, places] of Object.entries(main.places || {})) {
        for (const p of places.filter((q) => q.page === pageNo)) {
          parts.push(`<circle cx="${p.x}" cy="${p.y}" r="${16 * u}" class="tk-hit"><title>${esc(label)} counted</title></circle>`);
        }
      }
      if (main.typePage === pageNo) {
        for (const [label, t] of Object.entries(main.types)) {
          parts.push(`<circle cx="${t.at.x}" cy="${t.at.y}" r="${18 * u}" class="tk-type"><title>${esc(label)} ${esc(fmtFtIn(t.widthIn))} x ${esc(fmtFtIn(t.heightIn))}</title></circle>`);
        }
      }
      for (const d of main.repeats || []) {
        if (d.page === pageNo) parts.push(`<circle cx="${d.x}" cy="${d.y}" r="${16 * u}" class="tk-dup"><title>Also shown on another elevation; counted once</title></circle>`);
      }
    }
    const read = gem?.pages.get(pageNo);
    if (read) {
      const main = gemResult().main;
      const { w, h } = pageSize();
      for (const t of read.tags.filter((t) => main && t.shape === main.shape && !/type|schedule|legend/.test(t.where))) {
        parts.push(`<circle cx="${(t.x * w) / read.w}" cy="${(t.y * h) / read.h}" r="${16 * u}" class="tk-hit"><title>${esc(t.label)} counted by Gemini</title></circle>`);
      }
    }
    for (const k of marks.filter((m) => m.page === pageNo)) {
      const [x0, y0, x1, y1] = k.box;
      parts.push(`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" class="tk-mark"><title>${esc(k.text || 'Markup')}</title></rect>`);
    }
    const line = (a, b, cls) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" class="${cls}"/>`;
    const dot = (p) => `<circle cx="${p[0]}" cy="${p[1]}" r="${4 * u}" class="tk-dot"/>`;
    if (pick) parts.push(dot(pick));
    if (pendingCal) parts.push(line(pendingCal.a, pendingCal.b, 'tk-cal'), dot(pendingCal.a), dot(pendingCal.b));
    if (last && last.page === pageNo) {
      parts.push(line(last.a, last.b, 'tk-line'), dot(last.a), dot(last.b));
      const mx = (last.a[0] + last.b[0]) / 2, my = (last.a[1] + last.b[1]) / 2;
      parts.push(`<text x="${mx}" y="${my - 8 * u}" class="tk-label" font-size="${15 * u}">${esc(fmtFtIn(last.inches))}</text>`);
    }
    svg.innerHTML = parts.join('');
  }

  function tip() {
    const t = el.querySelector('[data-tip]');
    const sc = scaleAt(null);
    t.textContent = tool === 'measure'
      ? (sc ? `Click two points to measure. Scale: ${scaleSays(sc)}.` : 'Set the scale first: click "Set scale", then both ends of something you know the size of.')
      : tool === 'calibrate' ? 'Click both ends of something you know the size of, like a dimension line or a door, then type its size.'
        : 'Scroll to move around the sheet. Use Measure to size an opening, or read the whole drawing on the right.';
    el.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('primary', b.dataset.tool === tool));
  }

  // ---------- Scale and measuring ----------

  // The scale for a point on this page: one the person set, else the printed scale of the view
  // there, else the one the sheet's own dimensions give. A printed scale the dimensions around the
  // point disagree with (a title matched to the wrong view, an NTS detail) gives way to them.
  function scaleAt(p) {
    if (scales.has(pageNo)) return scales.get(pageNo);
    const m = models.get(pageNo);
    if (!m) return null;
    const views = findViews(m).filter((v) => v.scale);
    const same = views.length && views.every((v) => v.scale === views[0].scale);
    const v = (p && viewAt(m, p[0], p[1])) || (same ? views[0] : null);
    const fromDims = scaleFromDims(m, p || [m.width / 2, m.height / 2]);
    const printed = v?.scale ? ptsPerInchFromScale(v.scale) : null;
    if (printed && !(fromDims?.count >= 3 && Math.abs(fromDims.ppi - printed) > printed * 0.03)) {
      return { ppi: printed, text: scaleLabel(v.scale), how: 'printed on the sheet' };
    }
    if (fromDims) {
      return { ppi: fromDims.ppi, text: scaleLabel(fromDims.realPerPaper || 72 / fromDims.ppi), how: 'worked out from the dimensions on the sheet' };
    }
    return null;
  }

  async function clickAt(ev) {
    if (tool === 'none') return;
    const svg = el.querySelector('[data-overlay]');
    const r = svg.getBoundingClientRect();
    let p = [(ev.clientX - r.left) / zoom, (ev.clientY - r.top) / zoom];
    const m = await model(pageNo);
    if (m) p = snap(m.segs, p, 7 / zoom);
    if (tool === 'calibrate') {
      if (!pick) { pick = p; overlay(); return; }
      pendingCal = { a: pick, b: p };
      pick = null;
      overlay();
      renderMeasure();
      el.querySelector('[data-callen]')?.focus();
      return;
    }
    if (!pick) { pick = p; last = null; overlay(); return; }
    const sc = scaleAt(pick);
    if (!sc) { pick = null; tip(); toast('Set the scale first.', true); return; }
    const res = measure(pick, p, sc.ppi);
    last = { a: pick, b: p, page: pageNo, scale: scaleSays(sc), ...res };
    pick = null;
    overlay();
    renderMeasure();
  }

  function renderMeasure() {
    const box = el.querySelector('[data-measure]');
    const sc = scaleAt(null);
    const row = rows[selected];
    box.innerHTML = `<h2>Measure</h2>
      <p class="small">${sc ? `Scale: ${esc(scaleSays(sc))}` : isPdf() ? 'Scale: taken from the sheet (its printed scale or its dimensions) when you measure. Use "Set scale" where neither is there.' : 'Scale: not set. Click "Set scale" and click both ends of something you know the size of.'}</p>
      ${pendingCal ? `<form class="row" data-calform><label class="grow">How long is that line? <input data-callen placeholder="e.g. 8'-0&quot; or 36" required></label><button class="btn small primary">Set scale</button></form>` : ''}
      ${last ? `<p><b class="tk-big">${esc(fmtFtIn(last.inches))}</b> <span class="muted small">${esc(fmtIn(last.inches))}${last.dir === 'angled' ? ', on an angle' : ''}</span><br><span class="muted small">Scale: ${esc(last.scale)}</span></p>
      <div class="row">
        <button type="button" class="btn small" data-use="widthIn">Use as width${row ? ` of ${esc(row.label || `row ${selected + 1}`)}` : ''}</button>
        <button type="button" class="btn small" data-use="heightIn">Use as height${row ? ` of ${esc(row.label || `row ${selected + 1}`)}` : ''}</button>
      </div>` : '<p class="muted small">Click Measure, then two points on the drawing.</p>'}`;
    box.querySelector('[data-calform]')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const len = parseDim(box.querySelector('[data-callen]').value, { bare: 'in' });
      const ppi = len && calibrate(pendingCal.a, pendingCal.b, len);
      if (!ppi) { toast('Type the length, like 8\'-0" or 96.', true); return; }
      const real = isPdf() ? snapScale(72 / ppi) || 72 / ppi : null;
      scales.set(pageNo, { ppi, text: real ? scaleLabel(real) : '', how: `set from a ${fmtFtIn(len)} line` });
      pendingCal = null;
      tool = 'measure';
      overlay();
      tip();
      renderMeasure();
      toast('Scale set. Now click two points to measure.');
    });
    box.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => {
      if (!rows[selected]) { rows.push({ label: '', qty: 1, widthIn: null, heightIn: null }); selected = rows.length - 1; }
      rows[selected][b.dataset.use] = last.inches;
      renderRows();
      renderMeasure();
    }));
  }

  // ---------- Reading the drawing ----------

  function renderOpen() {
    const box = el.querySelector('[data-open]');
    const j = job();
    box.innerHTML = `<h2>${esc(file?.name || 'Drawing')}</h2>
      <p class="small muted">${j ? `Job: <a href="#/jobs/${esc(j.id)}">${esc(j.name)}</a>` : 'No job picked'}</p>
      <label class="small">Open a drawing or photo from this computer <input type="file" accept="application/pdf,.pdf,image/jpeg,image/png,image/webp" data-local></label>`;
    box.querySelector('[data-local]').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        file = { ...(file || {}), name: f.name, local: true };
        await openBytes(new Uint8Array(await f.arrayBuffer()), f.type, f.name);
        renderOpen();
      } catch (err) { console.error(err); toast(err.message, true); }
    });
  }

  function renderRead(progress) {
    const box = el.querySelector('[data-read]');
    if (!pdf && !img) { box.innerHTML = '<h2>Read the drawing</h2><p class="muted small">Open a drawing first.</p>'; return; }
    if (img) {
      box.innerHTML = `<h2>Read the drawing</h2><p class="small">This is a picture, so the free reader can't read it.${geminiAvailable() ? ' Read it with Gemini below, or set' : ' Set'} the scale on something you know the size of, then measure each opening.</p>`;
      return;
    }
    if (progress) { box.innerHTML = `<h2>Reading…</h2><p class="small">${esc(progress)}</p>`; return; }
    if (!result) {
      box.innerHTML = `<h2>Read the drawing</h2>
        <p class="small">Finds the window type tags, reads each type's size from its type elevation and counts the tags on the elevations. Also reads shop drawing mark boxes and sizes typed into markups. Works on drawings exported from CAD, for free; scans and photos need Gemini${geminiAvailable() ? ' (below)' : ''} or measuring by hand.</p>
        <button type="button" class="btn primary" data-readall>Read all ${pageCount()} sheets</button>`;
      box.querySelector('[data-readall]').addEventListener('click', readAll);
      return;
    }
    const scan = result.scanned;
    box.innerHTML = `<h2>What the drawing shows</h2>
      ${scan && !result.openings.length ? '<p class="small warn">These sheets are scans or pictures (no text in them), so they can\'t be read automatically. Measure the openings instead.</p>' : ''}
      ${result.openings.length ? `<p class="small">${esc(result.summary)}</p>` : scan ? '' : '<p class="small">No window type tags or mark boxes were found. Measure the openings instead.</p>'}
      ${marks.length ? `<p class="small">${esc(markCount())} (listed below).</p>` : ''}
      <div class="row"><button type="button" class="btn small" data-readall>Read again</button>
      ${result.openings.length ? '<button type="button" class="btn small" data-userows>Put these in the openings table</button>' : ''}</div>`;
    box.querySelector('[data-readall]').addEventListener('click', readAll);
    box.querySelector('[data-userows]')?.addEventListener('click', () => useOpenings(result.openings));
  }

  async function readAll() {
    // Stops quietly if the page is left or another drawing is opened while sheets are being read.
    const doc = pdf;
    const stale = () => gone || pdf !== doc;
    try {
      const list = [];
      for (let n = 1; n <= doc.numPages; n++) {
        if (stale()) return;
        renderRead(`Reading sheet ${n} of ${doc.numPages}…`);
        list.push(await model(n));
      }
      if (stale()) return;
      result = analyze(list);
      result.scanned = list.every((m) => !m.text.length && m.segs.length < 50);
      const labels = result.openings.map((o) => o.label);
      marks = readMarkups(list, labels);
      // Sizes from markups fill in what the drawing doesn't show; a drawing with sizes only in its
      // markups (typed onto a scan or a sketch, say) is read from them.
      const merged = withMarkups(result.openings, marks);
      if (!result.openings.length && merged.length) result.source = 'markups';
      result.openings = merged;
      result.summary = summary(result);
      if (!rows.some((r) => r.label || r.widthIn) && result.openings.length) useOpenings(result.openings, true);
      fillSheets();
      renderRead();
      renderFound();
      renderMeasure();
      overlay();
    } catch (err) {
      if (stale()) return;
      console.error(err);
      toast('Couldn\'t read this drawing.', true);
      renderRead();
    }
  }

  function markCount() {
    const written = marks.filter((k) => k.subtype === 'Written').length;
    const notes = marks.length - written;
    return [notes ? `${notes} markup${notes === 1 ? '' : 's'} on the drawing` : '', written ? `${written} size${written === 1 ? '' : 's'} written on the sheets` : ''].filter(Boolean).join(' and ');
  }

  const sheetName = (page) => result?.sheets?.find((x) => x.page === page)?.sheet || `Sheet ${page}`;

  function summary(r) {
    const m = r.main;
    if (!m) return r.source ? `Read from the ${r.source}. Check the counts before pricing.` : '';
    const counted = [...new Set(Object.values(m.places).flat().map((p) => p.sheet))].join(', ') || 'the drawings';
    const typeCount = Object.keys(m.types).length;
    const fromMarks = r.openings.filter((o) => o.how === 'size from a markup').length;
    const parts = [typeCount
      ? `Found ${typeCount} window types${m.typeSheet ? ` on ${m.typeSheet}` : ''} and counted them on ${counted}`
      : `Counted the window tags on ${counted}. This file has no sheet showing their sizes${fromMarks ? '' : ', so type them in from the type sheet or measure them'}`];
    if (fromMarks) parts.push(`${fromMarks} size${fromMarks === 1 ? '' : 's'} came from markups`);
    if (m.duplicates) parts.push(`${m.duplicates} shown twice (overlapping or enlarged elevations) were counted once`);
    return `${parts.join('. ')}. Check the counts before pricing.`;
  }

  function useOpenings(list, quiet = false) {
    if (!quiet && rows.some((r) => r.label || r.widthIn) && !confirm('Replace the openings table with what was read?')) return;
    rows = list.map((o) => ({ label: o.label, qty: o.qty, widthIn: o.widthIn, heightIn: o.heightIn, note: o.how }));
    selected = -1;
    renderRows();
  }

  // Other tag families (door marks, glass types) and markups, to use instead or add.
  function renderFound() {
    const box = el.querySelector('[data-found]');
    const fams = (result?.families || []).filter((f) => f !== result.main && f.total && /[A-Z]/.test(f.labels.join('')));
    if (!fams.length && !marks.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = `${fams.length ? `<h2>Other tags</h2>${fams.map((f, i) => `<div class="tk-fam"><p class="small"><b>${esc(f.shape)}</b> tags: ${Object.entries(f.counts).map(([k, v]) => `${esc(k)} ×${v}`).join(', ')}${f.typeSheet ? ` (sizes from ${esc(f.typeSheet)})` : ''}</p>
      <button type="button" class="btn small" data-fam="${i}">Use these instead</button></div>`).join('')}` : ''}
      ${marks.length ? `<h2 class="${fams.length ? 'top-gap' : ''}">Markups</h2><ul class="links">${marks.map((k, i) => `<li><span class="small">${esc(k.text || `${k.subtype} (no text)`)}<br><span class="muted">${esc(sheetName(k.page))}${k.subtype === 'Written' ? ' · written on the sheet' : k.author ? ` · ${esc(k.author)}` : ''}</span></span>
        ${k.widthIn && k.heightIn ? `<button type="button" class="btn small" data-mark="${i}">Add</button>` : ''}</li>`).join('')}</ul>` : ''}`;
    box.querySelectorAll('[data-fam]').forEach((b) => b.addEventListener('click', () => {
      const f = fams[Number(b.dataset.fam)];
      useOpenings(Object.keys({ ...f.types, ...f.counts }).sort().map((label) => ({ label, qty: f.counts[label] || 0, widthIn: f.types[label]?.widthIn ?? null, heightIn: f.types[label]?.heightIn ?? null, how: f.types[label]?.how || '' })));
    }));
    box.querySelectorAll('[data-mark]').forEach((b) => b.addEventListener('click', () => {
      const [o] = markupOpenings([marks[Number(b.dataset.mark)]]);
      rows.push({ label: o.label, qty: o.qty, widthIn: o.widthIn, heightIn: o.heightIn, note: 'from a markup' });
      renderRows();
    }));
  }

  // ---------- Reading with Gemini ----------

  const gemResult = () => openingsFrom([...(gem?.pages.values() || [])]);

  // The page drawn at reading size: a sheet SHEET_PX wide at most, a photo as it is (capped the same).
  async function pageCanvas(n) {
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    if (img) {
      const k = Math.min(1, SHEET_PX / Math.max(img.naturalWidth, img.naturalHeight));
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      g.drawImage(img, 0, 0, c.width, c.height);
      return c;
    }
    const page = await pdf.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: SHEET_PX / Math.max(vp1.width, vp1.height) });
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    page.cleanup();
    return c;
  }

  function readingSize() {
    const { w, h } = pageSize();
    const k = SHEET_PX / Math.max(w, h);
    return img ? { w: Math.min(w, Math.round(w * k)), h: Math.min(h, Math.round(h * k)) } : { w: Math.round(w * k), h: Math.round(h * k) };
  }

  async function readWithGemini(pageNos) {
    if (gem?.busy) return;
    const doc = pdf || img;
    const stale = () => gone || (pdf || img) !== doc;
    gem = gem || { pages: new Map(), cents: 0 };
    gem.busy = true;
    gem.abort = new AbortController();
    let n = 0;
    try {
      for (const no of pageNos) {
        n++;
        gem.progress = pageNos.length > 1 ? `Reading ${sheetName(no)} with Gemini (${n} of ${pageNos.length})…` : `Reading ${img ? 'the picture' : sheetName(no)} with Gemini…`;
        renderGemini();
        const canvas = await pageCanvas(no);
        if (stale()) return;
        const read = await readPage(canvas, { hint: img ? '' : `Sheet ${no} of ${pageCount()} of "${file?.name || 'a drawing set'}".`, signal: gem.abort.signal });
        if (stale()) return;
        gem.pages.set(no, read);
        gem.cents += usageCents(read.usage);
      }
    } catch (err) {
      if (stale()) return;
      if (gem.abort?.signal.aborted) toast('Stopped reading.');
      else { console.error(err); toast(err.message, true); }
    } finally {
      if (!stale()) {
        gem.busy = false;
        gem.abort = null;
        gem.progress = '';
        renderGemini();
        overlay();
        if (gem.pages.size && !rows.some((r) => r.label || r.widthIn)) useOpenings(gemResult().openings.filter((o) => o.qty > 0), true);
      }
    }
  }

  function renderGemini() {
    const box = el.querySelector('[data-gemini]');
    if (!geminiAvailable() || (!pdf && !img)) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const { w, h } = readingSize();
    const perPage = estimateCents(imagesFor(w, h));
    const count = pageCount();
    if (gem?.busy) {
      box.innerHTML = `<h2>Reading with Gemini…</h2><p class="small">${esc(gem.progress)}</p><button type="button" class="btn small" data-gstop>Stop</button>`;
      box.querySelector('[data-gstop]').addEventListener('click', () => gem.abort?.abort());
      return;
    }
    const r = gem?.pages.size ? gemResult() : null;
    const readPages = [...(gem?.pages.keys() || [])].sort((a, b) => a - b);
    const unread = Array.from({ length: count }, (_, i) => i + 1).filter((p) => !gem?.pages.has(p));
    const buttons = `<div class="row">
      <button type="button" class="btn ${r ? '' : 'primary'} small" data-gread="one">${gem?.pages.has(pageNo) ? 'Read this sheet again' : img ? 'Read the picture' : 'Read this sheet'} (${fmtCents(perPage)})</button>
      ${count > 1 && unread.length ? `<button type="button" class="btn small" data-gread="all">Read ${unread.length === count ? `all ${count}` : `the other ${unread.length}`} sheets (${fmtCents(perPage * unread.length)})</button>` : ''}
    </div>`;
    if (!r) {
      box.innerHTML = `<h2>Read with Gemini</h2>
        <p class="small">For scans, photos and handwriting. Gemini counts the window tags, reads type sizes and written sizes and notes, a few cents a sheet. Always check its counts against the drawing.</p>
        ${buttons}`;
    } else {
      const counted = r.openings.filter((o) => o.qty > 0);
      const total = counted.reduce((s, o) => s + o.qty, 0);
      const others = r.families.filter((f) => f !== r.main);
      box.innerHTML = `<h2>What Gemini read</h2>
        <p class="small">${esc(readPages.map((p) => (img ? 'the picture' : sheetName(p))).join(', '))} (${esc(fmtCents(gem.cents))}): ${r.main ? `${esc(r.main.shape)} tags counted, ${total} opening${total === 1 ? '' : 's'} of ${counted.length} type${counted.length === 1 ? '' : 's'}` : counted.length ? `${total} opening${total === 1 ? '' : 's'} written out` : 'no openings found'}. Check the counts and sizes before pricing.</p>
        ${counted.length ? `<ul class="links tk-gem">${r.openings.map((o) => `<li><span class="small">${esc(o.label)}${o.qty ? ` ×${o.qty}` : ''}${o.widthIn || o.heightIn ? ` ${esc(o.widthIn ? fmtIn(o.widthIn) : '?')} x ${esc(o.heightIn ? fmtIn(o.heightIn) : '?')}` : ''}<br><span class="muted">${esc(o.how)}</span></span></li>`).join('')}</ul>` : ''}
        ${others.length ? `<p class="small">Other tags: ${others.map((f) => `<b>${esc(f.shape)}</b> ${Object.entries(f.counts).map(([k, v]) => `${esc(k)} ×${v}`).join(', ')}`).join('; ')}.</p>` : ''}
        ${r.notes.length ? `<details class="small"><summary>${r.notes.length} note${r.notes.length === 1 ? '' : 's'} on the drawing</summary><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
        <div class="row">${counted.length ? '<button type="button" class="btn small primary" data-guse>Put these in the openings table</button>' : ''}</div>
        ${buttons}`;
      box.querySelector('[data-guse]')?.addEventListener('click', () => useOpenings(counted));
    }
    box.querySelectorAll('[data-gread]').forEach((b) => b.addEventListener('click', () => {
      const all = b.dataset.gread === 'all';
      if (all && unread.length > 3 && !confirm(`Read ${unread.length} sheets with Gemini for ${fmtCents(perPage * unread.length)}?`)) return;
      readWithGemini(all ? unread : [pageNo]);
    }));
  }

  // ---------- Openings table ----------

  function renderRows() {
    const body = el.querySelector('[data-rows]');
    body.innerHTML = rows.map((r, i) => `<tr data-i="${i}" class="${i === selected ? 'tk-sel' : ''}">
      <td><input type="radio" name="tkrow" ${i === selected ? 'checked' : ''} aria-label="Fill this row by measuring" data-pick></td>
      <td><input data-f="label" value="${esc(r.label)}" placeholder="A1" size="4"></td>
      <td><input data-f="qty" type="number" min="0" step="1" value="${esc(r.qty ?? '')}" class="n tk-n"></td>
      <td><input data-f="widthIn" value="${esc(inches(r.widthIn))}" class="n tk-n" placeholder="in"></td>
      <td><input data-f="heightIn" value="${esc(inches(r.heightIn))}" class="n tk-n" placeholder="in"></td>
      <td class="num">${r.widthIn && r.heightIn ? (sqft(r.widthIn, r.heightIn) * (Number(r.qty) || 0)).toFixed(1) : ''}</td>
      <td><button type="button" class="icon" data-del aria-label="Remove row">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted small">No openings yet.</td></tr>';
    const count = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
    const area = rows.reduce((s, r) => s + (r.widthIn && r.heightIn ? sqft(r.widthIn, r.heightIn) * (Number(r.qty) || 0) : 0), 0);
    el.querySelector('[data-totals]').innerHTML = rows.length ? `<tr><td></td><td>Total</td><td class="num">${count}</td><td></td><td></td><td class="num">${area.toFixed(1)}</td><td></td></tr>` : '';
  }

  function onRowsChange(e) {
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const r = rows[Number(tr.dataset.i)];
    const f = e.target.dataset.f;
    if (f === 'label') r.label = e.target.value.trim();
    else if (f === 'qty') r.qty = e.target.value === '' ? null : Number(e.target.value);
    else if (f) {
      const v = e.target.value.trim();
      const n = v ? parseDim(v, { bare: 'in' }) : null;
      if (v && n == null) { toast('Type a size like 54, 53 1/4 or 4\'-6".', true); e.target.value = inches(r[f]); return; }
      r[f] = n;
    }
    renderRows();
  }

  // ---------- Saving and the proposal ----------

  function cleanRows() {
    return rows.filter((r) => r.label || r.widthIn || r.heightIn || r.qty)
      .map((r) => ({ label: r.label || '', qty: Number(r.qty) || 0, widthIn: r.widthIn || null, heightIn: r.heightIn || null }));
  }

  async function save(quiet = false) {
    if (local || !file) return;
    try {
      await update('files', file.id, { takeoff: { rows: cleanRows(), by: state.user.uid, at: new Date().toISOString() } });
      if (!quiet) toast('Takeoff saved with the file');
    } catch (err) { console.error(err); if (!quiet) toast('Couldn\'t save the takeoff.', true); }
  }

  async function createEstimate() {
    const list = cleanRows().filter((r) => r.qty > 0);
    if (!list.length) { toast('Add at least one opening with a quantity.', true); return; }
    const j = job();
    if (!j) { toast('Pick the job this drawing belongs to first.', true); return; }
    await save(true);
    const draft = { jobId: j.id, scope: scopeLine(list), lines: estimateLines(list), fileName: file?.name || '' };
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* private mode */ }
    location.hash = `#/estimates/new?job=${encodeURIComponent(j.id)}&from=takeoff`;
  }

  // ---------- Page wiring ----------

  async function mount(root) {
    el = root;
    renderRows();
    renderMeasure();
    renderRead();
    renderGemini();
    el.querySelector('[data-overlay]').addEventListener('click', clickAt);
    el.querySelector('[data-rows]').addEventListener('change', onRowsChange);
    el.querySelector('[data-rows]').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      if (e.target.closest('[data-del]')) { rows.splice(Number(tr.dataset.i), 1); selected = -1; renderRows(); renderMeasure(); return; }
      if (e.target.closest('[data-pick]')) { selected = Number(tr.dataset.i); renderRows(); renderMeasure(); if (tool === 'none') { tool = 'measure'; tip(); model(pageNo).then(overlay); } }
    });
    el.querySelector('[data-addrow]').addEventListener('click', () => { rows.push({ label: '', qty: 1, widthIn: null, heightIn: null }); selected = rows.length - 1; renderRows(); renderMeasure(); });
    el.querySelector('[data-estimate]').addEventListener('click', createEstimate);
    el.querySelector('[data-save]')?.addEventListener('click', () => save());
    el.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', async () => {
      tool = tool === b.dataset.tool ? 'none' : b.dataset.tool;
      pick = null;
      pendingCal = null;
      await model(pageNo);
      tip();
      overlay();
      renderMeasure();
    }));
    el.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.zoom === 'fit') { fit(); return; }
      const box = el.querySelector('[data-scroll]');
      const cx = (box.scrollLeft + box.clientWidth / 2) / zoom, cy = (box.scrollTop + box.clientHeight / 2) / zoom;
      zoom = Math.min(8, Math.max(0.05, zoom * (b.dataset.zoom === 'in' ? 1.5 : 1 / 1.5)));
      draw().then(() => { box.scrollLeft = cx * zoom - box.clientWidth / 2; box.scrollTop = cy * zoom - box.clientHeight / 2; });
    }));
    const go = async (n) => {
      if (n < 1 || n > pageCount()) return;
      pageNo = n;
      pick = null;
      pendingCal = null;
      fillSheets();
      await fit();
      if (tool !== 'none') { await model(pageNo); tip(); }
      renderMeasure();
      renderGemini();
    };
    el.querySelector('[data-prev]').addEventListener('click', () => go(pageNo - 1));
    el.querySelector('[data-next]').addEventListener('click', () => go(pageNo + 1));
    el.querySelector('[data-sheet]').addEventListener('change', (e) => go(Number(e.target.value)));

    try {
      file = await loadRecord();
      if (file?.jobId) el.querySelector('[data-back]').href = `#/jobs/${encodeURIComponent(file.jobId)}?tab=files`;
      renderOpen();
      if (file?.takeoff?.rows?.length) { rows = file.takeoff.rows.map((r) => ({ ...r })); renderRows(); }
      if (file) await openStored();
    } catch (err) {
      console.error(err);
      el.querySelector('[data-read]').innerHTML = `<h2>Read the drawing</h2><p class="small warn">${esc(err.message)}</p>`;
    }
  }

  function unmount() {
    gone = true;
    reset();
  }

  return { html, mount, unmount, wide: true };
}
