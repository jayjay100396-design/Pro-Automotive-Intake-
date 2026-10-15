// Desktop & Mobile Web App (PWA) Installer for Windows and macOS
// Handles Service Worker registration, Chromium `beforeinstallprompt` 1-click install,
// standalone window detection, and step-by-step Windows (Chrome/Edge) & Mac (Safari/Chrome/Edge) install modal.

let deferredPrompt = null;
const listeners = new Set();

export function detectInstallEnvironment(
  ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '',
  platform = typeof navigator !== 'undefined' ? navigator.platform || '' : '',
  standalone = false,
) {
  const s = `${ua} ${platform}`.toLowerCase();
  let os = 'other';
  if (/iphone|ipad|ipod/.test(s)) os = 'ios';
  else if (/android/.test(s)) os = 'android';
  else if (/win/.test(s)) os = 'windows';
  else if (/mac/.test(s)) os = 'mac';

  let browser = 'other';
  if (/edg\//.test(s)) browser = 'edge';
  else if (/chrome\/|crios\//.test(s) && !/edg\//.test(s)) browser = 'chrome';
  else if (/safari\//.test(s) && !/chrome\/|crios\/|edg\//.test(s)) browser = 'safari';
  else if (/firefox\//.test(s)) browser = 'firefox';

  return {
    os,
    browser,
    isStandalone: Boolean(standalone),
    supportsNativePrompt: browser === 'chrome' || browser === 'edge',
  };
}

export function isRunningStandalone() {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.matchMedia?.('(display-mode: window-controls-overlay)')?.matches ||
    window.navigator?.standalone === true,
  );
}

export function canPromptNatively() {
  return Boolean(deferredPrompt);
}

export function onPwaChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  listeners.forEach((fn) => {
    try { fn({ canPrompt: Boolean(deferredPrompt), isStandalone: isRunningStandalone() }); } catch { /* ignore */ }
  });
}

let initialized = false;
export function initPwaInstall() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  if ('serviceWorker' in navigator) {
    // The app gets here only after its Firebase config has loaded, often after the page's load event.
    const register = () => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.warn('Stellar Glass SW registration:', err);
    });
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    notify();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });

  window.matchMedia?.('(display-mode: standalone)')?.addEventListener?.('change', () => notify());
}

export async function triggerNativeInstall() {
  if (!deferredPrompt) return { outcome: 'unavailable' };
  const promptEvent = deferredPrompt;
  deferredPrompt = null;
  notify();
  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    return choice || { outcome: 'dismissed' };
  } catch {
    return { outcome: 'error' };
  }
}

export async function triggerInstallOrModal(hostEl = document.body) {
  if (deferredPrompt) {
    const res = await triggerNativeInstall();
    if (res.outcome === 'accepted') return res;
  }
  openInstallAppModal(hostEl);
  return { outcome: 'modal' };
}

export function openInstallAppModal(hostEl = document.body) {
  if (typeof document === 'undefined') return;
  const env = detectInstallEnvironment(
    navigator.userAgent,
    navigator.platform,
    isRunningStandalone(),
  );

  let dlg = hostEl.querySelector('dialog.pwa-install-dlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'tk-video-dlg pwa-install-dlg';
    dlg.setAttribute('aria-label', 'Install Stellar Glass Desktop Web App on Windows and Mac');
    hostEl.append(dlg);
  }

  const winActive = env.os === 'windows';
  const macActive = env.os === 'mac';

  dlg.innerHTML = `
    <div class="tk-video-wrap pwa-install-wrap">
      <div class="row between tk-3d-head">
        <div class="row" style="gap:12px">
          <img src="/img/icon-192.png" alt="Stellar Glass App Icon" style="width:44px;height:44px;border-radius:10px;border:1px solid var(--line)">
          <div>
            <h2>Download &amp; Install Stellar Glass App (Windows &amp; Mac)</h2>
            <p class="small muted">Run Stellar Glass in its own standalone desktop window from your Windows Taskbar / Start Menu or Mac Dock</p>
          </div>
        </div>
        <button type="button" class="icon" data-pwa-close aria-label="Close install instructions">✕</button>
      </div>

      <div class="pwa-install-body">
        ${env.isStandalone ? `
          <div class="pwa-banner pwa-banner-ok">
            <strong>✓ Stellar Glass is currently running as an installed desktop app!</strong>
            <span class="small">You can pin it to your Windows Taskbar or right-click its icon in your Mac Dock and select <em>Options → Keep in Dock</em>.</span>
          </div>
        ` : deferredPrompt ? `
          <div class="pwa-banner pwa-banner-ready">
            <div>
              <strong>Ready for 1-Click Desktop Install</strong>
              <div class="small muted">Your browser supports direct desktop installation on ${env.os === 'mac' ? 'macOS' : env.os === 'windows' ? 'Windows' : 'this computer'}.</div>
            </div>
            <button type="button" class="btn primary" data-pwa-prompt-now>⬇ Install Stellar Glass Now</button>
          </div>
        ` : ''}

        <div class="grid2 pwa-os-grid">
          <section class="card pwa-os-card ${winActive ? 'pwa-os-active' : ''}" aria-label="Windows Installation Instructions">
            <div class="row between">
              <h3>Windows 10 &amp; Windows 11</h3>
              ${winActive ? '<span class="badge ok">Detected: Windows</span>' : '<span class="badge">PC / Windows</span>'}
            </div>
            <p class="small muted">Works in <strong>Microsoft Edge</strong> and <strong>Google Chrome</strong> — adds Stellar Glass to your Windows Start Menu, Taskbar, and Desktop.</p>
            <ol class="pwa-steps">
              <li>
                <strong>Option A — Address Bar Install Icon (Fastest):</strong>
                Look at the right side of the browser address bar (` + '`stellar-glass-jobs.web.app`' + `) and click the <strong>Install App</strong> icon <span class="mono" title="Computer monitor with download arrow">[⬇🖥]</span>, then click <strong>Install</strong>.
              </li>
              <li>
                <strong>Option B — Microsoft Edge Menu:</strong>
                Click the <strong><span class="mono">⋯</span> (Settings and more)</strong> menu in the top-right corner → <strong>Apps</strong> → <strong>Install Stellar Glass</strong>.
              </li>
              <li>
                <strong>Option C — Google Chrome Menu:</strong>
                Click the <strong><span class="mono">⋮</span> (More)</strong> menu in the top-right corner → <strong>Cast, save, and share</strong> → <strong>Install Stellar Glass…</strong>
              </li>
            </ol>
            <div class="small muted pwa-tip">
              <strong>Tip:</strong> After installing on Windows, check <em>"Pin to taskbar"</em> and <em>"Create desktop shortcut"</em> so you can right-click the taskbar icon to jump straight to <strong>CAD &amp; 3D Takeoff</strong>, <strong>Proposals</strong>, or <strong>Accounting</strong>.
            </div>
          </section>

          <section class="card pwa-os-card ${macActive ? 'pwa-os-active' : ''}" aria-label="Mac Installation Instructions">
            <div class="row between">
              <h3>Mac (macOS Sonoma, Sequoia &amp; newer)</h3>
              ${macActive ? '<span class="badge ok">Detected: Mac</span>' : '<span class="badge">Apple Mac</span>'}
            </div>
            <p class="small muted">Works in <strong>Safari</strong>, <strong>Google Chrome</strong>, and <strong>Microsoft Edge</strong> — adds Stellar Glass directly to your Mac <strong>Applications</strong> folder and <strong>Dock</strong>.</p>
            <ol class="pwa-steps">
              <li>
                <strong>In Safari on Mac:</strong>
                In the top Apple menu bar, click <strong>File → Add to Dock…</strong> (or click the <strong>Share</strong> button <span class="mono">[↑]</span> in the Safari toolbar → <strong>Add to Dock</strong>), then click <strong>Add</strong>.
              </li>
              <li>
                <strong>In Google Chrome on Mac:</strong>
                Click the <strong>Install Stellar Glass</strong> icon <span class="mono">[⬇🖥]</span> on the right side of the address bar (or click <strong><span class="mono">⋮</span> → Cast, save, and share → Install Stellar Glass…</strong>).
              </li>
              <li>
                <strong>In Microsoft Edge on Mac:</strong>
                Click <strong><span class="mono">⋯</span> → Apps → Install Stellar Glass</strong> to place the app in <span class="mono">~/Applications</span> and your Dock.
              </li>
            </ol>
            <div class="small muted pwa-tip">
              <strong>Tip:</strong> Once opened from your Mac Dock, right-click the <strong>Stellar Glass</strong> icon and choose <em>Options → Keep in Dock</em> for 1-click access anytime.
            </div>
          </section>
        </div>
      </div>
    </div>
  `;

  if (!dlg.open) dlg.showModal();

  dlg.querySelector('[data-pwa-prompt-now]')?.addEventListener('click', async () => {
    const res = await triggerNativeInstall();
    if (res.outcome === 'accepted') dlg.close();
  });

  dlg.querySelector('[data-pwa-close]').onclick = () => dlg.close();
}
