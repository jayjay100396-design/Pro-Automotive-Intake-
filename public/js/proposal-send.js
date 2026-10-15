// "Send to customer" on a proposal: the app makes the proposal's PDF (proposal-doc.js) and an email to go with it,
// and hands them to the phone's share sheet (which attaches the PDF), Gmail or the email app. Gmail and email-app
// links can't carry a file, so for those the PDF downloads to be attached there. Then it notes on the proposal that
// it went out.
import { state, get, update, listMembers, savePreparedBy } from './data.js';
import { BRAND } from './brand.js';
import { esc, toast } from './ui.js';
import { emailList, isEmail, gmailLink, mailtoLink } from './parts-email.js';
import { proposalContent, proposalPdf, proposalEmail, pdfName, dayText } from './proposal-doc.js';

// pdfmake makes the PDF. It's loaded from the CDN the first time a proposal is sent (nothing else needs it), pinned
// to this version and checked against these hashes, so a changed file doesn't run.
const PDFMAKE = 'https://cdn.jsdelivr.net/npm/pdfmake@0.3.11/build/';
const SCRIPTS = [
  ['pdfmake.min.js', 'sha384-vsaIaEjAOZA6uoCQ2pryCKIc8YGpQ/0HK5krdezL4PYvnmLzrizBMDJCZulvIomS'],
  ['vfs_fonts.js', 'sha384-pkBUW1wxcm6m7ZjKDxADnNHqnz+Sx9sAL1ndsLNv/GZnWZgodPYsju1yxeyQnn0c'],
];

let loading = null;
function pdfmake() {
  if (!loading) {
    loading = SCRIPTS.reduce((before, [file, integrity]) => before.then(() => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDFMAKE + file;
      s.integrity = integrity;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = () => reject(new Error('The app couldn\'t load what it makes the PDF with. Check the connection, then try again.'));
      document.head.append(s);
    })), Promise.resolve()).then(() => {
      // Everything the PDF needs is in it (the logo goes in as data), so it never fetches anything.
      window.pdfMake.setUrlAccessPolicy(() => false);
      return window.pdfMake;
    });
    loading.catch(() => { loading = null; });
  }
  return loading;
}

// The logo, as data the PDF can hold. Without it, the PDF prints the business name instead.
let logoData = null;
function logo() {
  if (!logoData) {
    logoData = fetch('img/logo.png')
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => b && new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve('');
        reader.readAsDataURL(b);
      }))
      .catch(() => '')
      .then((data) => { if (!data) logoData = null; return data || ''; });
  }
  return logoData;
}

const content = (e) => {
  const j = get('jobs', e.jobId) || {};
  return proposalContent({ estimate: e, company: state.company || {}, job: j, customer: get('customers', e.customerId || j.customerId) || {} });
};

// The proposal's PDF, as a file named for it.
async function proposalFile(e) {
  const [pm, img] = await Promise.all([pdfmake(), logo()]);
  const p = content(e);
  const blob = await pm.createPdf(proposalPdf(p, { logo: img })).getBlob();
  return new File([blob], pdfName(p), { type: 'application/pdf' });
}

// The person sending, for the signature: uses the proposal's own Prepared By fields first,
// then saved profile / company contact / signed-in user.
export function person(e = {}) {
  const p = state.profile?.preparedBy || {};
  const c = state.company || {};
  const name = e.preparedName || p.name || c.contactName || state.user?.displayName || BRAND.contactName || '';
  const title = e.preparedTitle || (e.preparedName ? '' : p.title || c.contactTitle || BRAND.contactTitle || '');
  const phone = e.preparedPhone || p.phone || c.cell || c.phone || state.user?.phoneNumber || '';
  const email = e.preparedEmail || p.email || c.email || state.user?.email || '';
  return { name, title, phone, email };
}

// Builds a list of distinct team senders so Wes, Jay, or any estimator can pick who is sending.
export function senderChoices(e = {}, members = []) {
  const list = [];
  const seen = new Set();
  const addChoice = (item) => {
    const k = `${(item.name || '').toLowerCase()}|${(item.email || '').toLowerCase()}`;
    if (!item.name || seen.has(k)) return;
    seen.add(k);
    list.push(item);
  };
  const c = state.company || {};
  const p = state.profile?.preparedBy || {};
  if (e.preparedName) {
    addChoice({
      name: e.preparedName,
      title: e.preparedTitle || '',
      phone: e.preparedPhone || c.cell || c.phone || '',
      email: e.preparedEmail || c.email || '',
    });
  }
  addChoice({
    name: c.contactName || BRAND.contactName,
    title: c.contactTitle || BRAND.contactTitle,
    phone: c.cell || c.phone || BRAND.cell || BRAND.phone,
    email: c.email || BRAND.email,
  });
  if (p.name) {
    addChoice({
      name: p.name,
      title: p.title || 'Estimator',
      phone: p.phone || state.user?.phoneNumber || '',
      email: p.email || state.user?.email || '',
    });
  }
  if (state.user?.displayName || state.user?.email) {
    addChoice({
      name: state.user.displayName || state.user.email.split('@')[0],
      title: p.title || 'Estimator',
      phone: state.user.phoneNumber || p.phone || '',
      email: state.user.email || '',
    });
  }
  for (const m of members) {
    const mName = m.displayName || (m.email ? m.email.split('@')[0] : '');
    if (mName) {
      addChoice({
        name: mName,
        title: m.role === 'owner' ? (c.contactTitle || 'President') : 'Estimator',
        phone: c.phone || '',
        email: m.email || '',
      });
    }
  }
  return list;
}

// The Google account to open Gmail in, when they signed in with Google.
const googleAccount = () => state.user?.providerData?.find((p) => p.providerId === 'google.com')?.email || '';
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const kb = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

// Phones and some computers can hand a file to another app (Mail, Gmail, Messages) from the browser.
const canShareFiles = () => {
  try {
    return !!navigator.canShare?.({ files: [new File(['%PDF-'], 'proposal.pdf', { type: 'application/pdf' })] });
  } catch { return false; }
};

// The line under a proposal's status that says when it went out and who sent it.
export function sentNote(e = {}) {
  if (!e.sentOn) return '';
  const to = emailList(e.lastSent?.to).join(', ');
  const by = e.lastSent?.by || e.preparedName || '';
  return `Sent to the customer ${dayText(e.sentOn)}${by ? ` by ${by}` : ''}${to ? ` (${to})` : ''}.`;
}

// Notes that it went out: when, how (share, gmail, email or copy), by whom, and to whom. A draft becomes sent; one that's
// accepted or declined stays so.
async function markSent(id, via, to, sender) {
  const e = get('estimates', id);
  if (!e) return null;
  const by = (sender?.name || e.preparedName || '').trim();
  const fields = {
    sentOn: localDay(),
    lastSent: { via, to: emailList(to), by, at: new Date().toISOString() },
  };
  if (sender?.name) {
    fields.preparedName = sender.name;
    fields.preparedTitle = sender.title || '';
    fields.preparedPhone = sender.phone || '';
    fields.preparedEmail = sender.email || '';
  }
  if (!e.status || e.status === 'draft') fields.status = 'sent';
  try {
    await update('estimates', id, fields);
    return fields;
  } catch (err) {
    console.error(err);
    toast(err.code === 'permission-denied' ? 'Your role can\'t change proposals.' : 'That didn\'t save. Check the connection, then try again.', true);
    return null;
  }
}

// Opens the Send window for a proposal as saved (e: the proposal, when it was just saved and the app's copy may
// not have caught up). onSent(fields) runs once it's marked sent.
export function sendProposal(id, e = get('estimates', id), { onSent = () => {} } = {}) {
  if (!e || document.querySelector('dialog.send-dlg')) return;
  let sender = person(e);
  const estWithSender = () => ({
    ...e,
    preparedName: sender.name,
    preparedTitle: sender.title,
    preparedPhone: sender.phone,
    preparedEmail: sender.email,
  });
  const p = content(estWithSender());
  const j = get('jobs', e.jobId) || {};
  const customer = get('customers', e.customerId || j.customerId) || {};
  const mail = proposalEmail(p, { sender, company: state.company || {} });
  const share = canShareFiles();
  // On a phone the share sheet is the way: it attaches the PDF. On a computer, Gmail.
  const phone = share && matchMedia('(pointer: coarse)').matches;
  const fileName = pdfName(p);
  let choices = senderChoices(e);

  const dlg = document.createElement('dialog');
  dlg.className = 'send-dlg';
  dlg.setAttribute('aria-labelledby', 'sendTitle');
  // Not a <form>: Enter in a box would close the window.
  dlg.innerHTML = `<div class="stack">
    <div class="row between"><h2 id="sendTitle">Send proposal ${esc(p.number)}</h2><button type="button" class="icon" id="sClose" aria-label="Close">✕</button></div>
    <div class="send-file"><span class="pdf-ico" aria-hidden="true">PDF</span>
      <span class="send-file-name"><b>${esc(fileName)}</b><span class="small muted" id="sFileNote">Making the PDF…</span></span>
      <a class="btn small" id="sPreview" target="_blank" rel="noopener" hidden>Preview</a></div>
    <div class="send-from-box">
      <div class="row between">
        <label class="grow">Sending as (shown on email &amp; PDF)
          <select id="sSenderPick"></select>
        </label>
      </div>
      <div class="grid2">
        <label class="small">Sender name <input id="sFromName" value="${esc(sender.name)}" placeholder="e.g. Wesley Stel"></label>
        <label class="small">Title <input id="sFromTitle" value="${esc(sender.title)}" placeholder="e.g. President"></label>
        <label class="small">Phone <input id="sFromPhone" value="${esc(sender.phone)}" placeholder="(863) 255-5731"></label>
        <label class="small">Email <input id="sFromEmail" value="${esc(sender.email)}" placeholder="wes@stellarglassllc.com"></label>
      </div>
    </div>
    <label>To <input id="sTo" type="email" multiple autocomplete="off" value="${esc(emailList(customer.email).join(', '))}" placeholder="customer@example.com"></label>
    <p class="hint warn hidden" id="sToNote"></p>
    <label>Subject <input id="sSubject" value="${esc(mail.subject)}" maxlength="200"></label>
    <label>Message <textarea id="sText" rows="8">${esc(mail.text)}</textarea></label>
    <div class="send-ways">
      ${share ? `<button type="button" class="btn ${phone ? 'primary' : ''}" id="sShare" disabled>Share with the PDF…</button>` : ''}
      <button type="button" class="btn ${phone ? '' : 'primary'}" id="sGmail">Open in Gmail</button>
      <button type="button" class="btn" id="sMail">Open in email app</button>
      <button type="button" class="btn" id="sCopy">Copy email</button>
      <button type="button" class="btn" id="sDownload" disabled>Download PDF</button>
    </div>
    <p class="hint">${share ? 'Share sends the PDF with the message to the app you pick (Mail, Gmail, Outlook…); put in the customer\'s email there. ' : ''}Gmail and the email app open with the email written: the PDF downloads, and you attach it there before sending.</p>
    <div class="ask-bar hidden" id="sAsk"><p><b>Did it go out?</b> <span id="sAskNote"></span></p>
      <div class="row"><button type="button" class="btn primary" id="sYes">Yes, mark it sent</button><button type="button" class="btn" id="sNo">Not yet</button></div></div>
  </div>`;
  document.body.append(dlg);
  const $ = (sel) => dlg.querySelector(sel);

  let file = null;
  let url = '';
  let via = '';
  let failed = false;
  dlg.addEventListener('close', () => { if (url) URL.revokeObjectURL(url); dlg.remove(); });
  dlg.showModal();
  $('#sClose').addEventListener('click', () => dlg.close());

  const renderSenderPick = () => {
    const sel = $('#sSenderPick');
    sel.innerHTML = choices.map((c, idx) => `<option value="${idx}" ${c.name === sender.name ? 'selected' : ''}>${esc(c.name)}${c.title ? ` — ${esc(c.title)}` : ''}${c.email ? ` (${esc(c.email)})` : ''}</option>`).join('')
      + '<option value="custom">Custom sender name…</option>';
  };
  renderSenderPick();
  listMembers().then((m) => {
    if (!dlg.isConnected) return;
    choices = senderChoices(e, m);
    renderSenderPick();
  }).catch(() => {});

  const buildPdf = () => {
    $('#sFileNote').textContent = 'Making the PDF…';
    $('#sFileNote').classList.remove('warn');
    proposalFile(estWithSender()).then((f) => {
      if (!dlg.isConnected) return;
      if (url) URL.revokeObjectURL(url);
      file = f;
      url = URL.createObjectURL(f);
      failed = false;
      $('#sFileNote').textContent = `${kb(f.size)}, ready to send (Prepared by ${sender.name || 'Stellar Glass'})`;
      $('#sPreview').href = url;
      $('#sPreview').hidden = false;
      dlg.querySelectorAll('#sShare, #sDownload').forEach((b) => { b.disabled = false; });
    }).catch((err) => {
      console.error(err);
      failed = true;
      $('#sFileNote').textContent = `${err.message || 'The PDF couldn\'t be made.'} Print proposal / PDF can save it instead.`;
      $('#sFileNote').classList.add('warn');
    });
  };
  buildPdf();

  const applySenderChange = () => {
    sender = {
      name: $('#sFromName').value.trim(),
      title: $('#sFromTitle').value.trim(),
      phone: $('#sFromPhone').value.trim(),
      email: $('#sFromEmail').value.trim(),
    };
    const updatedMail = proposalEmail(content(estWithSender()), { sender, company: state.company || {} });
    $('#sText').value = updatedMail.text;
    savePreparedBy(sender);
    buildPdf();
  };

  $('#sSenderPick').addEventListener('change', (ev) => {
    const idx = Number(ev.target.value);
    if (!Number.isNaN(idx) && choices[idx]) {
      const picked = choices[idx];
      $('#sFromName').value = picked.name || '';
      $('#sFromTitle').value = picked.title || '';
      $('#sFromPhone').value = picked.phone || '';
      $('#sFromEmail').value = picked.email || '';
      applySenderChange();
    } else {
      $('#sFromName').focus();
    }
  });
  ['#sFromName', '#sFromTitle', '#sFromPhone', '#sFromEmail'].forEach((sel) => {
    $(sel).addEventListener('change', applySenderChange);
  });

  const current = () => ({ to: emailList($('#sTo').value), subject: $('#sSubject').value.trim(), text: $('#sText').value });
  const checkTo = () => {
    const typed = $('#sTo').value.split(/[\s,;]+/).filter(Boolean);
    const bad = typed.filter((t) => !isEmail(t));
    const note = bad.length ? `Check this address: ${bad.join(', ')}`
      : typed.length ? '' : `There's no email saved for ${customer.company || customer.name || 'this customer'}. Type it here${customer.id ? ', or add it on the customer\'s page' : ''}.`;
    $('#sToNote').textContent = note;
    $('#sToNote').classList.toggle('hidden', !note);
  };
  $('#sTo').addEventListener('input', checkTo);
  checkTo();

  const download = () => {
    if (!file) return false;
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    return true;
  };
  // Where to get the PDF from when it hasn't downloaded.
  const noFile = (where) => (failed ? `The PDF couldn't be made here: save it from Print proposal / PDF and attach it ${where}.`
    : `The PDF isn't ready yet: download it here once it is, and attach it ${where}.`);
  const ask = (how, note) => {
    via = how;
    $('#sAskNote').textContent = note;
    $('#sAsk').classList.remove('hidden');
    $('#sAsk').scrollIntoView({ block: 'nearest' });
  };

  $('#sShare')?.addEventListener('click', async () => {
    if (!file) return;
    const m = current();
    try {
      // Straight away, while the tap still counts: the PDF is already made.
      await navigator.share({ files: [file], title: m.subject, text: m.text });
      ask('share', 'Mark the proposal sent once the email is on its way.');
    } catch (err) {
      if (err.name !== 'AbortError') toast('This device couldn\'t share the PDF. Use Download PDF and attach it to an email.', true);
    }
  });
  $('#sGmail').addEventListener('click', () => {
    const m = current();
    // Opened straight away, while the click still counts, so the browser doesn't block the new tab.
    window.open(gmailLink({ ...m, account: googleAccount() }), '_blank', 'noopener');
    const got = download();
    ask('gmail', got ? `Attach ${file.name} from your downloads in Gmail before you send it.` : noFile('in Gmail'));
  });
  $('#sMail').addEventListener('click', () => {
    const m = current();
    const got = download();
    location.href = mailtoLink(m);
    ask('email', got ? `Attach ${file.name} from your downloads before you send it.` : noFile('to the email'));
  });
  $('#sCopy').addEventListener('click', async () => {
    const m = current();
    const all = `To: ${m.to.join(', ')}\nSubject: ${m.subject}\n\n${m.text}`;
    try { await navigator.clipboard.writeText(all); toast('Email copied. Paste it into a new email and attach the PDF.'); } catch { prompt('Copy this email:', all); }
    ask('copy', 'Mark the proposal sent once the email with the PDF is on its way.');
  });
  $('#sDownload').addEventListener('click', () => { if (download()) toast('PDF downloaded'); });
  $('#sNo').addEventListener('click', () => $('#sAsk').classList.add('hidden'));
  $('#sYes').addEventListener('click', async (ev) => {
    const button = ev.currentTarget;
    button.disabled = true;
    const fields = await markSent(id, via, current().to, sender);
    button.disabled = false;
    if (!fields) return;
    dlg.close();
    toast(`Marked sent by ${sender.name || 'team'}`);
    onSent(fields);
  });
}
