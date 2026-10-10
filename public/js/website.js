// Website page: the photos on the public quote page (quote.html). Owners and admins replace the top
// photo and the service photos, and build the gallery. Each picture goes to Cloud Storage at
// companies/{companyId}/website/{name}.jpg and its record to sites/{SITE_ID}/photos/{id}
// (one per place, named after it, and any number for the gallery). firestore.rules and storage.rules
// check that shape, so keep this in step with them.
import { db, storage } from './firebase.js';
import {
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { ref as sref, uploadBytesResumable, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { state, readSite, can, siteLink } from './data.js';
import { SITE_ID, SITE_PLACES, SITE_STARTER_GALLERY } from './brand.js';
import { esc, toast } from './ui.js';

// Photos are kept sharp but sized for the web: the long side at most 2400 px.
const MAX_SIDE = 2400;
const MAX_MB = 15;
const photosCol = () => collection(db, 'sites', SITE_ID, 'photos');

function header() {
  return `<div class="page-head"><div class="page-title"><h1>Website</h1><p>Photos on your public quote page. Upload sharp ones of your own work.</p></div>
    <div class="actions"><a class="btn" href="${esc(siteLink())}" target="_blank" rel="noopener">Open the public page</a></div></div>`;
}

// Re-encodes big photos as JPEG; a photo that is already web-sized is uploaded as it is.
async function prepare(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  } catch {
    throw new Error(`${file.name} can't be opened here. Save it as a JPEG or PNG and try again.`);
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
  if (scale === 1 && ext && file.size < 4 * 1024 * 1024) { bmp.close?.(); return { blob: file, type: file.type, ext }; }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) throw new Error(`${file.name} couldn't be resized.`);
  return { blob, type: 'image/jpeg', ext: 'jpg' };
}

async function upload(file, base, onProgress) {
  const { blob, type, ext } = await prepare(file);
  if (blob.size >= MAX_MB * 1024 * 1024) throw new Error(`${file.name} is over ${MAX_MB} MB even after resizing.`);
  const path = `companies/${state.companyId}/website/${base}.${ext}`;
  const task = uploadBytesResumable(sref(storage, path), blob, { contentType: type, cacheControl: 'public, max-age=31536000' });
  task.on('state_changed', (s) => onProgress?.(s.bytesTransferred / s.totalBytes));
  await task;
  return { path, url: await getDownloadURL(sref(storage, path)) };
}

const dropFile = (path) => (path ? deleteObject(sref(storage, path)).catch((e) => console.warn('left file', path, e)) : null);
const fail = (e) => { console.error(e); toast(e.code === 'permission-denied' || e.code === 'storage/unauthorized' ? 'Only the owner or an admin can change website photos.' : e.message, true); };

export function websitePage() {
  let unsub = null;
  let el = null;
  let photos = [];
  let site;
  const busy = new Map(); // place or upload key -> progress text

  const slotCard = () => `<div class="card"><h2>Top and service photos</h2>
    <p class="small muted">Each one shows in one spot on the page. Replace it with a sharper photo of your own work.</p>
    <div class="site-slots">${SITE_PLACES.map(([place, label, starter]) => {
    const p = photos.find((x) => x.id === place);
    return `<div class="site-slot">
        <div class="thumb${place === 'hero' ? ' wide' : ''}"><img src="${esc(p?.url || starter)}" alt="" loading="lazy"></div>
        <strong>${esc(label)}</strong>
        <span class="small muted">${busy.has(place) ? esc(busy.get(place)) : p ? 'Your photo' : 'Starter photo'}</span>
        ${can.remove() ? `<div class="row-actions">
          <label class="btn small">Replace<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" data-slot="${place}" hidden></label>
          ${p ? `<button type="button" class="btn small" data-reset="${place}">Use starter</button>` : ''}
        </div>` : ''}
      </div>`;
  }).join('')}</div></div>`;

  const galleryCard = () => {
    const g = photos.filter((p) => p.place === 'gallery').sort((a, b) => a.order - b.order);
    const uploading = [...busy.entries()].filter(([k]) => k.startsWith('up:'));
    return `<div class="card"><div class="card-head"><h2>Gallery</h2>
      ${can.remove() ? '<label class="btn primary small">Add photos<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple data-add hidden></label>' : ''}</div>
      ${g.length ? '<p class="small muted">Shown in this order. Captions are optional and show under each photo. Visitors can click a photo to see it full size.</p>'
        : `<p class="small muted">The page shows these ${SITE_STARTER_GALLERY.length} starter photos, cut from screenshots of the old website, so they're small and soft. Add your own photos and they take the starter set's place. You can pick many at once.</p>`}
      ${uploading.length ? `<ul class="upload-list">${uploading.map(([, t]) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <div class="site-gallery">${g.length ? g.map((p, i) => `<div class="site-photo" data-id="${esc(p.id)}">
          <div class="thumb"><img src="${esc(p.url)}" alt="" loading="lazy"></div>
          ${can.remove() ? `<input class="caption" value="${esc(p.caption)}" maxlength="80" placeholder="Caption (optional)" aria-label="Caption">
          <div class="row-actions">
            <button type="button" class="btn small" data-move="-1" ${i ? '' : 'disabled'} aria-label="Move earlier">←</button>
            <button type="button" class="btn small" data-move="1" ${i < g.length - 1 ? '' : 'disabled'} aria-label="Move later">→</button>
            <button type="button" class="btn small danger" data-del>Remove</button>
          </div>` : `<span class="small">${esc(p.caption)}</span>`}
        </div>`).join('')
    : SITE_STARTER_GALLERY.map((src) => `<div class="site-photo starter"><div class="thumb"><img src="${esc(src)}" alt="" loading="lazy"></div></div>`).join('')}</div></div>`;
  };

  const render = () => {
    if (!el) return;
    if (site === undefined) { el.innerHTML = `${header()}<p class="muted">Loading…</p>`; return; }
    if (!site || site.companyId !== state.companyId) {
      el.innerHTML = `${header()}<div class="card"><p>${site ? 'The public page is connected to a different business.'
        : 'Turn on website requests in <a href="#/settings">Settings</a> first. That connects the public page to this business, and then you can change its photos here.'}</p></div>`;
      return;
    }
    const focus = document.activeElement?.classList.contains('caption') ? document.activeElement.closest('[data-id]')?.dataset.id : null;
    el.innerHTML = `${header()}
      ${can.remove() ? '' : '<p class="small muted">Only the owner or an admin can change website photos.</p>'}
      ${slotCard()}${galleryCard()}`;
    if (focus) el.querySelector(`[data-id="${CSS.escape(focus)}"] .caption`)?.focus();
  };

  async function replaceSlot(place, file) {
    const old = photos.find((p) => p.id === place);
    busy.set(place, 'Uploading…'); render();
    try {
      const { path, url } = await upload(file, `${place}-${Date.now()}`, (f) => { busy.set(place, `Uploading ${Math.round(f * 100)}%`); render(); });
      await setDoc(doc(photosCol(), place), { place, caption: '', url, path, order: 0, updatedAt: serverTimestamp() });
      if (old?.path && old.path !== path) dropFile(old.path);
      toast('Photo replaced');
    } catch (e) { fail(e); }
    busy.delete(place); render();
  }

  async function addGallery(files) {
    let order = Math.max(-1, ...photos.filter((p) => p.place === 'gallery').map((p) => p.order)) + 1;
    let added = 0;
    for (const file of files) {
      const key = `up:${Math.random()}`;
      busy.set(key, `${file.name}: preparing…`); render();
      try {
        const id = doc(photosCol()).id;
        const { path, url } = await upload(file, id, (f) => { busy.set(key, `${file.name}: ${Math.round(f * 100)}%`); render(); });
        await setDoc(doc(photosCol(), id), { place: 'gallery', caption: '', url, path, order: order++, updatedAt: serverTimestamp() });
        added++;
      } catch (e) { fail(e); }
      busy.delete(key); render();
    }
    if (added) toast(`${added} photo${added === 1 ? '' : 's'} added to the gallery`);
  }

  async function move(id, dir) {
    const g = photos.filter((p) => p.place === 'gallery').sort((a, b) => a.order - b.order);
    const i = g.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= g.length) return;
    [g[i], g[j]] = [g[j], g[i]];
    const batch = writeBatch(db);
    g.forEach((p, n) => { if (p.order !== n) batch.update(doc(photosCol(), p.id), { order: n, updatedAt: serverTimestamp() }); });
    try { await batch.commit(); } catch (e) { fail(e); }
  }

  async function removePhoto(p) {
    try {
      await deleteDoc(doc(photosCol(), p.id));
      dropFile(p.path);
      toast(p.place === 'gallery' ? 'Photo removed' : 'Back to the starter photo');
    } catch (e) { fail(e); }
  }

  return {
    html: `<div id="website-page">${header()}<p class="muted">Loading…</p></div>`,
    mount(root) {
      el = root.querySelector('#website-page');
      readSite().then((s) => {
        site = s;
        render();
        if (s?.companyId === state.companyId) {
          unsub = onSnapshot(photosCol(), (snap) => {
            photos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            render();
          }, (e) => { console.error(e); toast(e.message, true); });
        }
      }).catch((e) => { el.innerHTML = `${header()}<p class="muted">Couldn't load: ${esc(e.message)}</p>`; });

      el.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.slot && t.files[0]) replaceSlot(t.dataset.slot, t.files[0]);
        else if (t.hasAttribute('data-add') && t.files.length) addGallery([...t.files]);
        else if (t.classList.contains('caption')) {
          const id = t.closest('[data-id]').dataset.id;
          updateDoc(doc(photosCol(), id), { caption: t.value.trim().slice(0, 80), updatedAt: serverTimestamp() })
            .then(() => toast('Caption saved'), fail);
        }
      });
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const id = b.closest('[data-id]')?.dataset.id;
        if (b.dataset.reset) {
          const p = photos.find((x) => x.id === b.dataset.reset);
          if (p) removePhoto(p);
        } else if (b.dataset.move) move(id, Number(b.dataset.move));
        else if (b.hasAttribute('data-del')) {
          const p = photos.find((x) => x.id === id);
          if (p && confirm('Remove this photo from the website?')) removePhoto(p);
        }
      });
    },
    unmount() { unsub?.(); el = null; },
  };
}
