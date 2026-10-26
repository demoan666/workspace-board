// Shared model for the workspace board: used by the local server (Node) and by the page in both modes.
// Pure functions only (no DOM, no Node APIs). Labels and markers follow docs/plans/CONTRACT.md.

export const KINDS = ['bug', 'task', 'idea', 'plan'];
export const STATUSES = ['todo', 'doing', 'needsMe', 'done'];
const STATUS_LABEL = { 'status:todo': 'todo', 'status:doing': 'doing', 'status:needs-me': 'needsMe', 'status:done': 'done' };

// ---------- markers ----------
const MARKER_RE = /<!--\s*workspace:([a-z]+)\s*(\{.*?\})?\s*-->/g;

/** All workspace markers in a comment body: [{ type, data, text }] (text = the body without the marker). */
export function parseMarkers(body) {
  const out = [];
  const s = String(body || '');
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(s))) {
    let data = {};
    try { data = m[2] ? JSON.parse(m[2]) : {}; } catch { data = {}; }
    out.push({ type: m[1], data });
  }
  const text = s.replace(MARKER_RE, '').trim();
  return out.map((x) => ({ ...x, text }));
}

/** One comment body carrying a marker: `<!-- workspace:<type> {json} -->` + a human text line. */
export function markerComment(type, data, text) {
  return `<!-- workspace:${type} ${JSON.stringify(data || {})} -->\n${String(text || '').trim()}`;
}

// ---------- issue -> row ----------
function labelNames(issue) {
  const l = issue.labels;
  if (!l) return [];
  const arr = Array.isArray(l) ? l : l.nodes || [];
  return arr.map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean);
}
function commentsOf(issue) {
  const c = issue.comments;
  if (!c) return [];
  return Array.isArray(c) ? c : c.nodes || [];
}

export function kindOf(labels) {
  if (labels.includes('kind:idea') && labels.includes('plan')) return 'plan';
  if (labels.includes('kind:bug')) return 'bug';
  if (labels.includes('kind:idea')) return 'idea';
  if (labels.includes('plan')) return 'plan';
  return 'task';
}
export function statusOf(labels) {
  for (const l of labels) if (STATUS_LABEL[l]) return STATUS_LABEL[l];
  return 'todo';
}

/** Steps: the `## Steps` checklist in the body; without one, the step markers in comments. */
export function stepsOf(body, comments) {
  const lines = String(body || '').split(/\r?\n/);
  let inSteps = false, done = 0, total = 0;
  for (const l of lines) {
    if (/^#{1,6}\s+/.test(l)) { inSteps = /^#{1,6}\s+steps\s*$/i.test(l.trim()); continue; }
    if (!inSteps) continue;
    const m = /^\s*[-*]\s+\[([ xX])\]\s+/.exec(l);
    if (m) { total++; if (m[1] !== ' ') done++; }
  }
  if (total) return { done, total };
  const seen = new Map();
  for (const c of comments) for (const mk of parseMarkers(c.body)) {
    if (mk.type !== 'step' || !mk.data.step) continue;
    if (mk.data.state === 'done' || !seen.has(mk.data.step)) seen.set(mk.data.step, mk.data.state === 'done');
  }
  for (const v of seen.values()) { total++; if (v) done++; }
  return { done, total };
}

/** The latest question (ask marker) and whether an answer marker for it followed. */
export function askOf(comments) {
  let ask = null;
  for (const c of comments) for (const mk of parseMarkers(c.body)) {
    if (mk.type === 'ask') {
      ask = { id: String(mk.data.id || ''), text: mk.text, recommend: mk.data.recommend || '', options: Array.isArray(mk.data.options) ? mk.data.options : [], at: c.createdAt || '', answered: false, answer: '' };
    } else if (mk.type === 'answer' && ask && String(mk.data.ask || '') === ask.id) {
      ask.answered = true; ask.answer = mk.text; ask.answeredAt = c.createdAt || '';
    }
  }
  return ask;
}

export function hasMarker(comments, type) {
  return comments.some((c) => parseMarkers(c.body).some((m) => m.type === type));
}

/** Branch from the latest session marker (`workspace:session {"branch":...}`). */
export function sessionBranch(comments) {
  let b = '';
  for (const c of comments) for (const mk of parseMarkers(c.body)) if (mk.type === 'session' && mk.data.branch) b = mk.data.branch;
  return b;
}

/** Open pull requests linked to the issue in the same repository (closing references and cross references). */
export function linkedOpenPRs(issue, repoFullName) {
  const out = [];
  const add = (p) => {
    if (!p || !p.headRefName || p.state !== 'OPEN' || p.isCrossRepository) return;
    if (p.repository && repoFullName && p.repository.nameWithOwner.toLowerCase() !== repoFullName.toLowerCase()) return;
    if (!out.some((x) => x.number === p.number)) out.push({ number: p.number, branch: p.headRefName, url: p.url });
  };
  for (const p of (issue.closedByPullRequestsReferences && issue.closedByPullRequestsReferences.nodes) || []) add(p);
  for (const e of (issue.timelineItems && issue.timelineItems.nodes) || []) add(e && e.source);
  return out;
}

/** A board row for one issue (CONTRACT: { number, title, kind, status, url, steps, ask? }). */
export function issueToRow(issue, repoFullName) {
  const labels = labelNames(issue);
  const comments = commentsOf(issue);
  const row = {
    number: issue.number,
    title: issue.title,
    kind: kindOf(labels),
    status: statusOf(labels),
    url: issue.url || issue.html_url || '',
    steps: stepsOf(issue.body, comments),
    labels,
    updated: issue.updatedAt || issue.updated_at || '',
    approved: hasMarker(comments, 'approve'),
    researchRequested: hasMarker(comments, 'research'),
  };
  const ask = askOf(comments);
  if (ask && (!ask.answered || row.status === 'needsMe')) row.ask = ask;
  const prs = linkedOpenPRs(issue, repoFullName);
  if (prs.length) row.prs = prs;
  const sb = sessionBranch(comments);
  if (sb) row.branch = sb;
  return row;
}

/** Counts and progress over the rows that are work (ideas that are not plans stay out of the bar). */
export function summarize(rows) {
  const counts = { todo: 0, doing: 0, needsMe: 0, done: 0, ideas: 0 };
  for (const r of rows) {
    if (r.kind === 'idea') { counts.ideas++; continue; }
    counts[r.status]++;
  }
  const total = counts.todo + counts.doing + counts.needsMe + counts.done;
  return { counts, total, progress: total ? Math.round((counts.done / total) * 1000) / 1000 : 0 };
}

// ---------- GraphQL ----------
const gq = (s) => JSON.stringify(String(s));

/** One GraphQL query for many repositories (aliases r0..rN). withPRs=false for tokens without pull-request read. */
export function reposQuery(owner, names, { withPRs = true, closed = 15 } = {}) {
  const prFields = 'number state headRefName isCrossRepository url';
  const pr = withPRs
    ? `closedByPullRequestsReferences(first: 5, includeClosedPrs: false) { nodes { ${prFields} } }
       timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 10) { nodes { ... on CrossReferencedEvent { source { ... on PullRequest { ${prFields} repository { nameWithOwner } } } } } }`
    : '';
  const parts = names.map((n, i) => `r${i}: repository(owner: ${gq(owner)}, name: ${gq(n)}) {
    name nameWithOwner hasIssuesEnabled defaultBranchRef { name }
    open: issues(states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: ASC }) { totalCount nodes { ...I } }
    closed: issues(states: CLOSED, first: ${closed}, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { number title url closedAt labels(first: 20) { nodes { name } } comments(last: 15) { nodes { body createdAt } } } }
  }`);
  return `query {
${parts.join('\n')}
}
fragment I on Issue {
  number title url body createdAt updatedAt
  labels(first: 20) { nodes { name } }
  comments(last: 40) { nodes { body createdAt } }
  ${pr}
}`;
}

/** Turn a GraphQL response ({data, errors}) for reposQuery into { <name>: { ok, defaultBranch, rows, closed, error } }. */
export function readReposResponse(names, resp) {
  const data = (resp && resp.data) || {};
  const errors = (resp && resp.errors) || [];
  const out = {};
  names.forEach((n, i) => {
    const r = data['r' + i];
    if (!r) {
      const e = errors.find((x) => (x.path || [])[0] === 'r' + i);
      out[n] = { ok: false, error: e ? (e.type === 'NOT_FOUND' ? 'not on GitHub' : e.message) : 'no data', rows: [], closedTotal: 0, recentClosed: [] };
      return;
    }
    const full = r.nameWithOwner;
    const rows = (r.open && r.open.nodes || []).map((x) => issueToRow(x, full));
    out[n] = {
      ok: true,
      fullName: full,
      defaultBranch: r.defaultBranchRef ? r.defaultBranchRef.name : '',
      issuesEnabled: r.hasIssuesEnabled,
      rows,
      closedTotal: r.closed ? r.closed.totalCount : 0,
      recentClosed: (r.closed && r.closed.nodes || []).map((x) => ({
        number: x.number, title: x.title, url: x.url, closedAt: x.closedAt,
        kind: kindOf(labelNames(x)), approved: hasMarker(commentsOf(x), 'approve'),
      })),
    };
  });
  return out;
}

// ---------- CHANGELOG ----------
export function changelogLine(item) {
  const kind = item.kind && item.kind !== 'task' ? ` (${item.kind})` : '';
  return `- ${String(item.title).replace(/\r?\n/g, ' ').trim()}${kind} (#${item.number})`;
}
export function changelogHas(text, number) {
  return new RegExp(`\\(#${number}\\)\\s*$`, 'm').test(String(text || ''));
}
/** Insert one line under today's `## YYYY-MM-DD` heading (newest first), creating the file text when empty. */
export function insertChangelog(text, line, date) {
  const src = text && text.trim() ? text : '# Changelog\n\nApproved work, newest first.\n';
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const head = `## ${date}`;
  const at = lines.findIndex((l) => l.trim() === head);
  if (at >= 0) {
    let i = at + 1;
    if (lines[i] === '') i++; else lines.splice(i++, 0, '');
    lines.splice(i, 0, line);
  } else {
    const first = lines.findIndex((l) => /^##\s/.test(l));
    if (first < 0) { while (lines.length && lines[lines.length - 1].trim() === '') lines.pop(); lines.push('', head, '', line); }
    else lines.splice(first, 0, head, '', line, '');
  }
  let out = lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return out;
}
export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
