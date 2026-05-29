#!/usr/bin/env node
// frontend-conqueror — gate service (singleton)
//
// One gate = one project. The gate is installed alongside the project it
// serves. The admin sets the Linear API key first; the gate auto-resolves the
// team; the admin then picks an existing Linear project or creates a new one.
// All reports from the overlay flow to that single Linear project.
//
// Run:    GATE_ADMIN_PASSWORD=changeme node gate/server.js
// Admin:  http://localhost:54322/frontend-conqueror

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = Number(process.env.GATE_PORT || 54322);
const HOST = process.env.GATE_HOST || '0.0.0.0';
const DATA_FILE = process.env.GATE_DATA || path.join(__dirname, 'data.json');
// The "default" password is shown on the login screen until the admin sets
// a custom one (which is stored as a scrypt hash in data.json and from then on
// overrides the default). Configurable via env so the developer can pick
// something they're OK with shipping in plain text in their gate environment.
const DEFAULT_ADMIN_PASSWORD = process.env.GATE_ADMIN_PASSWORD || 'frontend-conqueror';
const JWT_SECRET = process.env.GATE_JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_TTL_SECONDS = Number(process.env.GATE_JWT_TTL || 24 * 60 * 60);
const ADMIN_SESSION_TTL = Number(process.env.GATE_ADMIN_TTL || 12 * 60 * 60);
const DEFAULT_PROJECT_NAME = process.env.GATE_PROJECT_NAME || 'frontend-conqueror';
// Where to point the overlay back to (used when the gate is reached over a
// proxy or a different hostname than the bind). Falls back to the bind URL.
const PUBLIC_URL = process.env.GATE_PUBLIC_URL || `http://localhost:${PORT}`;
const OVERLAY_FILE = path.join(__dirname, '..', 'overlay', 'overlay.js');

// ---------- Storage ----------
const DEFAULT_MODE_COLORS = { edit: '#2563eb', test: '#f59e0b', todo: '#059669' };
// v0.5.0 shape:
//   { modeColors, adminPasswordHash, linear: {apiKey,teamId,teamName},
//     projects: { [key]: { key, displayName, status, emails,
//                          linearProjectId, linearProjectName,
//                          linearApiKey, linearTeamId,         (per-project overrides; null=use global)
//                          activity: { firstSeenAt, lastSeenAt, totalHeartbeats,
//                                      origins: { [origin]: count },
//                                      pages: [url, ...],            (rolling, max 100)
//                                      dailyIpHashes: [{ day, hashes: [] }],  (rolling 7 days)
//                                      reportsCount },
//                          createdAt } } }
const DEFAULT_DATA = () => ({
  modeColors: { ...DEFAULT_MODE_COLORS },
  linear: null,    // { apiKey, teamId, teamName, availableTeams }
  github: null,    // v0.10.0+: { token } — global PAT used as a fallback when a project has no per-project token
  projects: {},
});
function emptyActivity() {
  return {
    firstSeenAt: null,
    lastSeenAt: null,
    totalHeartbeats: 0,
    origins: {},
    pages: [],
    dailyIpHashes: [],
    reportsCount: 0,
  };
}
function emptyProject(key, displayName) {
  return {
    key,
    displayName: displayName || key,
    status: 'pending',                   // pending | active | disabled
    users: {},                           // { [email]: { passwordHash, createdAt, lastLoginAt, lockedUntil } }
    // v0.10.0+: which tracker this project writes to.
    backend: 'linear',                   // 'linear' | 'github'
    // Linear-specific (used when backend === 'linear')
    linearProjectId: '',
    linearProjectName: '',
    linearApiKey: null,                  // per-project override
    linearTeamId: null,
    // GitHub-specific (used when backend === 'github')
    githubRepo: '',                      // 'owner/repo'
    githubToken: null,                   // per-project override; otherwise inherits global
    activity: emptyActivity(),
    createdAt: Math.floor(Date.now() / 1000),
  };
}
function emptyUser() {
  return { passwordHash: null, createdAt: Math.floor(Date.now() / 1000), lastLoginAt: null, lockedUntil: null };
}
function loadData() {
  let data;
  try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { data = DEFAULT_DATA(); }

  // ---- v0.5.0 migration from singleton shape ----
  // Old shape: { modeColors, adminPasswordHash, settings: { projectName, emails, linear } }
  if (data.settings && !data.projects) {
    const oldS = data.settings;
    const key = String(oldS.projectName || DEFAULT_PROJECT_NAME).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '') || 'default';
    const oldLin = oldS.linear || null;
    // Promote global Linear key + team if we had one.
    if (oldLin && oldLin.apiKey) {
      data.linear = {
        apiKey: oldLin.apiKey,
        teamId: oldLin.teamId || '',
        teamName: oldLin.teamName || '',
        availableTeams: oldLin.availableTeams || null,
      };
    }
    const proj = emptyProject(key, oldS.projectName);
    proj.status = 'active';
    // v0.8.0: emails[] → users{}. Migrated entries have no password — admin must
    // set one before they can log in.
    if (Array.isArray(oldS.emails)) {
      for (const e of oldS.emails) {
        const lc = String(e).toLowerCase().trim();
        if (lc) proj.users[lc] = emptyUser();
      }
    }
    if (oldLin) {
      proj.linearProjectId = oldLin.projectId || '';
      proj.linearProjectName = oldLin.projectName || '';
    }
    data.projects = { [key]: proj };
    delete data.settings;
  }

  // Pre-v0.5.0 alpha (very old multi-project shape; same migration target).
  if (data.projects && data.projects.length === undefined && Object.values(data.projects).some((p) => p && p.linear && p.linear.apiKey)) {
    // If any project still has its own .linear object, promote the first one to global.
    if (!data.linear) {
      for (const p of Object.values(data.projects)) {
        if (p && p.linear && p.linear.apiKey) {
          data.linear = {
            apiKey: p.linear.apiKey,
            teamId: p.linear.teamId || '',
            teamName: p.linear.teamName || '',
            availableTeams: p.linear.availableTeams || null,
          };
          break;
        }
      }
    }
    for (const [k, p] of Object.entries(data.projects)) {
      if (!p) continue;
      if (p.linear) {
        p.linearProjectId = p.linearProjectId || p.linear.projectId || '';
        p.linearProjectName = p.linearProjectName || p.linear.projectName || '';
        delete p.linear;
      }
      if (!p.key) p.key = k;
      if (!p.status) p.status = 'active';
      if (!p.activity) p.activity = emptyActivity();
      if (!p.createdAt) p.createdAt = Math.floor(Date.now() / 1000);
    }
  }

  if (!data.modeColors) data.modeColors = { ...DEFAULT_MODE_COLORS };
  if (!data.projects) data.projects = {};
  if (data.linear === undefined) data.linear = null;
  if (data.github === undefined) data.github = null;

  // v0.8.0 migration: convert per-project emails[] to users{} (with no
  // password — admin must set one). Idempotent — leaves existing users{} alone.
  // v0.10.0 migration: default backend='linear' on any project that doesn't
  // have one (i.e., existed before the GitHub feature). New projects get
  // backend assigned in the wizard.
  for (const proj of Object.values(data.projects)) {
    if (!proj) continue;
    if (!proj.users) proj.users = {};
    if (Array.isArray(proj.emails)) {
      for (const e of proj.emails) {
        const lc = String(e).toLowerCase().trim();
        if (lc && !proj.users[lc]) proj.users[lc] = emptyUser();
      }
      delete proj.emails;
    }
    if (!proj.backend) proj.backend = 'linear';
    if (proj.githubRepo === undefined) proj.githubRepo = '';
    if (proj.githubToken === undefined) proj.githubToken = null;
  }
  return data;
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Sanitize a string into a project key: lowercase, alphanum + dash.
function normalizeProjectKey(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64);
}
// Returns the project to use when no project key is given. If exactly one
// active project exists, that's it. Otherwise null (caller responsible for
// rejecting). GATE_DEFAULT_PROJECT env var overrides.
function defaultProject(data) {
  const envDefault = normalizeProjectKey(process.env.GATE_DEFAULT_PROJECT || '');
  if (envDefault && data.projects[envDefault]) return data.projects[envDefault];
  const active = Object.values(data.projects).filter((p) => p.status === 'active');
  if (active.length === 1) return active[0];
  return null;
}
// Resolve the Linear credentials a project uses: per-project override if set,
// else falls back to the global gate Linear config.
function projectLinear(data, proj) {
  const apiKey = proj.linearApiKey || (data.linear && data.linear.apiKey) || null;
  const teamId = proj.linearTeamId || (data.linear && data.linear.teamId) || null;
  return {
    apiKey,
    teamId,
    projectId: proj.linearProjectId || '',
    projectName: proj.linearProjectName || '',
  };
}
// v0.10.0+: resolve GitHub credentials for a project. Per-project token wins;
// falls back to the gate-wide token. Repo is project-scoped only.
function projectGithub(data, proj) {
  const token = proj.githubToken || (data.github && data.github.token) || null;
  return { token, repo: proj.githubRepo || '' };
}
// SHA-256 of an IP + the gate's daily salt. Daily salt rotates each UTC day,
// so we can compute unique-IP counts without storing raw IPs.
function dayKey() { return new Date().toISOString().slice(0, 10); }
function ipHash(ip) {
  const day = dayKey();
  return crypto.createHash('sha256').update(JWT_SECRET + ':' + day + ':' + ip).digest('hex').slice(0, 16);
}

// ---------- Crypto helpers ----------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(body).digest());
  return body + '.' + sig;
}
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', JWT_SECRET).update(body).digest());
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); }
  catch { return null; }
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}
// scrypt-based password hashing (Node built-in, no deps). Format:
// "scrypt$<salt-hex>$<derived-hex>" so the salt and parameters travel with the hash.
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt.toString('hex')}$${derived.toString('hex')}`);
    });
  });
}
function verifyHash(password, hash) {
  return new Promise((resolve) => {
    if (!hash || typeof hash !== 'string') return resolve(false);
    const parts = hash.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return resolve(false);
    let salt, expected;
    try { salt = Buffer.from(parts[1], 'hex'); expected = Buffer.from(parts[2], 'hex'); }
    catch { return resolve(false); }
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err || derived.length !== expected.length) return resolve(false);
      try { resolve(crypto.timingSafeEqual(derived, expected)); }
      catch { resolve(false); }
    });
  });
}

function constantTimeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------- Rate limiting ----------
// Per-bucket counters so login attempts can have a stricter cap than the
// regular tester-facing endpoints (and so a flood on one doesn't poison the
// other).
const buckets = new Map();
function rateLimit(bucket, ip, max = 30, windowMs = 60_000) {
  const key = bucket + ':' + ip;
  const now = Date.now();
  const entry = buckets.get(key) || { count: 0, windowStart: now };
  if (now - entry.windowStart > windowMs) { entry.count = 0; entry.windowStart = now; }
  entry.count++;
  buckets.set(key, entry);
  return entry.count <= max;
}

// ---------- HTTP plumbing ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function send(res, status, body, headers = {}) {
  const isObjectBody = body != null && !Buffer.isBuffer(body) && typeof body !== 'string';
  const finalHeaders = {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...headers,
  };
  if (isObjectBody) finalHeaders['Content-Type'] = 'application/json';
  res.writeHead(status, finalHeaders);
  if (body == null) return res.end();
  if (typeof body === 'string' || Buffer.isBuffer(body)) return res.end(body);
  res.end(JSON.stringify(body));
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const pair of raw.split(';')) {
    const [k, v] = pair.trim().split('=');
    if (k === name) return decodeURIComponent(v || '');
  }
  return null;
}
function setCookie(res, name, value, maxAgeSec, opts) {
  // v0.9.7: Secure attribute when we know the connection is HTTPS — Cloudflare
  // sets x-forwarded-proto; PUBLIC_URL is the deployed external URL. Without
  // Secure the cookie can be sent over a hypothetical HTTP request and
  // intercepted; with Secure on a local HTTP dev gate the cookie would never
  // be sent at all, so we only add it when the connection is actually TLS.
  const isSecure = !!(opts && opts.secure) ||
    String((opts && opts.req && opts.req.headers['x-forwarded-proto']) || '').toLowerCase() === 'https' ||
    PUBLIC_URL.startsWith('https://');
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; Max-Age=0`);
}
function requireAdmin(req) {
  const tok = getCookie(req, 'gate_admin');
  if (!tok) return false;
  const payload = verifyToken(tok);
  return !!(payload && payload.role === 'admin');
}
function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}
function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length < 255;
}
function isValidHex(s) {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
}
function trunc(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

// ---------- Linear ----------
async function linearGraphQL(apiKey, query, variables) {
  const r = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const data = await r.json();
  if (data.errors) throw new Error('Linear API: ' + JSON.stringify(data.errors));
  if (!data.data) throw new Error('Linear API: empty response');
  return data.data;
}
async function fetchLinearTeams(apiKey) {
  const data = await linearGraphQL(apiKey, `query { teams(first: 50) { nodes { id name key } } }`, {});
  return (data.teams && data.teams.nodes) || [];
}
async function fetchLinearProjectsInTeam(apiKey, teamId) {
  const data = await linearGraphQL(
    apiKey,
    `query($teamId: String!) { team(id: $teamId) { projects(first: 200) { nodes { id name } } } }`,
    { teamId },
  );
  return (data.team && data.team.projects && data.team.projects.nodes) || [];
}
async function createLinearProject(apiKey, teamId, name) {
  const data = await linearGraphQL(
    apiKey,
    `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name } } }`,
    { input: { name, teamIds: [teamId] } },
  );
  if (!data.projectCreate || !data.projectCreate.success) {
    throw new Error('Linear projectCreate failed: ' + JSON.stringify(data));
  }
  return data.projectCreate.project;
}
async function createLinearIssue(linear, issue) {
  if (!linear || !linear.apiKey) {
    console.log(`[gate] mock Linear issue (no apiKey): ${trunc(issue.title, 80)}`);
    return { id: 'mock-' + Date.now(), identifier: 'MOCK-' + Math.floor(Math.random() * 1000), url: null, mock: true };
  }
  if (!linear.teamId || !linear.projectId) {
    throw new Error('Linear team + project must be selected first');
  }
  const data = await linearGraphQL(
    linear.apiKey,
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`,
    { input: { teamId: linear.teamId, projectId: linear.projectId, title: issue.title, description: issue.description } },
  );
  if (!data.issueCreate || !data.issueCreate.success) {
    throw new Error('Linear issueCreate rejected: ' + JSON.stringify(data));
  }
  return data.issueCreate.issue;
}
// v0.9.0+: list open issues in a project. Filters out state.type IN (completed,
// canceled) at the Linear level so we transfer less. v0.9.7: paginates with
// endCursor up to a hard cap of 500 (5 × 100). Beyond 500 simultaneously-open
// Test-mode-filed issues the team should be triaging, not adding bubbles —
// the cap prevents a runaway against a very large project.
async function fetchLinearOpenIssues(linear) {
  if (!linear || !linear.apiKey) return [];
  if (!linear.projectId) return [];
  let all = [];
  let after = null;
  for (let pageCount = 0; pageCount < 5; pageCount++) {
    const data = await linearGraphQL(
      linear.apiKey,
      `query($projectId: ID!, $after: String) {
        issues(
          first: 100,
          after: $after,
          filter: {
            project: { id: { eq: $projectId } },
            state: { type: { nin: ["completed", "canceled"] } }
          },
          orderBy: updatedAt
        ) {
          nodes { id identifier url title description updatedAt state { name type } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { projectId: linear.projectId, after },
    );
    const conn = data.issues || {};
    if (Array.isArray(conn.nodes)) all = all.concat(conn.nodes);
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return all;
}
async function fetchLinearIssue(linear, issueId) {
  if (!linear || !linear.apiKey) return null;
  const data = await linearGraphQL(
    linear.apiKey,
    `query($id: String!) { issue(id: $id) { id identifier url title description updatedAt state { name type } } }`,
    { id: issueId },
  );
  return data.issue || null;
}
async function updateLinearIssue(linear, issueId, input) {
  const data = await linearGraphQL(
    linear.apiKey,
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue { id identifier url title description updatedAt state { name type } }
      }
    }`,
    { id: issueId, input },
  );
  if (!data.issueUpdate || !data.issueUpdate.success) {
    throw new Error('Linear issueUpdate rejected: ' + JSON.stringify(data));
  }
  return data.issueUpdate.issue;
}
// Linear soft-deletes (moves to trash; recoverable for 30 days). We don't
// expose an "archive" alternative — testers should think of this as "I
// reported this by mistake, take it off the board."
async function deleteLinearIssue(linear, issueId) {
  const data = await linearGraphQL(
    linear.apiKey,
    `mutation($id: String!) { issueDelete(id: $id) { success } }`,
    { id: issueId },
  );
  if (!data.issueDelete || !data.issueDelete.success) {
    throw new Error('Linear issueDelete rejected: ' + JSON.stringify(data));
  }
  return true;
}

// ---------- GitHub (v0.10.0+) ----------
// All gate↔GitHub traffic goes through here. The rest of the gate doesn't
// know which backend a project uses — request handlers branch on proj.backend
// and call either the Linear or the GitHub helpers.
//
// All bug Issues the gate creates carry the `fc:bug` label so we can filter
// them out from manually-filed Issues in the repo (otherwise every Issue in
// the repo would render a bubble on the page).
const FC_BUG_LABEL = 'fc:bug';
const GITHUB_API = 'https://api.github.com';
async function githubREST(token, method, pathAndQuery, body) {
  const r = await fetch(GITHUB_API + pathAndQuery, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'frontend-conqueror-gate',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const msg = (data && data.message) || r.statusText;
    throw new Error(`GitHub ${method} ${pathAndQuery} → ${r.status}: ${msg}`);
  }
  return data;
}
// Parse "owner/repo" → { owner, repo }. Throws on malformed input.
function parseGithubRepo(s) {
  const m = String(s || '').match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (!m) throw new Error('GitHub repo must be in the form "owner/repo" — got "' + s + '"');
  return { owner: m[1], repo: m[2] };
}
// Best-effort: the label exists if we 200 on the GET, otherwise we POST to
// create it. Idempotent — only fires once per gate boot per repo.
const _ghLabelEnsured = new Set();
async function ensureFcBugLabel(token, owner, repo) {
  const key = owner + '/' + repo;
  if (_ghLabelEnsured.has(key)) return;
  try {
    await githubREST(token, 'GET', `/repos/${owner}/${repo}/labels/${encodeURIComponent(FC_BUG_LABEL)}`);
  } catch {
    try {
      await githubREST(token, 'POST', `/repos/${owner}/${repo}/labels`, {
        name: FC_BUG_LABEL,
        color: 'f59e0b',
        description: 'Filed via frontend-conqueror Test mode (auto-managed).',
      });
    } catch (e) {
      // If both fail, the issues we file just don't get tagged — they'll
      // still appear in the list query (we fall back to filtering by fc-meta
      // marker in the body). Don't bomb on labels alone.
      console.warn('[gate] could not ensure fc:bug label on ' + key + ':', e.message);
    }
  }
  _ghLabelEnsured.add(key);
}
// Open issues tagged fc:bug in the project's repo. Paginates via the Link
// header up to a 500-issue cap (5 × 100, same as the Linear path).
async function fetchGithubOpenIssues(token, repoStr) {
  if (!token || !repoStr) return [];
  const { owner, repo } = parseGithubRepo(repoStr);
  let all = [];
  for (let page = 1; page <= 5; page++) {
    const data = await githubREST(token, 'GET',
      `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(FC_BUG_LABEL)}&per_page=100&page=${page}`);
    const arr = Array.isArray(data) ? data : [];
    // /issues endpoint also returns PRs; skip them.
    const issues = arr.filter((x) => !x.pull_request);
    all = all.concat(issues);
    if (arr.length < 100) break;
  }
  return all;
}
async function fetchGithubIssue(token, repoStr, number) {
  if (!token || !repoStr) return null;
  const { owner, repo } = parseGithubRepo(repoStr);
  try { return await githubREST(token, 'GET', `/repos/${owner}/${repo}/issues/${number}`); }
  catch { return null; }
}
async function createGithubIssue(token, repoStr, { title, body }) {
  const { owner, repo } = parseGithubRepo(repoStr);
  await ensureFcBugLabel(token, owner, repo);
  return await githubREST(token, 'POST', `/repos/${owner}/${repo}/issues`, {
    title, body, labels: [FC_BUG_LABEL],
  });
}
async function updateGithubIssue(token, repoStr, number, { title, body }) {
  const { owner, repo } = parseGithubRepo(repoStr);
  return await githubREST(token, 'PATCH', `/repos/${owner}/${repo}/issues/${number}`, { title, body });
}
// GitHub doesn't allow true deletion (only admins via GraphQL `deleteIssue`,
// and even that's not exposed via PATs). "Delete" maps to "close as not
// planned" — the bubble disappears (closed issues are filtered out) and the
// record is preserved with intent.
async function deleteGithubIssue(token, repoStr, number) {
  const { owner, repo } = parseGithubRepo(repoStr);
  return await githubREST(token, 'PATCH', `/repos/${owner}/${repo}/issues/${number}`, {
    state: 'closed', state_reason: 'not_planned',
  });
}
// Convert a GitHub Issue into the same shape the overlay/admin already expect
// from the Linear path: id is the GitHub node_id (opaque string), identifier
// is "#NN" (or use the issue number as plain string), state.type is one of
// backlog/unstarted/started by inspecting workflow labels. The overlay uses
// state.type for bubble color; everything else is for human display.
function _ghStateFromLabels(issue) {
  const names = ((issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)) || []);
  if (names.includes('fc:in-progress')) return { name: 'In Progress', type: 'started' };
  if (names.includes('fc:in-review')) return { name: 'In Review', type: 'started' };
  if (names.includes('fc:todo')) return { name: 'Todo', type: 'unstarted' };
  return { name: 'Open', type: 'backlog' };
}
function normalizeGithubIssue(issue, repoStr) {
  return {
    // Encode the (repo, number) tuple so PUT/DELETE handlers can decode the
    // id back into "which repo + which issue number" without storing extra
    // state. base64url keeps it URL-safe inside the /api/issues/:id route.
    id: ghEncodeIssueId(repoStr, issue.number),
    identifier: '#' + issue.number,
    url: issue.html_url,
    title: issue.title,
    description: issue.body || '',
    updatedAt: issue.updated_at,
    state: _ghStateFromLabels(issue),
  };
}
function ghEncodeIssueId(repoStr, number) {
  return 'gh-' + Buffer.from(repoStr + '#' + number, 'utf8').toString('base64url');
}
function ghDecodeIssueId(id) {
  if (typeof id !== 'string' || !id.startsWith('gh-')) return null;
  try {
    const decoded = Buffer.from(id.slice(3), 'base64url').toString('utf8');
    const hash = decoded.lastIndexOf('#');
    if (hash < 0) return null;
    const number = parseInt(decoded.slice(hash + 1), 10);
    if (!Number.isFinite(number)) return null;
    return { repo: decoded.slice(0, hash), number };
  } catch { return null; }
}

// ---------- fc-meta marker (v0.9.0+) ----------
// Each issue the gate creates carries a structured HTML-comment marker at the
// end of its description. This lets the overlay recover the element anchor and
// the original filer when listing issues later. Plain comment so Linear renders
// nothing visible. JSON shape: { v:1, anchor:{file,offset}, page, filer, title, note }.
//
// v0.9.1: encoded as base64 in the comment so Linear's auto-linker can't see
// any @ / :// inside the payload and rewrite it as a Markdown link (which
// destroys the JSON). Old format (raw JSON) is still parsed for back-compat,
// and we attempt to salvage payloads Linear already mangled before this fix.
const FC_META_B64_RE = /<!--\s*fc-meta-b64:\s*([A-Za-z0-9+/=_-]+)\s*-->/;
const FC_META_JSON_RE = /<!--\s*fc-meta:\s*(\{[\s\S]*?\})\s*-->/;
// Linear's auto-linker rewrites `something@example.com` inside the description
// into a Markdown link like `[CONTENT](<mailto:URL>)`. Strip those wrappers so
// the original JSON can be reconstructed.
function unmangleLinearLinks(s) {
  return s.replace(/\[([^\]]+)\]\(<mailto:[^>]*>\)/g, '$1');
}
function parseFcMeta(description) {
  if (typeof description !== 'string') return null;
  // v0.9.1+ form: base64-encoded.
  const b64 = description.match(FC_META_B64_RE);
  if (b64) {
    try {
      const json = Buffer.from(b64[1], 'base64').toString('utf8');
      return JSON.parse(json);
    } catch { /* fall through */ }
  }
  // v0.9.0 form: raw JSON. Try to salvage if Linear has rewritten emails into
  // Markdown links inside the comment.
  const m = description.match(FC_META_JSON_RE);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch {}
  try { return JSON.parse(unmangleLinearLinks(m[1])); } catch { return null; }
}
// Older overlays (v0.7.x / v0.8.x) send `meta.where = "file:offset"` instead of
// a structured anchor. Salvage what we can so their issues still get a bubble.
function normalizeAnchor(rawAnchor, rawWhere) {
  if (rawAnchor && typeof rawAnchor === 'object' && typeof rawAnchor.file === 'string') {
    const off = Number(rawAnchor.offset);
    if (Number.isFinite(off)) {
      const a = { file: rawAnchor.file, offset: off };
      // v0.10.0+: optional line+column from the plugin-emitted
      // data-edit-source attribute. Used to build IDE-clickable Where lines.
      const line = Number(rawAnchor.line);
      const col = Number(rawAnchor.column);
      if (Number.isFinite(line)) a.line = line;
      if (Number.isFinite(col)) a.column = col;
      return a;
    }
  }
  if (typeof rawWhere === 'string') {
    const i = rawWhere.lastIndexOf(':');
    if (i > 0) {
      const file = rawWhere.slice(0, i);
      const off = Number(rawWhere.slice(i + 1));
      if (file && Number.isFinite(off)) return { file, offset: off };
    }
  }
  return null;
}
function buildIssueDescription({ filer, projectDisplayName, title, note, anchor, page, locale, text, userAgent }) {
  // v0.10.0+: rewritten to use clean ## Markdown sections that humans AND
  // Claude Code / scripted readers can extract deterministically. The visible
  // "Where" line uses file:line:column so terminals / editors treat it as a
  // jump target; the byte offset stays inside the hidden fc-meta marker for
  // the overlay's bubble matching.
  const whereForHuman = anchor
    ? (anchor.line != null && anchor.column != null
        ? `${anchor.file}:${anchor.line}:${anchor.column}`
        : `${anchor.file}:${anchor.offset}`)
    : null;
  const meta = { v: 1, anchor: anchor || null, page: page || null, filer, title: title || '', note: note || '' };
  const metaB64 = Buffer.from(JSON.stringify(meta), 'utf8').toString('base64');
  const sections = [
    `**Reported via Test Mode** by \`${filer}\` for project \`${projectDisplayName}\`.`,
    note ? '## What\'s wrong\n\n' + note : '',
    whereForHuman ? '## Where\n\n`' + whereForHuman + '`' : '',
    page ? '## Page\n\n' + page : '',
    text || locale ? '## What the tester saw\n\n' + [
      text ? '"' + trunc(text, 200) + '"' : '',
      locale ? '(locale: `' + locale + '`)' : '',
    ].filter(Boolean).join(' ') : '',
    userAgent ? '## User agent\n\n`' + userAgent + '`' : '',
    '---',
    `<!-- fc-meta-b64: ${metaB64} -->`,
  ].filter((s) => s !== '');
  return sections.join('\n\n');
}

// ---------- Issues cache ----------
// 30s in-memory TTL per project. Lets dozens of testers loading the same page
// share a single Linear API call. Busted on issue create + edit so writes show
// up immediately for the writer.
const issuesCache = new Map(); // projKey -> { fetchedAt, issues }
const ISSUES_CACHE_TTL_MS = 30_000;
async function fetchOpenIssuesCached(projKey, linCreds) {
  const cached = issuesCache.get(projKey);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < ISSUES_CACHE_TTL_MS) return cached.issues;
  const issues = await fetchLinearOpenIssues(linCreds);
  issuesCache.set(projKey, { fetchedAt: now, issues });
  return issues;
}
function bustIssuesCache(projKey) { issuesCache.delete(projKey); }
// v0.10.0: backend-aware fetch wrapper. Reads from the cache (30s TTL keyed by
// project key) and dispatches to the right backend on miss. The cache key is
// project-scoped, so changing a project's backend automatically segregates
// its cached results from the previous backend's.
async function fetchOpenIssuesForProject(data, proj) {
  const cached = issuesCache.get(proj.key);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < ISSUES_CACHE_TTL_MS) return cached.issues;
  let issues = [];
  if (proj.backend === 'github') {
    const gh = projectGithub(data, proj);
    if (!gh.token || !gh.repo) return [];
    const raw = await fetchGithubOpenIssues(gh.token, gh.repo);
    issues = raw.map((iss) => normalizeGithubIssue(iss, gh.repo));
  } else {
    const lin = projectLinear(data, proj);
    if (!lin.apiKey || !lin.projectId) return [];
    issues = await fetchLinearOpenIssues(lin);
  }
  issuesCache.set(proj.key, { fetchedAt: now, issues });
  return issues;
}

// Tester JWT lookup for the new bubble endpoints. Bearer-only — the report-issue
// endpoint kept its body-token shape for back-compat, but new endpoints pick
// the cleaner header pattern.
function readTesterToken(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return null;
  return verifyToken(auth.slice(7));
}

// Hide API key value; signal presence only.
function publicLinear(linear) {
  if (!linear) return null;
  return {
    hasApiKey: !!linear.apiKey,
    teamId: linear.teamId || '',
    teamName: linear.teamName || '',
    availableTeams: linear.availableTeams || null,
  };
}
// v0.10.0+: hide PAT, surface only the username that owns it.
function publicGithub(github) {
  if (!github) return null;
  return { hasToken: !!github.token, username: github.username || '' };
}
// Per-project summary for the admin list (no allowlist values leaked here).
function publicProjectSummary(p) {
  const a = p.activity || emptyActivity();
  const users = p.users || {};
  const userCount = Object.keys(users).length;
  const usersWithoutPassword = Object.values(users).filter((u) => !u.passwordHash).length;
  return {
    key: p.key,
    displayName: p.displayName,
    status: p.status,
    usersCount: userCount,
    usersNeedingPassword: usersWithoutPassword,
    backend: p.backend || 'linear',
    linearProjectName: p.linearProjectName || '',
    hasLinearOverride: !!(p.linearApiKey || p.linearTeamId),
    githubRepo: p.githubRepo || '',
    hasGithubOverride: !!p.githubToken,
    activity: {
      firstSeenAt: a.firstSeenAt,
      lastSeenAt: a.lastSeenAt,
      totalHeartbeats: a.totalHeartbeats,
      originsCount: Object.keys(a.origins || {}).length,
      pagesCount: (a.pages || []).length,
      reportsCount: a.reportsCount || 0,
      uniqueIpsToday: ((a.dailyIpHashes || []).find((d) => d.day === dayKey())?.hashes.length) || 0,
    },
    createdAt: p.createdAt,
  };
}
// Full project detail for the admin's project page. Users surfaced as a list of
// safe records — never the password hash itself, only whether one is set.
function publicProjectDetail(p) {
  const users = Object.entries(p.users || {}).map(([email, u]) => ({
    email,
    hasPassword: !!u.passwordHash,
    createdAt: u.createdAt || null,
    lastLoginAt: u.lastLoginAt || null,
    locked: !!(u.lockedUntil && u.lockedUntil > Math.floor(Date.now() / 1000)),
    lockedUntil: u.lockedUntil || null,
  })).sort((a, b) => a.email.localeCompare(b.email));
  return {
    ...publicProjectSummary(p),
    users,
    linearProjectId: p.linearProjectId || '',
    linearApiKey: null, // never sent
    linearApiKeySet: !!p.linearApiKey,
    linearTeamId: p.linearTeamId || null,
    activity: {
      ...publicProjectSummary(p).activity,
      origins: p.activity?.origins || {},
      pages: (p.activity?.pages || []).slice(-50),
    },
  };
}

// ---------- Routes ----------
async function handle(req, res) {
  const parsed = url.parse(req.url, true);
  const route = parsed.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return send(res, 204, null);

  // ----- Public (overlay) -----

  // v0.8.0: tester login by email + password. Replaces /api/verify-email
  // (which is kept around as a 410 alias for old overlay versions).
  if (method === 'POST' && route === '/api/login') {
    // Per-IP rate limit (broad). Per-email lockout below catches focused stuffing.
    if (!rateLimit('login-tester', getClientIp(req), 20, 60_000)) return send(res, 429, { error: 'rate-limited' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    // Constant-ish-time delay so attackers can't distinguish missing user
    // from wrong password from missing project.
    await new Promise((r) => setTimeout(r, 300));
    if (!body || !isValidEmail(body.email) || typeof body.password !== 'string') {
      return send(res, 401, { error: 'invalid-credentials' });
    }
    const data = loadData();
    const projKey = normalizeProjectKey(body.project || '');
    const proj = projKey ? data.projects[projKey] : defaultProject(data);
    if (!proj || proj.status !== 'active') return send(res, 401, { error: 'invalid-credentials' });
    const lcEmail = body.email.toLowerCase().trim();
    const user = (proj.users || {})[lcEmail];
    if (!user) return send(res, 401, { error: 'invalid-credentials' });
    const now = Math.floor(Date.now() / 1000);
    // Lockout check.
    if (user.lockedUntil && user.lockedUntil > now) {
      return send(res, 401, { error: 'invalid-credentials' });
    }
    // No password set → admin must configure one. Generic error to avoid
    // distinguishing "no password" from "wrong password" to anonymous callers.
    if (!user.passwordHash) return send(res, 401, { error: 'invalid-credentials' });
    const ok = await verifyHash(body.password, user.passwordHash);
    if (!ok) {
      user.failedAttempts = (user.failedAttempts || 0) + 1;
      if (user.failedAttempts >= 5) {
        user.lockedUntil = now + 15 * 60;     // 15-minute lockout
        user.failedAttempts = 0;
        console.log(`[gate] tester ${lcEmail} (${proj.key}) locked out for 15min after 5 failed attempts`);
      }
      saveData(data);
      return send(res, 401, { error: 'invalid-credentials' });
    }
    user.failedAttempts = 0;
    user.lockedUntil = null;
    user.lastLoginAt = now;
    saveData(data);
    const exp = now + JWT_TTL_SECONDS;
    const token = signToken({ email: lcEmail, project: proj.key, exp });
    return send(res, 200, { token, expiresAt: exp, project: { key: proj.key, name: proj.displayName } });
  }
  // Deprecated alias for v0.7.x overlays. Tells them the auth model changed.
  if (method === 'POST' && route === '/api/verify-email') {
    return send(res, 410, { error: 'method-removed', message: 'Email-only auth has been replaced with email + password. Update your overlay.' });
  }

  if (method === 'POST' && route === '/api/report-issue') {
    if (!rateLimit('report-issue', getClientIp(req), 20, 60_000)) return send(res, 429, { error: 'rate-limited' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const { token, issue } = body || {};
    const payload = verifyToken(token);
    if (!payload) return send(res, 401, { error: 'not-authorized' });
    if (!payload.project) return send(res, 401, { error: 'stale-token' });  // pre-v0.5.0 token, re-verify
    const data = loadData();
    const proj = data.projects[payload.project];
    if (!proj || proj.status !== 'active') return send(res, 401, { error: 'project-gone' });
    const user = (proj.users || {})[payload.email];
    if (!user) return send(res, 401, { error: 'revoked' });
    if (!issue || typeof issue.title !== 'string' || !issue.title.trim()) {
      return send(res, 400, { error: 'missing-title' });
    }
    const title = trunc(issue.title.trim(), 200);
    const meta = issue.meta || {};
    const note = issue.description ? issue.description.trim() : '';
    const anchor = normalizeAnchor(meta.anchor, meta.where);
    const description = buildIssueDescription({
      filer: payload.email,
      projectDisplayName: proj.displayName,
      title,
      note,
      anchor,
      page: meta.page,
      locale: meta.locale,
      text: meta.text,
      userAgent: meta.userAgent,
    });
    try {
      let created;
      if (proj.backend === 'github') {
        const gh = projectGithub(data, proj);
        if (!gh.token) return send(res, 503, { error: 'github-not-configured', message: 'No GitHub PAT set — add one in admin Settings.' });
        if (!gh.repo) return send(res, 503, { error: 'github-repo-not-set', message: 'No GitHub repo set for this project.' });
        const raw = await createGithubIssue(gh.token, gh.repo, { title, body: description });
        created = normalizeGithubIssue(raw, gh.repo);
      } else {
        const linCreds = projectLinear(data, proj);
        if (!linCreds.apiKey) return send(res, 503, { error: 'linear-not-configured' });
        if (!linCreds.projectId) return send(res, 503, { error: 'linear-project-not-set' });
        created = await createLinearIssue(linCreds, { title, description });
      }
      proj.activity = proj.activity || emptyActivity();
      proj.activity.reportsCount = (proj.activity.reportsCount || 0) + 1;
      saveData(data);
      bustIssuesCache(proj.key);
      console.log(`[gate] issue ${created.identifier || created.id} for ${proj.key} (${proj.backend}) by ${payload.email}`);
      return send(res, 200, { ok: true, issue: created });
    } catch (e) {
      console.error('[gate] backend error:', e.message);
      return send(res, 502, { error: 'linear-failed', message: e.message });
    }
  }

  // v0.9.0: list open issues for the current page so the overlay can render
  // bubbles. Auth via Authorization: Bearer <jwt>. Page passed as ?page=.
  // Cache TTL 30s per project — when 50 testers load the same page only the
  // first call hits Linear.
  if (method === 'GET' && route === '/api/issues') {
    if (!rateLimit('issues-list', getClientIp(req), 60, 60_000)) return send(res, 429, { error: 'rate-limited' });
    const payload = readTesterToken(req);
    if (!payload || !payload.project) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    const proj = data.projects[payload.project];
    if (!proj || proj.status !== 'active') return send(res, 401, { error: 'project-gone' });
    if (!(proj.users || {})[payload.email]) return send(res, 401, { error: 'revoked' });
    const reqPage = String((parsed.query && parsed.query.page) || '').slice(0, 500);
    try {
      const all = await fetchOpenIssuesForProject(data, proj);
      const issues = all
        .map((iss) => {
          // Linear returns iss.description; GitHub returns iss.body. Treat
          // them uniformly here by reading whichever exists.
          const bodyText = iss.description || iss.body || '';
          const fc = parseFcMeta(bodyText);
          if (!fc || fc.v !== 1) return null;
          if (reqPage && fc.page && fc.page !== reqPage) return null;
          // For GitHub the iss object comes from normalizeGithubIssue and
          // already has the expected shape; Linear's fetchLinearOpenIssues
          // returns raw nodes with the same field names.
          return {
            id: iss.id || iss.node_id,
            identifier: iss.identifier || ('#' + iss.number),
            url: iss.url || iss.html_url,
            title: iss.title,
            note: typeof fc.note === 'string' ? fc.note : '',
            filer: fc.filer || null,
            anchor: fc.anchor || null,
            page: fc.page || null,
            updatedAt: iss.updatedAt || iss.updated_at,
            state: iss.state || null,
            mine: !!(fc.filer && fc.filer === payload.email),
          };
        })
        .filter(Boolean);
      return send(res, 200, { issues });
    } catch (e) {
      console.error('[gate] list error:', e.message);
      return send(res, 502, { error: 'backend-failed', message: e.message });
    }
  }

  // v0.9.0: edit the note (and optionally title) on an issue you filed. Only
  // the original filer can edit; ownership is enforced from the fc-meta marker
  // we wrote on creation, not from the JWT alone.
  // v0.10.0: id format extended to allow base64url chars so GitHub-encoded IDs
  // (gh-<base64url>) work alongside Linear's UUID strings.
  const issueEditMatch = route.match(/^\/api\/issues\/([A-Za-z0-9_-]{8,})$/);
  if (method === 'PUT' && issueEditMatch) {
    if (!rateLimit('issues-edit', getClientIp(req), 20, 60_000)) return send(res, 429, { error: 'rate-limited' });
    const payload = readTesterToken(req);
    if (!payload || !payload.project) return send(res, 401, { error: 'not-authorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const data = loadData();
    const proj = data.projects[payload.project];
    if (!proj || proj.status !== 'active') return send(res, 401, { error: 'project-gone' });
    if (!(proj.users || {})[payload.email]) return send(res, 401, { error: 'revoked' });
    const issueId = issueEditMatch[1];
    const ghRef = ghDecodeIssueId(issueId);
    try {
      // Fetch current state — branch on backend (encoded in the ID for GitHub,
      // determined by proj.backend for Linear).
      let current, currentDesc;
      if (ghRef) {
        const gh = projectGithub(data, proj);
        if (!gh.token) return send(res, 503, { error: 'github-not-configured' });
        current = await fetchGithubIssue(gh.token, ghRef.repo, ghRef.number);
        if (!current) return send(res, 404, { error: 'no-such-issue' });
        currentDesc = current.body || '';
      } else {
        const linCreds = projectLinear(data, proj);
        if (!linCreds.apiKey) return send(res, 503, { error: 'linear-not-configured' });
        current = await fetchLinearIssue(linCreds, issueId);
        if (!current) return send(res, 404, { error: 'no-such-issue' });
        currentDesc = current.description || '';
      }
      const fc = parseFcMeta(currentDesc);
      if (!fc || fc.v !== 1) return send(res, 409, { error: 'no-fc-meta', message: 'This issue was filed before v0.9.0 and can’t be edited from the overlay.' });
      if (fc.filer !== payload.email) return send(res, 403, { error: 'not-owner' });
      const newTitle = typeof body.title === 'string' && body.title.trim() ? trunc(body.title.trim(), 200) : current.title;
      const newNote = typeof body.note === 'string' ? body.note.trim() : (fc.note || '');
      const newDescription = buildIssueDescription({
        filer: fc.filer,
        projectDisplayName: proj.displayName,
        title: newTitle,
        note: newNote,
        anchor: fc.anchor || null,
        page: fc.page || null,
        // Locale, text, userAgent aren't re-collected on edit. Preserve from
        // the original description tail if you want them; for now drop — they
        // were point-in-time facts about the original report.
        locale: null,
        text: null,
        userAgent: null,
      });
      let outIssue;
      if (ghRef) {
        const gh = projectGithub(data, proj);
        const updated = await updateGithubIssue(gh.token, ghRef.repo, ghRef.number, { title: newTitle, body: newDescription });
        outIssue = normalizeGithubIssue(updated, ghRef.repo);
      } else {
        const linCreds = projectLinear(data, proj);
        outIssue = await updateLinearIssue(linCreds, issueId, { title: newTitle, description: newDescription });
      }
      bustIssuesCache(proj.key);
      return send(res, 200, {
        ok: true,
        issue: {
          id: outIssue.id,
          identifier: outIssue.identifier,
          url: outIssue.url,
          title: outIssue.title,
          note: newNote,
          filer: fc.filer,
          anchor: fc.anchor || null,
          page: fc.page || null,
          updatedAt: outIssue.updatedAt,
          state: outIssue.state || null,
          mine: true,
        },
      });
    } catch (e) {
      console.error('[gate] update error:', e.message);
      return send(res, 502, { error: 'backend-failed', message: e.message });
    }
  }

  // v0.9.4: delete an issue you filed. Ownership again enforced from the
  // fc-meta marker — not the JWT — so a stolen token still can't delete
  // someone else's issue. Linear's issueDelete is a soft-delete (30-day
  // trash); GitHub's "delete" closes with state_reason: not_planned (GitHub
  // doesn't allow true deletion without admin GraphQL access).
  if (method === 'DELETE' && issueEditMatch) {
    if (!rateLimit('issues-delete', getClientIp(req), 10, 60_000)) return send(res, 429, { error: 'rate-limited' });
    const payload = readTesterToken(req);
    if (!payload || !payload.project) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    const proj = data.projects[payload.project];
    if (!proj || proj.status !== 'active') return send(res, 401, { error: 'project-gone' });
    if (!(proj.users || {})[payload.email]) return send(res, 401, { error: 'revoked' });
    const issueId = issueEditMatch[1];
    const ghRef = ghDecodeIssueId(issueId);
    try {
      let current, currentDesc;
      if (ghRef) {
        const gh = projectGithub(data, proj);
        if (!gh.token) return send(res, 503, { error: 'github-not-configured' });
        current = await fetchGithubIssue(gh.token, ghRef.repo, ghRef.number);
        if (!current) return send(res, 404, { error: 'no-such-issue' });
        currentDesc = current.body || '';
      } else {
        const linCreds = projectLinear(data, proj);
        if (!linCreds.apiKey) return send(res, 503, { error: 'linear-not-configured' });
        current = await fetchLinearIssue(linCreds, issueId);
        if (!current) return send(res, 404, { error: 'no-such-issue' });
        currentDesc = current.description || '';
      }
      const fc = parseFcMeta(currentDesc);
      if (!fc || fc.v !== 1) return send(res, 409, { error: 'no-fc-meta', message: 'This issue was filed before v0.9.0 and can’t be deleted from the overlay.' });
      if (fc.filer !== payload.email) return send(res, 403, { error: 'not-owner' });
      if (ghRef) {
        const gh = projectGithub(data, proj);
        await deleteGithubIssue(gh.token, ghRef.repo, ghRef.number);
      } else {
        const linCreds = projectLinear(data, proj);
        await deleteLinearIssue(linCreds, issueId);
      }
      bustIssuesCache(proj.key);
      return send(res, 200, { ok: true });
    } catch (e) {
      console.error('[gate] delete error:', e.message);
      return send(res, 502, { error: 'backend-failed', message: e.message });
    }
  }

  // Heartbeat — overlay pings on load + every 5min. Auto-creates pending
  // projects when an unknown key arrives so the admin sees them surface.
  if (method === 'POST' && route === '/api/heartbeat') {
    if (!rateLimit('heartbeat', getClientIp(req), 60, 60_000)) return send(res, 204, null);
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const key = normalizeProjectKey(body && body.project);
    if (!key) return send(res, 400, { error: 'missing-project' });
    const data = loadData();
    let proj = data.projects[key];
    if (!proj) {
      proj = emptyProject(key, body.displayName || key);
      proj.status = 'pending';
      data.projects[key] = proj;
      console.log(`[gate] pending project auto-registered: ${key}`);
    }
    const a = proj.activity = proj.activity || emptyActivity();
    const now = Math.floor(Date.now() / 1000);
    if (!a.firstSeenAt) a.firstSeenAt = now;
    a.lastSeenAt = now;
    a.totalHeartbeats = (a.totalHeartbeats || 0) + 1;
    if (body.origin && typeof body.origin === 'string') {
      const origin = body.origin.slice(0, 200);
      a.origins = a.origins || {};
      a.origins[origin] = (a.origins[origin] || 0) + 1;
    }
    if (body.url && typeof body.url === 'string') {
      a.pages = a.pages || [];
      const u = body.url.slice(0, 300);
      if (!a.pages.includes(u)) {
        a.pages.push(u);
        if (a.pages.length > 100) a.pages.shift();
      }
    }
    // Daily-unique-IP count via hashed bucket.
    const today = dayKey();
    a.dailyIpHashes = a.dailyIpHashes || [];
    // Trim entries older than 7 days.
    a.dailyIpHashes = a.dailyIpHashes.filter((d) => {
      const diff = (Date.parse(today) - Date.parse(d.day)) / 86_400_000;
      return diff >= 0 && diff < 7;
    });
    let today_entry = a.dailyIpHashes.find((d) => d.day === today);
    if (!today_entry) { today_entry = { day: today, hashes: [] }; a.dailyIpHashes.push(today_entry); }
    const h = ipHash(getClientIp(req));
    if (!today_entry.hashes.includes(h)) {
      today_entry.hashes.push(h);
      if (today_entry.hashes.length > 10_000) today_entry.hashes.shift();
    }
    saveData(data);
    return send(res, 204, null);
  }

  if (method === 'GET' && route === '/api/mode-colors') {
    const data = loadData();
    return send(res, 200, { modeColors: data.modeColors || DEFAULT_MODE_COLORS });
  }

  // Production overlay: same overlay.js, but trimmed at runtime via the
  // injected config — only Test mode is enabled, no agent WebSocket, no
  // i18n-map endpoint expected.
  //
  // Two URL forms are accepted so plugin configs can opt-in to multi-project:
  //   GET /overlay.js                    — uses default project (or no project)
  //   GET /overlay.js?project=messarat   — project via query string
  //   GET /:project/overlay.js           — project via path (recommended)
  const overlayProjectMatch = route.match(/^\/([a-z0-9][a-z0-9-]{0,63})\/overlay\.js$/);
  if (method === 'GET' && (route === '/overlay.js' || overlayProjectMatch)) {
    try {
      const body = fs.readFileSync(OVERLAY_FILE, 'utf8');
      let project = '';
      if (overlayProjectMatch) {
        project = overlayProjectMatch[1];
      } else if (parsed.query && typeof parsed.query.project === 'string') {
        project = normalizeProjectKey(parsed.query.project);
      }
      const cfg = {
        gate: { url: PUBLIC_URL, project: project || null },
        enabledModes: ['test'],
        mapUrl: null,
        wsUrl: null,
      };
      const prelude = `window.__frontendConquerorConfig=${JSON.stringify(cfg)};\n`;
      // Browser + edge cache: short max-age (5 min) AND s-maxage so Cloudflare
      // / other reverse proxies don't override us with their default 4-hour
      // policy. Without `s-maxage`, Cloudflare ignores the upstream and pins
      // the file for hours — which means overlay hotfixes don't reach testers
      // until the proxy TTL expires.
      return send(res, 200, prelude + body, {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'public, max-age=300, s-maxage=300, must-revalidate',
      });
    } catch (e) {
      return send(res, 500, { error: 'overlay-missing', message: e.message });
    }
  }

  // ----- Admin auth -----

  // Unauthenticated — tells the login page whether the default password is
  // still active so we can render the hint without leaking once it's changed.
  if (method === 'GET' && route === '/frontend-conqueror/login-state') {
    const data = loadData();
    return send(res, 200, {
      usingDefault: !data.adminPasswordHash,
      defaultPassword: !data.adminPasswordHash ? DEFAULT_ADMIN_PASSWORD : null,
    });
  }

  if (method === 'POST' && route === '/frontend-conqueror/login') {
    if (!rateLimit('login', getClientIp(req), 5, 60_000)) return send(res, 429, { error: 'rate-limited' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    await new Promise((r) => setTimeout(r, 300));
    const data = loadData();
    const candidate = String(body.password || '');
    let valid;
    if (data.adminPasswordHash) {
      valid = await verifyHash(candidate, data.adminPasswordHash);
    } else {
      valid = constantTimeEq(candidate, DEFAULT_ADMIN_PASSWORD);
    }
    if (!valid) return send(res, 401, { error: 'wrong-password' });
    const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL;
    const token = signToken({ role: 'admin', exp });
    setCookie(res, 'gate_admin', token, ADMIN_SESSION_TTL, { req });
    // Tell the client to force a password change if they got in with the default.
    return send(res, 200, { ok: true, mustChangePassword: !data.adminPasswordHash });
  }
  if (method === 'POST' && route === '/frontend-conqueror/logout') {
    clearCookie(res, 'gate_admin');
    return send(res, 200, { ok: true });
  }

  const isAdmin = requireAdmin(req);

  // ----- Admin: state + mode colors -----

  if (method === 'GET' && route === '/frontend-conqueror/state') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    const projects = Object.values(data.projects).map(publicProjectSummary)
      .sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
    return send(res, 200, {
      modeColors: data.modeColors,
      linear: publicLinear(data.linear),
      github: publicGithub(data.github),
      projects,
      pendingCount: projects.filter((p) => p.status === 'pending').length,
    });
  }

  // ----- Admin: project CRUD -----

  if (method === 'POST' && route === '/frontend-conqueror/projects') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const data = loadData();
    const key = normalizeProjectKey(body.key || body.displayName || '');
    if (!key) return send(res, 400, { error: 'missing-key' });
    if (data.projects[key]) return send(res, 409, { error: 'already-exists' });
    const proj = emptyProject(key, body.displayName || key);
    proj.status = 'active';
    data.projects[key] = proj;
    saveData(data);
    return send(res, 200, { project: publicProjectDetail(proj) });
  }

  const projectMatch = route.match(/^\/frontend-conqueror\/projects\/([a-z0-9][a-z0-9-]{0,63})(?:\/(.+))?$/);
  if (projectMatch) {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    const key = projectMatch[1];
    const sub = projectMatch[2] || null;
    const proj = data.projects[key];
    if (!proj) return send(res, 404, { error: 'no-such-project' });

    if (method === 'GET' && !sub) {
      return send(res, 200, { project: publicProjectDetail(proj) });
    }
    if (method === 'DELETE' && !sub) {
      delete data.projects[key];
      saveData(data);
      return send(res, 200, { ok: true });
    }
    if (method === 'PUT' && !sub) {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
      if (typeof body.displayName === 'string' && body.displayName.trim()) {
        proj.displayName = body.displayName.trim().slice(0, 80);
      }
      if (typeof body.status === 'string' && ['active', 'pending', 'disabled'].includes(body.status)) {
        proj.status = body.status;
      }
      saveData(data);
      return send(res, 200, { project: publicProjectDetail(proj) });
    }
    // User CRUD (v0.8.0+).
    // PUT /projects/:key/users — { email, password } — adds or updates a user.
    //   Empty/missing password = unset (user can't login).
    // DELETE /projects/:key/users/:email — removes a user.
    if (method === 'PUT' && sub === 'users') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
      if (!isValidEmail(body.email)) return send(res, 400, { error: 'invalid-email' });
      const lcEmail = body.email.toLowerCase().trim();
      proj.users = proj.users || {};
      const existed = !!proj.users[lcEmail];
      if (!existed) proj.users[lcEmail] = emptyUser();
      const user = proj.users[lcEmail];
      if (typeof body.password === 'string' && body.password.length > 0) {
        if (body.password.length < 8) return send(res, 400, { error: 'password-too-short', message: 'Min 8 characters.' });
        user.passwordHash = await hashPassword(body.password);
        user.lockedUntil = null;
        user.failedAttempts = 0;
      }
      saveData(data);
      return send(res, 200, { project: publicProjectDetail(proj) });
    }
    const userMatch = sub && sub.match(/^users\/(.+)$/);
    if (userMatch) {
      const lcEmail = decodeURIComponent(userMatch[1]).toLowerCase().trim();
      if (method === 'DELETE') {
        if (proj.users && proj.users[lcEmail]) delete proj.users[lcEmail];
        saveData(data);
        return send(res, 200, { project: publicProjectDetail(proj) });
      }
    }
    // Legacy: PUT /projects/:key/emails kept as a no-op redirect for old admin
    // scripts (returns 410 Gone with a hint).
    if (method === 'PUT' && sub === 'emails') {
      return send(res, 410, { error: 'method-removed', message: 'Use PUT /projects/:key/users { email, password } instead.' });
    }
    if (method === 'PUT' && sub === 'linear-project') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
      const lin = projectLinear(data, proj);
      if (!lin.apiKey) return send(res, 400, { error: 'no-api-key' });
      if (!lin.teamId) return send(res, 400, { error: 'no-team' });
      try {
        let linProj = null;
        if (typeof body.projectId === 'string' && body.projectId.trim()) {
          const projects = await fetchLinearProjectsInTeam(lin.apiKey, lin.teamId);
          linProj = projects.find((p) => p.id === body.projectId.trim());
          if (!linProj) return send(res, 404, { error: 'project-not-in-team' });
        } else if (typeof body.newName === 'string' && body.newName.trim()) {
          linProj = await createLinearProject(lin.apiKey, lin.teamId, body.newName.trim());
          console.log(`[gate] created Linear project "${linProj.name}" (${linProj.id})`);
        } else {
          return send(res, 400, { error: 'missing-project' });
        }
        proj.linearProjectId = linProj.id;
        proj.linearProjectName = linProj.name;
        proj.backend = 'linear';
        saveData(data);
        bustIssuesCache(proj.key);
        return send(res, 200, { project: publicProjectDetail(proj) });
      } catch (e) {
        return send(res, 502, { error: 'linear-unreachable', message: e.message });
      }
    }
    // v0.10.0+: set the GitHub repo destination. Flips backend to 'github'.
    if (method === 'PUT' && sub === 'github-repo') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
      const gh = projectGithub(data, proj);
      if (!gh.token) return send(res, 400, { error: 'no-token', message: 'No GitHub PAT set in Settings.' });
      const repoStr = typeof body.repo === 'string' ? body.repo.trim() : '';
      if (!repoStr) return send(res, 400, { error: 'missing-repo' });
      let parsed;
      try { parsed = parseGithubRepo(repoStr); }
      catch (e) { return send(res, 400, { error: 'bad-repo', message: e.message }); }
      try {
        // Confirm access + that issues are enabled.
        const repoInfo = await githubREST(gh.token, 'GET', `/repos/${parsed.owner}/${parsed.repo}`);
        if (!repoInfo.has_issues) return send(res, 400, { error: 'issues-disabled', message: 'Issues are disabled on this repo. Enable them in GitHub repo settings first.' });
        await ensureFcBugLabel(gh.token, parsed.owner, parsed.repo);
        proj.githubRepo = repoInfo.full_name;
        proj.backend = 'github';
        saveData(data);
        bustIssuesCache(proj.key);
        return send(res, 200, { project: publicProjectDetail(proj) });
      } catch (e) {
        return send(res, 502, { error: 'github-unreachable', message: e.message });
      }
    }
    return send(res, 404, { error: 'not-found' });
  }

  if (method === 'PUT' && route === '/frontend-conqueror/password') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const data = loadData();
    const newPw = String(body.newPassword || '');
    if (newPw.length < 8) {
      return send(res, 400, { error: 'too-short', message: 'Password must be at least 8 characters.' });
    }
    // If a custom password already exists, require the current one to change it.
    // If we're still on the default, accept the new password directly (the admin
    // already proved they know the default by being signed in).
    if (data.adminPasswordHash) {
      const ok = await verifyHash(String(body.currentPassword || ''), data.adminPasswordHash);
      if (!ok) return send(res, 401, { error: 'wrong-current-password' });
    }
    data.adminPasswordHash = await hashPassword(newPw);
    saveData(data);
    return send(res, 200, { ok: true });
  }

  if (method === 'PUT' && route === '/frontend-conqueror/mode-colors') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const data = loadData();
    const next = { ...(data.modeColors || DEFAULT_MODE_COLORS) };
    for (const k of ['edit', 'test', 'todo']) {
      if (body && isValidHex(body[k])) next[k] = body[k];
    }
    data.modeColors = next;
    saveData(data);
    return send(res, 200, { modeColors: next });
  }

  // ----- Admin: global Linear (shared across all projects by default) -----

  if (method === 'PUT' && route === '/frontend-conqueror/linear/api-key') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const data = loadData();
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!apiKey) return send(res, 400, { error: 'missing-api-key' });
    // Reset team. Per-project Linear destinations stay (they're scoped to teamId).
    data.linear = { apiKey, teamId: '', teamName: '', availableTeams: null };
    saveData(data);
    try {
      const teams = await fetchLinearTeams(apiKey);
      if (teams.length === 1) {
        data.linear.teamId = teams[0].id;
        data.linear.teamName = teams[0].name;
      } else if (teams.length > 1) {
        data.linear.availableTeams = teams;
      }
      saveData(data);
      return send(res, 200, { linear: publicLinear(data.linear), resolution: teams.length === 0 ? 'no-teams' : teams.length === 1 ? 'auto-team' : 'pick-team' });
    } catch (e) {
      return send(res, 502, { error: 'linear-unreachable', message: e.message });
    }
  }

  if (method === 'PUT' && route === '/frontend-conqueror/linear/team') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const data = loadData();
    if (!data.linear || !data.linear.apiKey) return send(res, 400, { error: 'no-api-key' });
    const teamId = typeof body.teamId === 'string' ? body.teamId.trim() : '';
    if (!teamId) return send(res, 400, { error: 'missing-team-id' });
    const team = (data.linear.availableTeams || []).find((t) => t.id === teamId);
    data.linear.teamId = teamId;
    data.linear.teamName = team ? team.name : (data.linear.teamName || '');
    data.linear.availableTeams = null;
    saveData(data);
    return send(res, 200, { linear: publicLinear(data.linear) });
  }

  if (method === 'GET' && route === '/frontend-conqueror/linear/projects') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    const lin = data.linear;
    if (!lin || !lin.apiKey) return send(res, 400, { error: 'no-api-key' });
    if (!lin.teamId) return send(res, 400, { error: 'no-team' });
    try {
      const projects = await fetchLinearProjectsInTeam(lin.apiKey, lin.teamId);
      return send(res, 200, { projects });
    } catch (e) {
      return send(res, 502, { error: 'linear-unreachable', message: e.message });
    }
  }

  if (method === 'DELETE' && route === '/frontend-conqueror/linear') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    data.linear = null;
    saveData(data);
    return send(res, 200, { linear: null });
  }

  // ----- Admin: GitHub (v0.10.0+) -----
  // Mirrors the Linear admin shape: set/clear a gate-wide token, list
  // accessible repos for the wizard's repo picker.
  if (method === 'PUT' && route === '/frontend-conqueror/github/token') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) return send(res, 400, { error: 'missing-token' });
    // Validate by hitting /user and see whose token this is.
    let username;
    try {
      const me = await githubREST(token, 'GET', '/user');
      username = me && me.login;
      if (!username) throw new Error('unexpected /user response');
    } catch (e) {
      return send(res, 400, { error: 'token-invalid', message: 'GitHub rejected this token: ' + e.message });
    }
    const data = loadData();
    data.github = { token, username };
    saveData(data);
    return send(res, 200, { github: publicGithub(data.github) });
  }
  if (method === 'DELETE' && route === '/frontend-conqueror/github') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    data.github = null;
    saveData(data);
    return send(res, 200, { github: null });
  }
  // Repo search for the wizard picker. `q` is matched against name+owner.
  // Returns the user's own repos + repos in their orgs they can read.
  if (method === 'GET' && route === '/frontend-conqueror/github/repos') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    const token = data.github && data.github.token;
    if (!token) return send(res, 400, { error: 'no-token' });
    const q = String((parsed.query && parsed.query.q) || '').trim();
    try {
      // GitHub Search API needs a user prefix or org prefix; without `q` we
      // list the user's own repos (cheapest call).
      let items = [];
      if (q) {
        const search = await githubREST(token, 'GET',
          `/search/repositories?q=${encodeURIComponent(q + ' fork:true')}&per_page=20&sort=updated`);
        items = (search && search.items) || [];
      } else {
        items = await githubREST(token, 'GET', '/user/repos?per_page=30&sort=updated&affiliation=owner,collaborator,organization_member');
      }
      const repos = (items || []).map((r) => ({
        full_name: r.full_name,
        description: r.description || '',
        private: !!r.private,
      }));
      return send(res, 200, { repos });
    } catch (e) {
      return send(res, 502, { error: 'github-unreachable', message: e.message });
    }
  }

  // ----- Admin page -----

  if (method === 'GET' && (route === '/frontend-conqueror' || route === '/frontend-conqueror/' || route === '/')) {
    return send(res, 200, ADMIN_HTML, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  if (method === 'GET' && route === '/health') return send(res, 200, { ok: true });

  return send(res, 404, { error: 'not-found' });
}

// ---------- Admin UI ----------
const ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>frontend-conqueror · gate admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    --bg:#0b1220; --card:#111827; --card2:#0f1726;
    --text:#e5e7eb; --muted:#9ca3af; --dim:#6b7280;
    --accent:#2563eb; --ok:#10b981; --warn:#f59e0b; --danger:#ef4444;
    --border:#1f2937; --border2:#374151;
  }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.55 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header { padding: 14px 22px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  header .brand { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  header .right { display:flex; gap:10px; align-items:center; font-size: 12px; color: var(--muted); }
  header button { background: transparent; border: 1px solid var(--border2); color: var(--muted); padding: 5px 11px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 12px; }
  header button:hover { background: var(--card); color: var(--text); }
  main { max-width: 820px; margin: 0 auto; padding: 24px 22px 60px; }
  h2 { margin: 0 0 6px; font-size: 22px; font-weight: 600; color: var(--text); }
  h2 .sub { display: block; font-size: 12px; font-weight: 400; color: var(--muted); margin-top: 4px; letter-spacing: 0; text-transform: none; }
  h3 { margin: 0 0 10px; font-size: 13px; color: var(--muted); letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; }
  .crumbs { font-size: 12px; color: var(--muted); margin-bottom: 12px; }
  .crumbs a { color: var(--muted); }
  .crumbs a:hover { color: var(--text); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 18px; margin-bottom: 14px; }
  .card .body { color: var(--text); }
  .card .meta { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .sub-muted { color: var(--muted); font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
  .row input, .row select { flex: 1; }
  .row.spaced { justify-content: space-between; }
  label { display: block; font-size: 11px; color: var(--muted); margin: 10px 0 4px; text-transform: uppercase; letter-spacing: 0.06em; }
  input, select, textarea { width: 100%; background: var(--card2); border: 1px solid var(--border2); color: var(--text); padding: 9px 11px; border-radius: 6px; font: inherit; outline: none; }
  input:focus, select:focus, textarea:focus { border-color: var(--accent); }
  button.primary { background: var(--accent); color: white; border: 0; padding: 9px 16px; border-radius: 6px; cursor: pointer; font: inherit; font-weight: 600; }
  button.primary:hover { filter: brightness(1.1); }
  button.primary:disabled { opacity: 0.5; cursor: default; }
  button.ghost { background: transparent; border: 1px solid var(--border2); color: var(--muted); padding: 8px 14px; border-radius: 6px; cursor: pointer; font: inherit; }
  button.ghost:hover { background: var(--card); color: var(--text); }
  button.danger { background: transparent; color: var(--danger); border: 1px solid #4b1e22; padding: 6px 12px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 12px; }
  button.danger:hover { background: rgba(239,68,68,0.08); }
  .pill { display: inline-flex; align-items: center; gap: 4px; background: #1f2937; color: var(--muted); padding: 2px 9px; border-radius: 999px; font-size: 11px; }
  .pill.pending { background: rgba(245,158,11,0.15); color: #fcd34d; }
  .pill.active { background: rgba(16,185,129,0.15); color: #6ee7b7; }
  .pill.disabled { background: rgba(107,114,128,0.15); color: var(--dim); }
  .pill.dot::before { content: '●'; font-size: 8px; }
  .empty { color: var(--muted); font-style: italic; padding: 16px 0; text-align: center; }
  .err { color: #fca5a5; margin: 8px 0; font-size: 12px; min-height: 14px; }
  .ok-line { color: var(--ok); margin: 8px 0; font-size: 12px; }
  .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  code { background: var(--card2); padding: 2px 7px; border-radius: 4px; font: 12px/1 ui-monospace, Menlo, monospace; }
  .project-card { display: block; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; margin-bottom: 10px; cursor: pointer; transition: border-color 0.1s; }
  .project-card:hover { border-color: var(--border2); text-decoration: none; }
  .project-card .title { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .project-card .name { font-size: 15px; font-weight: 600; color: var(--text); }
  .project-card .meta { color: var(--muted); font-size: 12px; margin-top: 6px; display: flex; gap: 14px; flex-wrap: wrap; }
  .project-card.pending { border-style: dashed; }
  .section-h { display: flex; justify-content: space-between; align-items: center; margin: 18px 0 10px; }
  .stat { display: flex; flex-direction: column; gap: 2px; }
  .stat .v { font-size: 18px; font-weight: 600; color: var(--text); }
  .stat .l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .step-dots { display: flex; gap: 6px; margin: 0 0 18px; }
  .step-dots .d { width: 22px; height: 4px; border-radius: 2px; background: var(--border2); }
  .step-dots .d.on { background: var(--accent); }
  .step-dots .d.done { background: var(--ok); }
  .origin-list { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; font-size: 12px; color: var(--muted); }
  .origin-list .o { display: flex; justify-content: space-between; }
  .toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); background: var(--card); border: 1px solid var(--border2); color: var(--text); padding: 10px 16px; border-radius: 8px; font-size: 13px; z-index: 9; box-shadow: 0 10px 30px rgba(0,0,0,0.4); }
</style></head>
<body>
<div id="root"></div>
<div id="toast" style="display:none"></div>
<script>
const $ = (id) => document.getElementById(id);
const root = () => $('root');
const html = (strings, ...values) => strings.map((s, i) => s + (values[i] != null ? values[i] : '')).join('');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (kind === 'err' ? ' err' : '');
  t.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.style.display = 'none'; }, 3000);
}
function relTime(ts) {
  if (!ts) return 'never';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}
async function api(method, route, body) {
  const r = await fetch(route, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) { const err = new Error((json && (json.message || json.error)) || r.statusText); err.payload = json; throw err; }
  return json;
}

// ============================== ROUTING ==============================
// Simple hash router. Routes:
//   #/login                       (handled outside the router; only when 401)
//   #/                            project list
//   #/settings                    global settings
//   #/p/:key                      project detail
//   #/p/:key/configure            project configuration wizard
//   #/setup                       first-time wizard

let STATE = null;          // last fetched state
let ROUTE = null;          // current route object

window.addEventListener('hashchange', () => navigate());
window.addEventListener('load', () => navigate());

function parseHash() {
  const h = (window.location.hash || '#/').slice(1);
  const parts = h.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'list' };
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'setup') return { name: 'setup' };
  if (parts[0] === 'p' && parts[1]) {
    if (parts[2] === 'configure') return { name: 'project-wizard', key: parts[1] };
    return { name: 'project-detail', key: parts[1] };
  }
  return { name: 'list' };
}
function go(hash) { window.location.hash = hash; }

async function navigate() {
  ROUTE = parseHash();
  try {
    if (!STATE) STATE = await api('GET', '/frontend-conqueror/state');
    else STATE = await api('GET', '/frontend-conqueror/state');
  } catch (e) {
    if (e.payload && e.payload.error === 'not-authorized') return renderLogin();
    return renderError(e);
  }
  if (ROUTE.name === 'list') {
    const totalProjects = STATE.projects.length;
    const hasLinear = STATE.linear && STATE.linear.hasApiKey;
    if (!hasLinear && totalProjects === 0) return renderSetup();
    return renderList();
  }
  if (ROUTE.name === 'settings') return renderSettings();
  if (ROUTE.name === 'setup') return renderSetup();
  if (ROUTE.name === 'project-detail') return renderProjectDetail(ROUTE.key);
  if (ROUTE.name === 'project-wizard') return renderProjectWizard(ROUTE.key);
}

function renderError(e) {
  root().innerHTML = html\`
    <header><span class="brand">frontend-conqueror · gate</span></header>
    <main>
      <div class="card">
        <h3>Something went wrong</h3>
        <div class="body">\${esc(e.message)}</div>
      </div>
    </main>\`;
}

// ============================== LOGIN ==============================
async function renderLogin(err) {
  let hint = null;
  try {
    const s = await api('GET', '/frontend-conqueror/login-state');
    if (s.usingDefault) hint = s.defaultPassword;
  } catch {}
  root().innerHTML = html\`
    <header><span class="brand">frontend-conqueror · gate</span></header>
    <main>
      <div class="card" style="max-width:420px;margin:60px auto;">
        <h3>Admin sign in</h3>
        <label for="pw">Password</label>
        <input id="pw" type="password" autofocus>
        <div class="err">\${err ? esc(err) : ''}</div>
        \${hint ? '<div class="sub-muted" style="margin-top:6px;">First time? Default password: <code>' + esc(hint) + '</code> — you\\'ll be asked to change it after sign-in.</div>' : ''}
        <div class="row" style="justify-content:flex-end;margin-top:14px;">
          <button class="primary" id="loginBtn">Sign in →</button>
        </div>
      </div>
    </main>\`;
  const submit = async () => {
    try {
      const res = await api('POST', '/frontend-conqueror/login', { password: $('pw').value });
      if (res.mustChangePassword) return renderForcedPasswordChange();
      STATE = null;
      navigate();
    } catch (e) { renderLogin(e.message); }
  };
  $('loginBtn').addEventListener('click', submit);
  $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function renderForcedPasswordChange() {
  root().innerHTML = html\`
    <header><span class="brand">frontend-conqueror · gate</span></header>
    <main>
      <div class="card" style="max-width:460px;margin:60px auto;">
        <h2>Set your admin password<span class="sub">You signed in with the default. Pick a real one (8+ chars) before we continue.</span></h2>
        <label for="newPw">New password</label>
        <input id="newPw" type="password" autofocus>
        <label for="confirmPw">Confirm new password</label>
        <input id="confirmPw" type="password">
        <div class="err" id="pwErr"></div>
        <div class="row" style="justify-content:flex-end;margin-top:14px;">
          <button class="primary" id="saveBtn">Set password →</button>
        </div>
      </div>
    </main>\`;
  $('saveBtn').addEventListener('click', async () => {
    const a = $('newPw').value, b = $('confirmPw').value;
    if (a.length < 8) return ($('pwErr').textContent = 'At least 8 characters.');
    if (a !== b) return ($('pwErr').textContent = 'Passwords do not match.');
    try {
      await api('PUT', '/frontend-conqueror/password', { newPassword: a });
      STATE = null;
      navigate();
    } catch (e) { $('pwErr').textContent = e.message; }
  });
}

// ============================== FIRST-TIME SETUP WIZARD ==============================
async function renderSetup() {
  let step = 1;
  const ctx = {
    apiKey: '',
    teamId: null,
    teamName: null,
    teams: [],
    projectKey: '',
    projectDisplayName: '',
    linearProjectId: null,
    linearProjectNewName: '',
  };
  function nav(html_) {
    root().innerHTML = html\`
      <header>
        <span class="brand">frontend-conqueror · gate · setup</span>
        <div class="right">
          <button onclick="logout()">sign out</button>
        </div>
      </header>
      <main>\${html_}</main>\`;
  }
  const dots = (n) => '<div class="step-dots">' +
    [1,2,3,4,5].map(i => '<div class="d ' + (i < n ? 'done' : i === n ? 'on' : '') + '"></div>').join('') +
    '</div>';

  function renderStep() {
    if (step === 1) {
      nav(html\`
        \${dots(1)}
        <h2>Let's set up your gate<span class="sub">Step 1 of 5 — Linear API key. This is shared across all your projects (unless you override it per project later).</span></h2>
        <div class="card">
          <label for="apiKey">Linear API key</label>
          <input id="apiKey" type="password" placeholder="lin_api_..." autofocus value="\${esc(ctx.apiKey)}">
          <div class="sub-muted" style="margin-top:6px;">Get one from <a href="https://linear.app/settings/api" target="_blank" rel="noreferrer">Linear → Settings → API</a>. Personal API keys work fine.</div>
          <div class="err" id="err"></div>
          <div class="row" style="justify-content:flex-end;margin-top:14px;">
            <button class="primary" id="next">Continue →</button>
          </div>
        </div>\`);
      $('next').addEventListener('click', async () => {
        ctx.apiKey = $('apiKey').value.trim();
        if (!ctx.apiKey) return ($('err').textContent = 'Paste your Linear API key.');
        $('next').disabled = true;
        try {
          const res = await api('PUT', '/frontend-conqueror/linear/api-key', { apiKey: ctx.apiKey });
          if (res.resolution === 'no-teams') return ($('err').textContent = 'Linear returned no teams for this key.');
          if (res.resolution === 'auto-team') {
            ctx.teamId = res.linear.teamId;
            ctx.teamName = res.linear.teamName;
            step = 3;
          } else {
            ctx.teams = res.linear.availableTeams || [];
            step = 2;
          }
          renderStep();
        } catch (e) { $('err').textContent = e.message; $('next').disabled = false; }
      });
    } else if (step === 2) {
      nav(html\`
        \${dots(2)}
        <h2>Pick your Linear team<span class="sub">Step 2 of 5 — your key has access to multiple teams. Bugs will land in this one.</span></h2>
        <div class="card">
          <label for="team">Team</label>
          <select id="team">\${ctx.teams.map(t => '<option value="' + esc(t.id) + '">' + esc(t.name) + ' (' + esc(t.key) + ')</option>').join('')}</select>
          <div class="err" id="err"></div>
          <div class="row" style="justify-content:flex-end;margin-top:14px;">
            <button class="ghost" onclick="(()=>{step=1;renderStep();})()">← Back</button>
            <button class="primary" id="next">Continue →</button>
          </div>
        </div>\`);
      $('next').addEventListener('click', async () => {
        const teamId = $('team').value;
        try {
          const res = await api('PUT', '/frontend-conqueror/linear/team', { teamId });
          ctx.teamId = res.linear.teamId;
          ctx.teamName = res.linear.teamName;
          step = 3;
          renderStep();
        } catch (e) { $('err').textContent = e.message; }
      });
    } else if (step === 3) {
      nav(html\`
        \${dots(3)}
        <h2>Name your first project<span class="sub">Step 3 of 5 — this is what you'll use in your plugin config (<code>gate.project = '...'</code>). Letters, numbers, dashes.</span></h2>
        <div class="card">
          <label for="displayName">Display name</label>
          <input id="displayName" placeholder="Messarat" autofocus value="\${esc(ctx.projectDisplayName)}">
          <label for="key">Project key</label>
          <input id="key" placeholder="messarat" value="\${esc(ctx.projectKey)}">
          <div class="sub-muted" style="margin-top:4px;">Used in <code>gate.project</code> and the overlay URL.</div>
          <div class="err" id="err"></div>
          <div class="row" style="justify-content:flex-end;margin-top:14px;">
            <button class="ghost" onclick="(()=>{step=2;renderStep();})()">← Back</button>
            <button class="primary" id="next">Continue →</button>
          </div>
        </div>\`);
      $('displayName').addEventListener('input', () => {
        if (!$('key').value || $('key').value === ctx.projectKey) {
          $('key').value = $('displayName').value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '');
          ctx.projectKey = $('key').value;
        }
        ctx.projectDisplayName = $('displayName').value;
      });
      $('next').addEventListener('click', async () => {
        const displayName = $('displayName').value.trim();
        const key = $('key').value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '');
        if (!displayName) return ($('err').textContent = 'Display name required.');
        if (!key) return ($('err').textContent = 'Project key required.');
        try {
          await api('POST', '/frontend-conqueror/projects', { key, displayName });
          ctx.projectKey = key;
          ctx.projectDisplayName = displayName;
          step = 4;
          renderStep();
        } catch (e) {
          if (e.payload && e.payload.error === 'already-exists') {
            ctx.projectKey = key;
            ctx.projectDisplayName = displayName;
            step = 4;
            renderStep();
          } else $('err').textContent = e.message;
        }
      });
    } else if (step === 4) {
      nav(html\`
        \${dots(4)}
        <h2>Where should bugs land?<span class="sub">Step 4 of 5 — pick or create a Linear project. Bugs from \${esc(ctx.projectDisplayName)} will file there.</span></h2>
        <div class="card">
          <div id="projLoad" class="sub-muted">Loading Linear projects…</div>
        </div>\`);
      (async () => {
        let projects = [];
        try { projects = (await api('GET', '/frontend-conqueror/linear/projects')).projects || []; }
        catch (e) { $('projLoad').textContent = e.message; return; }
        nav(html\`
          \${dots(4)}
          <h2>Where should bugs land?<span class="sub">Step 4 of 5 — pick or create a Linear project. Bugs from \${esc(ctx.projectDisplayName)} will file there.</span></h2>
          <div class="card">
            <label for="existing">Existing Linear project</label>
            <select id="existing">
              <option value="">— pick one —</option>
              \${projects.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('')}
            </select>
            <div style="text-align:center;color:var(--muted);margin:14px 0;font-size:12px;">— or —</div>
            <label for="newName">Create a new Linear project</label>
            <input id="newName" placeholder="\${esc(ctx.projectDisplayName)} Bugs">
            <div class="err" id="err"></div>
            <div class="row" style="justify-content:flex-end;margin-top:14px;">
              <button class="ghost" onclick="(()=>{step=3;renderStep();})()">← Back</button>
              <button class="primary" id="next">Continue →</button>
            </div>
          </div>\`);
        $('next').addEventListener('click', async () => {
          const existingId = $('existing').value;
          const newName = $('newName').value.trim();
          if (!existingId && !newName) return ($('err').textContent = 'Pick one or type a name.');
          $('next').disabled = true;
          try {
            const body = existingId ? { projectId: existingId } : { newName };
            await api('PUT', '/frontend-conqueror/projects/' + ctx.projectKey + '/linear-project', body);
            step = 5;
            renderStep();
          } catch (e) { $('err').textContent = e.message; $('next').disabled = false; }
        });
      })();
    } else if (step === 5) {
      nav(html\`
        \${dots(5)}
        <h2>Add your first testers<span class="sub">Step 5 of 5 — only these emails will be able to file bugs from \${esc(ctx.projectDisplayName)}. You can add more later.</span></h2>
        <div class="card">
          <label for="firstEmail">First tester email</label>
          <input id="firstEmail" type="email" placeholder="alice@example.com" autofocus>
          <label for="firstPassword">Password (min 8 characters) — share this with the tester</label>
          <input id="firstPassword" type="text" placeholder="password">
          <div class="sub-muted" style="margin-top:6px;">You can add more testers from the project page after setup.</div>
          <div class="err" id="err"></div>
          <div class="row" style="justify-content:flex-end;margin-top:14px;">
            <button class="ghost" onclick="(()=>{step=4;renderStep();})()">← Back</button>
            <button class="primary" id="finish">Finish setup →</button>
          </div>
        </div>\`);
      $('finish').addEventListener('click', async () => {
        const email = $('firstEmail').value.trim();
        const password = $('firstPassword').value;
        if (!email) return ($('err').textContent = 'Email required.');
        if (!password || password.length < 8) return ($('err').textContent = 'Password must be at least 8 characters.');
        try {
          await api('PUT', '/frontend-conqueror/projects/' + ctx.projectKey + '/users', { email, password });
          STATE = null;
          toast('Setup complete — your gate is live.');
          go('#/p/' + ctx.projectKey);
        } catch (e) { $('err').textContent = e.message; }
      });
    }
  }
  renderStep();
}

// ============================== PROJECT LIST ==============================
function renderList() {
  const pending = STATE.projects.filter(p => p.status === 'pending');
  const active = STATE.projects.filter(p => p.status === 'active');
  const disabled = STATE.projects.filter(p => p.status === 'disabled');
  root().innerHTML = html\`
    <header>
      <span class="brand">frontend-conqueror · gate</span>
      <div class="right">
        <a href="#/settings">global settings</a>
        <button onclick="logout()">sign out</button>
      </div>
    </header>
    <main>
      <h2>Projects<span class="sub">\${STATE.projects.length} total · gate at <code>\${esc(location.host)}</code></span></h2>

      \${pending.length > 0 ? html\`
        <div class="section-h">
          <h3>Pending (\${pending.length}) — auto-detected, not configured yet</h3>
        </div>
        \${pending.map(projectCard).join('')}
      \` : ''}

      <div class="section-h">
        <h3>Active</h3>
        <button class="ghost" onclick="addProject()">+ Add project</button>
      </div>
      \${active.length === 0 ? '<div class="empty">No active projects yet.</div>' : active.map(projectCard).join('')}

      \${disabled.length > 0 ? html\`
        <div class="section-h"><h3>Disabled</h3></div>
        \${disabled.map(projectCard).join('')}
      \` : ''}
    </main>\`;
}
// v0.9.8: for each Linear projectId currently used as a gate destination,
// return the list of gate-project display names using it. excludeKey skips
// self so the "Change Linear destination" UI on project X doesn't list X
// itself as a user of its own destination.
function fcUsedByMap(excludeKey) {
  const m = new Map();
  for (const proj of (STATE && STATE.projects) || []) {
    if (!proj.linearProjectId) continue;
    if (excludeKey && proj.key === excludeKey) continue;
    if (!m.has(proj.linearProjectId)) m.set(proj.linearProjectId, []);
    m.get(proj.linearProjectId).push(proj.displayName);
  }
  return m;
}
function projectCard(p) {
  const lastSeen = p.activity.lastSeenAt ? relTime(p.activity.lastSeenAt) : 'never';
  const linearDest = p.linearProjectName || (p.status === 'pending' ? '(needs configuring)' : '(not set)');
  // v0.9.8: surface the Configure action directly on pending cards so the
  // pending → active flow is one click from the list view (used to require
  // clicking into the detail page first).
  const configureBtn = p.status === 'pending'
    ? '<button class="primary" style="font-size:11px;padding:5px 12px;margin-right:8px;" onclick="event.preventDefault();event.stopPropagation();go(\\'#/p/' + esc(p.key) + '/configure\\');return false;">Configure →</button>'
    : '';
  return html\`
    <a class="project-card \${p.status}" href="#/p/\${esc(p.key)}">
      <div class="title">
        <span class="name">\${esc(p.displayName)} <span class="sub-muted" style="font-weight:normal;font-size:12px;margin-left:6px;">\${esc(p.key)}</span></span>
        <span style="display:flex;align-items:center;">\${configureBtn}<span class="pill \${p.status} dot">\${p.status}</span></span>
      </div>
      <div class="meta">
        <span>📬 \${p.usersCount} \${p.usersCount === 1 ? 'tester' : 'testers'}\${p.usersNeedingPassword > 0 ? ' (' + p.usersNeedingPassword + ' need password)' : ''}</span>
        <span>🎯 \${esc(linearDest)}</span>
        <span>⏱ last activity \${lastSeen}</span>
        \${p.activity.uniqueIpsToday > 0 ? '<span>👤 ' + p.activity.uniqueIpsToday + ' unique today</span>' : ''}
        \${p.activity.reportsCount > 0 ? '<span>🐞 ' + p.activity.reportsCount + ' reports</span>' : ''}
      </div>
    </a>\`;
}
window.addProject = async function() {
  const displayName = prompt('Project display name (e.g. "TM Frontend"):');
  if (!displayName) return;
  const key = displayName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '');
  try {
    await api('POST', '/frontend-conqueror/projects', { key, displayName });
    STATE = null;
    go('#/p/' + key + '/configure');
  } catch (e) { toast(e.message, 'err'); }
};
window.logout = async function() {
  try { await api('POST', '/frontend-conqueror/logout'); } catch {}
  STATE = null;
  renderLogin();
};

// ============================== PROJECT DETAIL ==============================
async function renderProjectDetail(key) {
  let detail;
  try { detail = (await api('GET', '/frontend-conqueror/projects/' + key)).project; }
  catch (e) { return renderError(e); }

  const needsConfig = detail.status === 'pending' || !detail.linearProjectId || detail.usersCount === 0;
  const overlayTag = '<' + 'script src="' + location.origin + '/' + detail.key + '/overlay.js" defer><' + '/script>';
  const pluginCfg = "gate: { url: '" + location.origin + "', project: '" + detail.key + "' }";
  // v0.9.8: pull the busiest origin so the auto-detect banner can name it.
  const _origins = (detail.activity && detail.activity.origins) || {};
  const _topOriginEntry = Object.entries(_origins).sort((a, b) => b[1] - a[1])[0];
  const _topOrigin = _topOriginEntry ? _topOriginEntry[0] : null;
  const _topOriginHits = _topOriginEntry ? _topOriginEntry[1] : 0;

  root().innerHTML = html\`
    <header>
      <span class="brand">frontend-conqueror · gate</span>
      <div class="right">
        <a href="#/settings">global settings</a>
        <button onclick="logout()">sign out</button>
      </div>
    </header>
    <main>
      <div class="crumbs"><a href="#/">← Projects</a></div>
      <h2>\${esc(detail.displayName)} <span class="pill \${detail.status} dot" style="vertical-align:middle;margin-left:8px;font-size:11px;">\${detail.status}</span><span class="sub">Key: <code>\${esc(detail.key)}</code> · Created \${esc(new Date(detail.createdAt * 1000).toISOString().slice(0,10))}</span></h2>

      \${needsConfig ? html\`
        <div class="card" style="border-left:3px solid var(--warn);">
          <h3>\${detail.status === 'pending' ? '⚡ Auto-detected — finish setup' : '⚙ Finish configuring this project'}</h3>
          \${detail.status === 'pending' && detail.activity.firstSeenAt ? html\`
            <div class="body" style="font-size:13px;margin-bottom:6px;">
              Heartbeats started arriving <strong>\${esc(relTime(detail.activity.firstSeenAt))}</strong> — <strong>\${detail.activity.totalHeartbeats}</strong> total so far.
              \${_topOrigin ? '<br>Most-active origin: <code>' + esc(_topOrigin) + '</code> (' + _topOriginHits + ' ' + (_topOriginHits === 1 ? 'hit' : 'hits') + ').' : ''}
            </div>
          \` : ''}
          <div class="body sub-muted">This project won't accept bug reports until it has a Linear destination and at least one tester.</div>
          <div class="row" style="justify-content:flex-end;margin-top:10px;">
            <button class="primary" onclick="(()=>go('#/p/' + \${JSON.stringify(detail.key)} + '/configure'))()">Configure now →</button>
          </div>
        </div>
      \` : ''}

      <div class="card">
        <h3>Destination</h3>
        \${detail.backend === 'github' ? html\`
          \${detail.githubRepo ? html\`
            <div class="body">Reports go to: <strong><a href="https://github.com/\${esc(detail.githubRepo)}/issues" target="_blank" rel="noreferrer">\${esc(detail.githubRepo)}</a></strong> (GitHub Issues)</div>
            <div class="meta">Token: @\${esc(STATE.github ? STATE.github.username : '?')}\${detail.hasGithubOverride ? ' (per-project override)' : ''}</div>
            <div class="row" style="margin-top:10px;justify-content:flex-end;gap:6px;">
              <button class="ghost" onclick="changeGithubRepo('\${esc(detail.key)}')">Change repo</button>
              <button class="ghost" onclick="switchToLinear('\${esc(detail.key)}')">Switch to Linear</button>
            </div>
          \` : html\`
            <div class="empty">Not set. <a href="#" onclick="changeGithubRepo('\${esc(detail.key)}');return false;">Pick a GitHub repo</a></div>
          \`}
        \` : html\`
          \${detail.linearProjectName ? html\`
            <div class="body">Reports go to: <strong>\${esc(detail.linearProjectName)}</strong> (Linear)</div>
            <div class="meta">Team: \${esc(STATE.linear ? STATE.linear.teamName : '')}</div>
            <div class="row" style="margin-top:10px;justify-content:flex-end;gap:6px;">
              <button class="ghost" onclick="changeLinearProject('\${esc(detail.key)}')">Change project</button>
              <button class="ghost" onclick="switchToGithub('\${esc(detail.key)}')">Switch to GitHub</button>
            </div>
          \` : html\`
            <div class="empty">Not set. Pick a destination: <a href="#" onclick="changeLinearProject('\${esc(detail.key)}');return false;">Linear project</a> · <a href="#" onclick="changeGithubRepo('\${esc(detail.key)}');return false;">GitHub repo</a></div>
          \`}
        \`}
      </div>

      <div class="card">
        <h3>Testers (\${detail.users.length})</h3>
        <div class="sub-muted" style="margin-bottom:10px;">Each tester logs in with their email + the password you set here.</div>
        <div id="userList">
          \${detail.users.length === 0
            ? '<div class="empty">No testers yet.</div>'
            : detail.users.map(u => {
                const status = !u.hasPassword
                  ? '<span class="pill warn dot" style="background:rgba(245,158,11,.15);color:#fcd34d;">needs password</span>'
                  : u.locked ? '<span class="pill warn dot">locked (5 failed attempts)</span>'
                  : '<span class="pill active dot">active</span>';
                const lastLogin = u.lastLoginAt
                  ? '<span class="sub-muted" style="font-size:11px;">last login: ' + new Date(u.lastLoginAt * 1000).toISOString().slice(0,10) + '</span>'
                  : '<span class="sub-muted" style="font-size:11px;">never logged in</span>';
                return '<div class="row spaced" style="padding:8px 0;border-bottom:1px solid #f0f0f0;">'
                  + '<div><code style="background:transparent;font-size:12px;">' + esc(u.email) + '</code><br>' + status + ' &nbsp; ' + lastLogin + '</div>'
                  + '<div style="display:flex;gap:6px;">'
                    + '<button class="ghost" style="padding:4px 10px;font-size:11px;" onclick="setUserPassword(\\'' + esc(detail.key) + '\\', \\'' + esc(u.email) + '\\')">set password</button>'
                    + '<button class="danger" onclick="removeUser(\\'' + esc(detail.key) + '\\', \\'' + esc(u.email) + '\\')">remove</button>'
                  + '</div></div>';
              }).join('')
          }
        </div>
        <label style="margin-top:14px;">Add tester</label>
        <div class="row">
          <input id="newEmail" type="email" placeholder="alice@example.com">
          <input id="newPassword" type="text" placeholder="password (min 8 chars)" style="max-width:200px;">
          <button class="primary" onclick="addUser('\${esc(detail.key)}')">Add</button>
        </div>
        <div class="err" id="userErr"></div>
        \${detail.usersNeedingPassword > 0 ? '<div class="ok-line" style="color:#fcd34d;margin-top:8px;">⚠ ' + detail.usersNeedingPassword + ' tester(s) migrated from email-only mode and need a password set before they can log in.</div>' : ''}
      </div>

      <div class="card">
        <h3>How to use this project</h3>
        <div class="body sub-muted" style="margin-bottom:8px;">In your project's plugin config:</div>
        <div><code>\${esc(pluginCfg)}</code></div>
        <div class="body sub-muted" style="margin:10px 0 6px;">Or in production HTML directly:</div>
        <div><code>\${esc(overlayTag)}</code></div>
      </div>

      <div class="card">
        <h3>Activity</h3>
        <div class="grid3">
          <div class="stat"><span class="v">\${detail.activity.totalHeartbeats || 0}</span><span class="l">total heartbeats</span></div>
          <div class="stat"><span class="v">\${detail.activity.uniqueIpsToday}</span><span class="l">unique today</span></div>
          <div class="stat"><span class="v">\${detail.activity.reportsCount || 0}</span><span class="l">reports filed</span></div>
        </div>
        <div style="margin-top:14px;font-size:12px;color:var(--muted);">
          First seen: \${detail.activity.firstSeenAt ? new Date(detail.activity.firstSeenAt * 1000).toISOString() : 'never'}<br>
          Last heartbeat: \${detail.activity.lastSeenAt ? relTime(detail.activity.lastSeenAt) : 'never'}
        </div>
        \${Object.keys(detail.activity.origins).length > 0 ? html\`
          <h3 style="margin-top:16px;">Origins seen</h3>
          <div class="origin-list">
            \${Object.entries(detail.activity.origins).sort((a,b) => b[1]-a[1]).slice(0,10).map(([o,c]) => '<div class="o"><span>' + esc(o) + '</span><span>' + c + ' hits</span></div>').join('')}
          </div>
        \` : ''}
        \${detail.activity.pages.length > 0 ? html\`
          <h3 style="margin-top:16px;">Pages seen (\${detail.activity.pages.length})</h3>
          <div class="origin-list">
            \${detail.activity.pages.slice(-10).reverse().map(p => '<div class="o" style="display:block;"><a href="' + esc(p) + '" target="_blank" rel="noreferrer">' + esc(p) + '</a></div>').join('')}
          </div>
        \` : ''}
      </div>

      <div class="card">
        <h3>Danger zone</h3>
        <div class="row spaced">
          <div>
            <div>\${detail.status === 'disabled' ? 'Project disabled. Reports rejected.' : 'Disable to temporarily stop accepting reports.'}</div>
            <div class="meta">Disabling keeps testers and Linear destination intact.</div>
          </div>
          <button class="ghost" onclick="toggleStatus('\${esc(detail.key)}', '\${detail.status === 'disabled' ? 'active' : 'disabled'}')">\${detail.status === 'disabled' ? 'Re-enable' : 'Disable'}</button>
        </div>
        <div class="row spaced" style="margin-top:14px;">
          <div>
            <div>Delete this project</div>
            <div class="meta">Removes the allowlist, Linear destination link, and activity stats. Bugs already filed in Linear are not touched.</div>
          </div>
          <button class="danger" onclick="deleteProject('\${esc(detail.key)}')">Delete</button>
        </div>
      </div>
    </main>\`;
}
window.changeLinearProject = async function(key) {
  let projects;
  try { projects = (await api('GET', '/frontend-conqueror/linear/projects')).projects || []; } catch (e) { return toast(e.message, 'err'); }
  // v0.9.8: surface which gate projects are already using each Linear
  // destination so reuse is obvious from the picker.
  const usedBy = fcUsedByMap(key);
  const lines = projects.map((p, i) => {
    const u = usedBy.get(p.id);
    return (i + 1) + ') ' + p.name + (u && u.length > 0 ? ' [used by: ' + u.join(', ') + ']' : '');
  }).join('\\n');
  const choice = prompt('Pick a Linear project number, or type a name to create new:\\n\\n' + lines);
  if (!choice) return;
  const n = parseInt(choice, 10);
  let body;
  if (!isNaN(n) && projects[n - 1]) body = { projectId: projects[n - 1].id };
  else body = { newName: choice };
  try {
    await api('PUT', '/frontend-conqueror/projects/' + key + '/linear-project', body);
    toast('Linear destination updated.');
    navigate();
  } catch (e) { toast(e.message, 'err'); }
};
// v0.10.0+: pick a GitHub repo destination. Uses the gate's GitHub search
// route to autocomplete from your accessible repos. Switches the project's
// backend to 'github'.
window.changeGithubRepo = async function(key) {
  if (!STATE.github || !STATE.github.hasToken) {
    if (confirm('No GitHub PAT set yet. Go to Settings to add one?')) go('#/settings');
    return;
  }
  const q = prompt('Type repo name to search (e.g. "messarat" or "owner/repo"), or leave blank to see your recent repos:');
  if (q === null) return;
  let repos = [];
  try { repos = (await api('GET', '/frontend-conqueror/github/repos?q=' + encodeURIComponent(q || ''))).repos || []; }
  catch (e) { return toast(e.message, 'err'); }
  if (repos.length === 0) return toast('No matching repos.', 'err');
  const lines = repos.map((r, i) => (i + 1) + ') ' + r.full_name + (r.private ? ' (private)' : '')).join('\\n');
  const choice = prompt('Pick a repo number, or type "owner/repo" directly:\\n\\n' + lines);
  if (!choice) return;
  const n = parseInt(choice, 10);
  const repo = (!isNaN(n) && repos[n - 1]) ? repos[n - 1].full_name : choice.trim();
  try {
    await api('PUT', '/frontend-conqueror/projects/' + key + '/github-repo', { repo });
    toast('GitHub destination set to ' + repo + '.');
    navigate();
  } catch (e) { toast(e.message, 'err'); }
};
window.switchToGithub = async function(key) {
  if (!confirm('Switch this project to GitHub backend? You\\'ll pick a repo next. Existing Linear-filed bugs will keep working but new reports go to GitHub.')) return;
  window.changeGithubRepo(key);
};
window.switchToLinear = async function(key) {
  if (!confirm('Switch this project back to Linear backend? You\\'ll pick a Linear destination next.')) return;
  window.changeLinearProject(key);
};
window.addUser = async function(key) {
  const email = $('newEmail').value.trim();
  const password = $('newPassword').value;
  if (!email) return ($('userErr').textContent = 'Email required.');
  if (!password || password.length < 8) return ($('userErr').textContent = 'Password must be at least 8 characters.');
  try {
    await api('PUT', '/frontend-conqueror/projects/' + key + '/users', { email, password });
    $('newEmail').value = ''; $('newPassword').value = '';
    toast('Tester added — share email + password with them.');
    navigate();
  } catch (e) { $('userErr').textContent = e.message; }
};
window.setUserPassword = async function(key, email) {
  const password = prompt('New password for ' + email + ' (min 8 chars):');
  if (!password) return;
  if (password.length < 8) return toast('Password must be at least 8 characters.', 'err');
  try {
    await api('PUT', '/frontend-conqueror/projects/' + key + '/users', { email, password });
    toast('Password updated.');
    navigate();
  } catch (e) { toast(e.message, 'err'); }
};
window.removeUser = async function(key, email) {
  if (!confirm('Remove tester ' + email + '? They will no longer be able to log in.')) return;
  try {
    await api('DELETE', '/frontend-conqueror/projects/' + key + '/users/' + encodeURIComponent(email));
    toast('Tester removed.');
    navigate();
  } catch (e) { toast(e.message, 'err'); }
};
window.toggleStatus = async function(key, newStatus) {
  try {
    await api('PUT', '/frontend-conqueror/projects/' + key, { status: newStatus });
    navigate();
  } catch (e) { toast(e.message, 'err'); }
};
window.deleteProject = async function(key) {
  if (!confirm('Delete project "' + key + '"? This removes the allowlist and Linear destination link. Cannot be undone.')) return;
  try {
    await api('DELETE', '/frontend-conqueror/projects/' + key);
    toast('Project deleted.');
    go('#/');
  } catch (e) { toast(e.message, 'err'); }
};

// ============================== PROJECT CONFIGURE WIZARD (pending → active) ==============================
async function renderProjectWizard(key) {
  let detail;
  try { detail = (await api('GET', '/frontend-conqueror/projects/' + key)).project; }
  catch (e) { return renderError(e); }
  const dots2 = (n) => '<div class="step-dots">' +
    [1,2].map(i => '<div class="d ' + (i < n ? 'done' : i === n ? 'on' : '') + '"></div>').join('') +
    '</div>';
  let step = detail.linearProjectId ? 2 : 1;

  function renderStep() {
    if (step === 1) {
      root().innerHTML = html\`
        <header><span class="brand">frontend-conqueror · gate · configuring \${esc(detail.displayName)}</span></header>
        <main>
          <div class="crumbs"><a href="#/">← Projects</a></div>
          \${dots2(1)}
          <h2>Where should bugs land?<span class="sub">Step 1 of 2 — pick or create a Linear project for \${esc(detail.displayName)}.</span></h2>
          <div class="card"><div id="projLoad" class="sub-muted">Loading…</div></div>
        </main>\`;
      (async () => {
        let projects = [];
        try { projects = (await api('GET', '/frontend-conqueror/linear/projects')).projects || []; }
        catch (e) { return ($('projLoad').textContent = e.message); }
        const usedBy = fcUsedByMap(detail.key);
        $('projLoad').outerHTML = html\`
          <label for="existing">Existing Linear project</label>
          <select id="existing">
            <option value="">— pick one —</option>
            \${projects.map(p => {
              const u = usedBy.get(p.id);
              const label = p.name + (u && u.length > 0 ? ' (used by ' + u.join(', ') + ')' : '');
              return '<option value="' + esc(p.id) + '">' + esc(label) + '</option>';
            }).join('')}
          </select>
          <div style="text-align:center;color:var(--muted);margin:14px 0;font-size:12px;">— or —</div>
          <label for="newName">Create a new Linear project</label>
          <input id="newName" placeholder="\${esc(detail.displayName)} Bugs">
          <div class="err" id="err"></div>
          <div class="row" style="justify-content:flex-end;margin-top:14px;">
            <button class="primary" id="next">Continue →</button>
          </div>\`;
        $('next').addEventListener('click', async () => {
          const existingId = $('existing').value;
          const newName = $('newName').value.trim();
          if (!existingId && !newName) return ($('err').textContent = 'Pick one or type a name.');
          $('next').disabled = true;
          try {
            const body = existingId ? { projectId: existingId } : { newName };
            await api('PUT', '/frontend-conqueror/projects/' + detail.key + '/linear-project', body);
            step = 2;
            renderStep();
          } catch (e) { $('err').textContent = e.message; $('next').disabled = false; }
        });
      })();
    } else if (step === 2) {
      root().innerHTML = html\`
        <header><span class="brand">frontend-conqueror · gate · configuring \${esc(detail.displayName)}</span></header>
        <main>
          <div class="crumbs"><a href="#/">← Projects</a></div>
          \${dots2(2)}
          <h2>Add your first tester<span class="sub">Step 2 of 2 — set an email + password. You can add more testers from the project page after.</span></h2>
          <div class="card">
            <label for="firstEmail">Email</label>
            <input id="firstEmail" type="email" placeholder="alice@example.com" autofocus>
            <label for="firstPassword">Password (min 8 chars)</label>
            <input id="firstPassword" type="text" placeholder="password">
            <div class="err" id="err"></div>
            <div class="row" style="justify-content:flex-end;margin-top:14px;">
              <button class="ghost" onclick="(()=>{step=1;renderStep();})()">← Back</button>
              <button class="primary" id="finish">Activate project →</button>
            </div>
          </div>
        </main>\`;
      $('finish').addEventListener('click', async () => {
        const email = $('firstEmail').value.trim();
        const password = $('firstPassword').value;
        if (!email) return ($('err').textContent = 'Email required.');
        if (!password || password.length < 8) return ($('err').textContent = 'Password must be at least 8 characters.');
        try {
          await api('PUT', '/frontend-conqueror/projects/' + detail.key + '/users', { email, password });
          await api('PUT', '/frontend-conqueror/projects/' + detail.key, { status: 'active' });
          toast(detail.displayName + ' is live.');
          go('#/p/' + detail.key);
        } catch (e) { $('err').textContent = e.message; }
      });
    }
  }
  renderStep();
}

// ============================== GLOBAL SETTINGS ==============================
async function renderSettings() {
  const s = STATE;
  root().innerHTML = html\`
    <header>
      <span class="brand">frontend-conqueror · gate</span>
      <div class="right">
        <button onclick="logout()">sign out</button>
      </div>
    </header>
    <main>
      <div class="crumbs"><a href="#/">← Projects</a></div>
      <h2>Global settings<span class="sub">Affects all projects on this gate.</span></h2>

      <div class="card">
        <h3>GitHub access token</h3>
        \${s.github && s.github.hasToken ? html\`
          <div class="body">Connected as <strong>@\${esc(s.github.username || '?')}</strong>.</div>
          <div class="meta">Every project with backend = github uses this token unless it has a per-project override.</div>
          <div class="row" style="justify-content:flex-end;margin-top:10px;">
            <button class="ghost" onclick="replaceGithubToken()">Replace</button>
            <button class="danger" onclick="removeGithubToken()">Disconnect</button>
          </div>
        \` : html\`
          <div class="empty">No GitHub PAT set.</div>
          <div class="sub-muted" style="margin:8px 0 0;">Create one at <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer">github.com/settings/tokens (fine-grained)</a>. Permissions needed: <strong>Issues: Read &amp; Write</strong> on the repos you'll route bugs to.</div>
          <div class="row" style="justify-content:flex-end;margin-top:8px;">
            <button class="primary" onclick="replaceGithubToken()">Connect GitHub</button>
          </div>
        \`}
      </div>

      <div class="card">
        <h3>Linear API key</h3>
        \${s.linear && s.linear.hasApiKey ? html\`
          <div class="body">Connected to <strong>\${esc(s.linear.teamName || s.linear.teamId || 'a team')}</strong></div>
          <div class="meta">Projects with backend = linear use this key unless they override it.</div>
          <div class="row" style="justify-content:flex-end;margin-top:10px;">
            <button class="ghost" onclick="replaceApiKey()">Replace</button>
            <button class="danger" onclick="removeApiKey()">Disconnect</button>
          </div>
        \` : html\`
          <div class="empty">No Linear API key set.</div>
          <div class="row" style="justify-content:flex-end;">
            <button class="primary" onclick="replaceApiKey()">Connect Linear</button>
          </div>
        \`}
      </div>

      <div class="card">
        <h3>Mode colors</h3>
        <div class="sub-muted" style="margin-bottom:8px;">Border + palette colors for each mode in the overlay.</div>
        <div class="grid3">
          \${['edit','test','todo'].map(k => html\`
            <div>
              <label>\${k}</label>
              <input type="color" id="color-\${k}" value="\${esc(s.modeColors[k] || '#888888')}" style="height:38px;cursor:pointer;">
            </div>
          \`).join('')}
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:10px;">
          <button class="primary" onclick="saveColors()">Save colors</button>
        </div>
      </div>

      <div class="card">
        <h3>Admin password</h3>
        <label for="currentPw">Current password</label>
        <input id="currentPw" type="password">
        <label for="newAdminPw">New password (8+ characters)</label>
        <input id="newAdminPw" type="password">
        <div class="err" id="pwErr"></div>
        <div class="row" style="justify-content:flex-end;margin-top:10px;">
          <button class="primary" onclick="changePassword()">Change password</button>
        </div>
      </div>
    </main>\`;
}
window.replaceApiKey = async function() {
  const apiKey = prompt('Paste Linear API key:');
  if (!apiKey) return;
  try {
    const res = await api('PUT', '/frontend-conqueror/linear/api-key', { apiKey });
    STATE = null;
    if (res.resolution === 'pick-team') {
      const team = prompt('Multiple teams found. Pick one (number):\\n\\n' + res.linear.availableTeams.map((t,i)=>(i+1)+') '+t.name).join('\\n'));
      const idx = parseInt(team,10) - 1;
      if (res.linear.availableTeams[idx]) {
        await api('PUT', '/frontend-conqueror/linear/team', { teamId: res.linear.availableTeams[idx].id });
      }
    }
    toast('Linear connected.');
    navigate();
  } catch (e) { toast(e.message, 'err'); }
};
window.removeApiKey = async function() {
  if (!confirm('Disconnect Linear? All projects with backend = linear will stop accepting reports until a new key is set (or per-project override is configured).')) return;
  try {
    await api('DELETE', '/frontend-conqueror/linear');
    STATE = null;
    toast('Linear disconnected.');
    navigate();
  } catch (e) { toast(e.message, 'err'); }
};
// v0.10.0+: GitHub PAT management. Same UX shape as Linear, paste-driven.
window.replaceGithubToken = async function() {
  const token = prompt('Paste GitHub fine-grained PAT (Issues: R/W on the destination repos):');
  if (!token) return;
  try {
    await api('PUT', '/frontend-conqueror/github/token', { token });
    STATE = null;
    toast('GitHub connected.');
    navigate();
  } catch (e) { toast(e.message, 'err'); }
};
window.removeGithubToken = async function() {
  if (!confirm('Disconnect GitHub? All projects with backend = github will stop accepting reports until a new token is set.')) return;
  try {
    await api('DELETE', '/frontend-conqueror/github');
    STATE = null;
    toast('GitHub disconnected.');
    navigate();
  } catch (e) { toast(e.message, 'err'); }
};
window.saveColors = async function() {
  const body = { edit: $('color-edit').value, test: $('color-test').value, todo: $('color-todo').value };
  try {
    await api('PUT', '/frontend-conqueror/mode-colors', body);
    toast('Colors saved.');
  } catch (e) { toast(e.message, 'err'); }
};
window.changePassword = async function() {
  const currentPassword = $('currentPw').value;
  const newPassword = $('newAdminPw').value;
  if (newPassword.length < 8) return ($('pwErr').textContent = 'At least 8 characters.');
  try {
    await api('PUT', '/frontend-conqueror/password', { currentPassword, newPassword });
    $('currentPw').value = ''; $('newAdminPw').value = '';
    toast('Password changed.');
  } catch (e) { $('pwErr').textContent = e.message; }
};
</script>
</body></html>`;
http.createServer(handle).listen(PORT, HOST, () => {
  // Surface a clear "what's the default password right now" line so the
  // developer doesn't have to dig — useful in dev. Once data.adminPasswordHash
  // exists, this stops being printed and the env var is ignored.
  const initial = loadData();
  if (!initial.adminPasswordHash) {
    console.log(`[gate] no admin password set yet — default is "${DEFAULT_ADMIN_PASSWORD}" (shown on login page)`);
  } else {
    console.log('[gate] custom admin password in use');
  }
  console.log(`frontend-conqueror gate listening on http://${HOST}:${PORT}`);
  console.log(`admin: http://localhost:${PORT}/frontend-conqueror`);
  console.log(`data:  ${DATA_FILE}`);
});