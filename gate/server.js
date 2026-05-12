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
const DEFAULT_DATA = () => ({
  modeColors: { ...DEFAULT_MODE_COLORS },
  settings: {
    projectName: DEFAULT_PROJECT_NAME,
    emails: [],
    linear: null, // { apiKey, teamId, availableTeams, projectId, projectName }
  },
});
function loadData() {
  let data;
  try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { data = DEFAULT_DATA(); }
  // Migrate old multi-project shape if present.
  if (data.projects && !data.settings) {
    const keys = Object.keys(data.projects);
    const first = keys.length ? data.projects[keys[0]] : null;
    data.settings = {
      projectName: (first && first.name) || DEFAULT_PROJECT_NAME,
      emails: (first && first.emails) || [],
      linear: (first && first.linear) || null,
    };
    delete data.projects;
  }
  if (!data.modeColors) data.modeColors = { ...DEFAULT_MODE_COLORS };
  if (!data.settings) data.settings = DEFAULT_DATA().settings;
  return data;
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
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

// Public projection of `settings` for the admin UI. Hides the API key value
// itself (only signals presence).
function publicSettings(settings) {
  return {
    projectName: settings.projectName,
    emails: settings.emails || [],
    linear: settings.linear ? {
      hasApiKey: !!settings.linear.apiKey,
      teamId: settings.linear.teamId || '',
      availableTeams: settings.linear.availableTeams || null,
      projectId: settings.linear.projectId || '',
      projectName: settings.linear.projectName || '',
    } : null,
  };
}

// ---------- Routes ----------
async function handle(req, res) {
  const parsed = url.parse(req.url, true);
  const route = parsed.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return send(res, 204, null);

  // ----- Public (overlay) -----

  if (method === 'POST' && route === '/api/verify-email') {
    // Email enumeration / brute-force defense. Tight bucket because a valid
    // request only fires when a real tester first clicks Test mode.
    if (!rateLimit('verify-email', getClientIp(req), 10, 60_000)) return send(res, 429, { error: 'rate-limited' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    await new Promise((r) => setTimeout(r, 300));
    if (!body || !isValidEmail(body.email)) return send(res, 403, { error: 'not-allowed' });
    const data = loadData();
    const lcEmail = body.email.toLowerCase().trim();
    const allowed = (data.settings.emails || []).some((e) => e.toLowerCase().trim() === lcEmail);
    if (!allowed) return send(res, 403, { error: 'not-allowed' });
    const exp = Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS;
    const token = signToken({ email: lcEmail, exp });
    return send(res, 200, { token, expiresAt: exp, project: { name: data.settings.projectName } });
  }

  if (method === 'POST' && route === '/api/report-issue') {
    if (!rateLimit('report-issue', getClientIp(req), 20, 60_000)) return send(res, 429, { error: 'rate-limited' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const { token, issue } = body || {};
    const payload = verifyToken(token);
    if (!payload) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    const stillAllowed = (data.settings.emails || []).some((e) => e.toLowerCase().trim() === payload.email);
    if (!stillAllowed) return send(res, 401, { error: 'revoked' });
    if (!issue || typeof issue.title !== 'string' || !issue.title.trim()) {
      return send(res, 400, { error: 'missing-title' });
    }
    const title = trunc(issue.title.trim(), 200);
    const meta = issue.meta || {};
    const description = [
      `**Reported via Test Mode** by \`${payload.email}\``,
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
      const created = await createLinearIssue(data.settings.linear, { title, description });
      console.log(`[gate] issue ${created.identifier || created.id} by ${payload.email}`);
      return send(res, 200, { ok: true, issue: created });
    } catch (e) {
      console.error('[gate] linear error:', e.message);
      return send(res, 502, { error: 'linear-failed', message: e.message });
    }
  }

  if (method === 'GET' && route === '/api/mode-colors') {
    const data = loadData();
    return send(res, 200, { modeColors: data.modeColors || DEFAULT_MODE_COLORS });
  }

  // Production overlay: same overlay.js, but trimmed at runtime via the
  // injected config — only Test mode is enabled, no agent WebSocket, no
  // i18n-map endpoint expected. This is what host apps include in prod via
  // <script src="https://<gate>/overlay.js" defer>.
  if (method === 'GET' && route === '/overlay.js') {
    try {
      const body = fs.readFileSync(OVERLAY_FILE, 'utf8');
      const cfg = {
        gate: { url: PUBLIC_URL },
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
    return send(res, 200, { settings: publicSettings(data.settings), modeColors: data.modeColors });
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

  // ----- Admin: project meta + emails -----

  if (method === 'PUT' && route === '/frontend-conqueror/project') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const data = loadData();
    if (typeof body.projectName === 'string' && body.projectName.trim()) {
      data.settings.projectName = body.projectName.trim().slice(0, 80);
    }
    if (Array.isArray(body.emails)) {
      data.settings.emails = body.emails.filter(isValidEmail).map((e) => e.toLowerCase().trim()).slice(0, 500);
    }
    saveData(data);
    return send(res, 200, { settings: publicSettings(data.settings) });
  }

  // ----- Admin: Linear -----
  // The Linear setup is staged:
  //   1) PUT /linear/api-key { apiKey }      → stores key, auto-resolves teams
  //   2) PUT /linear/team    { teamId }      → picks a team (only needed if >1)
  //   3) GET /linear/projects                → list Linear projects in the chosen team
  //   4) PUT /linear/project { projectId | newName }
  //                                          → select existing or create new

  if (method === 'PUT' && route === '/frontend-conqueror/linear/api-key') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const data = loadData();
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!apiKey) return send(res, 400, { error: 'missing-api-key' });
    // Reset everything downstream — new key invalidates prior team/project state.
    data.settings.linear = { apiKey, teamId: '', availableTeams: null, projectId: '', projectName: '' };
    saveData(data);
    try {
      const teams = await fetchLinearTeams(apiKey);
      if (teams.length === 1) {
        data.settings.linear.teamId = teams[0].id;
      } else if (teams.length > 1) {
        data.settings.linear.availableTeams = teams;
      }
      saveData(data);
      return send(res, 200, { settings: publicSettings(data.settings), resolution: teams.length === 0 ? 'no-teams' : teams.length === 1 ? 'auto-team' : 'pick-team' });
    } catch (e) {
      return send(res, 502, { error: 'linear-unreachable', message: e.message });
    }
  }

  if (method === 'PUT' && route === '/frontend-conqueror/linear/team') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const data = loadData();
    if (!data.settings.linear || !data.settings.linear.apiKey) return send(res, 400, { error: 'no-api-key' });
    const teamId = typeof body.teamId === 'string' ? body.teamId.trim() : '';
    if (!teamId) return send(res, 400, { error: 'missing-team-id' });
    data.settings.linear.teamId = teamId;
    data.settings.linear.availableTeams = null;
    // Switching team invalidates the previously-chosen Linear project.
    data.settings.linear.projectId = '';
    data.settings.linear.projectName = '';
    saveData(data);
    return send(res, 200, { settings: publicSettings(data.settings) });
  }

  if (method === 'GET' && route === '/frontend-conqueror/linear/projects') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    const lin = data.settings.linear;
    if (!lin || !lin.apiKey) return send(res, 400, { error: 'no-api-key' });
    if (!lin.teamId) return send(res, 400, { error: 'no-team' });
    try {
      const projects = await fetchLinearProjectsInTeam(lin.apiKey, lin.teamId);
      return send(res, 200, { projects });
    } catch (e) {
      return send(res, 502, { error: 'linear-unreachable', message: e.message });
    }
  }

  if (method === 'PUT' && route === '/frontend-conqueror/linear/project') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid-json' }); }
    const data = loadData();
    const lin = data.settings.linear;
    if (!lin || !lin.apiKey || !lin.teamId) return send(res, 400, { error: 'team-not-set' });
    try {
      let project = null;
      if (typeof body.projectId === 'string' && body.projectId.trim()) {
        // Select an existing Linear project (resolve its name for display).
        const projects = await fetchLinearProjectsInTeam(lin.apiKey, lin.teamId);
        project = projects.find((p) => p.id === body.projectId.trim());
        if (!project) return send(res, 404, { error: 'project-not-in-team' });
      } else if (typeof body.newName === 'string' && body.newName.trim()) {
        // Create a new Linear project under the chosen team.
        project = await createLinearProject(lin.apiKey, lin.teamId, body.newName.trim());
        console.log(`[gate] created Linear project "${project.name}" (${project.id})`);
      } else {
        return send(res, 400, { error: 'missing-project' });
      }
      lin.projectId = project.id;
      lin.projectName = project.name;
      saveData(data);
      return send(res, 200, { settings: publicSettings(data.settings), project });
    } catch (e) {
      return send(res, 502, { error: 'linear-unreachable', message: e.message });
    }
  }

  if (method === 'DELETE' && route === '/frontend-conqueror/linear') {
    if (!isAdmin) return send(res, 401, { error: 'not-authorized' });
    const data = loadData();
    data.settings.linear = null;
    saveData(data);
    return send(res, 200, { settings: publicSettings(data.settings) });
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
  :root { --c-bg:#0b1220; --c-card:#111827; --c-text:#e5e7eb; --c-muted:#9ca3af; --c-accent:#2563eb; --c-danger:#dc2626; --c-ok:#059669; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; background: var(--c-bg); color: var(--c-text); min-height: 100vh; }
  header { padding: 18px 24px; border-bottom: 1px solid #1f2937; display: flex; justify-content: space-between; align-items: center; }
  header h1 { margin: 0; font-size: 14px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--c-muted); }
  header button { background: transparent; border: 1px solid #374151; color: var(--c-muted); padding: 4px 10px; border-radius: 6px; cursor: pointer; font: inherit; }
  main { max-width: 880px; margin: 0 auto; padding: 24px; }
  .card { background: var(--c-card); border: 1px solid #1f2937; border-radius: 10px; padding: 18px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 12px; font-size: 13px; color: var(--c-muted); letter-spacing: 0.05em; text-transform: uppercase; }
  .sub { font-size: 11px; color: var(--c-muted); margin-bottom: 12px; }
  label { display: block; font-size: 11px; color: var(--c-muted); margin: 8px 0 4px; text-transform: uppercase; letter-spacing: 0.05em; }
  input, select, textarea { width: 100%; background: #0b1220; border: 1px solid #374151; color: var(--c-text); padding: 8px 10px; border-radius: 6px; font: inherit; outline: none; }
  input:focus, select:focus, textarea:focus { border-color: var(--c-accent); }
  button.primary { background: var(--c-accent); color: white; border: 0; padding: 8px 14px; border-radius: 6px; cursor: pointer; font: inherit; font-weight: 600; }
  button.primary:hover { filter: brightness(1.1); }
  button.primary:disabled { opacity: 0.6; cursor: default; }
  button.ghost { background: transparent; border: 1px solid #374151; color: var(--c-muted); padding: 6px 12px; border-radius: 6px; cursor: pointer; font: inherit; }
  button.ghost:hover { background: #1f2937; }
  button.danger { background: transparent; color: var(--c-danger); border: 1px solid #4b1e22; padding: 4px 10px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 12px; }
  button.danger:hover { background: rgba(220,38,38,0.1); }
  .row { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
  .row input { flex: 1; }
  .pill { display: inline-block; background: #1f2937; color: var(--c-muted); padding: 2px 8px; border-radius: 999px; font-size: 11px; margin-inline-end: 6px; }
  .pill.ok { background: rgba(5,150,105,0.18); color: #6ee7b7; }
  .pill.warn { background: rgba(245,158,11,0.18); color: #fcd34d; }
  .empty { color: var(--c-muted); font-style: italic; }
  .err { color: #fca5a5; margin: 6px 0; font-size: 12px; min-height: 14px; }
  .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  code { background: #0b1220; padding: 2px 6px; border-radius: 4px; font: 12px/1 ui-monospace, Menlo, monospace; }
</style></head>
<body>
<div id="root"></div>
<script>
const $ = (id) => document.getElementById(id);
async function api(method, route, body) {
  const r = await fetch(route, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) { const err = new Error((json && (json.message || json.error)) || r.statusText); err.payload = json; throw err; }
  return json;
}
async function renderLogin(err) {
  // Pull login-state so we can hint the default password the FIRST time only.
  let hint = null;
  try {
    const s = await api('GET', '/frontend-conqueror/login-state');
    if (s.usingDefault) hint = s.defaultPassword;
  } catch {}
  $('root').innerHTML = \`
    <header><h1>frontend-conqueror · gate</h1></header>
    <main>
      <div class="card" style="max-width:420px;margin:60px auto;">
        <h2>admin sign in</h2>
        <label for="pw">Password</label>
        <input id="pw" type="password" autofocus>
        \${err ? '<div class="err">' + err + '</div>' : ''}
        \${hint ? '<div class="sub" style="margin-top:10px;">First time? Default password: <code>' + hint + '</code> — you\\'ll be asked to change it after sign-in.</div>' : ''}
        <div class="row" style="justify-content:flex-end;margin-top:12px;">
          <button class="primary" id="loginBtn">Sign in</button>
        </div>
      </div>
    </main>\`;
  const submit = async () => {
    try {
      const res = await api('POST', '/frontend-conqueror/login', { password: $('pw').value });
      if (res.mustChangePassword) renderForcedPasswordChange();
      else load();
    }
    catch (e) { renderLogin(e.message); }
  };
  $('loginBtn').addEventListener('click', submit);
  $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function renderForcedPasswordChange() {
  $('root').innerHTML = \`
    <header><h1>frontend-conqueror · gate</h1></header>
    <main>
      <div class="card" style="max-width:460px;margin:60px auto;">
        <h2>set your admin password</h2>
        <div class="sub">You signed in with the default password. Set a custom one to continue. Minimum 8 characters.</div>
        <label for="newPw">New password</label>
        <input id="newPw" type="password" autofocus>
        <label for="confirmPw">Confirm new password</label>
        <input id="confirmPw" type="password">
        <div class="err" id="pwErr"></div>
        <div class="row" style="justify-content:flex-end;margin-top:12px;">
          <button class="primary" id="saveBtn">Set password</button>
        </div>
      </div>
    </main>\`;
  const submit = async () => {
    const newPw = $('newPw').value;
    const conf = $('confirmPw').value;
    $('pwErr').textContent = '';
    if (newPw.length < 8) { $('pwErr').textContent = 'At least 8 characters.'; return; }
    if (newPw !== conf) { $('pwErr').textContent = 'Passwords do not match.'; return; }
    try {
      await api('PUT', '/frontend-conqueror/password', { newPassword: newPw });
      load();
    } catch (e) { $('pwErr').textContent = e.message; }
  };
  $('saveBtn').addEventListener('click', submit);
  $('confirmPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function renderState(state) {
  const s = state.settings;
  const mc = state.modeColors || { edit: '#2563eb', test: '#f59e0b', todo: '#059669' };
  const lin = s.linear;
  // Stages drive the UI: 1) no key → just show the API-key card.
  // 2) key but multi-team → pick a team. 3) team set but no Linear project →
  // pick or create. 4) fully wired → show the project (testers) card.
  const stage =
    !lin || !lin.hasApiKey ? 'need-key'
    : lin.availableTeams && lin.availableTeams.length > 1 ? 'pick-team'
    : !lin.teamId ? 'need-key'  // edge: key present but no team resolved → re-resolve
    : !lin.projectId ? 'pick-project'
    : 'ready';

  $('root').innerHTML = \`
    <header>
      <h1>frontend-conqueror · gate</h1>
      <button id="logoutBtn">Sign out</button>
    </header>
    <main>
      <div class="card">
        <h2>mode colors</h2>
        <div class="sub">Single source of truth for the badge, viewport frame, hover outline, buttons, and editor focus.</div>
        <div class="grid3">
          \${['edit','test','todo'].map((k) => \`
            <div>
              <label>\${k.toUpperCase()} mode</label>
              <div style="display:flex;gap:8px;align-items:center;">
                <input type="color" id="color_\${k}" value="\${mc[k]}" style="width:48px;height:32px;border:1px solid #374151;border-radius:6px;background:transparent;padding:0;cursor:pointer;">
                <input id="color_\${k}_hex" value="\${mc[k]}" style="flex:1;font:12px ui-monospace,Menlo,monospace;">
              </div>
            </div>\`).join('')}
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:12px;">
          <button class="primary" id="saveColorsBtn">Save colors</button>
        </div>
      </div>

      <div class="card">
        <h2>linear</h2>
        \${stage === 'need-key' ? \`
          <div class="sub">Paste a Linear API key (Settings → API → Personal API keys). The gate auto-resolves your team next.</div>
          <label>API key</label>
          <input id="apiKey" type="password" placeholder="lin_api_…" autocomplete="off">
          <div class="err" id="linErr"></div>
          <div class="row" style="justify-content:flex-end;margin-top:8px;">
            <button class="primary" id="saveApiKeyBtn">Save API key</button>
          </div>
        \` : ''}

        \${stage === 'pick-team' ? \`
          <div class="sub">Your token has access to multiple teams. Pick the one issues should land in.</div>
          <label>Team</label>
          <select id="teamSel">
            <option value="">— select —</option>
            \${lin.availableTeams.map((t) => '<option value="' + t.id + '">' + (t.name || t.key || t.id) + '</option>').join('')}
          </select>
          <div class="err" id="linErr"></div>
          <div class="row" style="justify-content:space-between;margin-top:8px;">
            <button class="ghost" id="resetLinearBtn">Reset API key</button>
            <button class="primary" id="saveTeamBtn">Continue</button>
          </div>
        \` : ''}

        \${stage === 'pick-project' ? \`
          <div class="sub">
            <span class="pill ok">API key set</span>
            <span class="pill ok">Team: <code>\${lin.teamId}</code></span>
          </div>
          <label>Pick an existing Linear project</label>
          <select id="projectSel"><option value="">— loading… —</option></select>
          <div style="margin-top:10px;border-top:1px solid #1f2937;padding-top:10px;">
            <label>…or create a new one</label>
            <div class="row">
              <input id="newProjName" placeholder="\${s.projectName} feedback">
              <button class="primary" id="createProjBtn">Create</button>
            </div>
          </div>
          <div class="err" id="linErr"></div>
          <div class="row" style="justify-content:space-between;margin-top:8px;">
            <button class="ghost" id="resetLinearBtn">Reset Linear setup</button>
            <button class="primary" id="saveProjectBtn" disabled>Use selected</button>
          </div>
        \` : ''}

        \${stage === 'ready' ? \`
          <div class="sub">
            <span class="pill ok">API key set</span>
            <span class="pill ok">Linear project: <strong>\${lin.projectName}</strong></span>
          </div>
          <div class="row" style="justify-content:flex-end;margin-top:8px;">
            <button class="ghost" id="resetLinearBtn">Disconnect Linear</button>
          </div>
        \` : ''}
      </div>

      <div class="card">
        <h2>account</h2>
        <div class="sub">Change the admin password used to sign into this gate.</div>
        <label>Current password</label>
        <input id="curPw" type="password" autocomplete="current-password">
        <label>New password (min 8 characters)</label>
        <input id="newPw2" type="password" autocomplete="new-password">
        <label>Confirm new password</label>
        <input id="confirmPw2" type="password" autocomplete="new-password">
        <div class="err" id="pwErr2"></div>
        <div class="row" style="justify-content:flex-end;margin-top:8px;">
          <button class="primary" id="changePwBtn">Change password</button>
        </div>
      </div>

      \${stage === 'ready' ? \`
      <div class="card">
        <h2>\${s.projectName}</h2>
        <div class="sub">Reports filed from this gate land in Linear → <strong>\${lin.projectName}</strong>.</div>
        <label>Project display name</label>
        <input id="projName" value="\${s.projectName}">
        <div class="row" style="justify-content:flex-end;margin-top:8px;">
          <button class="primary" id="saveProjNameBtn">Save name</button>
        </div>

        <div style="margin-top:16px;border-top:1px solid #1f2937;padding-top:14px;">
          <label>Allowed tester emails</label>
          <div id="emails"></div>
          <div class="row">
            <input id="newEmail" placeholder="tester@example.com">
            <button class="primary" id="addEmailBtn">Add</button>
          </div>
        </div>
      </div>\` : ''}
    </main>\`;

  $('logoutBtn').addEventListener('click', async () => { await api('POST', '/frontend-conqueror/logout'); load(); });

  // ----- Mode colors -----
  for (const k of ['edit', 'test', 'todo']) {
    const pick = $('color_' + k);
    const hex = $('color_' + k + '_hex');
    pick.addEventListener('input', () => { hex.value = pick.value; });
    hex.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(hex.value.trim())) pick.value = hex.value.trim(); });
  }
  $('saveColorsBtn').addEventListener('click', async () => {
    const payload = {
      edit: $('color_edit_hex').value.trim() || $('color_edit').value,
      test: $('color_test_hex').value.trim() || $('color_test').value,
      todo: $('color_todo_hex').value.trim() || $('color_todo').value,
    };
    try { await api('PUT', '/frontend-conqueror/mode-colors', payload); load(); }
    catch (e) { alert(e.message); }
  });

  // ----- Account (change password) -----
  $('changePwBtn').addEventListener('click', async () => {
    const cur = $('curPw').value;
    const nw  = $('newPw2').value;
    const cf  = $('confirmPw2').value;
    $('pwErr2').textContent = '';
    if (nw.length < 8) { $('pwErr2').textContent = 'At least 8 characters.'; return; }
    if (nw !== cf) { $('pwErr2').textContent = 'Passwords do not match.'; return; }
    try {
      await api('PUT', '/frontend-conqueror/password', { currentPassword: cur, newPassword: nw });
      $('curPw').value = $('newPw2').value = $('confirmPw2').value = '';
      $('pwErr2').textContent = 'Password updated.';
      $('pwErr2').style.color = '#6ee7b7';
    } catch (e) { $('pwErr2').style.color = ''; $('pwErr2').textContent = e.message; }
  });

  // ----- Stage handlers -----
  if (stage === 'need-key') {
    const submit = async () => {
      const apiKey = $('apiKey').value.trim();
      if (!apiKey) { $('linErr').textContent = 'Enter the API key.'; return; }
      $('saveApiKeyBtn').disabled = true;
      try { await api('PUT', '/frontend-conqueror/linear/api-key', { apiKey }); load(); }
      catch (e) { $('linErr').textContent = e.message; $('saveApiKeyBtn').disabled = false; }
    };
    $('saveApiKeyBtn').addEventListener('click', submit);
    $('apiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }

  if (stage === 'pick-team') {
    $('saveTeamBtn').addEventListener('click', async () => {
      const teamId = $('teamSel').value;
      if (!teamId) { $('linErr').textContent = 'Pick a team.'; return; }
      try { await api('PUT', '/frontend-conqueror/linear/team', { teamId }); load(); }
      catch (e) { $('linErr').textContent = e.message; }
    });
    $('resetLinearBtn').addEventListener('click', resetLinear);
  }

  if (stage === 'pick-project') {
    // Load list lazily after the card renders.
    (async () => {
      try {
        const r = await api('GET', '/frontend-conqueror/linear/projects');
        const sel = $('projectSel');
        sel.innerHTML = '<option value="">— select —</option>' +
          r.projects.map((p) => '<option value="' + p.id + '">' + p.name + '</option>').join('');
        sel.addEventListener('change', () => { $('saveProjectBtn').disabled = !sel.value; });
      } catch (e) {
        $('linErr').textContent = e.message;
      }
    })();
    $('saveProjectBtn').addEventListener('click', async () => {
      const projectId = $('projectSel').value;
      try { await api('PUT', '/frontend-conqueror/linear/project', { projectId }); load(); }
      catch (e) { $('linErr').textContent = e.message; }
    });
    $('createProjBtn').addEventListener('click', async () => {
      const newName = $('newProjName').value.trim();
      if (!newName) { $('linErr').textContent = 'Enter a project name.'; return; }
      try { await api('PUT', '/frontend-conqueror/linear/project', { newName }); load(); }
      catch (e) { $('linErr').textContent = e.message; }
    });
    $('resetLinearBtn').addEventListener('click', resetLinear);
  }

  if (stage === 'ready') {
    $('resetLinearBtn').addEventListener('click', resetLinear);
    $('saveProjNameBtn').addEventListener('click', async () => {
      const projectName = $('projName').value.trim();
      try { await api('PUT', '/frontend-conqueror/project', { projectName }); load(); }
      catch (e) { alert(e.message); }
    });
    // Emails
    const root = $('emails');
    if (!s.emails.length) root.innerHTML = '<div class="empty">No testers yet.</div>';
    else {
      for (const email of s.emails) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = '<div style="flex:1;">' + email + '</div><button class="danger">Remove</button>';
        row.querySelector('button').addEventListener('click', async () => {
          const remaining = s.emails.filter((e) => e !== email);
          try { await api('PUT', '/frontend-conqueror/project', { emails: remaining }); load(); }
          catch (e) { alert(e.message); }
        });
        root.appendChild(row);
      }
    }
    $('addEmailBtn').addEventListener('click', async () => {
      const newEmail = $('newEmail').value.trim();
      if (!newEmail) return;
      const next = Array.from(new Set([...s.emails, newEmail]));
      try { await api('PUT', '/frontend-conqueror/project', { emails: next }); load(); }
      catch (e) { alert(e.message); }
    });
  }
}
async function resetLinear() {
  if (!confirm('Disconnect Linear? You\\'ll need to re-enter the API key.')) return;
  try { await api('DELETE', '/frontend-conqueror/linear'); load(); }
  catch (e) { alert(e.message); }
}
async function load() {
  try {
    const state = await api('GET', '/frontend-conqueror/state');
    renderState(state);
  } catch (e) {
    renderLogin();
  }
}
load();
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