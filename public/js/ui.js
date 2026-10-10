// Small DOM helpers shared by the views.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const today = () => new Date().toISOString().slice(0, 10);

export function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return isNaN(d) ? esc(iso) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// <select> options from [value, label] pairs.
export const options = (pairs, selected) => pairs
  .map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('');

export const badge = (status) => `<span class="badge s-${esc(String(status || '').replace(/\s+/g, '-'))}">${esc(status || '')}</span>`;

// Reads a form into an object; number inputs become numbers.
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.closest('[data-lines]')) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value.trim();
  }
  return out;
}

// Reads editable line-item rows: each <tr data-row> with inputs named by field.
export function readLines(container) {
  return [...container.querySelectorAll('tr[data-row]')].map((tr) => {
    const line = {};
    tr.querySelectorAll('[name]').forEach((el) => {
      if (el.type === 'checkbox') line[el.name] = el.checked;
      else if (el.type === 'number') line[el.name] = el.value === '' ? 0 : Number(el.value);
      else line[el.name] = el.value;
    });
    return line;
  });
}

let toastTimer;
let toastEl;
export function toast(text, isError = false) {
  // Kept by reference: it may sit inside a dialog that the page later removes.
  const el = toastEl || (toastEl = document.getElementById('toast'));
  // An open dialog (the file viewer) sits above the page, so show the message inside it.
  const host = document.querySelector('dialog[open]') || document.body;
  if (el.parentElement !== host) host.append(el);
  el.textContent = text;
  el.className = 'toast show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
}

export const empty = (text, action = '') => `<div class="empty"><p>${esc(text)}</p>${action}</div>`;
