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
    linearProjectId: '',
    linearProjectName: '',
    linearApiKey: null,                  // per-project override
    linearTeamId: null,
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

  // v0.8.0 migration: convert per-project emails[] to users{} (with no
  // password — admin must set one). Idempotent — leaves existing users{} alone.
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
function setCookie(res, name, value, maxAgeSec) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`);
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
    linearProjectName: p.linearProjectName || '',
    hasLinearOverride: !!(p.linearApiKey || p.linearTeamId),
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
    const linCreds = projectLinear(data, proj);
    if (!linCreds.apiKey) return send(res, 503, { error: 'linear-not-configured' });
    if (!linCreds.projectId) return send(res, 503, { error: 'linear-project-not-set' });
    const title = trunc(issue.title.trim(), 200);
    const meta = issue.meta || {};
    const description = [
      `**Reported via Test Mode** by \`${payload.email}\` for project \`${proj.displayName}\``,
      '',
      issue.description ? issue.description.trim() : '',
      '',
      '---',
      meta.where ? `**Where:** \`${meta.where}\`` : '',
      meta.page ? `**Page:** ${meta.page}` : '',
      meta.locale ? `**Locale:** ${meta.locale}` : '',
      meta.text ? `**Text:** "${trunc(meta.text, 200)}"` : '',
      meta.userAgent ? `**UA:** ${meta.userAgent}` : '',
    ].filter(Boolean).join('\n');
    try {
      const created = await createLinearIssue(linCreds, { title, description });
      proj.activity = proj.activity || emptyActivity();
      proj.activity.reportsCount = (proj.activity.reportsCount || 0) + 1;
      saveData(data);
      console.log(`[gate] issue ${created.identifier || created.id} for ${proj.key} by ${payload.email}`);
      return send(res, 200, { ok: true, issue: created });
    } catch (e) {
      console.error('[gate] linear error:', e.message);
      return send(res, 502, { error: 'linear-failed', message: e.message });
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
      return send(res, 200, prelude + body, {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'public, max-age=300',
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
    setCookie(res, 'gate_admin', token, ADMIN_SESSION_TTL);
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
        saveData(data);
        return send(res, 200, { project: publicProjectDetail(proj) });
      } catch (e) {
        return send(res, 502, { error: 'linear-unreachable', message: e.message });
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
function projectCard(p) {
  const lastSeen = p.activity.lastSeenAt ? relTime(p.activity.lastSeenAt) : 'never';
  const linearDest = p.linearProjectName || (p.status === 'pending' ? '(needs configuring)' : '(not set)');
  return html\`
    <a class="project-card \${p.status}" href="#/p/\${esc(p.key)}">
      <div class="title">
        <span class="name">\${esc(p.displayName)} <span class="sub-muted" style="font-weight:normal;font-size:12px;margin-left:6px;">\${esc(p.key)}</span></span>
        <span class="pill \${p.status} dot">\${p.status}</span>
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
          <h3>Finish configuring this project</h3>
          <div class="body sub-muted">This project was auto-detected from a heartbeat or just created. It won't accept bug reports until it has a Linear destination and at least one tester email.</div>
          <div class="row" style="justify-content:flex-end;margin-top:10px;">
            <button class="primary" onclick="(()=>go('#/p/' + \${JSON.stringify(detail.key)} + '/configure'))()">Configure now →</button>
          </div>
        </div>
      \` : ''}

      <div class="card">
        <h3>Linear destination</h3>
        \${detail.linearProjectName ? html\`
          <div class="body">Reports go to: <strong>\${esc(detail.linearProjectName)}</strong></div>
          <div class="meta">Team: \${esc(STATE.linear ? STATE.linear.teamName : '')}</div>
          <div class="row" style="margin-top:10px;justify-content:flex-end;">
            <button class="ghost" onclick="changeLinearProject('\${esc(detail.key)}')">Change</button>
          </div>
        \` : html\`
          <div class="empty">Not set. <a href="#" onclick="changeLinearProject('\${esc(detail.key)}');return false;">Pick a Linear project</a></div>
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
  const lines = projects.map((p, i) => (i + 1) + ') ' + p.name).join('\\n');
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
        $('projLoad').outerHTML = html\`
          <label for="existing">Existing Linear project</label>
          <select id="existing">
            <option value="">— pick one —</option>
            \${projects.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('')}
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
        <h3>Linear API key</h3>
        \${s.linear && s.linear.hasApiKey ? html\`
          <div class="body">Connected to <strong>\${esc(s.linear.teamName || s.linear.teamId || 'a team')}</strong></div>
          <div class="meta">All projects use this key unless they override it.</div>
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
  if (!confirm('Disconnect Linear? All projects will stop accepting reports until a new key is set (or per-project override is configured).')) return;
  try {
    await api('DELETE', '/frontend-conqueror/linear');
    STATE = null;
    toast('Linear disconnected.');
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