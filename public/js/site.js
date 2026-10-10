// Public quote page (quote.html): no sign-in. A request is saved to the business the site is connected to
// (sites/{SITE_ID} in Firestore, set by the owner in Settings) as companies/{companyId}/requests/{id},
// and its photos and plans go to Cloud Storage at companies/{companyId}/requests/{id}/{n}-{file name}.
// firestore.rules and storage.rules only allow that shape, so keep this in step with them.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, collection, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getStorage, connectStorageEmulator, ref, uploadBytesResumable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { useEmulators, loadConfig } from './config.js';
import { SITE_ID, BRAND } from './brand.js';

const MB = 1024 * 1024;
const MAX_FILES = 8;
const MAX_MB = 20;
// Big phone photos are shrunk before upload: quicker on a phone, and plenty for pricing a job.
const MAX_SIDE = 2000;
const TYPES_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf' };
const ALLOWED = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/;

const $ = (s) => document.querySelector(s);
const form = $('#quote-form');
const list = $('#file-list');
const msg = $('#form-msg');
const sendBtn = $('#send');
const openedAt = Date.now();
let files = [];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const extOf = (name) => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const typeOf = (file) => file.type || TYPES_BY_EXT[extOf(file.name)] || '';
const safeName = (name) => String(name).replace(/[\\/#?[\]*\u0000-\u001f]/g, '_').slice(-100) || 'file';
const say = (text, info = false) => { msg.textContent = text; msg.className = 'form-msg' + (info ? ' info' : ''); };
const unavailable = `Online requests aren't available right now. Please call ${BRAND.phone} or email ${BRAND.email}.`;

// ---------- Firebase: connected lazily so the page shows right away ----------
let fb = null;
function firebase() {
  fb = fb || (async () => {
    const app = initializeApp(await loadConfig());
    const db = getFirestore(app);
    const storage = getStorage(app);
    if (useEmulators) {
      connectFirestoreEmulator(db, '127.0.0.1', 8080);
      connectStorageEmulator(storage, '127.0.0.1', 9199);
    }
    return { db, storage };
  })();
  return fb;
}

// The business that receives requests, or null if the form is off. Rechecked if the lookup failed.
let target = null;
async function findTarget() {
  if (target) return target;
  const { db } = await firebase();
  const snap = await getDoc(doc(db, 'sites', SITE_ID));
  const site = snap.exists() ? snap.data() : null;
  if (!site?.companyId || !site.open) return null;
  target = site.companyId;
  return target;
}

findTarget().then((t) => { if (!t) say(unavailable, true); }).catch((e) => console.warn('site lookup', e));

// ---------- Small page behaviors ----------
document.getElementById('year').textContent = new Date().getFullYear();

// "Ask about a shower" etc. picks that service on the form.
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-service]');
  if (a) form.elements.service.value = a.dataset.service;
});

// Underline the nav link of the section on screen.
const links = [...document.querySelectorAll('.site-nav a')];
const seen = new Map();
const spy = new IntersectionObserver((entries) => {
  entries.forEach((en) => seen.set(en.target.id, en.isIntersecting));
  const current = ['home', 'services', 'gallery', 'quote', 'contact'].find((id) => seen.get(id));
  links.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${current}`));
}, { rootMargin: '-45% 0px -50% 0px' });
document.querySelectorAll('main section[id], footer[id]').forEach((s) => spy.observe(s));

// ---------- Attachments ----------
function addFiles(picked) {
  for (const file of picked) {
    const type = typeOf(file);
    if (!ALLOWED.test(type)) { say(`${file.name} can't be attached. Send photos or PDFs.`); continue; }
    if (file.size >= MAX_MB * MB) { say(`${file.name} is over ${MAX_MB} MB. Email it to ${BRAND.email} instead.`); continue; }
    if (files.length >= MAX_FILES) { say(`You can attach up to ${MAX_FILES} files. Email any others to ${BRAND.email}.`); break; }
    files.push({ file, type, key: `${Date.now()}-${Math.random()}`, preview: type.startsWith('image/') && !/hei[cf]/.test(type) ? URL.createObjectURL(file) : '' });
  }
  renderFiles();
}

function renderFiles(locked = false) {
  list.innerHTML = files.map((f) => `<li data-key="${f.key}">
    ${f.preview ? `<img class="thumb" src="${f.preview}" alt="">` : `<span class="thumb">${esc(extOf(f.file.name).toUpperCase() || 'FILE')}</span>`}
    <span class="fname">${esc(f.file.name)}</span>
    ${f.state === 'done' ? '<span class="done">Sent</span>'
      : f.state === 'failed' ? '<span class="failed">Didn\'t upload</span>'
        : f.state === 'sending' ? `<progress max="1" value="${f.pct || 0}"></progress>`
          : locked ? '' : `<button type="button" class="x" data-remove="${f.key}" aria-label="Remove ${esc(f.file.name)}">✕</button>`}
  </li>`).join('');
}

const input = $('#file-input');
input.addEventListener('change', () => { say(''); addFiles([...input.files]); input.value = ''; });
list.addEventListener('click', (e) => {
  const key = e.target.closest('[data-remove]')?.dataset.remove;
  if (!key) return;
  const f = files.find((x) => x.key === key);
  if (f?.preview) URL.revokeObjectURL(f.preview);
  files = files.filter((x) => x.key !== key);
  renderFiles();
});
const drop = $('#file-drop');
drop.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); drop.classList.add('over'); } });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); say(''); addFiles([...e.dataTransfer.files]); });

// Shrinks a large photo to a JPEG. Returns the original if the browser can't read it (e.g. HEIC on Windows).
async function shrink({ file, type }) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(type)) return { blob: file, type, name: file.name };
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 3 * MB && !/hei[cf]/.test(type)) { bmp.close?.(); return { blob: file, type, name: file.name }; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('no blob');
    return { blob, type: 'image/jpeg', name: file.name.replace(/\.[a-z0-9]+$/i, '') + '.jpg' };
  } catch {
    return { blob: file, type, name: file.name };
  }
}

// ---------- Validation ----------
const digits = (s) => s.replace(/\D/g, '');
const emailOk = (s) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s);

function check(v) {
  const bad = [];
  const mark = (name, isBad) => { form.elements[name].setAttribute('aria-invalid', isBad ? 'true' : 'false'); if (isBad) bad.push(name); };
  mark('name', !v.name);
  mark('service', !v.service);
  mark('details', !v.details);
  mark('email', !!v.email && !emailOk(v.email));
  const noContact = digits(v.phone).length < 7 && !emailOk(v.email);
  mark('phone', noContact || (!!v.phone && digits(v.phone).length < 7));
  $('#contact-hint').classList.toggle('bad', noContact);
  if (!bad.length) return '';
  form.elements[bad[0]].focus();
  if (noContact) return 'Add a phone number or an email so we can get back to you.';
  if (bad.includes('email')) return 'That email address doesn\'t look right.';
  if (bad.includes('phone')) return 'That phone number looks too short. Include the area code.';
  return 'Fill in the fields marked with *.';
}

// A field marked wrong clears as soon as it's edited.
form.addEventListener('input', (e) => {
  if (e.target.getAttribute('aria-invalid') === 'true') e.target.setAttribute('aria-invalid', 'false');
  if (['phone', 'email'].includes(e.target.name)) $('#contact-hint').classList.remove('bad');
});

// ---------- Send ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(form);
  const v = Object.fromEntries(['name', 'company', 'phone', 'email', 'contactBy', 'service', 'timeline', 'siteAddress', 'details', 'website']
    .map((k) => [k, String(f.get(k) || '').trim()]));
  // Bots fill the hidden field or send the form the instant the page loads. Look done, send nothing.
  if (v.website || Date.now() - openedAt < 3000) return showThanks(v, 0);
  const problem = check(v);
  if (problem) return say(problem);

  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';
  say('');
  let companyId;
  let id;
  try {
    companyId = await findTarget();
    if (!companyId) throw Object.assign(new Error(unavailable), { shown: true });
    const { db } = await firebase();
    const prepared = [];
    for (const item of files) prepared.push({ item, ...(await shrink(item)) });
    id = doc(collection(db, 'companies', companyId, 'requests')).id;
    await setDoc(doc(db, 'companies', companyId, 'requests', id), {
      name: v.name.slice(0, 100), company: v.company.slice(0, 100), phone: v.phone.slice(0, 30), email: v.email.slice(0, 120),
      contactBy: ['phone', 'text', 'email'].includes(v.contactBy) ? v.contactBy : 'phone',
      service: v.service, timeline: v.timeline, siteAddress: v.siteAddress.slice(0, 200), details: v.details.slice(0, 4000),
      files: prepared.length, site: SITE_ID, source: 'website', status: 'new', createdAt: serverTimestamp(),
    });
    files = prepared.map((p) => Object.assign(p.item, { state: 'waiting' }));
    renderFiles(true);
    const failed = await uploadAll(companyId, id, prepared);
    showThanks(v, failed);
  } catch (err) {
    console.error(err);
    say(err.shown ? err.message : `Sorry, that didn't go through. Check your connection and try again, or call ${BRAND.phone}.`);
    files.forEach((x) => { delete x.state; });
    renderFiles();
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send my request';
  }
});

async function uploadAll(companyId, id, prepared) {
  const { storage } = await firebase();
  let failed = 0;
  for (const [n, p] of prepared.entries()) {
    const item = p.item;
    item.state = 'sending';
    renderFiles(true);
    try {
      const path = `companies/${companyId}/requests/${id}/${n}-${safeName(p.name)}`;
      const task = uploadBytesResumable(ref(storage, path), p.blob, { contentType: p.type });
      task.on('state_changed', (s) => {
        item.pct = s.totalBytes ? s.bytesTransferred / s.totalBytes : 0;
        list.querySelector(`[data-key="${item.key}"] progress`)?.setAttribute('value', item.pct);
      });
      await task;
      item.state = 'done';
    } catch (err) {
      console.error(err);
      item.state = 'failed';
      failed += 1;
    }
    renderFiles(true);
  }
  return failed;
}

function showThanks(v, failed) {
  const how = { phone: 'call you', text: 'text you', email: 'email you' }[v.contactBy] || 'get back to you';
  $('#thanks-text').textContent = `We'll ${how} soon to talk about your project.`
    + (failed ? ` ${failed === 1 ? 'One file' : `${failed} files`} didn't upload, so please email ${failed === 1 ? 'it' : 'them'} to ${BRAND.email}.` : '')
    + ` If it's urgent, call ${BRAND.phone}.`;
  form.classList.add('hidden');
  $('#thanks').classList.remove('hidden');
  $('#thanks').focus();
}

$('#again').addEventListener('click', () => {
  form.reset();
  files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
  files = [];
  renderFiles();
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  $('#contact-hint').classList.remove('bad');
  $('#thanks').classList.add('hidden');
  form.classList.remove('hidden');
  form.elements.name.focus();
});
