// Job files: photos, plans, contracts, permits and forms.
// The file goes to Cloud Storage at companies/{company}/{category}/{job}/{fileId}/{name};
// its record (job, category, note, who added it, Drive copies) is in companies/{company}/files/{fileId}.
import { db, storage, useEmulators } from './firebase.js';
import {
  collection, query, where as fwhere, orderBy, limit, onSnapshot, getCountFromServer,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  ref as sref, uploadBytesResumable, uploadBytes, getDownloadURL, deleteObject,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { state, newId, put, update, remove, get, can, onChange, saveProfile } from './data.js';
import * as drive from './drive.js';
import { esc, options, toast } from './ui.js';

export const CATEGORIES = [
  { key: 'photos', label: 'Photos' },
  { key: 'plans', label: 'Plans & drawings' },
  { key: 'documents', label: 'Contracts & documents' },
  { key: 'forms', label: 'Permits & forms' },
  { key: 'other', label: 'Other' },
];
const catLabel = (key) => CATEGORIES.find((c) => c.key === key)?.label || 'Other';
// The accountant adds contracts and documents, and permits and forms (see storage.rules).
const ACCOUNTANT_CATS = ['documents', 'forms'];
const isAccountant = () => state.role === 'accountant';

const MB = 1024 * 1024;
const TYPES_BY_EXT = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif',
  dwg: 'image/vnd.dwg', dxf: 'image/vnd.dxf', mp4: 'video/mp4', mov: 'video/quicktime', txt: 'text/plain', csv: 'text/csv', eml: 'message/rfc822',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const ACCEPT = 'image/*,video/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.eml,.dwg,.dxf,.heic';
const extOf = (name) => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
// CAD drawings come with all sorts of types from the computer (or none), so those go by the extension.
const typeOf = (file) => (/^(dwg|dxf)$/.test(extOf(file.name)) ? TYPES_BY_EXT[extOf(file.name)] : file.type || TYPES_BY_EXT[extOf(file.name)] || '');
// Only links to this business's files in the app's own Cloud Storage bucket, and to Google Drive, are
// used, so a record can't carry a link that runs a script or shows someone else's page (firestore.rules
// checks this too).
export const safeUrl = (u) => {
  const base = `${useEmulators ? 'http://127.0.0.1:9199' : 'https://firebasestorage.googleapis.com'}/v0/b/${storage.app.options.storageBucket}/o/companies%2F${state.companyId}%2F`;
  return typeof u === 'string' && u.startsWith(base) ? u : '';
};
const driveUrl = (u) => (/^https:\/\/(drive|docs)\.google\.com\//.test(u) ? u : '');

// The same limits as storage.rules, checked first so people get a clear message.
function problem(file) {
  const t = typeOf(file);
  const ok = /^image\//.test(t) || /^video\//.test(t) || t === 'application/pdf' || /^text\/(plain|csv)$/.test(t) || t === 'message/rfc822'
    || /^application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\..+)$/.test(t);
  if (!ok) return `${file.name} can't be added. Use photos, videos, PDFs, Word, Excel, PowerPoint, text files or saved emails.`;
  const max = t.startsWith('video/') ? 100 : 25;
  if (file.size >= max * MB) return `${file.name} is over the ${max} MB limit.`;
  return '';
}

// "Sort by type": photos and videos to Photos, CAD drawings to Plans, everything else to Contracts & documents.
function autoCategory(file) {
  const t = typeOf(file);
  if (isAccountant()) return 'documents';
  if (/dwg|dxf/.test(t)) return 'plans';
  return /^(image|video)\//.test(t) ? 'photos' : 'documents';
}
const safeName = (name) => String(name).replace(/[\\/#?[\]*\u0000-\u001f]/g, '_').slice(-150) || 'file';
const myName = () => state.user.displayName || state.profile.preparedBy?.name || state.user.email || state.user.phoneNumber || '';

// A small JPEG preview so the file grid loads fast on a phone.
async function makeThumb(file) {
  if (!/^image\/(jpeg|png|webp|gif|bmp|heic|heif)$/.test(typeOf(file))) return null;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
    const scale = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.75));
  } catch {
    return null;
  }
}

async function uploadOne(file, job, category, progress) {
  const id = newId('files');
  const contentType = typeOf(file);
  const name = file.name || `Photo ${new Date().toLocaleString()}.jpg`;
  const dir = `companies/${state.companyId}/${category}/${job.id}/${id}`;
  const path = `${dir}/${safeName(name)}`;
  const customMetadata = { uploadedBy: state.user.uid, fileId: id, jobId: job.id };
  const task = uploadBytesResumable(sref(storage, path), file, { contentType, customMetadata });
  task.on('state_changed', (s) => progress(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0));
  await task;
  const url = await getDownloadURL(task.snapshot.ref);
  let thumbPath = ''; let thumbUrl = '';
  const thumb = await makeThumb(file);
  if (thumb) {
    try {
      // In its own folder, so it can't land on a file that's itself called thumb.jpg.
      const t = await uploadBytes(sref(storage, `${dir}/preview/thumb.jpg`), thumb, { contentType: 'image/jpeg', customMetadata });
      thumbPath = t.ref.fullPath;
      thumbUrl = await getDownloadURL(t.ref);
    } catch (e) { console.warn('preview', e); }
  }
  const rec = {
    jobId: job.id, customerId: job.customerId || '', category, name, contentType, size: file.size,
    path, url, thumbPath, thumbUrl, note: '', createdByName: myName(),
  };
  try {
    await put('files', id, rec);
  } catch (e) {
    deleteObject(sref(storage, path)).catch(() => {});
    if (thumbPath) deleteObject(sref(storage, thumbPath)).catch(() => {});
    throw e;
  }
  return { id, ...rec, createdBy: state.user.uid };
}

// Downloads a stored file to copy it to Drive. A plain download fails straight away when Storage is
// missing its one-time download setting, where the Storage library would keep retrying for minutes.
async function download(rec) {
  const url = safeUrl(rec.url);
  if (!url) throw new Error('This file\'s download link isn\'t valid, so it can\'t be copied.');
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.error(e);
    throw new Error('Couldn\'t download this file to copy it to Drive. Storage may still need its one-time download setting (CORS, see FIREBASE_SETUP.md).');
  }
  if (res.status === 404) throw new Error('This file is missing from storage, so it can\'t be copied.');
  if (!res.ok) throw new Error(`Couldn't download this file to copy it to Drive (error ${res.status}).`);
  return res.blob();
}

// Copies one file into the person's Drive and notes it on the file's record.
// `blob` is the file itself when it was just uploaded; otherwise it's downloaded from storage.
async function copyToDrive(rec, blob) {
  const job = get('jobs', rec.jobId) || { id: rec.jobId, name: 'Deleted job', customerId: rec.customerId || '', deleted: true };
  const customerId = job.customerId || '';
  const folderId = await drive.jobFolder({
    companyId: state.companyId, companyName: state.company?.name, job, customer: get('customers', customerId), customerId,
    category: CATEGORIES.find((c) => c.key === rec.category) || CATEGORIES[4],
  });
  const f = await drive.saveFile(`${state.companyId}:file:${rec.id}`, async () => blob || download(rec),
    { name: rec.name, mimeType: rec.contentType, folderId, description: rec.note });
  const link = driveUrl(f.webViewLink) || `https://drive.google.com/file/d/${encodeURIComponent(f.id)}/view`;
  const mark = { id: f.id, link, email: drive.driveAccount()?.email || '', at: new Date().toISOString() };
  await update('files', rec.id, { [`drive.${state.user.uid}`]: mark });
  return mark;
}

async function deleteFile(rec) {
  await remove('files', rec.id);
  await deleteObject(sref(storage, rec.path)).catch((e) => console.warn(e));
  if (rec.thumbPath) await deleteObject(sref(storage, rec.thumbPath)).catch(() => {});
}

export async function countJobFiles(jobId) {
  const snap = await getCountFromServer(query(collection(db, 'companies', state.companyId, 'files'), fwhere('jobId', '==', jobId)));
  return snap.data().count;
}

const fmtSize = (n) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const when = (rec) => (rec.createdAt?.toDate ? rec.createdAt.toDate() : new Date());
const fmtWhen = (rec) => when(rec).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const kindLabel = (rec) => {
  const t = rec.contentType || '';
  if (t.startsWith('video/')) return 'Video';
  if (t === 'application/pdf') return 'PDF';
  return (extOf(rec.name) || t.split('/')[1] || 'File').toUpperCase().slice(0, 5);
};
const mineInDrive = (rec) => rec.drive?.[state.user.uid];
const canChange = (rec) => can.edit() || (isAccountant() && rec.createdBy === state.user.uid);
// Photos a customer sent with a website quote request were stored by the website, so only owners
// and admins can remove them (see firestore.rules).
const fromRequest = (rec) => /^companies\/[^/]+\/requests\//.test(rec.path || '');
const canDelete = (rec) => can.remove() || (can.edit() && rec.createdBy === state.user.uid && !fromRequest(rec));
const catIndex = (rec) => CATEGORIES.findIndex((c) => c.key === rec.category);
const G = '<svg class="g-drive" viewBox="0 0 24 24" aria-hidden="true"><path fill="#0066da" d="M3.3 19.6 4.4 21.5c.2.4.6.7 1 .9l3.8-6.6H1.6c0 .5.1.9.4 1.3z"/><path fill="#00ac47" d="M12 8.2 8.2 1.6c-.4.2-.7.5-1 .9L1.9 11.7c-.2.4-.3.8-.3 1.3h7.6z"/><path fill="#ea4335" d="M18.6 22.4c.4-.2.7-.5 1-.9l.4-.8 2.1-3.6c.2-.4.4-.8.4-1.3h-7.6l1.6 3.2z"/><path fill="#00832d" d="M12 8.2 15.8 1.6c-.4-.2-.8-.3-1.3-.3H9.5c-.5 0-.9.1-1.3.3z"/><path fill="#2684fc" d="M14.8 15.8H9.2l-3.8 6.6c.4.2.8.3 1.3.3h10.6c.5 0 .9-.1 1.3-.3z"/><path fill="#ffba00" d="m18.6 8.7-3.5-6.1c-.4-.4-.7-.7-1.1-.9L10.2 8.3 14.8 16h7.6c0-.5-.1-.9-.4-1.3z"/></svg>';

// Uploads in progress. They're kept outside the Files screen so that leaving a job and coming back
// still shows them; each open screen redraws its list when they change.
const uploads = new Map();
const uploadWatchers = new Set();
const uploadsChanged = () => uploadWatchers.forEach((redraw) => redraw());

// The Files screen: on a job (jobId), or across all jobs (jobId null, optionally starting on one job).
export function fileBrowser({ jobId = null, startJob = '' } = {}) {
  let files = [];
  let loaded = false;
  let cat = 'all';
  let search = '';
  let jobFilter = jobId || startJob;
  let addTo = isAccountant() ? 'documents' : 'auto';
  let el = null;
  let unsub = null;
  let offChange = null;
  let raf = 0;
  let busy = '';
  let viewer = null;
  let offDrop = null;
  const touch = matchMedia('(pointer: coarse)').matches;

  const job = () => get('jobs', jobFilter);
  const canUpload = () => !!job() && (can.edit() || isAccountant());
  const inJob = () => (jobFilter ? files.filter((f) => f.jobId === jobFilter) : files);
  // Newest first; everything at once is grouped by category the way the grid shows it.
  const visible = () => {
    const s = search.toLowerCase();
    const grouped = cat === 'all' && !s;
    return inJob()
      .filter((f) => cat === 'all' || f.category === cat)
      .filter((f) => !s || [f.name, f.note, f.createdByName, catLabel(f.category), get('jobs', f.jobId)?.name, get('customers', f.customerId)?.name]
        .some((v) => String(v || '').toLowerCase().includes(s)))
      .sort((a, b) => (grouped ? catIndex(a) - catIndex(b) : 0) || when(b) - when(a));
  };

  const html = `
  <div class="card files" data-files>
    <div class="row files-head"><div class="actions" data-upload></div></div>
    <div class="row file-tools">
      ${jobId ? '' : '<select data-job class="job-filter" aria-label="Job"></select>'}
      <input type="search" data-search placeholder="Search files" class="grow" aria-label="Search files">
    </div>
    <div class="chips" data-chips role="tablist"></div>
    <div class="drive-bar" data-drive></div>
    <div data-progress></div>
    <div data-grid></div>
    <input type="file" data-camera accept="image/*" capture="environment" hidden>
    <input type="file" data-pick accept="${ACCEPT}" multiple hidden>
  </div>`;

  function subscribe() {
    unsub?.();
    loaded = false;
    const col = collection(db, 'companies', state.companyId, 'files');
    const q = jobFilter ? query(col, fwhere('jobId', '==', jobFilter)) : query(col, orderBy('createdAt', 'desc'), limit(500));
    unsub = onSnapshot(q, (snap) => {
      files = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      loaded = true;
      render();
      if (!viewer || !el) return;
      // Redraw the open file only when it changed or went away; otherwise just update where it sits.
      if (snap.docChanges().some((c) => c.doc.id === viewer.id) || !files.some((f) => f.id === viewer.id)) showViewer(viewer.id);
      else renderNav();
    }, (e) => { console.error('files', e); toast('Couldn\'t load files.', true); });
  }

  function renderUpload() {
    if (!el) return;
    const box = el.querySelector('[data-upload]');
    const takeoffBtn = can.edit() ? `<a class="btn small" href="#/takeoff/local${jobFilter ? `?job=${esc(jobFilter)}` : ''}" title="Open a CAD (.DXF/.DWG), PDF drawing or photo for takeoff">CAD / Drawing Takeoff</a>` : '';
    if (!canUpload()) {
      box.innerHTML = `${takeoffBtn} ${jobId ? '' : '<span class="muted small">Choose a job to add files to it.</span>'}`;
      return;
    }
    const cats = isAccountant() ? CATEGORIES.filter((c) => ACCOUNTANT_CATS.includes(c.key)) : CATEGORIES;
    box.innerHTML = `
      <label class="small add-to">Add to <select data-addto>${options([...(isAccountant() ? [] : [['auto', 'Sort by type']]), ...cats.map((c) => [c.key, c.label])], addTo)}</select></label>
      ${touch ? '<button type="button" class="btn small primary" data-take>Take photo</button>' : ''}
      <button type="button" class="btn small ${touch ? '' : 'primary'}" data-add>Add files</button>
      ${takeoffBtn}`;
  }

  function renderChips() {
    if (!el) return;
    const base = inJob();
    const counts = Object.fromEntries(CATEGORIES.map((c) => [c.key, base.filter((f) => f.category === c.key).length]));
    el.querySelector('[data-chips]').innerHTML = [['all', 'All', base.length], ...CATEGORIES.map((c) => [c.key, c.label, counts[c.key]])]
      .map(([k, l, n]) => `<button type="button" class="chip ${cat === k ? 'on' : ''}" data-cat="${k}" role="tab" aria-selected="${cat === k}">${esc(l)} <span>${n}</span></button>`).join('');
  }

  function renderDrive() {
    if (!el) return;
    const box = el.querySelector('[data-drive]');
    const acct = drive.driveAccount();
    if (!acct) {
      box.innerHTML = `<button type="button" class="btn small" data-connect>${G} Save to Google Drive</button>
        <span class="muted small">Keeps a copy of these files in your own Google Drive, in a ${esc(rootName())} folder sorted by customer and job.</span>`;
      return;
    }
    const waiting = inJob().filter((f) => !mineInDrive(f));
    box.innerHTML = `<span class="small drive-acct">${G} Google Drive${acct.email ? `: <b>${esc(acct.email)}</b>` : ''}</span>
      <label class="inline small"><input type="checkbox" data-auto ${state.profile.driveAutoSave === false ? '' : 'checked'}> Copy new files automatically</label>
      ${waiting.length ? `<button type="button" class="btn small" data-copyall ${busy ? 'disabled' : ''}>Copy ${waiting.length} ${waiting.length === 1 ? 'file' : 'files'} to Drive</button>` : '<span class="small ok">All copied to Drive</span>'}
      ${job() ? `<button type="button" class="btn small" data-folder ${busy ? 'disabled' : ''}>Open job folder</button>` : ''}
      <button type="button" class="btn small" data-disconnect>Disconnect</button>
      ${busy ? `<span class="small muted">${esc(busy)}</span>` : ''}`;
  }

  function renderProgress() {
    if (!el) return;
    el.querySelector('[data-progress]').innerHTML = [...uploads.values()].filter((u) => !jobFilter || u.jobId === jobFilter).map((u) => `
      <div class="upload-row ${u.error ? 'err' : ''}"><span class="grow">${esc(u.name)}</span>
        ${u.error ? `<span class="small">${esc(u.error)}</span>` : `<progress max="1" value="${u.pct}"></progress>`}</div>`).join('');
  }

  const tile = (f) => `
    <button type="button" class="file-tile" data-open="${esc(f.id)}" title="${esc(f.name)}">
      <span class="thumb">${safeUrl(f.thumbUrl) ? `<img src="${esc(safeUrl(f.thumbUrl))}" alt="" loading="lazy">` : `<span class="ext">${esc(kindLabel(f))}</span>`}</span>
      <span class="fname">${esc(f.name)}</span>
      <span class="fmeta">${fmtWhen(f)}${f.createdByName ? ` · ${esc(f.createdByName.split('@')[0])}` : ''}${mineInDrive(f) ? ' · <span class="in-drive">In Drive</span>' : ''}</span>
      ${jobId ? '' : `<span class="fjob">${esc(get('jobs', f.jobId)?.name || 'Deleted job')}</span>`}
    </button>`;

  function renderGrid() {
    if (!el) return;
    const list = visible();
    const box = el.querySelector('[data-grid]');
    if (!loaded) { box.innerHTML = '<p class="muted">Loading…</p>'; return; }
    if (!list.length) {
      box.innerHTML = `<div class="empty"><p>${search || cat !== 'all' ? 'No files match.' : canUpload() ? 'No files yet. Add photos, plans, contracts and permits here, or drag them onto this box.' : 'No files yet.'}</p></div>`;
      return;
    }
    // Everything at once is grouped by category; a search or a category shows one grid.
    if (cat === 'all' && !search) {
      box.innerHTML = CATEGORIES.map((c) => {
        const items = list.filter((f) => f.category === c.key);
        return items.length ? `<h3 class="file-group">${esc(c.label)} <span class="muted">${items.length}</span></h3><div class="file-grid">${items.map(tile).join('')}</div>` : '';
      }).join('');
    } else box.innerHTML = `<div class="file-grid">${list.map(tile).join('')}</div>`;
  }

  function renderJobs() {
    if (!el) return;
    const sel = el.querySelector('[data-job]');
    if (!sel) return;
    const jobs = [...state.data.jobs].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    sel.innerHTML = options([['', 'All jobs'], ...jobs.map((j) => [j.id, `${j.name}${get('customers', j.customerId) ? ` · ${get('customers', j.customerId).name}` : ''}`])], jobFilter);
  }

  function render() {
    if (!el) return;
    renderUpload(); renderChips(); renderDrive(); renderProgress(); renderGrid(); renderJobs();
  }

  async function addFiles(list) {
    const j = job();
    if (!j || !list.length) return;
    // Queue them all so the list shows what's coming, then upload one at a time.
    const queue = [];
    for (const file of list) {
      const bad = problem(file);
      if (bad) { toast(bad, true); continue; }
      const key = `${Date.now()}-${Math.random()}`;
      uploads.set(key, { name: file.name || 'Photo', pct: 0, jobId: j.id });
      queue.push({ file, key, category: addTo === 'auto' ? autoCategory(file) : addTo });
    }
    uploadsChanged();
    let added = 0;
    for (const { file, key, category } of queue) {
      try {
        const rec = await uploadOne(file, j, category, (pct) => {
          const u = uploads.get(key);
          if (u) { u.pct = pct; uploadsChanged(); }
        });
        uploads.delete(key);
        uploadsChanged();
        added += 1;
        if (drive.driveAccount() && state.profile.driveAutoSave !== false) {
          copyToDrive(rec, file).catch((e) => { console.error(e); toast(`Saved here, but not copied to Drive: ${e.message}`, true); render(); });
        }
      } catch (e) {
        console.error(e);
        uploads.set(key, { name: file.name, jobId: j.id, error: e.code === 'storage/unauthorized' || e.code === 'permission-denied' ? 'Your role can\'t add files here.' : 'Upload failed. Check the connection and try again.' });
        uploadsChanged();
        setTimeout(() => { uploads.delete(key); uploadsChanged(); }, 8000);
      }
    }
    if (added) toast(added === 1 ? 'File added' : `${added} files added`);
  }

  async function connect() {
    try {
      await drive.connectDrive();
      if (state.profile.driveAutoSave === undefined) saveProfile({ driveAutoSave: true });
      toast('Google Drive connected');
    } catch (e) {
      if (!['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(e.code)) {
        console.error(e);
        toast(e.code === 'auth/user-mismatch' ? 'Pick the Google account you sign in to this app with.'
          : e.code === 'auth/popup-blocked' ? 'The browser blocked the Google window. Allow pop-ups for this site and try again.'
            : e.code === 'auth/operation-not-allowed' ? 'Google sign-in is turned off for this app. Turn it on in Firebase first.' : e.message, true);
      }
    }
    render();
  }

  async function copyAll() {
    drive.forgetFolders();
    const todo = inJob().filter((f) => !mineInDrive(f));
    let done = 0;
    try {
      for (const f of todo) {
        busy = `Copying ${done + 1} of ${todo.length}…`;
        renderDrive();
        await copyToDrive(f);
        done += 1;
      }
      toast(`Copied ${done} ${done === 1 ? 'file' : 'files'} to Google Drive`);
    } catch (e) {
      console.error(e);
      toast(done ? `Copied ${done}, then stopped: ${e.message}` : e.message, true);
    }
    busy = '';
    render();
  }

  async function openFolder() {
    const j = job();
    // Open the tab during the click so the browser doesn't block it, then point it at the folder.
    const w = window.open('', '_blank');
    drive.forgetFolders();
    try {
      busy = 'Finding the folder…'; renderDrive();
      const id = await drive.jobFolder({ companyId: state.companyId, companyName: state.company?.name, job: j, customer: get('customers', j.customerId), customerId: j.customerId });
      if (w) w.location.href = drive.folderLink(id); else location.href = drive.folderLink(id);
    } catch (e) { w?.close(); console.error(e); toast(e.message, true); }
    busy = ''; render();
  }

  // ---------- Viewer: preview, details, Drive, delete ----------
  // Where the open file sits in the grid, for "3 of 12" and Previous / Next.
  function place(id) {
    const list = visible();
    return { list, i: list.findIndex((f) => f.id === id) };
  }

  function renderNav() {
    const dlg = el?.querySelector('dialog.viewer');
    if (!dlg?.open || !viewer) return;
    const { list, i } = place(viewer.id);
    dlg.querySelector('[data-count]').textContent = i >= 0 ? `${i + 1} of ${list.length}` : '';
    dlg.querySelector('[data-prev]').disabled = !(i > 0);
    dlg.querySelector('[data-next]').disabled = !(i >= 0 && i < list.length - 1);
  }

  const isCad = (f) => /dwg|dxf/i.test(f.contentType || '') || /\.(dwg|dxf)$/i.test(f.name || '');
  const canTakeoff = (f) => /^(application\/pdf|image\/(jpeg|png|webp|vnd\.dwg|vnd\.dxf))$/.test(f.contentType || '') || isCad(f);

  function preview(f, url) {
    const t = f.contentType || '';
    if (!url) return '<p class="muted">This file can\'t be shown.</p>';
    if (isCad(f) && can.edit()) return `<a class="big-ext" href="#/takeoff/${esc(f.id)}">${esc(kindLabel(f))}<small>Open in CAD Takeoff</small></a>`;
    if (t.startsWith('image/') && !/dwg|dxf/.test(t)) return `<img src="${esc(url)}" alt="${esc(f.name)}">`;
    if (t.startsWith('video/')) return `<video src="${esc(url)}" controls playsinline></video>`;
    if (t === 'application/pdf' && !touch) return `<iframe src="${esc(url)}" title="${esc(f.name)}"></iframe>`;
    return `<a class="big-ext" href="${esc(url)}" target="_blank" rel="noopener">${esc(kindLabel(f))}<small>Tap to open</small></a>`;
  }

  function showViewer(id) {
    if (!el) return;
    const f = files.find((x) => x.id === id);
    let dlg = el.querySelector('dialog.viewer');
    if (!f) { dlg?.close(); viewer = null; return; }
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'viewer';
      dlg.innerHTML = '<div class="viewer-wrap"></div>';
      el.append(dlg);
      dlg.addEventListener('close', () => {
        viewer = null;
        // Stops a video (or PDF) that was open.
        dlg.querySelector('.viewer-wrap').innerHTML = '';
        // Messages show inside the viewer while it's open; put the message box back on the page.
        const t = dlg.querySelector('#toast');
        if (t) document.body.append(t);
      });
      dlg.addEventListener('keydown', (e) => {
        if (e.target.closest('input,textarea,select')) return;
        if (e.key === 'ArrowLeft') dlg.querySelector('[data-prev]')?.click();
        if (e.key === 'ArrowRight') dlg.querySelector('[data-next]')?.click();
      });
    }
    const wrap = dlg.querySelector('.viewer-wrap');
    const url = safeUrl(f.url);
    // Redrawing the file that's already open (it changed): keep the preview as it is (a video keeps
    // playing), keep what's been typed but not saved yet, and where the cursor was. Fields nobody
    // touched show the record as it is now (say, a teammate's rename).
    const same = viewer?.id === id && dlg.open;
    let form = wrap.querySelector('[data-meta]');
    const field = (name) => form.elements.namedItem(name);
    const edited = same && form ? viewer.edited : new Set();
    const typed = [...edited].map((k) => [k, field(k)?.value]);
    const focused = same && form?.contains(document.activeElement) ? document.activeElement : null;
    const caret = focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
    if (!same || viewer.url !== url || !form) {
      wrap.innerHTML = `<div class="viewer-body"><div class="viewer-media">${preview(f, url)}</div><form class="viewer-side stack" data-meta></form></div>`;
      form = wrap.querySelector('[data-meta]');
    }
    viewer = { id, url, edited, edits: same ? viewer.edits : 0 };

    const edit = canChange(f);
    const cats = edit && isAccountant() ? CATEGORIES.filter((c) => ACCOUNTANT_CATS.includes(c.key)) : CATEGORIES;
    const mine = mineInDrive(f);
    const mineLink = driveUrl(mine?.link);
    const connected = !!drive.driveAccount();
    const others = Object.entries(f.drive || {}).filter(([uid]) => uid !== state.user.uid);
    const j = get('jobs', f.jobId);
    form.innerHTML = `
      <div class="row between"><span class="muted small" data-count></span><button type="button" class="icon" data-close aria-label="Close">✕</button></div>
      <label>Name <input name="name" value="${esc(f.name)}" ${edit ? '' : 'readonly'}></label>
      <label>Category <select name="category" ${edit ? '' : 'disabled'}>${options(cats.map((c) => [c.key, c.label]), f.category)}</select></label>
      <label>Note <textarea name="note" rows="4" ${edit ? '' : 'readonly'} placeholder="e.g. Before install, north elevation">${esc(f.note)}</textarea></label>
      <p class="small muted">Added ${fmtWhen(f)}${f.createdByName ? ` by ${esc(f.createdByName)}` : ''} · ${fmtSize(f.size)}${jobId ? '' : `<br>Job: ${j ? `<a href="#/jobs/${esc(j.id)}?tab=files">${esc(j.name)}</a>` : 'deleted'}`}</p>
      <div class="row">
        ${url ? `<a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">Open</a>` : ''}
        ${edit ? '<button class="btn small primary">Save changes</button>' : ''}
      </div>
      ${url && can.edit() && canTakeoff(f)
    ? `<div class="row"><a class="btn small" href="#/takeoff/${esc(f.id)}" title="Count window types and sizes, measure, and start a proposal">Takeoff for a proposal</a></div>` : ''}
      <div class="row">
        ${mineLink ? `<a class="btn small" href="${esc(mineLink)}" target="_blank" rel="noopener">${G} Open in Drive</a>` : ''}
        ${connected ? `<button type="button" class="btn small" data-copy>${mineLink ? 'Copy again' : `${G} Copy to Drive`}</button>`
          : mineLink ? '' : `<button type="button" class="btn small" data-connect>${G} Connect Google Drive</button>`}
      </div>
      ${others.length ? `<p class="small muted">Also in the Drive of ${others.map(([, d]) => esc(d.email || 'a teammate')).join(', ')}.</p>` : ''}
      ${canDelete(f) ? '<div class="row"><button type="button" class="btn small danger" data-delete>Delete file</button></div>' : ''}
      <div class="row between viewer-nav">
        <button type="button" class="btn small" data-prev>‹ Previous</button>
        <button type="button" class="btn small" data-next>Next ›</button>
      </div>`;
    for (const [k, v] of typed) if (field(k) && v != null) field(k).value = v;
    if (focused?.name && field(focused.name)) {
      field(focused.name).focus();
      if (caret) field(focused.name).setSelectionRange?.(...caret);
    }
    if (!dlg.open) dlg.showModal();
    renderNav();

    const go = (step) => { const { list, i } = place(id); if (i >= 0 && list[i + step]) showViewer(list[i + step].id); };
    form.oninput = (e) => { if (viewer?.id === id && e.target.name) { viewer.edited.add(e.target.name); viewer.edits += 1; } };
    form.querySelector('[data-close]').onclick = () => dlg.close();
    form.querySelector('[data-prev]').onclick = () => go(-1);
    form.querySelector('[data-next]').onclick = () => go(1);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim() || f.name;
      const edits = viewer?.edits;
      try {
        await update('files', f.id, { name, category: fd.get('category'), note: String(fd.get('note') || '').trim() });
        // Saved; but anything typed while it was saving is still unsaved.
        if (viewer?.id === f.id && viewer.edits === edits) viewer.edited.clear();
        toast('File saved');
      } catch (err) { console.error(err); toast('Your role can\'t change this file.', true); }
    };
    form.querySelector('[data-copy]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      drive.forgetFolders();
      try { await copyToDrive(f); toast('Copied to Google Drive'); } catch (err) { console.error(err); toast(err.message, true); render(); btn.disabled = false; }
    });
    form.querySelector('[data-connect]')?.addEventListener('click', async () => { await connect(); showViewer(f.id); });
    form.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!confirm(`Delete ${f.name}? This can't be undone.${mine || others.length ? ' Copies in Google Drive stay.' : ''}`)) return;
      try { await deleteFile(f); dlg.close(); toast('File deleted'); } catch (err) { console.error(err); toast('Your role can\'t delete this file.', true); }
    });
  }

  function mount(root) {
    el = root.querySelector('[data-files]');
    subscribe();
    // Job and customer names come from the company's data, which can arrive after the files.
    offChange = onChange(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (el) { renderGrid(); renderUpload(); renderJobs(); } }); });
    const pick = el.querySelector('[data-pick]');
    const camera = el.querySelector('[data-camera]');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button, [data-open]');
      if (!b || b.closest('dialog')) return;
      if (b.dataset.open) showViewer(b.dataset.open);
      else if (b.dataset.cat) { cat = b.dataset.cat; if (cat !== 'all' && (!isAccountant() || ACCOUNTANT_CATS.includes(cat))) addTo = cat; render(); }
      else if (b.hasAttribute('data-add')) pick.click();
      else if (b.hasAttribute('data-take')) camera.click();
      else if (b.hasAttribute('data-connect')) connect();
      else if (b.hasAttribute('data-disconnect')) { drive.disconnectDrive(); render(); }
      else if (b.hasAttribute('data-copyall')) copyAll();
      else if (b.hasAttribute('data-folder')) openFolder();
    });
    el.addEventListener('change', (e) => {
      if (e.target.matches('[data-addto]')) addTo = e.target.value;
      else if (e.target.matches('[data-auto]')) { saveProfile({ driveAutoSave: e.target.checked }); }
      else if (e.target.matches('[data-job]')) { jobFilter = e.target.value; subscribe(); render(); }
      else if (e.target.matches('[data-pick], [data-camera]')) { addFiles([...e.target.files]); e.target.value = ''; }
    });
    el.querySelector('[data-search]').addEventListener('input', (e) => { search = e.target.value.trim(); renderGrid(); });
    // Drag and drop onto the Files box.
    el.addEventListener('dragover', (e) => { if (canUpload() && e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); el.classList.add('drop-on'); } });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-on'); });
    el.addEventListener('drop', (e) => { if (!canUpload()) return; e.preventDefault(); el.classList.remove('drop-on'); addFiles([...e.dataTransfer.files]); });
    // A file dropped just outside the box would otherwise open in the browser and leave the app.
    const stray = (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      if (!el?.contains(e.target)) e.dataTransfer.dropEffect = 'none';
    };
    document.addEventListener('dragover', stray);
    document.addEventListener('drop', stray);
    offDrop = () => { document.removeEventListener('dragover', stray); document.removeEventListener('drop', stray); };
    uploadWatchers.add(renderProgress);
    render();
  }

  function unmount() {
    unsub?.(); unsub = null;
    offChange?.(); offChange = null;
    offDrop?.(); offDrop = null;
    uploadWatchers.delete(renderProgress);
    el?.querySelector('dialog.viewer')?.close();
    el = null;
  }

  return { html, mount, unmount };
}

function rootName() {
  return `${String(state.company?.name || 'Stellar Glass').replace(/,?\s+(LLC|L\.L\.C\.|Inc\.?|Corp\.?|Co\.?)$/i, '')} Jobs`;
}
