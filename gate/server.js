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
const os = require('os');
const crypto = require('crypto');
const url = require('url');

const PORT = Number(process.env.GATE_PORT || 54322);
// v0.10.3: default to 127.0.0.1 (loopback only). Production deploys behind a
// reverse proxy already set GATE_HOST=127.0.0.1 explicitly (because the proxy
// terminates TLS and forwards to localhost). The old 0.0.0.0 default exposed
// every freshly-started gate to the local network — fine on a developer
// laptop, dangerous if the dev was on hotel/conference wifi or the gate
// happened to boot on a cloud VM without a firewall rule. Explicit
// GATE_HOST=0.0.0.0 still works for the rare case where you actually want
// external reachability without a proxy.
const HOST = process.env.GATE_HOST || '127.0.0.1';
// v0.10.2: data file no longer defaults to node_modules. Resolution order:
//   1. GATE_DATA env  (explicit — production deploys should always set this)
//   2. ~/.frontend-conqueror/data.json  (new default — survives npm upgrades)
//   3. <pkg-dir>/gate/data.json  (legacy node_modules path — auto-migrated to
//      the new default on first boot if it exists and the new file doesn't)
// Putting the file in node_modules was the original sin: `npm install` to
// upgrade the plugin would silently wipe every tester credential, admin
// password hash, Linear/GitHub token, and project record. ~/.frontend-conqueror
// is the dotfile-pattern equivalent of what most node-based dev tools do
// (vite, nuxt, npm itself).
function resolveDataFile() {
  if (process.env.GATE_DATA) return process.env.GATE_DATA;
  const newDir = path.join(os.homedir(), '.frontend-conqueror');
  const newPath = path.join(newDir, 'data.json');
  const legacyPath = path.join(__dirname, 'data.json');
  try { fs.mkdirSync(newDir, { recursive: true }); } catch {}
  if (!fs.existsSync(newPath) && fs.existsSync(legacyPath)) {
    try {
      fs.copyFileSync(legacyPath, newPath);
      process.stderr.write(
        `[gate] migrated data file out of node_modules/ (which gets wiped on every npm upgrade).\n` +
        `       old: ${legacyPath}\n` +
        `       new: ${newPath}\n` +
        `       The old file is left in place — delete it manually after verifying the new\n` +
        `       location is being used (the [gate] startup log line shows the active path).\n`
      );
    } catch (e) {
      process.stderr.write(
        `[gate] WARN: could not auto-migrate data file from ${legacyPath} to ${newPath}: ${e.message}\n` +
        `       Falling back to the legacy node_modules path. Your data will be lost on next\n` +
        `       \`npm install\` unless you copy it manually or set GATE_DATA explicitly.\n`
      );
      return legacyPath;
    }
  }
  return newPath;
}
const DATA_FILE = resolveDataFile();
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
    // v0.11.2: default flipped to 'github' — Linear remains a server-side
    // code path for legacy projects but new projects always start GitHub.
    backend: 'github',                   // 'linear' (legacy) | 'github'
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

  // v0.12.0 migration: data.github went from a single PAT shape
  //   { token, username }  →  { accounts: [{ id, token, username, addedAt }] }
  // The gate now holds an arbitrary list of GitHub accounts so admins can
  // route different projects through different orgs' PATs. Idempotent — the
  // new-shape branch leaves accounts untouched.
  if (!data.github) {
    data.github = { accounts: [] };
  } else if (!data.github.accounts) {
    // Old single-PAT shape — convert.
    if (data.github.token) {
      const username = data.github.username || 'default';
      data.github = {
        accounts: [{
          id: 'gh-' + username,
          token: data.github.token,
          username,
          label: username,
          addedAt: Math.floor(Date.now() / 1000),
        }],
      };
    } else {
      data.github = { accounts: [] };
    }
  }
  // v0.12.1: backfill .label on accounts that were created under v0.12.0
  // (before labels were a distinct field). Falls back to the username.
  for (const a of data.github.accounts) {
    if (a.label === undefined) a.label = a.username || a.id;
  }

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
    // v0.11.2: any project without a backend that has Linear data set is a
    // pre-v0.10.0 project — keep it on 'linear' so ingestion doesn't break.
    // Everything else defaults to 'github' (the new default).
    if (!proj.backend) proj.backend = (proj.linearProjectId || proj.linearApiKey) ? 'linear' : 'github';
    // v0.11.2: one-time clean-up. Projects that defaulted to 'linear' under
    // v0.10.0–v0.11.1 but never actually got a Linear destination configured
    // are silently flipped to 'github' so the new GitHub-only wizard can
    // pick them up. Real Linear-backed projects (with linearProjectId set)
    // are untouched and continue routing to Linear server-side.
    if (proj.backend === 'linear' && !proj.linearProjectId && !proj.linearApiKey) {
      proj.backend = 'github';
    }
    if (proj.githubRepo === undefined) proj.githubRepo = '';
    // v0.12.0: per-project routing — which account in data.github.accounts
    // files this project's bug reports. Null until the project picks one.
    if (proj.githubAccountId === undefined) proj.githubAccountId = null;
    // v0.12.0: migrate any legacy proj.githubToken into a new account on the
    // gate. None of the current projects on local or prod gates use this
    // override, but the data shape change shouldn't silently drop a real
    // override if a stray one exists somewhere.
    if (proj.githubToken) {
      const id = 'gh-proj-' + proj.key;
      data.github.accounts.push({
        id,
        token: proj.githubToken,
        username: '',
        addedAt: Math.floor(Date.now() / 1000),
      });
      proj.githubAccountId = id;
    }
    delete proj.githubToken;
  }
  return data;
}
function saveData(data) {
  // Defensive mkdir -p so explicit GATE_DATA paths (which skip the auto-mkdir
  // at resolveDataFile() line 44) don't ENOENT on the first write and kill the
  // process. Idempotent — no-op when the dir already exists.
  try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); } catch {}
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
// v0.12.0: resolve GitHub credentials for a project. data.github now holds an
// array of accounts (each its own PAT) — projects pick which one routes their
// reports via proj.githubAccountId. When unset, falls back to the first
// account so legacy single-account gates keep working without migration.
function projectGithub(data, proj) {
  const accounts = (data.github && data.github.accounts) || [];
  const picked = (proj.githubAccountId && accounts.find((a) => a.id === proj.githubAccountId))
    || accounts[0]
    || null;
  return {
    token: picked ? picked.token : null,
    username: picked ? picked.username : '',
    accountId: picked ? picked.id : null,
    repo: proj.githubRepo || '',
  };
}
// v0.12.0: look up a specific account by id (for explicit-account API calls).
function getGithubAccount(data, accountId) {
  const accounts = (data.github && data.github.accounts) || [];
  return accounts.find((a) => a.id === accountId) || null;
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
// v0.11.1: 30 s per-token in-memory cache of /user/repos. Lets the live
// combobox filter locally without re-hitting GitHub on every keystroke. Keyed
// by token so a token rotation invalidates implicitly. Cleared on gate restart.
// v0.11.2: paginates up to 3 pages (300 repos) so accounts with lots of repos
// still cover the recent ones — and so org-owned repos at higher offsets
// aren't dropped before the local filter runs.
const _ghRepoCache = new Map(); // token -> { fetchedAt, repos }
const GH_REPO_CACHE_TTL_MS = 30_000;
const GH_REPO_PAGES = 3;
async function getCachedUserRepos(token) {
  const hit = _ghRepoCache.get(token);
  if (hit && Date.now() - hit.fetchedAt < GH_REPO_CACHE_TTL_MS) return hit.repos;
  // per_page=100 is GitHub's max for /user/repos. Fetch up to GH_REPO_PAGES
  // pages in parallel and concat. affiliation covers everything the PAT can
  // see — owner-only repos, repos shared as collaborator, repos in orgs the
  // PAT has been approved for. Fine-grained PATs allow-listed to specific
  // repos return only those repos here.
  const pageReqs = [];
  for (let p = 1; p <= GH_REPO_PAGES; p++) {
    pageReqs.push(
      githubREST(token, 'GET',
        '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=' + p)
        .catch(() => []) // a failing page (e.g. 404 past end) shouldn't kill the whole search
    );
  }
  const pages = await Promise.all(pageReqs);
  const repos = pages.flat().filter((r) => r && r.full_name);
  _ghRepoCache.set(token, { fetchedAt: Date.now(), repos });
  return repos;
}
// v0.11.2: direct-lookup fallback for org repos that /user/repos may not
// surface even when the PAT has explicit access (common for fine-grained PATs
// scoped to a single repo in an org that hasn't approved fine-grained at the
// org level — the PAT works for /repos/:owner/:repo calls but is invisible to
// /user/repos). Returns the repo metadata if reachable, null otherwise.
async function tryDirectRepoLookup(token, ownerRepo) {
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(ownerRepo);
  if (!m) return null;
  try {
    const r = await githubREST(token, 'GET', '/repos/' + m[1] + '/' + m[2]);
    if (!r || !r.full_name) return null;
    return { full_name: r.full_name, description: r.description || '', private: !!r.private };
  } catch {
    return null;
  }
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
// v0.12.0: surface the list of connected accounts (id + username only — never
// tokens). Replaces the v0.10.0 single-PAT shape { hasToken, username }.
// v0.12.1: + label (user-supplied display name, defaults to username) and
// tokenHint (first 12 chars — distinguishes accounts that share a GitHub
// username, e.g. two fine-grained PATs owned by the same user).
function publicGithub(github) {
  if (!github || !github.accounts) return { accounts: [] };
  return {
    accounts: github.accounts.map((a) => ({
      id: a.id,
      username: a.username || '',
      label: a.label || a.username || a.id,
      tokenHint: (a.token || '').slice(0, 12),
    })),
  };
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
    backend: p.backend || 'github', // v0.11.2: default flipped (was 'linear').
    linearProjectName: p.linearProjectName || '',
    hasLinearOverride: !!(p.linearApiKey || p.linearTeamId),
    githubRepo: p.githubRepo || '',
    githubAccountId: p.githubAccountId || null,
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
      const acctTag = proj.backend === 'github' ? ` @${projectGithub(data, proj).username || '?'}` : '';
      console.log(`[gate] issue ${created.identifier || created.id} for ${proj.key} (${proj.backend}${acctTag}) by ${payload.email}`);
      return send(res, 200, { ok: true, issue: created });
    } catch (e) {
      // v0.11.3: report the actual backend that failed (was hardcoded
      // 'linear-failed' which was misleading once we added GitHub). Also,
      // detect the specific "PAT missing Issues:W" 403 case and surface an
      // actionable message instead of GitHub's generic "Resource not
      // accessible by personal access token".
      console.error('[gate] backend error:', e.message);
      const errCode = proj.backend === 'github' ? 'github-failed' : 'linear-failed';
      let message = e.message;
      if (proj.backend === 'github' && /Resource not accessible by personal access token/i.test(e.message)) {
        message = "Your GitHub PAT can see the repo but can't create Issues. " +
          'Re-issue the PAT with "Issues: Read & Write" permission ' +
          '(fine-grained) or "repo" scope (classic), then paste it again in admin Settings → GitHub.';
      }
      return send(res, 502, { error: errCode, message });
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
    // v0.10.6: track whether THIS heartbeat is the one that created the
    // pending entry, so the overlay can show a one-time toast pointing the
    // dev at the admin UI. We always return a JSON status object now (the
    // overlay's heartbeat call is fire-and-forget but reads the response if
    // it gets one).
    let justCreated = false;
    if (!proj) {
      proj = emptyProject(key, body.displayName || key);
      proj.status = 'pending';
      data.projects[key] = proj;
      justCreated = true;
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
    return send(res, 200, { pending: proj.status === 'pending', justCreated });
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
  // v0.10.1: only reveal the actual default value to anonymous callers in dev.
  // A misconfigured prod gate previously broadcast 'frontend-conqueror' (or
  // whatever GATE_ADMIN_PASSWORD was) to anyone hitting /frontend-conqueror.
  // In prod we still set `usingDefault` so the login page can render an
  // appropriate hint pointing at the CLI reset command.
  if (method === 'GET' && route === '/frontend-conqueror/login-state') {
    const data = loadData();
    const isDev = process.env.NODE_ENV !== 'production';
    return send(res, 200, {
      usingDefault: !data.adminPasswordHash,
      defaultPassword: (isDev && !data.adminPasswordHash) ? DEFAULT_ADMIN_PASSWORD : null,
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

  // v0.10.3: force admin to rotate the default password before allowing any
  // state-changing operation. Pre-v0.10.3 the gate happily ran forever with
  // adminPasswordHash=null (and the default password 'frontend-conqueror'
  // or whatever GATE_ADMIN_PASSWORD was set to). Reads still go through so
  // the UI can render the forced-rotate screen; only the password-change
  // route + logout are allowed writes until a real password is set.
  if (isAdmin && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
    const isPasswordRoute = method === 'PUT' && route === '/frontend-conqueror/password';
    const isLogoutRoute = method === 'POST' && route === '/frontend-conqueror/logout';
    if (!isPasswordRoute && !isLogoutRoute) {
      const _d = loadData();
      if (!_d.adminPasswordHash) {
        return send(res, 409, { error: 'must-change-password', message: 'Change the admin password before performing this action.' });
      }
    }
  }

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
      const repoStr = typeof body.repo === 'string' ? body.repo.trim() : '';
      if (!repoStr) return send(res, 400, { error: 'missing-repo' });
      let parsed;
      try { parsed = parseGithubRepo(repoStr); }
      catch (e) { return send(res, 400, { error: 'bad-repo', message: e.message }); }
      // v0.12.0: caller may pass accountId to lock the project to a specific
      // account. If omitted, keep the current githubAccountId (or fall back
      // to the first account).
      let acct = null;
      if (body.accountId) {
        acct = getGithubAccount(data, body.accountId);
        if (!acct) return send(res, 400, { error: 'no-such-account' });
      } else {
        acct = (proj.githubAccountId && getGithubAccount(data, proj.githubAccountId))
          || (data.github.accounts[0] || null);
      }
      if (!acct || !acct.token) return send(res, 400, { error: 'no-token', message: 'No GitHub account connected. Add one in Settings → GitHub.' });
      try {
        // Confirm access + that issues are enabled.
        const repoInfo = await githubREST(acct.token, 'GET', `/repos/${parsed.owner}/${parsed.repo}`);
        if (!repoInfo.has_issues) return send(res, 400, { error: 'issues-disabled', message: 'Issues are disabled on this repo. Enable them in GitHub repo settings first.' });
        await ensureFcBugLabel(acct.token, parsed.owner, parsed.repo);
        proj.githubRepo = repoInfo.full_name;
        proj.githubAccountId = acct.id;
        proj.backend = 'github';
        saveData(data);
        bustIssuesCache(proj.key);
        return send(res, 200, { project: publicProjectDetail(proj) });
      } catch (e) {
        return send(res, 502, { error: 'github-unreachable', message: e.message });
      }
    }
    // v0.12.0: change the account routing this project's reports WITHOUT
    // re-picking a repo. Validates the new account can still see the repo.
    if (method === 'PUT' && sub === 'github-account') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
      const acct = body.accountId ? getGithubAccount(data, body.accountId) : null;
      if (!acct) return send(res, 400, { error: 'no-such-account' });
      if (!proj.githubRepo) return send(res, 400, { error: 'no-repo', message: 'Pick a repo first.' });
      try {
        const parsedR = parseGithubRepo(proj.githubRepo);
        await githubREST(acct.token, 'GET', `/repos/${parsedR.owner}/${parsedR.repo}`);
      } catch (e) {
        return send(res, 400, { error: 'account-cannot-see-repo', message: 'This account can\'t see ' + proj.githubRepo + ': ' + e.message });
      }
      proj.githubAccountId = acct.id;
      saveData(data);
      bustIssuesCache(proj.key);
      return send(res, 200, { project: publicProjectDetail(proj) });
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

  // ----- Admin: GitHub accounts (v0.12.0) -----
  // The gate now holds an arbitrary list of GitHub accounts (each its own PAT)
  // so admins can route different projects through different orgs. Each
  // account is keyed by its GitHub username (id='gh-<username>') with collision
  // disambiguation; the routing happens per-project via proj.githubAccountId.

  // PUT /github/accounts — add an account, OR no-op if the exact same token
  // is already connected. v0.12.1: dedup is by TOKEN, not username — two
  // fine-grained PATs owned by the same GitHub user (e.g. one for personal
  // repos, one for an org) authenticate as the same user but reach different
  // repo sets and must coexist. Optional body.label distinguishes them in
  // the UI (defaults to the GitHub username).
  // Body: { token, label? }. Returns { account: {id, username, label} }.
  if (method === 'PUT' && route === '/frontend-conqueror/github/accounts') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) return send(res, 400, { error: 'missing-token' });
    const labelRaw = typeof body.label === 'string' ? body.label.trim().slice(0, 64) : '';
    let username;
    try {
      const me = await githubREST(token, 'GET', '/user');
      username = me && me.login;
      if (!username) throw new Error('unexpected /user response');
    } catch (e) {
      return send(res, 400, { error: 'token-invalid', message: 'GitHub rejected this token: ' + e.message });
    }
    const data = loadData();
    // Exact-token match → no-op (idempotent re-paste).
    const exactDup = data.github.accounts.find((a) => a.token === token);
    if (exactDup) {
      if (labelRaw && labelRaw !== exactDup.label) {
        exactDup.label = labelRaw;
        saveData(data);
      }
      return send(res, 200, { account: { id: exactDup.id, username: exactDup.username, label: exactDup.label || exactDup.username } });
    }
    // New account. id = 'gh-' + (label or username), disambiguated if it
    // collides (same username + no label, or two accounts with the same
    // label).
    const idBase = 'gh-' + (labelRaw || username).replace(/[^A-Za-z0-9_-]/g, '-');
    let id = idBase, n = 2;
    while (data.github.accounts.find((a) => a.id === id)) id = idBase + '-' + n++;
    const acct = {
      id,
      token,
      username,
      label: labelRaw || username,
      addedAt: Math.floor(Date.now() / 1000),
    };
    data.github.accounts.push(acct);
    saveData(data);
    return send(res, 200, { account: { id: acct.id, username: acct.username, label: acct.label } });
  }

  // GET /github/accounts — list connected accounts (no tokens).
  if (method === 'GET' && route === '/frontend-conqueror/github/accounts') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    return send(res, 200, { accounts: data.github.accounts.map((a) => ({ id: a.id, username: a.username, label: a.label || a.username })) });
  }

  // PUT /github/accounts/:id — rename. Body: { label }. v0.12.1.
  const ghAcctRenameMatch = route.match(/^\/frontend-conqueror\/github\/accounts\/([A-Za-z0-9_-]+)$/);
  if (method === 'PUT' && ghAcctRenameMatch) {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 64) : '';
    if (!label) return send(res, 400, { error: 'missing-label' });
    const data = loadData();
    const acct = data.github.accounts.find((a) => a.id === ghAcctRenameMatch[1]);
    if (!acct) return send(res, 404, { error: 'no-such-account' });
    acct.label = label;
    saveData(data);
    return send(res, 200, { account: { id: acct.id, username: acct.username, label: acct.label } });
  }

  // GET /github/accounts/:id/token — reveal a single account's PAT.
  const ghAcctTokenMatch = route.match(/^\/frontend-conqueror\/github\/accounts\/([A-Za-z0-9_-]+)\/token$/);
  if (method === 'GET' && ghAcctTokenMatch) {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    const acct = data.github.accounts.find((a) => a.id === ghAcctTokenMatch[1]);
    if (!acct) return send(res, 404, { error: 'no-such-account' });
    return send(res, 200, { token: acct.token });
  }

  // DELETE /github/accounts/:id — remove an account. Any project that was
  // routing through it has its githubAccountId nulled so the next admin sees
  // "pick an account" prompts instead of silent broken routing.
  const ghAcctDeleteMatch = route.match(/^\/frontend-conqueror\/github\/accounts\/([A-Za-z0-9_-]+)$/);
  if (method === 'DELETE' && ghAcctDeleteMatch) {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    const idx = data.github.accounts.findIndex((a) => a.id === ghAcctDeleteMatch[1]);
    if (idx < 0) return send(res, 404, { error: 'no-such-account' });
    const acct = data.github.accounts[idx];
    _ghRepoCache.delete(acct.token);
    data.github.accounts.splice(idx, 1);
    for (const proj of Object.values(data.projects)) {
      if (proj.githubAccountId === acct.id) proj.githubAccountId = null;
    }
    saveData(data);
    return send(res, 200, { ok: true });
  }

  // ----- Deprecated v0.10–v0.11 shims (route to the new endpoints) -----
  // These keep prod gates that haven't bumped to v0.12.0 working when they
  // POST to /github/token from an older consumer-project deploy script, etc.

  if (method === 'PUT' && route === '/frontend-conqueror/github/token') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) return send(res, 400, { error: 'missing-token' });
    let username;
    try {
      const me = await githubREST(token, 'GET', '/user');
      username = me && me.login;
      if (!username) throw new Error('unexpected /user response');
    } catch (e) {
      return send(res, 400, { error: 'token-invalid', message: 'GitHub rejected this token: ' + e.message });
    }
    const data = loadData();
    // v0.12.1: shim now dedups by token. The legacy shape only ever held one
    // account; with the new accounts list, dedupe-by-token preserves multi-
    // account semantics for callers that came in via the new path.
    const exactDup = data.github.accounts.find((a) => a.token === token);
    if (!exactDup) {
      const idBase = 'gh-' + username;
      let id = idBase, n = 2;
      while (data.github.accounts.find((a) => a.id === id)) id = idBase + '-' + n++;
      data.github.accounts.push({ id, token, username, label: username, addedAt: Math.floor(Date.now() / 1000) });
    }
    saveData(data);
    return send(res, 200, { github: publicGithub(data.github) });
  }
  if (method === 'DELETE' && route === '/frontend-conqueror/github') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    for (const a of data.github.accounts) _ghRepoCache.delete(a.token);
    data.github = { accounts: [] };
    for (const proj of Object.values(data.projects)) proj.githubAccountId = null;
    saveData(data);
    return send(res, 200, { github: publicGithub(data.github) });
  }
  if (method === 'GET' && route === '/frontend-conqueror/github/token') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    const acct = data.github.accounts[0];
    if (!acct) return send(res, 404, { error: 'no-token' });
    return send(res, 200, { token: acct.token });
  }

  // Repo search merges /user/repos across every connected account, tags each
  // result with which account surfaced it, dedups by full_name (first account
  // wins on dup), and adds direct-lookup fallback for owner/repo queries that
  // no account's /user/repos surfaces. Optional ?accountId= constrains the
  // search to a single account.
  if (method === 'GET' && route === '/frontend-conqueror/github/repos') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    const requestedAcctId = (parsed.query && parsed.query.accountId) || null;
    const accounts = requestedAcctId
      ? data.github.accounts.filter((a) => a.id === requestedAcctId)
      : data.github.accounts;
    if (accounts.length === 0) return send(res, 400, { error: 'no-accounts' });
    const qRaw = String((parsed.query && parsed.query.q) || '').trim();
    const q = qRaw.toLowerCase();
    try {
      // Fetch each account's /user/repos in parallel; tag results with the
      // accountId that returned them. Failures on one account don't kill the
      // whole search (a revoked PAT shouldn't black-hole the other accounts).
      const perAccountLists = await Promise.all(accounts.map(async (acct) => {
        try {
          const repos = await getCachedUserRepos(acct.token);
          return { acct, repos };
        } catch {
          return { acct, repos: [] };
        }
      }));
      // Filter + dedup. Iterate in account order so the FIRST account that
      // surfaces a repo wins for that repo's accountId tag.
      const seen = new Map(); // full_name → { acct, repo }
      for (const { acct, repos } of perAccountLists) {
        for (const r of repos) {
          if (seen.has(r.full_name)) continue;
          const matches = !q
            ? true
            : (r.full_name || '').toLowerCase().includes(q)
              || (r.description || '').toLowerCase().includes(q);
          if (!matches) continue;
          seen.set(r.full_name, { acct, repo: r });
        }
      }
      let repos = Array.from(seen.values()).slice(0, 30).map(({ acct, repo }) => ({
        full_name: repo.full_name,
        description: repo.description || '',
        private: !!repo.private,
        accountId: acct.id,
        accountLabel: acct.label || acct.username,
      }));
      let hint = null;
      // Direct-lookup fallback when the query is owner/repo-shaped. Try every
      // account; the first one that can reach the repo wins.
      if (qRaw.includes('/') && repos.length === 0) {
        for (const acct of accounts) {
          const direct = await tryDirectRepoLookup(acct.token, qRaw);
          if (direct) {
            repos = [{ ...direct, accountId: acct.id, accountLabel: acct.label || acct.username }];
            break;
          }
        }
        if (repos.length === 0) hint = 'direct-lookup-404';
      }
      // Bare-name fallback: try <username>/<name> for each account's owner.
      if (!qRaw.includes('/') && qRaw && repos.length === 0) {
        for (const acct of accounts) {
          if (!acct.username) continue;
          const direct = await tryDirectRepoLookup(acct.token, acct.username + '/' + qRaw);
          if (direct) {
            repos = [{ ...direct, accountId: acct.id, accountLabel: acct.label || acct.username }];
            break;
          }
        }
      }
      return send(res, 200, { repos, hint });
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
  /* v0.11.1: password show/hide toggle. The wrapper sits in place of the
     <input> in the DOM; wirePasswordToggles() re-parents the input into it
     and appends the .pw-toggle button. Width: 100% so it visually replaces
     the input one-for-one in the existing layout. */
  .pw-wrap { position: relative; width: 100%; }
  .pw-wrap input { padding-right: 36px; }
  .pw-toggle { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); background: transparent; border: 0; color: var(--muted); cursor: pointer; padding: 4px 6px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; }
  .pw-toggle:hover { background: var(--card2); color: var(--text); }
  .pw-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .pw-toggle svg { width: 16px; height: 16px; display: block; }
  /* v0.11.1: live repo combobox (replaces input + button + results list). */
  .combo { position: relative; }
  .combo-input { width: 100%; }
  .combo-results { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; max-height: 360px; overflow-y: auto; }
  .combo-results .palette-option[aria-selected="true"] { outline: 2px solid var(--accent); outline-offset: -2px; }
  .combo-empty { color: var(--muted); font-size: 12px; padding: 14px 4px; text-align: center; }
  .combo-loading { color: var(--muted); font-size: 12px; padding: 14px 4px; text-align: center; font-style: italic; }
  .combo-hint { color: var(--muted); font-size: 11px; margin-top: 6px; }
  /* v0.11.3: project-detail tab bar. Horizontal pills with an underline for
     active. Deep-linkable via #/p/:key/:tab so the URL is the source of truth
     for which tab is rendered (and reload preserves it). */
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin: 18px 0 18px; flex-wrap: wrap; }
  .tab { background: transparent; border: 0; color: var(--muted); padding: 9px 14px; cursor: pointer; font: inherit; font-size: 13px; border-bottom: 2px solid transparent; margin-bottom: -1px; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; }
  .tab:hover { color: var(--text); text-decoration: none; }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); font-weight: 500; }
  .tab .count { display: inline-flex; align-items: center; padding: 0 7px; height: 17px; background: var(--card2); color: var(--muted); border-radius: 999px; font-size: 11px; font-weight: 400; }
  .tab.active .count { background: rgba(37,99,235,0.18); color: #93c5fd; }
  .tab .dot-warn { width: 6px; height: 6px; border-radius: 50%; background: var(--warn); display: inline-block; }
  /* v0.11.1: lightweight modal helper (used by changeGithubRepo() etc.). */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 50; display: flex; align-items: flex-start; justify-content: center; padding-top: 90px; }
  .modal-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; width: min(560px, calc(100vw - 32px)); box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  .modal-card h3 { margin: 0 0 12px; }
  .modal-close { float: right; background: transparent; border: 0; color: var(--muted); cursor: pointer; font-size: 18px; line-height: 1; padding: 0 4px; }
  .modal-close:hover { color: var(--text); }
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
  if (!r.ok) {
    // v0.10.3: server enforces password rotation server-side. If the user
    // somehow gets past the initial forced-rotate screen and tries to write,
    // bounce them straight back to the rotate UI rather than surfacing a raw
    // "must-change-password" error in a toast.
    if (r.status === 409 && json && json.error === 'must-change-password') {
      renderForcedPasswordChange();
      const err = new Error('Change the admin password to continue.');
      err.payload = json;
      err.handled = true;
      throw err;
    }
    const err = new Error((json && (json.message || json.error)) || r.statusText);
    err.payload = json;
    throw err;
  }
  return json;
}

// ============================== UI HELPERS (v0.11.1) ==============================
// SVG eye + eye-off, both 16x16. Inlined so there's no extra HTTP fetch.
const EYE_OPEN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.77 21.77 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.83 21.83 0 0 1-3.17 4.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
// Wrap every <input type="password"> in rootEl with an inline show/hide eye
// toggle. Idempotent via data-pw-wired so re-renders don't double-wrap. Call
// at the END of each renderer that paints a password input.
function wirePasswordToggles(rootEl) {
  if (!rootEl) return;
  const inputs = rootEl.querySelectorAll('input[type="password"]:not([data-pw-wired])');
  inputs.forEach((input) => {
    input.setAttribute('data-pw-wired', '1');
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.tabIndex = -1; // skip in tab order — most users prefer to type-then-click
    btn.setAttribute('aria-label', 'Show password');
    btn.innerHTML = EYE_OPEN_SVG;
    btn.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.innerHTML = showing ? EYE_OPEN_SVG : EYE_OFF_SVG;
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      // Keep focus in the input so the user can keep typing without re-clicking.
      input.focus();
    });
    wrap.appendChild(btn);
  });
}

// Live repo combobox. Host element gets an input + a debounced results panel.
// opts = { onPick(fullName), initialQuery (default ''), placeholder, hint }.
// Returns nothing — the caller already owns the host element.
function renderRepoCombobox(host, opts) {
  opts = opts || {};
  const placeholder = opts.placeholder || 'Search your repos — type to filter';
  const hint = opts.hint != null ? opts.hint : 'Tip: type owner/repo to look up a specific repo (works for private + org repos your PAT can reach).';
  host.classList.add('combo');
  host.innerHTML =
    '<input class="combo-input" type="text" placeholder="' + esc(placeholder) + '" autocomplete="off" autofocus>' +
    '<div class="combo-results"><div class="combo-loading">Loading your repos…</div></div>' +
    (hint ? '<div class="combo-hint">' + esc(hint) + '</div>' : '') +
    '<div class="row" style="margin-top:8px;gap:6px;">' +
      '<input class="combo-direct" type="text" placeholder="…or paste owner/repo directly" autocomplete="off" style="flex:1;">' +
      '<button class="ghost combo-direct-btn">Use this</button>' +
    '</div>';
  const input = host.querySelector('.combo-input');
  const resultsEl = host.querySelector('.combo-results');
  const directInput = host.querySelector('.combo-direct');
  const directBtn = host.querySelector('.combo-direct-btn');
  let current = [];
  let activeIdx = -1;
  let reqSeq = 0;
  let lastQuery = '';
  let lastHint = null;

  const renderRows = () => {
    if (current.length === 0) {
      // v0.11.3: tailor the empty-state message to the actual cause. The
      // server returns hint='direct-lookup-404' when an owner/repo-shaped
      // query couldn't be reached at all — usually the org-approval case.
      let msg;
      if (lastHint === 'direct-lookup-404') {
        msg =
          '<div class="combo-empty" style="text-align:left;line-height:1.5;">' +
            '<strong style="color:#fca5a5;">Can\\'t reach <code>' + esc(lastQuery) + '</code> with this PAT.</strong><br><br>' +
            'Most likely cause: this is a private <strong>org repo</strong> and your fine-grained PAT either:' +
            '<ul style="margin:6px 0;padding-left:18px;">' +
              '<li>has the user (not the org) as <em>Resource Owner</em>, or</li>' +
              '<li>hasn\\'t been approved by the org yet (see <code>github.com/organizations/&lt;org&gt;/settings/personal-access-tokens-pending</code>).</li>' +
            '</ul>' +
            '<strong>Quickest fix:</strong> re-create the PAT and pick the <strong>organization</strong> as Resource Owner, then ask an org admin to approve it. Or use a <strong>classic PAT</strong> with the <code>repo</code> scope — sees every repo you can see, no org-approval dance.' +
          '</div>';
      } else if (lastQuery) {
        msg = '<div class="combo-empty">No matches for <code>' + esc(lastQuery) + '</code>. Try the <code>owner/repo</code> field below if the repo is private or in an org.</div>';
      } else {
        msg = '<div class="combo-empty"><strong>This PAT can\\'t see any of your repos.</strong><br>Re-issue with <strong>"All repositories"</strong> (fine-grained) or use a <strong>classic PAT</strong> with <code>repo</code> scope. Both work.</div>';
      }
      resultsEl.innerHTML = msg;
      activeIdx = -1;
      return;
    }
    // v0.12.0: surface which connected account surfaced each repo. The badge
    // matters when multiple accounts are connected — clarifies routing before
    // the user commits to a repo pick. With one account, the badge still
    // renders but is informational.
    resultsEl.innerHTML = current.map((r, i) => (
      '<button class="palette-option" data-repo="' + esc(r.full_name) + '" data-account="' + esc(r.accountId || '') + '" data-idx="' + i + '"' + (i === activeIdx ? ' aria-selected="true"' : '') + '>' +
        '<span class="name" style="font:600 12px/1.2 ui-monospace,Menlo,monospace;">' + esc(r.full_name) + '</span>' +
        (r.private ? ' <span class="kbd">private</span>' : '') +
        (r.accountLabel ? ' <span class="kbd" style="opacity:0.75;">' + esc(r.accountLabel) + '</span>' : '') +
        (r.description ? '<span class="desc" style="display:block;margin-top:4px;">' + esc(r.description) + '</span>' : '') +
      '</button>'
    )).join('');
    resultsEl.querySelectorAll('button.palette-option').forEach((btn) => {
      btn.addEventListener('click', () => opts.onPick && opts.onPick(btn.getAttribute('data-repo'), btn.getAttribute('data-account') || null));
    });
  };

  const search = async (q) => {
    const mySeq = ++reqSeq;
    lastQuery = q;
    if (mySeq === 1) resultsEl.innerHTML = '<div class="combo-loading">Loading your repos…</div>';
    try {
      const r = await api('GET', '/frontend-conqueror/github/repos?q=' + encodeURIComponent(q));
      if (mySeq !== reqSeq) return; // a newer keystroke superseded this fetch
      current = r.repos || [];
      lastHint = r.hint || null;
      activeIdx = current.length ? 0 : -1;
      renderRows();
    } catch (e) {
      if (mySeq !== reqSeq) return;
      resultsEl.innerHTML = '<div class="err">' + esc(e.message) + '</div>';
    }
  };

  let debounceT = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceT);
    debounceT = setTimeout(() => search(input.value.trim()), 220);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (current.length) { activeIdx = (activeIdx + 1) % current.length; renderRows(); resultsEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (current.length) { activeIdx = (activeIdx - 1 + current.length) % current.length; renderRows(); resultsEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && current[activeIdx]) opts.onPick && opts.onPick(current[activeIdx].full_name, current[activeIdx].accountId || null);
    } else if (e.key === 'Escape') {
      input.value = '';
      search('');
    }
  });

  const submitDirect = () => {
    const v = directInput.value.trim();
    if (!v) return;
    opts.onPick && opts.onPick(v);
  };
  directBtn.addEventListener('click', submitDirect);
  directInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitDirect(); } });

  if (opts.initialQuery) input.value = opts.initialQuery;
  search(opts.initialQuery || '');
}

// Lightweight modal. Returns the inner content host element for the caller
// to paint into. Closes on backdrop click, Esc, or modal._close().
function openModal(title) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML =
    '<div class="modal-card" role="dialog" aria-modal="true">' +
      '<button class="modal-close" aria-label="Close">✕</button>' +
      (title ? '<h3>' + esc(title) + '</h3>' : '') +
      '<div class="modal-body"></div>' +
    '</div>';
  document.body.appendChild(back);
  const card = back.querySelector('.modal-card');
  const body = back.querySelector('.modal-body');
  const close = () => {
    if (!back.parentNode) return;
    back.parentNode.removeChild(back);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  back.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  body._close = close;
  return body;
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
window.addEventListener('load', () => {
  // v0.11.1: one MutationObserver on document.body catches every renderX()
  // output (root.innerHTML = ...) AND modal mounts (openModal appends to body)
  // and wires password show/hide toggles on any new <input type="password">
  // nodes. Idempotent (data-pw-wired marker) — re-renders are harmless. One
  // observer = covers every current and future renderer + modal.
  new MutationObserver(() => wirePasswordToggles(document.body))
    .observe(document.body, { childList: true, subtree: true });
  navigate();
});

function parseHash() {
  const h = (window.location.hash || '#/').slice(1);
  const parts = h.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'list' };
  // v0.11.3: settings tabs are deep-linkable too — #/settings, #/settings/github,
  // #/settings/appearance, #/settings/security.
  if (parts[0] === 'settings') return { name: 'settings', tab: parts[1] || null };
  if (parts[0] === 'setup') return { name: 'setup' };
  if (parts[0] === 'p' && parts[1]) {
    if (parts[2] === 'configure') return { name: 'project-wizard', key: parts[1] };
    // v0.11.3: tabs are deep-linkable. #/p/:key, #/p/:key/activity,
    // #/p/:key/testers, #/p/:key/destination, #/p/:key/integration,
    // #/p/:key/settings. Unknown tab falls back to the default.
    return { name: 'project-detail', key: parts[1], tab: parts[2] || null };
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
    // v0.11.2: first-run check uses GitHub now (setup wizard is GitHub-only).
    // Legacy gates with only Linear configured fall through to renderList.
    // v0.12.0: first-run check looks for at least one connected GitHub account.
    const hasGithub = STATE.github && (STATE.github.accounts || []).length > 0;
    if (!hasGithub && totalProjects === 0) return renderSetup();
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
  // v0.10.1: defaultPassword only travels over the wire in dev. usingDefault
  // still travels everywhere so the prod hint can point at the CLI recovery
  // command rather than silently leaving the user stuck.
  let hint = null;
  let usingDefault = false;
  try {
    const s = await api('GET', '/frontend-conqueror/login-state');
    usingDefault = !!s.usingDefault;
    if (s.defaultPassword) hint = s.defaultPassword;
  } catch {}
  const hintHtml = hint
    ? '<div class="sub-muted" style="margin-top:6px;">First time? Default password: <code>' + esc(hint) + '</code> — you\\'ll be asked to change it after sign-in.</div>'
    : (usingDefault
      ? '<div class="sub-muted" style="margin-top:6px;">First time? Check the gate startup logs for the default password (or set <code>GATE_ADMIN_PASSWORD</code>). Locked out? Run <code>npx frontend-conqueror gate --reset-admin-password</code> on the server.</div>'
      : '');
  root().innerHTML = html\`
    <header><span class="brand">frontend-conqueror · gate</span></header>
    <main>
      <div class="card" style="max-width:420px;margin:60px auto;">
        <h3>Admin sign in</h3>
        <label for="pw">Password</label>
        <input id="pw" type="password" autofocus>
        <div class="err">\${err ? esc(err) : ''}</div>
        \${hintHtml}
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
  // v0.11.2: GitHub-only setup wizard. Previously there was a backend chooser
  // (Linear vs GitHub) at step 1 with two divergent branches. Now we go
  // straight to GitHub: PAT → project → repo → tester.
  let step = 1;
  const ctx = {
    githubToken: '',
    projectKey: '',
    projectDisplayName: '',
    githubRepo: '',
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
  const TOTAL = 4;
  const dots = (n) => '<div class="step-dots">' +
    [1,2,3,4].map(i => '<div class="d ' + (i < n ? 'done' : i === n ? 'on' : '') + '"></div>').join('') +
    '</div>';

  function renderStep() {
    if (step === 1) {
      // GitHub PAT.
      nav(html\`
        \${dots(1)}
        <h2>GitHub access token<span class="sub">Step 1 of \${TOTAL} — paste a PAT. Used by every project on this gate to file Issues.</span></h2>
        <div class="card">
          <label for="ghToken">Personal access token (classic or fine-grained)</label>
          <input id="ghToken" type="password" placeholder="github_pat_... or ghp_..." autofocus value="\${esc(ctx.githubToken)}">
          <div class="sub-muted" style="margin-top:6px;line-height:1.55;">
            <strong>Easiest:</strong> a <a href="https://github.com/settings/tokens/new?scopes=repo&description=frontend-conqueror" target="_blank" rel="noreferrer">classic PAT with <code>repo</code> scope</a>. Sees every repo you can see (public + private, personal + org). No org-approval needed.<br>
            <strong>More secure:</strong> a <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer">fine-grained PAT</a> with <strong>Issues: Read &amp; Write</strong> + <strong>Metadata: Read</strong>. For org repos, set <em>Resource Owner</em> to the organization and have an admin approve it.
          </div>
          <div class="err" id="err"></div>
          <div class="row" style="justify-content:flex-end;margin-top:14px;gap:6px;">
            <button class="primary" id="next">Continue →</button>
          </div>
        </div>\`);
      $('next').addEventListener('click', async () => {
        ctx.githubToken = $('ghToken').value.trim();
        if (!ctx.githubToken) return ($('err').textContent = 'Paste your GitHub PAT.');
        $('next').disabled = true;
        try {
          await api('PUT', '/frontend-conqueror/github/token', { token: ctx.githubToken });
          step = 2;
          renderStep();
        } catch (e) { $('err').textContent = e.message; $('next').disabled = false; }
      });
    } else if (step === 2) {
      // Project name + key.
      nav(html\`
        \${dots(2)}
        <h2>Name your first project<span class="sub">Step 2 of \${TOTAL} — this is what you'll use in your plugin config (<code>gate.project = '...'</code>). Letters, numbers, dashes.</span></h2>
        <div class="card">
          <label for="displayName">Display name</label>
          <input id="displayName" placeholder="Messarat" autofocus value="\${esc(ctx.projectDisplayName)}">
          <label for="key">Project key</label>
          <input id="key" placeholder="messarat" value="\${esc(ctx.projectKey)}">
          <div class="sub-muted" style="margin-top:4px;">Used in <code>gate.project</code> and the overlay URL.</div>
          <div class="err" id="err"></div>
          <div class="row" style="justify-content:flex-end;margin-top:14px;gap:6px;">
            <button class="ghost" onclick="(()=>{step=1;renderStep();})()">← Back</button>
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
          step = 3;
          renderStep();
        } catch (e) {
          if (e.payload && e.payload.error === 'already-exists') {
            ctx.projectKey = key;
            ctx.projectDisplayName = displayName;
            step = 3;
            renderStep();
          } else $('err').textContent = e.message;
        }
      });
    } else if (step === 3) {
      // Repo picker.
      nav(html\`
        \${dots(3)}
        <h2>Which GitHub repo?<span class="sub">Step 3 of \${TOTAL} — bugs from \${esc(ctx.projectDisplayName)} will land in this repo's Issues tab, tagged <code>fc:bug</code>.</span></h2>
        <div class="card">
          <div id="ghCombo"></div>
          <div class="err" id="err" style="margin-top:6px;"></div>
          <div class="row" style="justify-content:flex-end;margin-top:14px;gap:6px;">
            <button class="ghost" onclick="(()=>{step=2;renderStep();})()">← Back</button>
          </div>
        </div>\`);
      const pickRepo = async (repo, accountId) => {
        if (!repo || !repo.includes('/')) return ($('err').textContent = 'Repo must be in the form "owner/repo".');
        try {
          await api('PUT', '/frontend-conqueror/projects/' + ctx.projectKey + '/github-repo', { repo, accountId });
          step = 4;
          renderStep();
        } catch (e) { $('err').textContent = e.message; }
      };
      renderRepoCombobox($('ghCombo'), { onPick: pickRepo });
    } else if (step === 4) {
      // First tester.
      nav(html\`
        \${dots(4)}
        <h2>Add your first tester<span class="sub">Step 4 of \${TOTAL} — only people whose email + password you set here will be able to file bugs from \${esc(ctx.projectDisplayName)}. You can add more later.</span></h2>
        <div class="card">
          <label for="firstEmail">First tester email</label>
          <input id="firstEmail" type="email" placeholder="alice@example.com" autofocus>
          <label for="firstPassword">Password (min 8 characters) — share this with the tester</label>
          <input id="firstPassword" type="text" placeholder="password">
          <div class="sub-muted" style="margin-top:6px;">You can add more testers from the project page after setup.</div>
          <div class="err" id="err"></div>
          <div class="row" style="justify-content:flex-end;margin-top:14px;gap:6px;">
            <button class="ghost" onclick="(()=>{step=3;renderStep();})()">← Back</button>
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
  // v0.11.2: show GitHub destination by default; legacy Linear-backed projects
  // surface their Linear destination name with a "(legacy)" tag.
  const dest = p.backend === 'linear'
    ? (p.linearProjectName ? p.linearProjectName + ' (legacy Linear)' : '(legacy Linear — needs migration)')
    : (p.githubRepo || (p.status === 'pending' ? '(needs configuring)' : '(not set)'));
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
        <span>🎯 \${esc(dest)}</span>
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
// v0.11.3: redesigned as a tabbed layout. Five tabs:
//   Activity · Testers · Destination · Integration · Settings
// The pending warning, when applicable, sits ABOVE the tab bar as a banner so
// it can't be tab-clicked away. Tabs are deep-linkable via #/p/:key/:tab so
// reloads / shared links preserve the tab. Each tab renders only its own
// content — no more endless scroll.
async function renderProjectDetail(key) {
  let detail;
  try { detail = (await api('GET', '/frontend-conqueror/projects/' + key)).project; }
  catch (e) { return renderError(e); }

  const hasDestination = detail.backend === 'github' ? !!detail.githubRepo : !!detail.linearProjectId;
  const needsConfig = detail.status === 'pending' || !hasDestination || detail.usersCount === 0;
  const overlayTag = '<' + 'script src="' + location.origin + '/' + detail.key + '/overlay.js" defer><' + '/script>';
  const pluginCfg = "gate: { url: '" + location.origin + "', project: '" + detail.key + "' }";
  const _origins = (detail.activity && detail.activity.origins) || {};
  const _topOriginEntry = Object.entries(_origins).sort((a, b) => b[1] - a[1])[0];
  const _topOrigin = _topOriginEntry ? _topOriginEntry[0] : null;
  const _topOriginHits = _topOriginEntry ? _topOriginEntry[1] : 0;

  // Pick the active tab. Default to 'destination' when destination is unset
  // (most-actionable next step), otherwise 'activity' (the most-checked view).
  const validTabs = ['activity', 'testers', 'destination', 'integration', 'settings'];
  const defaultTab = !hasDestination ? 'destination' : 'activity';
  const activeTab = (ROUTE.tab && validTabs.includes(ROUTE.tab)) ? ROUTE.tab : defaultTab;

  // Each tab definition: key, label, optional badge (number or warning dot).
  const testerWarn = detail.usersNeedingPassword > 0 ? '<span class="dot-warn"></span>' : '';
  const destWarn = !hasDestination ? '<span class="dot-warn"></span>' : '';
  const tabs = [
    { key: 'activity', label: 'Activity' },
    { key: 'testers', label: 'Testers', extra: '<span class="count">' + detail.users.length + '</span>' + testerWarn },
    { key: 'destination', label: 'Destination', extra: destWarn },
    { key: 'integration', label: 'Integration' },
    { key: 'settings', label: 'Settings' },
  ];
  const tabBar = '<nav class="tabs" aria-label="Project sections">' +
    tabs.map((t) => (
      '<a class="tab' + (t.key === activeTab ? ' active' : '') + '" href="#/p/' + esc(detail.key) + '/' + t.key + '">' +
        esc(t.label) + (t.extra || '') +
      '</a>'
    )).join('') +
    '</nav>';

  // -------- Tab content renderers (HTML strings, plugged into the page below) --------

  const renderActivityTab = () => html\`
    <div class="card">
      <div class="grid3">
        <div class="stat"><span class="v">\${detail.activity.totalHeartbeats || 0}</span><span class="l">total heartbeats</span></div>
        <div class="stat"><span class="v">\${detail.activity.uniqueIpsToday}</span><span class="l">unique today</span></div>
        <div class="stat"><span class="v">\${detail.activity.reportsCount || 0}</span><span class="l">reports filed</span></div>
      </div>
      <div style="margin-top:14px;font-size:12px;color:var(--muted);">
        First seen: \${detail.activity.firstSeenAt ? new Date(detail.activity.firstSeenAt * 1000).toISOString() : 'never'}<br>
        Last heartbeat: \${detail.activity.lastSeenAt ? relTime(detail.activity.lastSeenAt) : 'never'}
      </div>
    </div>
    \${Object.keys(_origins).length > 0 ? html\`
      <div class="card">
        <h3>Origins seen</h3>
        <div class="origin-list">
          \${Object.entries(_origins).sort((a,b) => b[1]-a[1]).slice(0,10).map(([o,c]) => '<div class="o"><span>' + esc(o) + '</span><span>' + c + ' hits</span></div>').join('')}
        </div>
      </div>
    \` : ''}
    \${detail.activity.pages.length > 0 ? html\`
      <div class="card">
        <h3>Pages seen (\${detail.activity.pages.length})</h3>
        <div class="origin-list">
          \${detail.activity.pages.slice(-10).reverse().map(p => '<div class="o" style="display:block;"><a href="' + esc(p) + '" target="_blank" rel="noreferrer">' + esc(p) + '</a></div>').join('')}
        </div>
      </div>
    \` : ''}
    \${Object.keys(_origins).length === 0 && detail.activity.pages.length === 0 && !detail.activity.firstSeenAt ? html\`
      <div class="card"><div class="empty">No activity yet. Once the overlay loads this project's key, heartbeats start flowing here.</div></div>
    \` : ''}
  \`;

  const renderTestersTab = () => html\`
    <div class="card">
      <div class="sub-muted" style="margin-bottom:10px;">Each tester logs in with their email + the password you set here.</div>
      <div id="userList">
        \${detail.users.length === 0
          ? '<div class="empty">No testers yet — add the people who\\'ll file feedback from this site.</div>'
          : detail.users.map(u => {
              const status = !u.hasPassword
                ? '<span class="pill warn dot" style="background:rgba(245,158,11,.15);color:#fcd34d;">needs password</span>'
                : u.locked ? '<span class="pill warn dot">locked (5 failed attempts)</span>'
                : '<span class="pill active dot">active</span>';
              const lastLogin = u.lastLoginAt
                ? '<span class="sub-muted" style="font-size:11px;">last login: ' + new Date(u.lastLoginAt * 1000).toISOString().slice(0,10) + '</span>'
                : '<span class="sub-muted" style="font-size:11px;">never logged in</span>';
              return '<div class="row spaced" style="padding:8px 0;border-bottom:1px solid var(--border);">'
                + '<div><code style="background:transparent;font-size:12px;">' + esc(u.email) + '</code><br>' + status + ' &nbsp; ' + lastLogin + '</div>'
                + '<div style="display:flex;gap:6px;">'
                  + '<button class="ghost" style="padding:4px 10px;font-size:11px;" onclick="setUserPassword(\\'' + esc(detail.key) + '\\', \\'' + esc(u.email) + '\\')">set password</button>'
                  + '<button class="danger" onclick="removeUser(\\'' + esc(detail.key) + '\\', \\'' + esc(u.email) + '\\')">remove</button>'
                + '</div></div>';
            }).join('')
        }
      </div>
      <label style="margin-top:14px;">Add tester</label>
      <div class="sub-muted" style="font-size:11px;margin:-2px 0 6px;">Share the email + password with them out-of-band (DM, password manager — anywhere that isn't a shared chat).</div>
      <div class="row">
        <input id="newEmail" type="email" placeholder="alice@example.com">
        <input id="newPassword" type="text" placeholder="password (min 8 chars)" style="max-width:200px;">
        <button class="primary" onclick="addUser('\${esc(detail.key)}')">Add</button>
      </div>
      <div class="err" id="userErr"></div>
      \${detail.usersNeedingPassword > 0 ? '<div class="ok-line" style="color:#fcd34d;margin-top:8px;">⚠ ' + detail.usersNeedingPassword + ' tester(s) migrated from email-only mode and need a password set before they can log in.</div>' : ''}
    </div>
  \`;

  const renderDestinationTab = () => html\`
    <div class="card">
      \${detail.backend === 'linear' ? html\`
        <div class="body">Reports go to: <strong>\${esc(detail.linearProjectName || 'Linear (legacy)')}</strong></div>
        <div class="sub-muted" style="margin-top:6px;font-size:12px;line-height:1.55;">This project uses the legacy Linear backend. Run <code>node tools/migrate-linear-to-github.js --project \${esc(detail.key)} --repo OWNER/NAME</code> to migrate existing Issues to GitHub, then switch the destination here.</div>
        <div class="row" style="margin-top:10px;justify-content:flex-end;gap:6px;">
          <button class="primary" onclick="switchToGithub('\${esc(detail.key)}')">Switch to GitHub →</button>
        </div>
      \` : html\`
        \${detail.githubRepo ? html\`
          \${(() => {
            // v0.12.0: show which account routes this project, with a
            // change-account action when more than one is connected.
            const accounts = (STATE.github && STATE.github.accounts) || [];
            const acct = accounts.find((a) => a.id === detail.githubAccountId);
            const acctLabel = acct ? (acct.label || ('@' + acct.username))
              : (detail.githubAccountId ? 'Account removed — pick a new one' : (accounts.length > 0 ? (accounts[0].label || ('@' + accounts[0].username)) + ' (default)' : 'No account connected'));
            const showChangeAccount = accounts.length > 1 && detail.githubRepo;
            return html\`
              <div class="body">Reports go to: <strong><a href="https://github.com/\${esc(detail.githubRepo)}/issues" target="_blank" rel="noreferrer">\${esc(detail.githubRepo)}</a></strong> (GitHub Issues)</div>
              <div class="meta">Routed via <strong>\${esc(acctLabel)}</strong></div>
              <div class="row" style="margin-top:10px;justify-content:flex-end;gap:6px;">
                \${showChangeAccount ? '<button class="ghost" onclick="changeGithubAccount(\\'' + esc(detail.key) + '\\')">Change account</button>' : ''}
                <button class="ghost" onclick="changeGithubRepo('\${esc(detail.key)}')">Change repo</button>
              </div>
            \`;
          })()}
        \` : html\`
          <div class="empty">No destination set. Bug reports will be rejected until one is picked.</div>
          <div class="row" style="margin-top:10px;justify-content:flex-end;">
            <button class="primary" onclick="changeGithubRepo('\${esc(detail.key)}')">Pick a GitHub repo</button>
          </div>
        \`}
      \`}
    </div>
  \`;

  const renderIntegrationTab = () => html\`
    <div class="card">
      <h3 style="margin-bottom:8px;">In your project's Vite/Nuxt plugin config</h3>
      <div class="sub-muted" style="margin-bottom:8px;font-size:12px;">Add this to <code>frontendConqueror()</code> in your <code>vite.config.ts</code> / <code>nuxt.config.ts</code>:</div>
      <div><code>\${esc(pluginCfg)}</code></div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:8px;">In production HTML directly</h3>
      <div class="sub-muted" style="margin-bottom:8px;font-size:12px;">Add to the <code>&lt;head&gt;</code> of every page where testers should file bugs:</div>
      <div><code>\${esc(overlayTag)}</code></div>
    </div>
    <div class="card" style="background:transparent;border-style:dashed;">
      <h3 style="margin-bottom:8px;">Key info</h3>
      <div class="row spaced" style="font-size:12px;color:var(--muted);">
        <span>Project key: <code style="color:var(--text);">\${esc(detail.key)}</code></span>
        <span>Gate origin: <code style="color:var(--text);">\${esc(location.origin)}</code></span>
      </div>
    </div>
  \`;

  const renderSettingsTab = () => html\`
    <div class="card">
      <h3>Project status</h3>
      <div class="row spaced">
        <div>
          <div>\${detail.status === 'disabled' ? 'Project disabled. Reports rejected.' : 'Disable to temporarily stop accepting reports.'}</div>
          <div class="meta">Disabling keeps testers and destination intact — re-enable any time.</div>
        </div>
        <button class="ghost" onclick="toggleStatus('\${esc(detail.key)}', '\${detail.status === 'disabled' ? 'active' : 'disabled'}')">\${detail.status === 'disabled' ? 'Re-enable' : 'Disable'}</button>
      </div>
    </div>
    <div class="card" style="border-left:3px solid var(--danger);">
      <h3 style="color:#fca5a5;">Danger zone</h3>
      <div class="row spaced">
        <div>
          <div><strong>Delete this project</strong></div>
          <div class="meta">Removes the tester allowlist, destination link, and activity stats. Bug Issues already filed in GitHub or Linear are NOT touched.</div>
        </div>
        <button class="danger" onclick="deleteProject('\${esc(detail.key)}')">Delete</button>
      </div>
    </div>
  \`;

  const tabContent =
    activeTab === 'activity' ? renderActivityTab() :
    activeTab === 'testers' ? renderTestersTab() :
    activeTab === 'destination' ? renderDestinationTab() :
    activeTab === 'integration' ? renderIntegrationTab() :
    activeTab === 'settings' ? renderSettingsTab() :
    renderActivityTab();

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
          <div class="body sub-muted">This project won't accept bug reports until it has a GitHub repo destination and at least one tester.</div>
          <div class="row" style="justify-content:flex-end;margin-top:10px;">
            <button class="primary" onclick="go('#/p/\${esc(detail.key)}/configure')">Configure now →</button>
          </div>
        </div>
      \` : ''}

      \${tabBar}
      \${tabContent}
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
// v0.11.1: was a two-prompt() flow; now uses openModal() + renderRepoCombobox.
// v0.12.0: passes the surfaced accountId so the project remembers which
// connected account routes its reports.
window.changeGithubRepo = async function(key) {
  const accounts = (STATE.github && STATE.github.accounts) || [];
  if (accounts.length === 0) {
    if (confirm('No GitHub account connected. Go to Settings to add one?')) go('#/settings/github');
    return;
  }
  const body = openModal('Pick a GitHub repo');
  body.innerHTML = '<div id="ghModalCombo"></div>';
  const onPick = async (repo, accountId) => {
    if (!repo || !repo.includes('/')) return toast('Repo must be in the form "owner/repo".', 'err');
    try {
      await api('PUT', '/frontend-conqueror/projects/' + key + '/github-repo', { repo, accountId });
      body._close();
      toast('GitHub destination set to ' + repo + '.');
      navigate();
    } catch (e) { toast(e.message, 'err'); }
  };
  renderRepoCombobox(body.querySelector('#ghModalCombo'), { onPick });
};
// v0.12.0: change the account routing a project's reports without re-picking
// a repo. Shows the connected accounts in a modal; clicking one validates
// access (server side) then updates proj.githubAccountId.
window.changeGithubAccount = async function(key) {
  const accounts = (STATE.github && STATE.github.accounts) || [];
  if (accounts.length === 0) {
    if (confirm('No accounts connected. Add one in Settings?')) go('#/settings/github');
    return;
  }
  const body = openModal('Route this project through which account?');
  body.innerHTML = accounts.map((a) => (
    '<button class="palette-option" data-account="' + esc(a.id) + '" style="margin-bottom:8px;">' +
      '<span class="name">' + esc(a.label || a.username || a.id) + '</span>' +
      '<span class="desc" style="display:block;margin-top:4px;font-family:ui-monospace,Menlo,monospace;font-size:11px;">' + esc(a.id) + (a.label && a.label !== a.username ? ' · GitHub user: @' + esc(a.username || '?') : '') + '</span>' +
    '</button>'
  )).join('');
  body.querySelectorAll('button.palette-option').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const accountId = btn.getAttribute('data-account');
      try {
        await api('PUT', '/frontend-conqueror/projects/' + key + '/github-account', { accountId });
        body._close();
        toast('Account changed.');
        navigate();
      } catch (e) { toast(e.message, 'err'); }
    });
  });
};
window.switchToGithub = async function(key) {
  if (!confirm('Migrate this project to GitHub? Pick a repo next. Any bugs already filed in Linear stay there (run the migration tool to copy them over); new bugs go to GitHub.')) return;
  window.changeGithubRepo(key);
};
// v0.11.2: kept as a callable for ops scripts but no UI exposes it. Linear
// is legacy-only — there's no "switch back to Linear" path in the gate UI.
window.switchToLinear = async function(key) {
  if (!confirm('Switch this project back to Linear backend (legacy)? You\\'ll pick a Linear destination next.')) return;
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

  // v0.11.2: GitHub-only configure wizard. Two steps:
  //   1. Pick GitHub repo (skipped if already set)
  //   2. Add first tester (skipped if at least one tester exists)
  // The previous backend-chooser step is gone entirely. Legacy projects with
  // backend='linear' AND a linearProjectId already set are short-circuited
  // to the tester step (their Linear destination keeps working server-side
  // — switch them via the migration tool when ready).
  const hasGithubRepo = !!detail.githubRepo;
  const hasLegacyLinearDest = detail.backend === 'linear' && !!detail.linearProjectId;
  const hasDestination = hasGithubRepo || hasLegacyLinearDest;
  const totalSteps = 2;
  const dots = (n) => '<div class="step-dots">' +
    [1, 2].map(i => '<div class="d ' + (i < n ? 'done' : i === n ? 'on' : '') + '"></div>').join('') +
    '</div>';
  let step = hasDestination ? 2 : 1;

  function renderStep() {
    if (step === 1) {
      // GitHub repo picker. Only path for new/pending projects in v0.11.2.
      root().innerHTML = html\`
        <header><span class="brand">frontend-conqueror · gate · configuring \${esc(detail.displayName)}</span></header>
        <main>
          <div class="crumbs"><a href="#/">← Projects</a></div>
          \${dots(1)}
          <h2>Which GitHub repo?<span class="sub">Step 1 of \${totalSteps} — bugs from \${esc(detail.displayName)} will land in this repo's Issues tab, tagged <code>fc:bug</code>.</span></h2>
          <div class="card">
            <div id="ghCombo"></div>
            <div class="err" id="err" style="margin-top:6px;"></div>
          </div>
        </main>\`;
      const pickRepo = async (repo, accountId) => {
        if (!repo || !repo.includes('/')) return ($('err').textContent = 'Repo must be in the form "owner/repo".');
        try {
          await api('PUT', '/frontend-conqueror/projects/' + detail.key + '/github-repo', { repo, accountId });
          step = 2;
          renderStep();
        } catch (e) { $('err').textContent = e.message; }
      };
      renderRepoCombobox($('ghCombo'), { onPick: pickRepo });
    } else if (step === 2) {
      root().innerHTML = html\`
        <header><span class="brand">frontend-conqueror · gate · configuring \${esc(detail.displayName)}</span></header>
        <main>
          <div class="crumbs"><a href="#/">← Projects</a></div>
          \${dots(totalSteps)}
          <h2>Add your first tester<span class="sub">Step \${totalSteps} of \${totalSteps} — set an email + password. You can add more testers from the project page after.</span></h2>
          <div class="card">
            <label for="firstEmail">Email</label>
            <input id="firstEmail" type="email" placeholder="alice@example.com" autofocus>
            <label for="firstPassword">Password (min 8 chars)</label>
            <input id="firstPassword" type="text" placeholder="password">
            <div class="err" id="err"></div>
            <div class="row" style="justify-content:flex-end;margin-top:14px;gap:6px;">
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
// v0.11.3: redesigned as a tabbed layout matching the project detail page.
// Three tabs: GitHub (token mgmt), Appearance (mode colors), Security (admin
// password). Tabs are deep-linkable via #/settings/:tab.
async function renderSettings() {
  const s = STATE;

  const validTabs = ['github', 'appearance', 'security'];
  const activeTab = (ROUTE.tab && validTabs.includes(ROUTE.tab)) ? ROUTE.tab : 'github';

  // v0.12.0: state.github is now { accounts: [...] }. Warn when zero accounts.
  const ghAccounts = (s.github && s.github.accounts) || [];
  const ghWarn = ghAccounts.length === 0 ? '<span class="dot-warn"></span>' : '';
  const tabs = [
    { key: 'github', label: 'GitHub', extra: ghAccounts.length > 0 ? '<span class="count">' + ghAccounts.length + '</span>' : ghWarn },
    { key: 'appearance', label: 'Appearance' },
    { key: 'security', label: 'Security' },
  ];
  const tabBar = '<nav class="tabs" aria-label="Settings sections">' +
    tabs.map((t) => (
      '<a class="tab' + (t.key === activeTab ? ' active' : '') + '" href="#/settings/' + t.key + '">' +
        esc(t.label) + (t.extra || '') +
      '</a>'
    )).join('') +
    '</nav>';

  // v0.12.0: GitHub tab renders one card per connected account, plus an
  // "Add account" button. Zero-state preserves the existing onboarding copy.
  const renderGithubTab = () => html\`
    \${ghAccounts.length > 0 ? html\`
      <div class="sub-muted" style="margin-bottom:10px;font-size:12px;">Each project routes through one of these accounts. Add another to reach repos a single PAT can't see (e.g. across orgs, or a fine-grained PAT scoped to a different repo set).</div>
      \${ghAccounts.map((acct) => html\`
        <div class="card">
          <div class="row spaced" style="align-items:flex-start;">
            <div>
              <div class="body"><strong>\${esc(acct.label || acct.username || '?')}</strong>\${acct.label && acct.label !== acct.username ? ' <span class="sub-muted" style="font-size:11px;font-weight:normal;">— GitHub user: @' + esc(acct.username || '?') + '</span>' : ''}</div>
              <div class="meta" style="font-family:ui-monospace,Menlo,monospace;font-size:11px;">Token: <code>\${esc(acct.tokenHint || '')}…</code> · id: <code>\${esc(acct.id)}</code></div>
            </div>
            <button class="ghost" onclick="renameGithubAccount('\${esc(acct.id)}', '\${esc(acct.label || acct.username || '')}')" style="font-size:11px;padding:4px 10px;">Rename</button>
          </div>
          <div id="ghTokenReveal-\${esc(acct.id)}" style="margin-top:10px;"></div>
          <div class="row" style="justify-content:flex-end;margin-top:10px;gap:6px;">
            <button class="ghost" onclick="showGithubToken('\${esc(acct.id)}')">Show &amp; copy</button>
            <button class="danger" onclick="removeGithubToken('\${esc(acct.id)}', '\${esc(acct.label || acct.username || '')}')">Disconnect</button>
          </div>
        </div>
      \`).join('')}
      <div class="row" style="justify-content:flex-end;margin-top:6px;">
        <button class="primary" onclick="addGithubAccount()">+ Add account</button>
      </div>
    \` : html\`
      <div class="card">
        <h3>Connect GitHub</h3>
        <div class="empty">No GitHub accounts connected yet.</div>
        <div class="sub-muted" style="margin:8px 0 0;line-height:1.55;">
          <strong>Easiest:</strong> a <a href="https://github.com/settings/tokens/new?scopes=repo&description=frontend-conqueror" target="_blank" rel="noreferrer">classic PAT with <code>repo</code> scope</a> — sees every repo you can see, no org-approval dance.<br>
          <strong>More secure:</strong> a <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer">fine-grained PAT</a> with <strong>Issues: R/W</strong> + <strong>Metadata: R</strong>. For org repos: pick the org as <em>Resource Owner</em> and have an admin approve it.<br>
          Same token works on every gate. You can connect multiple accounts here if you need to reach repos across separate orgs.
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:8px;">
          <button class="primary" onclick="replaceGithubToken()">Connect GitHub</button>
        </div>
      </div>
    \`}
  \`;

  const renderAppearanceTab = () => html\`
    <div class="card">
      <h3>Mode colors</h3>
      <div class="sub-muted" style="margin-bottom:8px;">Border + palette colors for each mode in the overlay (Edit / Test / TODO).</div>
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
  \`;

  const renderSecurityTab = () => html\`
    <div class="card">
      <h3>Admin password</h3>
      <div class="sub-muted" style="margin-bottom:10px;font-size:12px;">Used to sign into this admin UI. Forgot it? Run <code>npx frontend-conqueror gate --reset-admin-password</code> on the server.</div>
      <label for="currentPw">Current password</label>
      <input id="currentPw" type="password">
      <label for="newAdminPw">New password (8+ characters)</label>
      <input id="newAdminPw" type="password">
      <div class="err" id="pwErr"></div>
      <div class="row" style="justify-content:flex-end;margin-top:10px;">
        <button class="primary" onclick="changePassword()">Change password</button>
      </div>
    </div>
  \`;

  const tabContent =
    activeTab === 'github' ? renderGithubTab() :
    activeTab === 'appearance' ? renderAppearanceTab() :
    activeTab === 'security' ? renderSecurityTab() :
    renderGithubTab();

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
      \${tabBar}
      \${tabContent}
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
// v0.12.1: Add an account. Dedups by EXACT token (re-paste = no-op); allows
// multiple accounts with the same GitHub username (e.g. fine-grained PATs
// for different repo sets), distinguished by user-supplied labels.
window.addGithubAccount = async function() {
  const token = prompt('Paste GitHub PAT — classic with "repo" scope (easiest, sees all repos) OR fine-grained with Issues: R/W + Metadata: R:');
  if (!token) return;
  const label = prompt('Label this account (helps when you have multiple PATs from the same GitHub user — e.g. "Personal", "Makers org"). Leave blank to use the GitHub username:') || '';
  try {
    const r = await api('PUT', '/frontend-conqueror/github/accounts', { token, label });
    STATE = null;
    toast('Connected as ' + (r.account ? (r.account.label || ('@' + r.account.username)) : '?') + '.');
    navigate();
  } catch (e) { toast(e.message, 'err'); }
};
// Backward-compat alias — the zero-state "Connect GitHub" button still calls
// replaceGithubToken from older HTML; keep it pointed at addGithubAccount.
window.replaceGithubToken = function() { return window.addGithubAccount(); };
// v0.12.1: rename an account in place (label only — token + username untouched).
window.renameGithubAccount = async function(accountId, currentLabel) {
  const label = prompt('Rename this account:', currentLabel || '');
  if (!label) return;
  try {
    await api('PUT', '/frontend-conqueror/github/accounts/' + encodeURIComponent(accountId), { label });
    STATE = null;
    toast('Renamed.');
    navigate();
  } catch (e) { toast(e.message, 'err'); }
};
// v0.12.0: per-account disconnect. Projects that route through the removed
// account get their githubAccountId nulled server-side.
window.removeGithubToken = async function(accountId, username) {
  if (!accountId) return;
  if (!confirm('Disconnect @' + (username || accountId) + '? Projects routing through this account will need a new account picked before they can file reports.')) return;
  try {
    await api('DELETE', '/frontend-conqueror/github/accounts/' + encodeURIComponent(accountId));
    STATE = null;
    toast('Disconnected.');
    navigate();
  } catch (e) { toast(e.message, 'err'); }
};
// v0.11.2: reveal the stored PAT inline + copy to clipboard. Admin-only path.
// v0.12.0: takes an accountId to target the right account's reveal host.
window.showGithubToken = async function(accountId) {
  const host = $('ghTokenReveal-' + accountId);
  if (!host) return;
  try {
    const r = await api('GET', '/frontend-conqueror/github/accounts/' + encodeURIComponent(accountId) + '/token');
    if (!r || !r.token) return toast('No token stored.', 'err');
    const inputId = 'ghTokenInput-' + accountId;
    const copyId = 'ghTokenCopy-' + accountId;
    const hideId = 'ghTokenHide-' + accountId;
    host.innerHTML =
      '<div class="card" style="margin:0;padding:10px 12px;background:var(--card2);">' +
        '<div class="sub-muted" style="font-size:11px;margin-bottom:4px;">Stored PAT — copy and paste into your password manager or another gate.</div>' +
        '<div class="row" style="gap:6px;">' +
          '<input id="' + inputId + '" type="text" value="' + esc(r.token) + '" readonly style="font:12px/1.2 ui-monospace,Menlo,monospace;">' +
          '<button class="primary" id="' + copyId + '">Copy</button>' +
          '<button class="ghost" id="' + hideId + '">Hide</button>' +
        '</div>' +
      '</div>';
    const inp = $(inputId);
    inp.focus();
    inp.select();
    $(copyId).addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(r.token);
        toast('Token copied to clipboard.');
      } catch {
        // Older browsers / non-secure contexts: fall back to execCommand.
        inp.select();
        document.execCommand && document.execCommand('copy');
        toast('Token copied (fallback).');
      }
    });
    const hide = () => { host.innerHTML = ''; };
    $('ghTokenHide-' + accountId).addEventListener('click', hide);
    setTimeout(hide, 20000);
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
// v0.10.1: CLI subcommands. If any are present on argv, run them and exit
// instead of starting the HTTP server. Mirrors the convention used by
// psql/discourse/gitea/nextcloud/sentry — admin-recovery operations are CLI,
// not endpoints, so they require shell access to the box rather than HTTP.
function runCliIfRequested() {
  if (process.argv.includes('--reset-admin-password')) {
    const data = loadData();
    data.adminPasswordHash = null;
    saveData(data);
    process.stderr.write(
      `[gate] admin password reset.\n` +
      `       Data file: ${DATA_FILE}\n` +
      `       Log in with the default password ('${DEFAULT_ADMIN_PASSWORD}') next,\n` +
      `       then change it from Settings.\n`
    );
    process.exit(0);
  }
}
runCliIfRequested();

http.createServer(handle).listen(PORT, HOST, () => {
  // Surface a clear "what's the default password right now" line so the
  // developer doesn't have to dig — useful in dev. Once data.adminPasswordHash
  // exists, this stops being printed and the env var is ignored.
  const initial = loadData();
  if (!initial.adminPasswordHash) {
    console.log(`[gate] no admin password set yet — default is "${DEFAULT_ADMIN_PASSWORD}" (shown on login page in dev)`);
  } else {
    console.log('[gate] custom admin password in use');
  }
  console.log(`frontend-conqueror gate listening on http://${HOST}:${PORT}`);
  console.log(`admin: http://localhost:${PORT}/frontend-conqueror`);
  console.log(`data:  ${DATA_FILE}`);
});