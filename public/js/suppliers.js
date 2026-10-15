// Suppliers: who the business buys from, their branch, the rep's email and the account number, and how they like
// requests. Each is companies/{company}/suppliers/{id}; owners and admins add and change them (firestore.rules),
// since the app emails parts requests to these addresses and nobody else. Supplier plugins (supplier-plugins.js)
// fill in a new one.
import { state, add, update, remove, get, where, can } from './data.js';
import { PLUGINS, pluginFor } from './supplier-plugins.js';
import { LIST_TYPES, REQUEST_KINDS, DELIVERY, MAX_EMAILS, isOpen } from './parts-email.js';
import { parseEmails } from './requests.js';
import { esc, options, toast, empty } from './ui.js';

const go = (hash) => { location.hash = hash; };
const byName = (a, b) => (a.name || '').localeCompare(b.name || '');

async function attempt(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { console.error(e); toast(e.code === 'permission-denied' ? 'Your role can\'t make that change.' : e.message, true); return null; }
}

export const supplierName = (id) => get('suppliers', id)?.name || '';
const openCount = (id) => where('partsRequests', 'supplierId', id).filter(isOpen).length;
const telLink = (p) => (p ? `<a href="tel:${esc(String(p).replace(/[^\d+]/g, ''))}">${esc(p)}</a>` : '');

// ---------- List, and the plugins to add one from ----------
export function supplierList() {
  const rows = [...state.data.suppliers].sort(byName);
  const manage = can.suppliers();
  return {
    live: true,
    html: `<div class="page-head"><div class="page-title"><h1>Suppliers</h1></div><div class="actions"><a class="btn" href="#/parts">Parts orders</a>
      ${manage ? '<a class="btn primary" href="#/suppliers/new?plugin=other">Add a supplier</a>' : ''}</div></div>
    <div class="card">${rows.length ? `<table class="list"><thead><tr><th>Supplier</th><th>Rep</th><th>Requests go to</th><th>Branch</th><th>Account #</th><th class="num">Open orders</th></tr></thead><tbody>
      ${rows.map((s) => `<tr data-href="#/suppliers/${esc(s.id)}"><td><b>${esc(s.name)}</b>${s.plugin && s.plugin !== 'other' ? `<br><span class="muted small">${esc(pluginFor(s.plugin).what)}</span>` : ''}</td>
        <td>${esc(s.contactName)}</td><td>${(s.emails || []).length ? esc(s.emails.join(', ')) : '<span class="warn">No email yet</span>'}</td>
        <td>${esc(s.branch)}</td><td>${esc(s.account)}</td><td class="num">${openCount(s.id) || ''}</td></tr>`).join('')}
    </tbody></table>` : empty('No suppliers yet. Add the ones you buy from, starting with a plugin below.')}</div>
    <div class="card"><h2>Supplier plugins</h2>
      <p class="hint">A plugin fills in the supplier's branches, the kind of list they work from and tips for the request. You add your rep's email and your account number.</p>
      <div class="plugin-grid">${PLUGINS.map((p) => {
        const have = state.data.suppliers.filter((s) => s.plugin === p.id).length;
        return `<div class="plugin"><div><b>${esc(p.name)}</b><p class="small muted">${esc(p.what)}</p>
          ${p.branches.length ? `<p class="small">${p.branches.map((b) => esc(b.label)).join(' · ')}</p>` : ''}</div>
          <div class="row">${manage ? `<a class="btn small ${have ? '' : 'primary'}" href="#/suppliers/new?plugin=${esc(p.id)}">${have && p.id !== 'other' ? 'Add another branch' : `Add ${esc(p.id === 'other' ? 'a supplier' : p.short)}`}</a>` : ''}
          ${have && p.id !== 'other' ? `<span class="small ok">${have} added</span>` : ''}</div></div>`;
      }).join('')}</div>
    </div>`,
  };
}

// ---------- One supplier ----------
export function supplierEdit(id, params) {
  const isNew = id === 'new';
  const plugin = pluginFor(isNew ? params.get('plugin') : get('suppliers', id)?.plugin);
  const branch0 = plugin.branches[0] || {};
  const s = isNew
    ? {
      plugin: plugin.id, name: plugin.id === 'other' || plugin.id === 'fabricator' ? '' : plugin.name, branch: branch0.city || '',
      branchAddress: branch0.address || '', branchPhone: branch0.phone || '', website: plugin.website, listType: plugin.listType,
      kind: plugin.kind, delivery: plugin.delivery, notes: plugin.tip, emails: [], cc: [],
    }
    : get('suppliers', id);
  if (!s) return { waiting: true, html: '<p class="muted">Loading…</p>' };
  const manage = can.suppliers();
  const ro = manage ? '' : 'disabled';
  const requests = isNew ? [] : where('partsRequests', 'supplierId', id);
  const branchPick = plugin.branches.length
    ? `<label class="span2">Their branches <select id="branchPick" ${ro}>${options([...plugin.branches.map((b) => [b.city, `${b.label}: ${b.address}`]), ['', 'Another branch (type it below)']],
      plugin.branches.some((b) => b.city === s.branch) ? s.branch : '')}</select></label>` : '';

  return {
    html: `<div class="page-head"><div class="page-title"><h1>${isNew ? `New supplier${plugin.id !== 'other' ? `: ${esc(plugin.short)}` : ''}` : esc(s.name)}</h1></div><div class="actions">
      <a class="btn" href="#/suppliers">All suppliers</a>
      ${!isNew && can.edit() ? `<a class="btn" href="#/parts/new?supplier=${esc(id)}">New parts request</a>` : ''}
      ${!isNew && manage ? '<button class="btn danger" id="del">Delete</button>' : ''}</div></div>
    ${manage ? '' : '<p class="hint">Only the owner or an admin can change suppliers, since the app emails parts requests to these addresses.</p>'}
    <form class="card grid2" id="f">
      <fieldset class="span2 grid2" ${ro}>
        <label>Supplier name <input name="name" value="${esc(s.name)}" required maxlength="120" placeholder="${plugin.id === 'fabricator' ? 'e.g. the glass shop you use' : ''}"></label>
        <label>Website <input name="website" value="${esc(s.website)}" maxlength="200"></label>
        ${branchPick}
        <label>Branch name <input name="branch" value="${esc(s.branch)}" maxlength="60" placeholder="City, e.g. Plant City"></label>
        <label>Branch phone <input name="branchPhone" type="tel" value="${esc(s.branchPhone)}" maxlength="40"></label>
        <label class="span2">Branch address <input name="branchAddress" value="${esc(s.branchAddress)}" maxlength="200"></label>
        <h2 class="span2 top-gap">Your rep and account</h2>
        <label>Rep's name <input name="contactName" value="${esc(s.contactName)}" maxlength="80" placeholder="Used to greet them: Hi Pat,"></label>
        <label>Rep's phone <input name="phone" type="tel" value="${esc(s.phone)}" maxlength="40"></label>
        <label class="span2">Send requests to <input name="emails" value="${esc((s.emails || []).join(', '))}" placeholder="rep@supplier.com" autocomplete="off">
          <span class="hint">Up to ${MAX_EMAILS} addresses, separated by commas. The app emails parts requests to these and nobody else.</span></label>
        <label class="span2">Also copy <input name="cc" value="${esc((s.cc || []).join(', '))}" placeholder="Optional, e.g. the branch's order desk" autocomplete="off"></label>
        <label>Account # <input name="account" value="${esc(s.account)}" maxlength="40"></label>
        <span></span>
        <h2 class="span2 top-gap">New requests to them</h2>
        <label>Start as <select name="kind">${options(REQUEST_KINDS, s.kind || 'quote')}</select></label>
        <label>List <select name="listType">${options(LIST_TYPES, s.listType || 'parts')}</select></label>
        <label>Delivery <select name="delivery">${options(DELIVERY, s.delivery || 'site')}</select></label>
        <span></span>
        <label class="span2">Tips for the team, shown on each new request <textarea name="notes" rows="4" maxlength="1000">${esc(s.notes)}</textarea></label>
      </fieldset>
      ${manage ? '<div class="span2 row"><button class="btn primary">Save supplier</button></div>' : ''}
    </form>
    ${requests.length ? `<div class="card"><h2>Parts requests</h2><ul class="links">${requests.sort((a, b) => (b.number || 0) - (a.number || 0)).map((r) => `<li><a href="#/parts/${esc(r.id)}">Request ${esc(r.number)}</a> <span class="muted small">${esc(get('jobs', r.jobId)?.name || '')}</span></li>`).join('')}</ul></div>` : ''}`,
    mount(root) {
      const form = root.querySelector('#f');
      root.querySelector('#branchPick')?.addEventListener('change', (e) => {
        const b = plugin.branches.find((x) => x.city === e.target.value);
        form.branch.value = b ? b.city : '';
        form.branchAddress.value = b ? b.address : '';
        form.branchPhone.value = b ? b.phone : '';
        if (!b) form.branch.focus();
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));
        const to = parseEmails(f.emails);
        const cc = parseEmails(f.cc);
        if (to.bad.length || cc.bad.length) return toast(`Check this email address: ${[...to.bad, ...cc.bad][0]}`, true);
        if (to.emails.length > MAX_EMAILS || cc.emails.length > MAX_EMAILS) return toast(`Up to ${MAX_EMAILS} addresses in each.`, true);
        const data = { ...f, plugin: plugin.id, emails: to.emails, cc: cc.emails };
        if (isNew) {
          const r = await attempt(() => add('suppliers', data), 'Supplier saved');
          if (r) go(`#/suppliers/${r.id}`);
        } else await attempt(() => update('suppliers', id, data), 'Supplier saved');
      });
      root.querySelector('#del')?.addEventListener('click', async () => {
        const n = requests.length;
        if (!confirm(`Delete ${s.name}?${n ? ` Its ${n} parts request${n === 1 ? '' : 's'} keep their history, but can't be emailed from the app again.` : ''} This can't be undone.`)) return;
        if (await attempt(() => remove('suppliers', id), 'Supplier deleted') !== null) go('#/suppliers');
      });
    },
  };
}
