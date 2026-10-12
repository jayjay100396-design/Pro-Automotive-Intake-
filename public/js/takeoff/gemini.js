// Reading scans, photos and handwriting with Gemini, through Firebase AI Logic. It costs a few
// cents a sheet, so it only runs when the person asks. The prompt and the model live in a server
// template (prompts/takeoff-read-v1.prompt), so they can change without touching the app. Only
// people signed in to the app can call it (the project is locked to that), and App Check proves
// the call comes from the app itself.
import { app, useEmulators } from '../firebase.js';
import { planTiles, captions, pageTags, TEMPLATE_ID } from './vision.js';

// The AI and App Check SDKs are fetched the first time Gemini is used; the rest of the app never needs them.
const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';

// The reCAPTCHA Enterprise key App Check uses for the web app. A site key is public; it only works
// on the app's own addresses.
export const RECAPTCHA_SITE_KEY = '6LespuotAAAAAPLJfnxJYaBwkVxmq0KHAWmG61Kl';
// Close-ups are at most this many pixels on a side. Tested on scanned sheets: at 1024 the small
// dimensions on a type sheet read right, at 1536 the model mixed up head heights and frame heights.
export const TILE = 1024;
const OVERLAP = 120;
const WHOLE = 2048; // the whole page is sent no bigger than this
export const SHEET_PX = 6300; // a drawing sheet is drawn this wide for reading (150 dpi on a 42" sheet)

// Gemini 3 Flash through the Gemini Developer API, in dollars per million tokens; Google doubles
// these on January 1, 2027. The estimate is only shown to the person, so the date is enough.
const RATE = () => (new Date().getFullYear() >= 2027 ? 2 : 1);
export const PRICE = { inPerM: 0.75, outPerM: 3.75 };
const IMAGE_TOKENS = 1120; // what one image costs the model, whatever its size
const TEXT_TOKENS = 1500; // the prompt itself
const OUT_TOKENS = 3000; // a typical answer

// Local dev has no App Check (the key only works on the live addresses) and can point the calls at
// a stand-in server for tests.
function testUrl() {
  if (!useEmulators) return null;
  try { return sessionStorage.getItem('takeoff.aiUrl'); } catch { return null; }
}
export const geminiAvailable = () => !useEmulators || !!testUrl();

let model = null;
async function client() {
  if (model) return model;
  const baseUrl = testUrl();
  const [{ getAI, GoogleAIBackend, getTemplateGenerativeModel }, { initializeAppCheck, ReCaptchaEnterpriseProvider }] = await Promise.all([import(`${SDK}/firebase-ai.js`), import(`${SDK}/firebase-app-check.js`)]);
  if (!useEmulators) initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY), isTokenAutoRefreshEnabled: true });
  const ai = getAI(app, { backend: new GoogleAIBackend() });
  model = getTemplateGenerativeModel(ai, baseUrl ? { baseUrl } : undefined);
  return model;
}

// Part of a canvas as a base64 JPEG, no bigger than `max` on a side.
async function jpeg(src, x, y, w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Couldn\'t make a picture of the page.'))), 'image/jpeg', 0.85));
  const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  return url.slice(url.indexOf(',') + 1);
}

// How many images a page of w x h pixels is sent as, and what that costs, in cents.
export function imagesFor(w, h) {
  const plan = planTiles(w, h, { max: TILE, overlap: OVERLAP });
  return plan.tiles.length > 1 ? plan.tiles.length + 1 : 1;
}
export const estimateCents = (images) => ((images * IMAGE_TOKENS + TEXT_TOKENS) * PRICE.inPerM + OUT_TOKENS * PRICE.outPerM) * RATE() / 1e6 * 100;
export const usageCents = (u) => (((u?.promptTokenCount || 0) * PRICE.inPerM + ((u?.candidatesTokenCount || 0) + (u?.thoughtsTokenCount || 0)) * PRICE.outPerM) * RATE()) / 1e6 * 100;
export const fmtCents = (c) => (c < 1 ? 'under a cent' : c < 10 ? `about ${Math.ceil(c)}¢` : `about $${(c / 100).toFixed(2)}`);

function parseAnswer(text) {
  try {
    const a = JSON.parse(text);
    if (!a || typeof a !== 'object') throw new Error('not an object');
    for (const k of ['tags', 'types', 'items', 'notes']) if (!Array.isArray(a[k])) a[k] = [];
    return a;
  } catch {
    throw new Error('Gemini\'s answer couldn\'t be read. Try again.');
  }
}

function plain(err) {
  const m = String(err?.message || err);
  if (/app check|appcheck/i.test(m)) return 'Gemini wouldn\'t take the request from this page (App Check). Reload the app and try again.';
  if (/not found|404/.test(m) && /template/i.test(m)) return 'The Gemini reading template isn\'t set up on this Firebase project yet (FIREBASE_SETUP.md, section 7).';
  if (/401|403|unauthenticated|permission/i.test(m)) return 'Gemini is only for people signed in to the app. Sign in again and retry.';
  if (/429|quota|resource exhausted/i.test(m)) return 'Gemini is busy or the spending cap was hit. Try again in a minute.';
  if (/abort/i.test(m)) return 'Stopped.';
  return `Gemini couldn't read this page (${m.slice(0, 120)}).`;
}

// Reads one page, drawn on `canvas` at reading size (a sheet about SHEET_PX wide; a photo as is).
// Returns what Gemini found with the tags placed in canvas pixels, and the tokens used.
export async function readPage(canvas, { hint = '', signal } = {}) {
  const w = canvas.width, h = canvas.height;
  const plan = planTiles(w, h, { max: TILE, overlap: OVERLAP });
  const caps = captions(plan);
  const data = [await jpeg(canvas, 0, 0, w, h, WHOLE)];
  if (plan.tiles.length > 1) for (const t of plan.tiles) data.push(await jpeg(canvas, t.x, t.y, t.w, t.h, TILE));
  const images = data.map((d, i) => ({ caption: caps[i], mimeType: 'image/jpeg', data: d }));
  let result;
  try {
    result = await (await client()).generateContent(TEMPLATE_ID, { hint: hint || '', images }, { signal, timeout: 180000 });
  } catch (err) {
    console.error(err);
    throw new Error(plain(err));
  }
  const answer = parseAnswer(result.response.text());
  const usage = result.response.usageMetadata || null;
  return { answer, tags: pageTags(answer, plan, w, h), usage, w, h, images: images.length };
}
