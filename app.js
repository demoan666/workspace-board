// Workspace board page. Runs unchanged in two modes (docs/plans/CONTRACT.md):
//   local: served by board/server.mjs, talks to /api/* (the server puts its token in <meta name="workspace-token">);
//   pages: a static copy (GitHub Pages), talks to api.github.com with a fine-grained token kept in localStorage.
import { reposQuery, readReposResponse, summarize, markerComment } from './model.js';

const $ = (id) => document.getElementById(id);
const TOKEN_META = (document.querySelector('meta[name="workspace-token"]') || {}).content || '';
const params = new URLSearchParams(location.search);
const MODE = params.get('mode') === 'pages' || !TOKEN_META ? 'pages' : 'local';
const LS = { token: 'workspace-board-token', hub: 'workspace-board-hub', theme: 'workspace-board-theme', drafts: 'workspace-board-drafts' };
const DEFAULT_HUB = 'demoan666/git-global-workspace';
const store = {
  get(k, d = '') { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} },
};

const STATUS_LABEL = { todo: 'Not touched', doing: 'In progress', needsMe: 'Needs me', done: 'Done' };
const STATUS_GLYPH = { todo: '○', doing: '◐', needsMe: '!', done: '✓' };
const KIND_LABEL = { bug: 'Bug', task: 'Task', idea: 'Idea', plan: 'Plan' };
const ICON = {
  bug: '<svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="9.5" rx="4" ry="5" fill="currentColor"/><path d="M5 3.5 6.5 5M11 3.5 9.5 5M2 8h2M12 8h2M2.5 12.5 4.3 11M13.5 12.5 11.7 11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  task: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m5 8.2 2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  idea: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a4.5 4.5 0 0 0-2.6 8.2c.4.3.6.7.6 1.1V12h4v-1.2c0-.4.2-.8.6-1.1A4.5 4.5 0 0 0 8 1.5Z" fill="currentColor"/><rect x="6" y="13" width="4" height="1.6" rx=".8" fill="currentColor"/></svg>',
  plan: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h2M2 8h2M2 12.5h2M6 3.5h8M6 8h8M6 12.5h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
};

let repos = null;            // payload of /api/repos (same shape in both modes)
let items = {};              // name -> rows
let current = null;          // dialog context
let lastVersion = '';
let drafts = {};
try { drafts = JSON.parse(store.get(LS.drafts, '{}')) || {}; } catch { drafts = {}; }

// ---------- helpers ----------
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function inline(s) {
  const parts = String(s == null ? '' : s).split('`');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1 && i < parts.length - 1) { out += '<code>' + esc(parts[i]) + '</code>'; continue; }
    let t = esc(i % 2 === 1 ? '`' + parts[i] : parts[i]);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    out += t;
  }
  return out;
}
function block(s) { return String(s || '').split(/\n{2,}/).map((p) => '<p style="margin:0 0 8px">' + p.split('\n').map(inline).join('<br>') + '</p>').join(''); }
function pill(st) { return `<span class="pill ${st}"><span aria-hidden="true">${STATUS_GLYPH[st]}</span>${STATUS_LABEL[st]}</span>`; }
function kind(k) { return `<span class="kind ${k}" title="${KIND_LABEL[k]}">${ICON[k]}${KIND_LABEL[k]}</span>`; }
function when(ts) { try { return new Date(ts).toLocaleString(); } catch { return ts; } }
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); }
function saveDrafts() { store.set(LS.drafts, JSON.stringify(drafts)); }
function setConn(ok, text) { const c = $('conn'); c.className = ok ? 'conn' : 'conn off'; c.innerHTML = '<i></i>' + esc(text || (ok ? 'Live' : 'Not reachable')); }
const enc = encodeURIComponent;

// ---------- data: local mode ----------
const local = {
  async repos() { return getJson('api/repos'); },
  async items(name) { return getJson(`api/repos/${enc(name)}/items`); },
  async act(name, n, act, body) { return postJson(`api/repos/${enc(name)}/items/${n}/${act}`, body); },
  async state(name, state) { return postJson(`api/repos/${enc(name)}/state`, { state }); },
};
async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
  return j;
}
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-token': TOKEN_META }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

// ---------- data: pages mode (api.github.com with the pasted token) ----------
const pages = {
  data: null,
  async gh(path, opt = {}) {
    const token = store.get(LS.token);
    if (!token) throw Object.assign(new Error('No token yet'), { needToken: true });
    const r = await fetch('https://api.github.com/' + path.replace(/^\//, ''), {
      ...opt, cache: 'no-store',
      headers: { authorization: 'Bearer ' + token, accept: opt.accept || 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(opt.body ? { 'content-type': 'application/json' } : {}) },
    });
    if (r.status === 401) throw Object.assign(new Error('The token was refused (expired or wrong). Paste a new one in Settings.'), { needToken: true });
    const text = await r.text();
    let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
    if (!r.ok) throw new Error((j && j.message) || 'HTTP ' + r.status);
    return j;
  },
  async repos() {
    const hub = store.get(LS.hub, DEFAULT_HUB);
    const reg = await this.gh(`repos/${hub}/contents/registry/repos.json`, { accept: 'application/vnd.github.raw+json' })
      .then((x) => (typeof x === 'string' ? JSON.parse(x) : x))
      .catch((e) => {
        if (e.needToken) throw e;
        throw Object.assign(new Error(`The registry is not readable from ${hub} (${e.message}). Check the hub repository name below and that the token includes it.`), { needToken: true });
      });
    const names = reg.repos.map((r) => r.name);
    const resp = await this.gh('graphql', { method: 'POST', body: JSON.stringify({ query: reposQuery(reg.owner, names, { withPRs: false, closed: 1 }) }) });
    this.data = readReposResponse(names, resp);
    const out = reg.repos.map((r) => {
      const d = this.data[r.name];
      const s = summarize(d.rows);
      const o = { ...r, branch: null, cloned: false, counts: s.counts, progress: s.progress, total: s.total, open: d.rows.length, closed: d.closedTotal, defaultBranch: d.defaultBranch || '' };
      if (!d.ok) o.error = d.error;
      return o;
    });
    const version = JSON.stringify(this.data).length + ':' + out.map((x) => x.state).join('');
    return { ...reg, repos: out, mode: 'pages', hub, updated: new Date().toISOString(), version };
  },
  async items(name) { if (!this.data) await this.repos(); return (this.data[name] && this.data[name].rows) || []; },
  async act(name, n, act, body) {
    const owner = repos.owner;
    const post = (b) => this.gh(`repos/${owner}/${name}/issues/${n}/comments`, { method: 'POST', body: JSON.stringify({ body: b }) });
    if (act === 'answer') return { comment: (await post(markerComment('answer', { ask: body.ask || '' }, body.text))).html_url };
    if (act === 'research') return { comment: (await post(markerComment('research', { request: true }, 'Research requested from the board.' + (body.text ? '\n\n' + body.text : '')))).html_url };
    const row = (await this.items(name)).find((r) => r.number === n);
    if (!row || row.status !== 'done') throw new Error('Only Done items can be approved.');
    const c = await post(markerComment('approve', {}, 'Approved' + (body.text ? '\n\n' + body.text : '')));
    await this.gh(`repos/${owner}/${name}/issues/${n}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
    return { comment: c.html_url, closed: true, changelog: 'pending: written by the local board' };
  },
  async state() { throw new Error('Close and Revive change the hub registry; use the local board for that.'); },
};
const api = MODE === 'local' ? local : pages;

// ---------- routing ----------
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (h.startsWith('repo/')) return { page: 'repo', name: h.slice(5) };
  if (h === 'dormant') return { page: 'dormant' };
  if (h === 'settings') return { page: 'settings' };
  return { page: 'all' };
}
function renderTabs() {
  const r = route();
  const live = repos ? repos.repos.filter((x) => x.state === 'live') : [];
  const dormant = repos ? repos.repos.filter((x) => x.state !== 'live') : [];
  const cur = (cond) => (cond ? ' aria-current="page"' : '');
  const badge = (n) => (n ? `<span class="n" title="${n} waiting for you">${n}</span>` : '');
  let h = `<a href="#/"${cur(r.page === 'all')}>All repos${badge(live.reduce((a, x) => a + (x.counts ? x.counts.needsMe : 0), 0))}</a>`;
  if (r.page === 'repo') h += `<a href="#/repo/${enc(r.name)}" aria-current="page">${esc(r.name)}</a>`;
  h += `<a href="#/dormant"${cur(r.page === 'dormant')}>Dormant${dormant.length ? ' (' + dormant.length + ')' : ''}</a>`;
  if (MODE === 'pages') h += `<a href="#/settings"${cur(r.page === 'settings')}>Settings</a>`;
  $('tabs').innerHTML = h;
}

// ---------- pages ----------
function bar(c, total) {
  const t = total || 1;
  return `<div class="bar" role="img" aria-label="${c.done} of ${total} done"><span class="done" style="width:${100 * c.done / t}%"></span><span class="doing" style="width:${100 * c.doing / t}%"></span><span class="you" style="width:${100 * c.needsMe / t}%"></span></div>`;
}
function countChips(c, total, small) {
  if (small) {
    const m = (st) => `<span class="mc ${st}" title="${STATUS_LABEL[st]}"><span aria-hidden="true">${STATUS_GLYPH[st]}</span> ${c[st]}<span class="sr"> ${STATUS_LABEL[st]}</span></span>`;
    return `<div class="mini">${m('done')}${m('doing')}${m('needsMe')}${m('todo')}<span class="mc total">${c.done}/${total} done</span></div>`;
  }
  const ch = (st) => `<span class="chip">${pill(st)}<b>${c[st]}</b></span>`;
  return `<div class="counts">${ch('done')}${ch('doing')}${ch('needsMe')}${ch('todo')}<span class="chip">Total <b>${total}</b></span></div>`;
}
function branchOf(r) {
  if (r.branch) return `<span class="branch" title="Current branch of the local clone">${esc(r.branch)}</span>`;
  if (MODE === 'local' && !r.cloned) return `<span class="meta">not cloned here · working branch <span class="branch">${esc(r.workingBranch || '')}</span></span>`;
  return `<span class="branch" title="Working branch (registry)">${esc(r.workingBranch || r.defaultBranch || '')}</span>`;
}
const tags = (r) => (r.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ');

function repoCard(r, dormant) {
  const c = r.counts || { todo: 0, doing: 0, needsMe: 0, done: 0, ideas: 0 };
  const btn = dormant
    ? `<button class="btn small" data-act="revive" data-repo="${esc(r.name)}"${MODE === 'pages' ? ' disabled title="Use the local board to revive a repository"' : ''}>Revive</button>`
    : `<button class="btn ghost small" data-act="close" data-repo="${esc(r.name)}"${MODE === 'pages' ? ' disabled title="Use the local board to close a repository"' : ''}>Close</button>`;
  return `<div class="repo"><div class="h"><a class="name" href="#/repo/${enc(r.name)}">${esc(r.name)}</a>${btn}</div>
    <div class="sub">${branchOf(r)} ${tags(r)}</div>
    ${r.error ? `<div class="warn">GitHub: ${esc(r.error)}</div>` : ''}
    ${countChips(c, r.total || 0, true)}
    ${c.ideas ? `<div class="meta">${c.ideas} idea${c.ideas === 1 ? '' : 's'}</div>` : ''}
    ${bar(c, r.total || 0)}</div>`;
}
function renderAll() {
  const live = repos.repos.filter((x) => x.state === 'live');
  document.title = 'All repos — Workspace board';
  let h = `<div class="top"><h1>All repos</h1></div><div class="meta">${live.length} live · updated ${esc(when(repos.updated))}${MODE === 'pages' ? ' · read from GitHub' : ''}</div>`;
  h += waitingBox(live) + `<div class="repos" style="margin-top:14px">${live.map((r) => repoCard(r, false)).join('') || '<p class="empty">No live repositories.</p>'}</div>`;
  $('main').innerHTML = h;
}
function waitingBox(live) {
  const n = live.reduce((a, x) => a + (x.counts ? x.counts.needsMe : 0), 0);
  if (!n) return '';
  return `<section class="card waiting" style="margin-top:14px"><h2>Waiting for you (${n})</h2>${live.filter((x) => x.counts && x.counts.needsMe).map((x) => `<div class="ask"><div class="q"><b>${esc(x.name)}</b><div class="muted">${x.counts.needsMe} question${x.counts.needsMe === 1 ? '' : 's'} open</div></div><a class="btn red" href="#/repo/${enc(x.name)}">Open</a></div>`).join('')}</section>`;
}
function renderDormant() {
  const list = repos.repos.filter((x) => x.state !== 'live');
  document.title = 'Dormant — Workspace board';
  $('main').innerHTML = `<div class="top"><h1>Dormant</h1></div><div class="meta">Closed repositories. Revive brings one back to All repos with its progress bar.</div>
    <div class="repos" style="margin-top:14px">${list.map((r) => repoCard(r, true)).join('') || '<p class="empty">No dormant repositories.</p>'}</div>`;
}

function rowAction(name, r) {
  if (r.status === 'needsMe' || (r.ask && !r.ask.answered)) {
    if (r.ask && r.ask.answered) return `<span class="status">Answered</span> <button class="btn ghost small" data-act="answer" data-repo="${esc(name)}" data-n="${r.number}">Change</button>`;
    return `<button class="btn red small" data-act="answer" data-repo="${esc(name)}" data-n="${r.number}">${r.ask ? 'Answer' : 'Reply'}</button>`;
  }
  if (r.status === 'done' && r.kind !== 'idea') {
    if (r.approved) return '<span class="status">Approved ✓</span>';
    return `<button class="btn ghost small" data-act="approve" data-repo="${esc(name)}" data-n="${r.number}">Approve</button>`;
  }
  return '';
}
function rowHtml(name, r, research) {
  const steps = r.steps && r.steps.total ? `${r.steps.done}/${r.steps.total} steps` : '';
  let act = rowAction(name, r);
  if (research) act = (r.researchRequested ? '<span class="status wait">Research requested</span> ' : '') + `<button class="btn ghost small" data-act="research" data-repo="${esc(name)}" data-n="${r.number}">Research</button>` + (act ? ' ' + act : '');
  return `<tr class="${r.status} k-${r.kind}"><td class="id"><a href="${esc(r.url)}" target="_blank" rel="noopener">#${r.number}</a></td><td class="kd">${kind(r.kind)}</td>
    <td class="title">${inline(r.title)}${r.branch ? ` <span class="meta branch">${esc(r.branch)}</span>` : ''}</td><td class="st">${pill(r.status)}</td><td class="note">${steps}</td><td class="act">${act}</td></tr>`;
}
function table(name, rows, research) {
  return `<table><thead><tr><th>#</th><th>Kind</th><th>Title</th><th>State</th><th>Steps</th><th></th></tr></thead><tbody>${rows.map((r) => rowHtml(name, r, research)).join('')}</tbody></table>`;
}
function renderRepo(name) {
  const r = repos.repos.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!r) { $('main').innerHTML = `<p class="empty">Unknown repository <code>${esc(name)}</code>. <a href="#/">All repos</a></p>`; return; }
  const rows = items[r.name];
  const c = r.counts || { todo: 0, doing: 0, needsMe: 0, done: 0 };
  document.title = (c.needsMe ? `(${c.needsMe}) ` : '') + r.name + ' — Workspace board';
  const gh = `https://github.com/${repos.owner}/${r.name}/issues`;
  let h = `<div class="top"><h1>${esc(r.name)}</h1></div>
    <div class="sub meta" style="display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;margin-top:4px">${branchOf(r)} ${tags(r)} <a href="${gh}" target="_blank" rel="noopener">Issues on GitHub</a>${r.state !== 'live' ? ' <span class="tag">dormant</span>' : ''}</div>`;
  if (r.error) h += `<div class="banner" style="margin-top:12px">GitHub: ${esc(r.error)}. The board lists this repository's issues once it exists on GitHub.</div>`;
  h += countChips(c, r.total || 0, false) + bar(c, r.total || 0);
  if (!rows) { $('main').innerHTML = h + '<p class="empty">Loading items…</p>'; return; }
  const work = rows.filter((x) => x.kind === 'bug' || x.kind === 'task');
  const ideas = rows.filter((x) => x.kind === 'idea' || x.kind === 'plan');
  const waiting = rows.filter((x) => x.status === 'needsMe' || (x.ask && !x.ask.answered));
  if (waiting.length) {
    h += `<section class="card waiting"><h2>Waiting for you (${waiting.length})</h2>`;
    for (const x of waiting) {
      const q = x.ask;
      const sub = q ? inline((q.text || '').split('\n')[0]) : 'No question written yet; you can still reply.';
      const stat = q && q.answered ? `<div class="status">Answered ${esc(when(q.answeredAt))} · waiting for the assistant to pick it up</div>` : '';
      const rec = q && q.recommend ? `<div class="rec"><b>Recommendation:</b> ${inline(q.recommend)}</div>` : '';
      h += `<div class="ask"><div class="q"><div><b>#${x.number}</b> · ${inline(x.title)}</div><div class="muted">${sub}</div>${rec}${stat}</div>
        <button class="btn red" data-act="answer" data-repo="${esc(r.name)}" data-n="${x.number}">${q && q.answered ? 'Change answer' : q ? 'Answer' : 'Reply'}</button></div>`;
    }
    h += '</section>';
  }
  h += `<section class="card">${work.length ? table(r.name, work, false) : '<p class="empty">No open bugs or tasks.</p>'}</section>`;
  h += `<section class="card"><details class="ideas" id="ideas"${store.get('ideas-open:' + r.name) === '1' ? ' open' : ''}><summary>Ideas &amp; plans (${ideas.length})</summary>
    ${ideas.length ? table(r.name, ideas, true) : '<p class="empty">No open ideas.</p>'}</details></section>`;
  $('main').innerHTML = h;
  const d = $('ideas');
  if (d) d.addEventListener('toggle', () => store.set('ideas-open:' + r.name, d.open ? '1' : ''));
}
function renderSettings(msg) {
  document.title = 'Settings — Workspace board';
  const has = !!store.get(LS.token);
  $('main').innerHTML = `<div class="top"><h1>Settings</h1></div>
  <section class="card settings" style="margin-top:14px">
    ${msg ? `<div class="banner">${esc(msg)}</div>` : ''}
    <p>This page reads and writes your GitHub issues straight from this browser. Nothing is sent anywhere else, and the token stays in this browser's storage.</p>
    <p><b>Create a fine-grained personal access token</b> on GitHub (Settings → Developer settings → Fine-grained tokens), with an expiry date and:</p>
    <ul>
      <li><b>Repository access:</b> Only select repositories — the repositories on the board and the hub repository.</li>
      <li><b>Issues:</b> Read and write (comments, Answer, Approve, closing an approved issue).</li>
      <li><b>Contents:</b> Read-only (the hub's <code>registry/repos.json</code>).</li>
      <li><b>Metadata:</b> Read-only (required by GitHub).</li>
    </ul>
    <p class="meta">Approve here posts the approval comment and closes the issue. The <code>CHANGELOG.md</code> line is written later by the local board on your PC (it picks up approved issues on its next refresh). Close and Revive need the local board.</p>
    <form id="setForm">
      <div class="row"><label for="tok">Token ${has ? '(saved; paste a new one to replace it)' : ''}</label><input type="password" id="tok" autocomplete="off" placeholder="github_pat_…"></div>
      <div class="row"><label for="hub">Hub repository (owner/name)</label><input type="text" id="hub" value="${esc(store.get(LS.hub, DEFAULT_HUB))}"></div>
      <div class="actions"><button type="button" class="btn ghost" id="forget"${has ? '' : ' disabled'}>Forget token</button><button type="submit" class="btn">Save</button></div>
    </form>
  </section>`;
  $('setForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('tok').value.trim(), hub = $('hub').value.trim();
    if (t) store.set(LS.token, t);
    if (hub && /^[\w.-]+\/[\w.-]+$/.test(hub)) store.set(LS.hub, hub);
    toast('Saved.'); location.hash = '#/'; load(true);
  });
  $('forget').addEventListener('click', () => { store.set(LS.token, ''); toast('Token removed from this browser.'); renderSettings(); });
}

function render() {
  renderTabs();
  const r = route();
  if (r.page === 'settings') return renderSettings();
  if (!repos) return;
  if (r.page === 'repo') return renderRepo(r.name);
  if (r.page === 'dormant') return renderDormant();
  return renderAll();
}

// ---------- loading + live updates ----------
let loading = null;
async function load(force) {
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const p = await api.repos();
      const r = route();
      let changed = p.version !== lastVersion || force;
      repos = p; lastVersion = p.version;
      if (r.page === 'repo') {
        const name = (p.repos.find((x) => x.name.toLowerCase() === r.name.toLowerCase()) || {}).name;
        if (name) {
          const rows = await api.items(name);
          if (JSON.stringify(rows) !== JSON.stringify(items[name])) { items[name] = rows; changed = true; }
        }
      }
      setConn(true, MODE === 'pages' ? 'GitHub' : 'Live');
      if (changed && !$('dlg').open) render();
      else renderTabs();
    } catch (e) {
      if (e.needToken) { setConn(false, 'No token'); renderTabs(); if (route().page !== 'settings') renderSettings(e.message === 'No token yet' ? 'Paste a GitHub token to see the board.' : e.message); return; }
      setConn(false, MODE === 'local' ? 'Server not reachable' : 'GitHub error');
      if (!repos) $('main').innerHTML = `<div class="banner">${esc(e.message)}</div>`;
    } finally { loading = null; }
  })();
  return loading;
}
function live() {
  if (MODE === 'local' && 'EventSource' in window) {
    const es = new EventSource('api/events');
    es.addEventListener('update', (ev) => { try { const d = JSON.parse(ev.data); if (d.version && d.version !== lastVersion) load(); } catch {} setConn(true, 'Live'); });
    es.onerror = () => setConn(false, 'Server not reachable');
  }
  setInterval(() => { if (!document.hidden) load(); }, MODE === 'local' ? 20000 : 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
}

// ---------- dialog: Answer / Approve / Research ----------
function findRow(name, n) { return (items[name] || []).find((r) => r.number === n); }
function openDialog(act, name, n) {
  const r = findRow(name, n); if (!r) return;
  current = { act, name, n, ask: r.ask ? r.ask.id : '' };
  const q = r.ask;
  $('dlgErr').textContent = '';
  $('dlgTask').innerHTML = `<b>${esc(name)} #${r.number}</b> · ${inline(r.title)}`;
  const opts = $('dlgOpts'); opts.innerHTML = '';
  $('dlgRec').hidden = true;
  if (act === 'approve') {
    $('dlgTitle').textContent = `Approve #${r.number}`;
    $('dlgQ').innerHTML = MODE === 'local'
      ? 'Approve this finished item? The board writes it to <code>CHANGELOG.md</code> (on its PR branch if it has one, otherwise on the default branch), comments "Approved" on the issue and closes it. No pull request is merged.'
      : 'Approve this finished item? This comments "Approved" on the issue and closes it. Your local board adds the <code>CHANGELOG.md</code> line on its next refresh. No pull request is merged.';
    $('dlgLabel').textContent = 'Comment (optional)'; $('dlgSend').textContent = 'Approve';
  } else if (act === 'research') {
    $('dlgTitle').textContent = `Research #${r.number}`;
    $('dlgQ').innerHTML = 'Ask a local assistant to investigate this idea. The request becomes a comment on the issue; the report arrives there as a research comment.';
    $('dlgLabel').textContent = 'What should the research look at? (optional)'; $('dlgSend').textContent = 'Request research';
  } else {
    $('dlgTitle').textContent = q ? 'Question' : 'Reply';
    $('dlgQ').innerHTML = q ? block(q.text) : '<span class="meta">No question was written for this item. Your reply goes to the issue as an answer.</span>';
    if (q && q.recommend) { $('dlgRec').hidden = false; $('dlgRec').innerHTML = '<b>Recommendation:</b> ' + inline(q.recommend); }
    const choices = q && q.options ? q.options.slice() : [];
    if (q && q.recommend) choices.unshift('Go with the recommendation');
    for (const o of choices) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'opt'; b.setAttribute('aria-pressed', 'false'); b.innerHTML = inline(o);
      b.addEventListener('click', () => {
        for (const x of opts.children) x.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        $('dlgText').value = o === 'Go with the recommendation' && q.recommend ? q.recommend : o;
        drafts[key()] = $('dlgText').value; saveDrafts(); $('dlgText').focus();
      });
      opts.appendChild(b);
    }
    $('dlgLabel').textContent = 'Your answer'; $('dlgSend').textContent = 'Send answer';
  }
  $('dlgText').value = drafts[key()] != null ? drafts[key()] : (act === 'answer' && q && q.answered ? q.answer : '');
  $('dlg').showModal(); $('dlgText').focus();
}
const key = () => current ? `${current.act}:${current.name}#${current.n}` : '';
async function send() {
  if (!current) return;
  const c = current, k = key();
  const text = $('dlgText').value.trim();
  if (c.act === 'answer' && !text) { $('dlgErr').textContent = 'Write an answer or pick an option first.'; return; }
  $('dlgSend').disabled = true;
  try {
    const res = await api.act(c.name, c.n, c.act, { ask: c.ask, text });
    delete drafts[k]; saveDrafts();
    $('dlg').close();
    const msg = c.act === 'approve'
      ? (res.changelog && res.changelog.sha ? `Approved. CHANGELOG ${res.changelog.sha.slice(0, 7)} on ${res.changelog.branch}; issue closed.` : 'Approved; issue closed.' + (MODE === 'pages' ? ' The local board adds the CHANGELOG line.' : ''))
      : c.act === 'research' ? 'Research requested on the issue.' : 'Answer posted on the issue. The assistant picks it up.';
    toast(msg);
    setTimeout(() => load(true), 400);
  } catch (e) { $('dlgErr').textContent = 'Not saved: ' + e.message; }
  finally { $('dlgSend').disabled = false; }
}
async function setRepoState(name, state) {
  const verb = state === 'dormant' ? 'Close' : 'Revive';
  if (state === 'dormant' && !confirm(`${verb} ${name}? It moves to Dormant on every machine and on the phone. Its issues stay on GitHub.`)) return;
  try {
    const r = await api.state(name, state);
    toast(`${name} is ${state}${r.commit ? ' · registry ' + r.commit.slice(0, 7) : ''}`);
    load(true);
  } catch (e) { toast('Not changed: ' + e.message); }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b || b.disabled) return;
  const act = b.getAttribute('data-act'), name = b.getAttribute('data-repo');
  if (act === 'close') return setRepoState(name, 'dormant');
  if (act === 'revive') return setRepoState(name, 'live');
  openDialog(act, name, Number(b.getAttribute('data-n')));
});
$('dlgForm').addEventListener('submit', (e) => { e.preventDefault(); send(); });
$('dlgCancel').addEventListener('click', () => { $('dlg').close(); current = null; });
$('dlgText').addEventListener('input', () => { if (current) { drafts[key()] = $('dlgText').value; saveDrafts(); } });
$('dlgText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
$('dlg').addEventListener('close', () => { current = null; render(); });

// ---------- theme ----------
const THEMES = ['auto', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
  const b = $('theme'); b.textContent = t[0].toUpperCase() + t.slice(1); b.title = 'Theme: ' + (t === 'auto' ? 'follows the system' : t) + ' (click to change)';
}
$('theme').addEventListener('click', () => { const t = THEMES[(THEMES.indexOf(store.get(LS.theme, 'auto')) + 1) % 3]; store.set(LS.theme, t === 'auto' ? '' : t); applyTheme(t); });
applyTheme(store.get(LS.theme, 'auto'));

window.addEventListener('hashchange', () => { render(); load(true); });
render();
load(true);
// ?snapshot loads once without the live stream (headless captures and screenshots).
if (!params.has('snapshot')) live();
