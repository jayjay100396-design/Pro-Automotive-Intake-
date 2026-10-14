// Embedded video walkthrough modal for Wes explaining how to use CAD (.DXF/.DWG) takeoffs,
// layer controls, Box W×H & Perimeter LF measurements, commercial storefront glass cut-size
// deductions, 3D storefront modeling, and 1-click Trulite/glass parts order generation.
import { esc } from '../ui.js';

export const TUTORIAL_VIDEO_URL = '/media/takeoff-walkthrough.mp4';

export const TUTORIAL_CHAPTERS = [
  { step: 1, time: 0, label: '0:00 · 1. Dashboard & Shortcuts', detail: 'Use the Quick Shortcuts bar or ⌘K Quick Jump anywhere, and convert incoming Website Quote Requests into Customers, Jobs, and Google Calendar measures.' },
  { step: 2, time: 26.5, label: '0:26 · 2. Job Files & CAD 1:1', detail: 'Store PDFs, photos, and AutoCAD .DXF/.DWG drawings backed up to Google Drive, and open CAD drawings at 1:1 true scale with automatic window tag counting.' },
  { step: 3, time: 52, label: '0:52 · 3. CAD Layers & Box W×H', detail: 'Click Glazing & Dims to hide A-WALL & A-GRID clutter, then measure openings with 2-click Box W×H or trace floor runs with Perimeter LF.' },
  { step: 4, time: 76, label: '1:16 · 4. Storefront Cut Sizes', detail: 'Pick CG451 1-3/4" Storefront, 2" Storefront, Curtain Wall, or Frameless to get DLO + 3/8" pocket bite cut sizes, 24\' stock lengths, and sealant tubes.' },
  { step: 5, time: 103, label: '1:43 · 5. 3D Storefront View', detail: 'Orbit and zoom your storefront mullions & transoms in 3D, switch anodized finishes & Low-E tints, and save a PNG snapshot.' },
  { step: 6, time: 122.5, label: '2:02 · 6. Proposals & Trulite Orders', detail: 'Select who is sending the proposal (shown on the PDF signature & email) or pre-fill a Trulite / Glass Shop parts request in one click.' },
  { step: 7, time: 144, label: '2:24 · 7. Contracts, AIA G702 & Invoices', detail: 'Convert accepted proposals to Contracts, track Change Orders, generate AIA G702/G703 progress pay apps with retainage, and send Stripe invoices.' },
];

export function openTutorialModal(hostEl = document.body, { showOpenTakeoff = false } = {}) {
  let dlg = hostEl.querySelector('dialog.tk-video-dlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'tk-video-dlg';
    dlg.setAttribute('aria-label', 'Stellar Glass Start-to-Finish Walkthrough Video');
    hostEl.append(dlg);
  }

  dlg.innerHTML = `
    <div class="tk-video-wrap">
      <div class="row between tk-3d-head">
        <div>
          <h2>Stellar Glass — Start-to-Finish App &amp; CAD/3D Takeoff Walkthrough</h2>
          <p class="small muted">2:47 narrated guide · Click any chapter below to jump straight to that step</p>
        </div>
        <div class="row">
          ${showOpenTakeoff ? '<a class="btn small primary" href="#/takeoff/local" data-try-takeoff>Open CAD / Drawing Takeoff</a>' : ''}
          <a class="btn small" href="${TUTORIAL_VIDEO_URL}" download="Wes-Stellar-Glass-Start-To-Finish-Walkthrough.mp4">Download MP4</a>
          <button type="button" class="icon" data-vid-close aria-label="Close walkthrough video">✕</button>
        </div>
      </div>
      <div class="tk-video-stage">
        <video data-vid-player src="${TUTORIAL_VIDEO_URL}" controls playsinline preload="metadata" aria-label="Stellar Glass Start-to-Finish Walkthrough Video">
          <track kind="captions" src="/media/takeoff-walkthrough.vtt" srclang="en" label="English" default>
        </video>
      </div>
      <div class="chips tk-video-chapters" role="group" aria-label="Video chapters">
        ${TUTORIAL_CHAPTERS.map((c, i) => `<button type="button" class="chip ${i === 0 ? 'on' : ''}" data-seek="${c.time}" title="${esc(c.detail)}">${esc(c.label)}</button>`).join('')}
      </div>
      <p class="small muted tk-video-note" data-vid-note aria-live="polite">${esc(TUTORIAL_CHAPTERS[0].detail)}</p>
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
