// Embedded video walkthrough modal for Wes explaining how to use CAD (.DXF/.DWG) takeoffs,
// layer controls, Box W×H & Perimeter LF measurements, commercial storefront glass cut-size
// deductions, 3D storefront modeling, and 1-click Trulite/glass parts order generation.
import { esc } from '../ui.js';

export const TUTORIAL_VIDEO_URL = '/media/takeoff-walkthrough.mp4';

export const TUTORIAL_CHAPTERS = [
  { step: 1, time: 0, label: '0:00 · 1. Open CAD (.DXF / .DWG)', detail: 'Open CAD drawings from a job\'s Files tab or your computer at automatic 1:1 true scale.' },
  { step: 2, time: 21, label: '0:21 · 2. Filter CAD Layers', detail: 'Click Glazing & Dims or toggle layer pills (A-GLAZ, A-DIMS, A-WALL) to hide background clutter.' },
  { step: 3, time: 36, label: '0:36 · 3. Box W×H & Perimeter LF', detail: '2-click opposite corners for Width × Height, or trace a floor plan run for linear footage.' },
  { step: 4, time: 55, label: '0:55 · 4. Storefront Glass Cut Sizes', detail: 'Pick CG451 1-3/4" Storefront, 2" Storefront, Curtain Wall, or Frameless to get DLO + pocket bite cut sizes, 24\' stock lengths, and sealant tubes.' },
  { step: 5, time: 82, label: '1:22 · 5. 3D Storefront View', detail: 'Orbit and zoom your storefront mullions & transoms in 3D, switch anodized finishes & Low-E tints, and save a PNG snapshot.' },
  { step: 6, time: 101, label: '1:41 · 6. Proposal & Trulite Orders', detail: 'Create a customer proposal or pre-fill a Trulite / Glass Shop parts request in one click.' },
];

export function openTutorialModal(hostEl = document.body, { showOpenTakeoff = false } = {}) {
  let dlg = hostEl.querySelector('dialog.tk-video-dlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'tk-video-dlg';
    hostEl.append(dlg);
  }

  dlg.innerHTML = `
    <div class="tk-video-wrap">
      <div class="row between tk-3d-head">
        <div>
          <h2>CAD Takeoff, Glass Cut-Size &amp; 3D Storefront Walkthrough</h2>
          <p class="small muted">2-minute narrated guide · Click any chapter below to jump straight to that step</p>
        </div>
        <div class="row">
          ${showOpenTakeoff ? '<a class="btn small primary" href="#/takeoff/local" data-try-takeoff>Open CAD / Drawing Takeoff</a>' : ''}
          <a class="btn small" href="${TUTORIAL_VIDEO_URL}" download="Wes-Stellar-Glass-CAD-3D-Walkthrough.mp4">Download MP4</a>
          <button type="button" class="icon" data-vid-close aria-label="Close">✕</button>
        </div>
      </div>
      <div class="tk-video-stage">
        <video data-vid-player src="${TUTORIAL_VIDEO_URL}" controls playsinline preload="metadata"></video>
      </div>
      <div class="chips tk-video-chapters">
        ${TUTORIAL_CHAPTERS.map((c, i) => `<button type="button" class="chip ${i === 0 ? 'on' : ''}" data-seek="${c.time}" title="${esc(c.detail)}">${esc(c.label)}</button>`).join('')}
      </div>
      <p class="small muted tk-video-note" data-vid-note>${esc(TUTORIAL_CHAPTERS[0].detail)}</p>
    </div>
  `;

  if (!dlg.open) dlg.showModal();

  const video = dlg.querySelector('[data-vid-player]');
  const noteEl = dlg.querySelector('[data-vid-note]');
  const chips = [...dlg.querySelectorAll('[data-seek]')];

  chips.forEach((btn, idx) => {
    btn.addEventListener('click', () => {
      const sec = Number(btn.dataset.seek) || 0;
      video.currentTime = sec;
      video.play().catch(() => {});
      chips.forEach((c, j) => c.classList.toggle('on', j === idx));
      if (noteEl && TUTORIAL_CHAPTERS[idx]) noteEl.textContent = TUTORIAL_CHAPTERS[idx].detail;
    });
  });

  video.addEventListener('timeupdate', () => {
    const t = video.currentTime || 0;
    let activeIdx = 0;
    for (let i = 0; i < TUTORIAL_CHAPTERS.length; i++) {
      if (t >= TUTORIAL_CHAPTERS[i].time) activeIdx = i;
    }
    chips.forEach((c, j) => c.classList.toggle('on', j === activeIdx));
    if (noteEl && TUTORIAL_CHAPTERS[activeIdx]) noteEl.textContent = TUTORIAL_CHAPTERS[activeIdx].detail;
  });

  dlg.querySelector('[data-try-takeoff]')?.addEventListener('click', () => {
    video.pause();
    dlg.close();
  });
  dlg.querySelector('[data-vid-close]').onclick = () => {
    video.pause();
    dlg.close();
  };
  dlg.addEventListener('close', () => {
    video.pause();
  }, { once: true });

  video.play().catch(() => {});
}
