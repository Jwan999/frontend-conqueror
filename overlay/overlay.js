(function () {
  if (window.__frontendConquerorLoaded) return;
  window.__frontendConquerorLoaded = true;

  // Config is injected by the Vite plugin via <script> before this file loads;
  // falls back to sensible defaults so the overlay still works if dropped into a
  // project without the plugin.
  const CFG = Object.assign(
    {
      wsUrl: 'ws://localhost:54321',
      mapUrl: '/__frontend-conqueror/map.json',
      locales: [],
      gate: null,
      // Which modes are reachable in this environment. Dev defaults to all
      // three; prod (overlay served by the gate) trims this to ['test'].
      enabledModes: ['edit', 'todo', 'test'],
    },
    (window.__frontendConquerorConfig || {})
  );
  const WS_URL = CFG.wsUrl;
  const MAP_URL = CFG.mapUrl;
  const GATE = CFG.gate; // { url, project? } | null — required for Test mode
  const ENABLED = new Set(Array.isArray(CFG.enabledModes) ? CFG.enabledModes : ['edit', 'todo', 'test']);
  const HOST_ID = '__frontend-conqueror-host';

  // ---------- Gate session helpers (Test mode) ----------
  // Tokens are namespaced by (gate URL, project) since one gate can serve
  // multiple projects and each project has its own allowlist.
  function gateProject() { return (GATE && GATE.project) || ''; }
  function gateStorageKey() {
    return GATE ? `__fc_jwt:${GATE.url}:${gateProject()}` : null;
  }
  function getStoredGateToken() {
    if (!GATE) return null;
    try {
      const raw = sessionStorage.getItem(gateStorageKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed.token || !parsed.expiresAt) return null;
      if (Date.now() / 1000 > parsed.expiresAt - 30) return null;
      return parsed;
    } catch { return null; }
  }
  function storeGateToken(token, expiresAt, email) {
    if (!GATE) return;
    try { sessionStorage.setItem(gateStorageKey(), JSON.stringify({ token, expiresAt, email })); } catch {}
  }
  function clearGateToken() {
    if (!GATE) return;
    try { sessionStorage.removeItem(gateStorageKey()); } catch {}
  }
  // v0.8.0: email + password login. Gate intentionally collapses every failure
  // (no such user, wrong password, lockout, missing password, disabled project)
  // into a single `invalid-credentials` error so callers can't enumerate.
  // 429 surfaces separately as rate-limit feedback.
  async function gateLogin(email, password) {
    let r;
    try {
      r = await fetch(`${GATE.url}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, project: gateProject() || undefined }),
      });
    } catch (e) {
      return { ok: false, status: 0, error: 'network' };
    }
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) return { ok: false, status: r.status, error: (data && data.error) || 'invalid-credentials' };
    return { ok: true, ...data };
  }
  async function gateReportIssue(token, issue) {
    const r = await fetch(`${GATE.url}/api/report-issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, issue }),
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { ok: r.ok, status: r.status, data };
  }
  // v0.9.0: list open Linear issues filed against the current page so the
  // overlay can render bubbles. Bearer auth — keeps the report-issue body
  // shape unchanged (which still uses body-token for back-compat).
  async function gateListIssues(token, page) {
    const r = await fetch(`${GATE.url}/api/issues?page=${encodeURIComponent(page)}`, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!r.ok) return { ok: false, status: r.status, issues: [] };
    const data = await r.json().catch(() => null);
    return { ok: true, issues: (data && data.issues) || [] };
  }
  async function gateUpdateIssue(token, id, body) {
    const r = await fetch(`${GATE.url}/api/issues/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) return { ok: false, error: (data && (data.message || data.error)) || 'update-failed', status: r.status };
    return { ok: true, issue: data && data.issue };
  }
  // v0.9.4: soft-delete (Linear's issueDelete — 30-day trash, admin-recoverable).
  async function gateDeleteIssue(token, id) {
    const r = await fetch(`${GATE.url}/api/issues/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) return { ok: false, error: (data && (data.message || data.error)) || 'delete-failed', status: r.status };
    return { ok: true };
  }

  // ---------- Heartbeat ----------
  // Lets the gate auto-discover this project and surface activity to the admin.
  // Fired on load and every 5 minutes while the page stays open.
  // No-op (and fail-silent) when no gate or no project key configured.
  // v0.10.6: when the gate responds with `pending: true` AND this is a
  // brand-new pending registration (justCreated), surface a one-time toast
  // pointing the dev at the admin UI. Throttled via sessionStorage so a
  // page reload doesn't re-fire — the gate's auto-registration is
  // idempotent but the message would be confusing on subsequent loads.
  function gateHeartbeat() {
    if (!GATE || !GATE.url || !gateProject()) return;
    try {
      fetch(`${GATE.url}/api/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: gateProject(),
          origin: location.origin,
          url: location.href.slice(0, 300),
        }),
        keepalive: true,
      })
        .then((r) => r.ok ? r.json().catch(() => null) : null)
        .then((data) => { if (data && data.justCreated) fcMaybeHintPendingProject(); })
        .catch(() => {});
    } catch {}
  }
  function fcMaybeHintPendingProject() {
    const key = '__fc_pending_hinted:' + GATE.url + ':' + gateProject();
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { /* private mode etc — better to spam than crash */ }
    setTimeout(() => {
      toast(
        "First time this project (\"" + gateProject() + "\") has been seen by the gate — open admin to configure",
        'info'
      );
    }, 1200);
  }

  // Multi-mode state. Mutually exclusive: only one mode is active at a time.
  // Color defaults; overridden by the gate's /api/mode-colors at startup so
  // the developer can theme all three modes from one place (the admin UI).
  function hexToGlow(hex, alpha = 0.45) {
    const m = String(hex || '').match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (!m) return `rgba(37, 99, 235, ${alpha})`;
    return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
  }
  const MODES = {
    edit: { label: 'EDIT MODE', color: '#2563eb', glow: hexToGlow('#2563eb') },
    test: { label: 'TEST MODE', color: '#f59e0b', glow: hexToGlow('#f59e0b') },
    todo: { label: 'TODO MODE', color: '#059669', glow: hexToGlow('#059669') },
  };
  function applyModeColorsFromGate(modeColors) {
    if (!modeColors || typeof modeColors !== 'object') return;
    for (const k of ['edit', 'test', 'todo']) {
      if (typeof modeColors[k] === 'string' && /^#[0-9a-fA-F]{6}$/.test(modeColors[k])) {
        MODES[k].color = modeColors[k];
        MODES[k].glow = hexToGlow(modeColors[k]);
      }
    }
    // If a mode is currently active, re-apply on the host so the change is visible
    // immediately without needing to re-toggle.
    if (activeMode) applyModeColor(activeMode);
  }
  // Fire-and-forget: the rest of the overlay works fine with defaults if this
  // fails (no gate, offline, etc.). When it resolves, current colors update live.
  // v0.10.4: on network failure during *dev* (localhost gate), show a one-time
  // toast pointing at the CLI command. Pre-v0.10.4 the failure was silent and
  // first-time integrators saw nothing in the UI — they had to open devtools
  // to discover the gate wasn't running.
  let fcGateUnreachableHinted = false;
  function fcMaybeWarnGateUnreachable() {
    if (fcGateUnreachableHinted) return;
    fcGateUnreachableHinted = true;
    const isLocal = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])/i.test(GATE.url);
    // Defer so toast() definition has executed and so the toast actually
    // renders after the page has finished setting up.
    setTimeout(() => {
      if (isLocal) toast('Gate not running at ' + GATE.url + ' — run `npx frontend-conqueror gate`', 'error');
      else toast("Can't reach gate at " + GATE.url, 'error');
    }, 800);
  }
  if (GATE && GATE.url) {
    fetch(GATE.url + '/api/mode-colors', { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (j) applyModeColorsFromGate(j.modeColors); })
      .catch(fcMaybeWarnGateUnreachable);
    // Heartbeat: announce ourselves on load, then every 5 minutes while the
    // page stays open. Lets the gate's admin see this project + page activity.
    gateHeartbeat();
    setInterval(gateHeartbeat, 5 * 60 * 1000);
  }
  let activeMode = null;  // null | 'edit' | 'test' | 'todo'
  // Convenience: anywhere we previously checked `editMode`, we now check `activeMode === 'edit'`.
  // Kept the same name pattern via a getter so downstream code reads naturally.
  function inEditMode() { return activeMode === 'edit'; }
  let ws = null;
  let connected = false;
  let reconnectTimer = null;

  let currentTarget = null;
  let editingTarget = null;
  let pendingId = 0;
  const pending = new Map();

  // ---------- Shadow DOM ----------
  const host = document.createElement('div');
  host.id = HOST_ID;
  // Lock the overlay UI to LTR + English — the host site might be RTL
  // (Arabic / Hebrew / Persian / Urdu), but the plugin's chrome stays in a
  // fixed orientation so all developers see the same layout regardless of
  // which site they're inspecting. Per-locale RTL still applies inside the
  // multi-locale editor's individual translation textareas.
  host.dir = 'ltr';
  host.lang = 'en';
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;direction:ltr;text-align:left;';
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host, * { box-sizing: border-box; }
    :host {
      /* Lock direction at the shadow root — without this, RTL inheritance
         from the host page mirrors the entire overlay UI. */
      direction: ltr;
      text-align: left;
      unicode-bidi: isolate;
      /* Single source of truth for the active mode color. Future modes will
         only need to swap --mode-color on the host. */
      --mode-color: #2563eb;
      --mode-color-glow: rgba(37, 99, 235, 0.45);
    }
    .frame {
      position: fixed; inset: 0;
      pointer-events: none;
      box-shadow: inset 0 0 0 7px var(--mode-color),
                  inset 0 0 36px var(--mode-color-glow);
      z-index: 2147483646;
    }
    .indicator {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      padding: 6px 14px;
      background: var(--mode-color); color: #fff;
      font: 700 11px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      letter-spacing: 0.12em;
      border-radius: 999px; box-shadow: 0 6px 18px var(--mode-color-glow);
      animation: pulse 1.6s ease-in-out infinite;
      pointer-events: none; user-select: none;
      z-index: 2147483647;
    }
    .indicator.disconnected { background: #6b7280; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: translateX(-50%) scale(1); }
      50%      { opacity: 0.82; transform: translateX(-50%) scale(0.97); }
    }
    .outline {
      position: fixed; pointer-events: none;
      border: 1.5px dashed var(--mode-color); border-radius: 3px;
    }
    .bubble {
      position: fixed; padding: 4px 10px;
      background: var(--mode-color); color: #fff;
      font: 700 10px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      letter-spacing: 0.08em;
      border-radius: 4px; cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      user-select: none;
    }
    .bubble:hover { filter: brightness(0.9); }
    .choice-picker {
      position: fixed;
      display: flex; gap: 4px;
      padding: 4px;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      font: 600 12px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      z-index: 2147483647;
      animation: pickerIn 120ms ease-out;
    }
    .choice-picker button {
      border: 0; padding: 6px 10px; border-radius: 6px;
      cursor: pointer; background: transparent; color: #111827;
      font: inherit;
      display: inline-flex; align-items: center; gap: 6px;
    }
    .choice-picker button:hover { background: #f3f4f6; }
    .choice-picker .picker-edit { color: #fff; background: var(--mode-color); }
    .choice-picker .picker-edit:hover { filter: brightness(0.9); background: var(--mode-color); }
    .choice-picker .picker-hint {
      font-size: 10px; color: #9ca3af; padding: 0 6px;
      align-self: center; border-inline-start: 1px solid #e5e7eb;
    }
    @keyframes pickerIn {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .palette-backdrop {
      position: fixed; inset: 0;
      background: rgba(17, 24, 39, 0.55);
      backdrop-filter: blur(2px);
      z-index: 2147483647;
      animation: fadeIn 140ms ease-out;
    }
    .palette {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 360px;
      background: #fff;
      border-radius: 12px;
      padding: 8px;
      box-shadow: 0 30px 80px rgba(0,0,0,0.4);
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: #111827;
    }
    .palette-title {
      font-size: 11px; color: #6b7280;
      padding: 8px 10px 6px; letter-spacing: 0.06em; text-transform: uppercase;
    }
    .palette-option {
      display: flex; align-items: center; gap: 10px;
      width: 100%;
      padding: 10px 12px; border-radius: 8px;
      background: transparent; border: 0; cursor: pointer;
      font: inherit; color: inherit; text-align: start;
    }
    .palette-option:hover, .palette-option.focused {
      background: #f3f4f6;
    }
    .palette-option .dot {
      width: 10px; height: 10px; border-radius: 50%;
      flex: 0 0 auto;
    }
    .palette-option .name { font-weight: 600; flex: 1; }
    .palette-option .desc { font-size: 11px; color: #6b7280; }
    .palette-option .kbd {
      font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #6b7280;
      padding: 2px 6px; border: 1px solid #e5e7eb; border-radius: 4px;
    }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .panel {
      position: fixed; background: #fff;
      border: 1px solid #e5e7eb; border-radius: 8px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.25);
      padding: 12px; width: 360px;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: #111827;
    }
    .panel textarea {
      width: 100%; min-height: 64px; max-height: 240px;
      resize: vertical;
      border: 1px solid #d1d5db; border-radius: 6px;
      padding: 8px;
      font: inherit; color: inherit;
      outline: none;
    }
    .panel textarea:focus {
      border-color: var(--mode-color);
      box-shadow: 0 0 0 3px var(--mode-color-glow);
    }
    .panel .row {
      display: flex; gap: 6px; margin-top: 8px;
      justify-content: flex-end; align-items: center;
    }
    .panel .hint { flex: 1; font-size: 11px; color: #6b7280; }
    .panel .chips {
      display: flex; flex-wrap: wrap; gap: 4px;
      margin-bottom: 8px; padding-bottom: 8px;
      border-bottom: 1px solid #f3f4f6;
    }
    .panel .chips-label {
      width: 100%; font-size: 11px; color: #6b7280; margin-bottom: 2px;
    }
    .panel .chip {
      background: #f3f4f6; color: #111827;
      border: 1px solid #e5e7eb; border-radius: 999px;
      padding: 3px 8px; font: 500 11px/1.2 inherit;
      cursor: pointer; max-width: 240px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      direction: ltr; unicode-bidi: plaintext;
    }
    .panel .chip:hover { background: #e5e7eb; }
    .panel .chip-active { background: var(--mode-color); color: #fff; border-color: var(--mode-color); }
    .panel .chip-loc { color: #9ca3af; font-size: 10px; margin-inline-start: 4px; }
    .panel .panel-title {
      font: 700 11px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: var(--mode-color); letter-spacing: 0.08em;
      margin: 0 0 8px; text-transform: uppercase;
    }
    .panel .multi-header {
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid #f0f0f0;
    }
    .panel .multi-title {
      font: 700 11px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: var(--mode-color); letter-spacing: 0.08em;
      text-transform: uppercase; margin-bottom: 4px;
    }
    .panel .multi-path {
      font: 12px/1 ui-monospace, Menlo, monospace;
      color: #6b7280; word-break: break-all;
    }
    .panel .multi-field {
      margin-bottom: 10px;
    }
    .panel .multi-field label {
      display: block;
      font: 600 10px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: #6b7280; letter-spacing: 0.06em; text-transform: uppercase;
      margin-bottom: 4px;
    }
    .panel .multi-field textarea {
      width: 100%; min-height: 36px;
      padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 6px;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: #111827; background: #fafafa;
      resize: vertical; outline: none;
    }
    .panel .multi-field textarea:focus {
      border-color: var(--mode-color); background: #fff;
    }
    .panel .picker-intro {
      font-size: 12px; color: #6b7280;
      margin-bottom: 10px;
    }
    .panel .picker-intro strong {
      color: #111827; font-weight: 600;
    }
    .panel .picker-list {
      max-height: 280px; overflow-y: auto;
      border: 1px solid #f0f0f0; border-radius: 6px;
    }
    .panel .picker-row {
      display: block;
      width: 100%;
      text-align: start;
      padding: 10px 12px;
      background: transparent;
      border: 0;
      border-bottom: 1px solid #f0f0f0;
      cursor: pointer;
      font: inherit;
      transition: background-color 0.08s;
    }
    .panel .picker-row:last-child { border-bottom: 0; }
    .panel .picker-row:hover { background: #f9fafb; }
    .panel .picker-row:focus { outline: none; background: #f3f4f6; }
    .panel .picker-path {
      font: 12px/1.3 ui-monospace, Menlo, monospace;
      color: var(--mode-color);
      margin-bottom: 3px;
    }
    .panel .picker-file {
      font: 10px/1.3 ui-monospace, Menlo, monospace;
      color: #9ca3af;
    }
    .panel .picker-value {
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: #374151;
      margin-top: 4px;
      max-height: 36px; overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .panel .picker-recommended {
      font: 9px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: var(--mode-color);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-inline-start: 6px;
      font-weight: 600;
    }
    .panel .panel-sub {
      font-size: 11px; color: #6b7280; margin: -4px 0 8px;
    }
    .panel .todo-linear {
      display: flex; gap: 6px; align-items: center;
      margin-top: 8px; font-size: 11px; color: #6b7280;
    }
    .panel .todo-linear input {
      flex: 1; border: 1px solid #d1d5db; border-radius: 4px;
      padding: 4px 6px; font: 12px/1.2 inherit; color: #111827;
      outline: none;
    }
    .panel .todo-linear input:focus {
      border-color: var(--mode-color);
      box-shadow: 0 0 0 2px var(--mode-color-glow);
    }
    .panel button {
      border: 0; padding: 6px 12px; border-radius: 6px;
      font: 600 12px/1 inherit; cursor: pointer;
    }
    .panel button[disabled] { opacity: 0.6; cursor: default; }
    .panel .save { background: var(--mode-color); color: #fff; }
    .panel .save:hover:not([disabled]) { filter: brightness(0.9); }
    .panel .cancel { background: #f3f4f6; color: #111827; }
    .panel .cancel:hover { background: #e5e7eb; }
    .toast {
      position: fixed; bottom: 16px; right: 16px;
      padding: 10px 14px; border-radius: 8px;
      background: #111827; color: #fff;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      max-width: 380px;
      white-space: pre-wrap;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      animation: slideIn 200ms ease-out;
    }
    .toast.success { background: #059669; }
    .toast.error { background: #dc2626; }
    @keyframes slideIn {
      from { transform: translateY(10px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    /* v0.9.0: report-bubble feature. Persistent dot anchored to each element
       with one or more open Linear issues. Click → list panel.
       Intentionally NO z-index on .fc-bubble-host — keep it at the default so
       any panel opened later (test-report .panel, login prompt, edit popup)
       paints on top via normal document stacking order. The shadow root host
       is already z-index 2147483647 on the page, so even default-z children
       float above page content. */
    .fc-bubble-host {
      position: absolute; top: 0; left: 0;
      width: 0; height: 0;
      pointer-events: none;
    }
    .fc-bubble {
      position: absolute;
      display: inline-flex; align-items: center; gap: 3px;
      height: 22px; padding: 0 8px;
      border-radius: 999px;
      background: var(--mode-color); color: #fff;
      font: 700 11px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      cursor: pointer;
      pointer-events: auto;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3), 0 0 0 2px rgba(255,255,255,0.95);
      transition: transform 0.1s;
      user-select: none;
    }
    .fc-bubble:hover { transform: scale(1.12); }
    .fc-bubble-icon { width: 11px; height: 11px; flex: 0 0 auto; }
    .fc-bubble-count { font: inherit; }
    .fc-bubble-panel {
      position: absolute;
      max-height: 70vh; overflow-y: auto;
      width: 320px;
    }
    .fc-issue-row {
      padding: 8px 0;
      border-bottom: 1px solid #f3f4f6;
    }
    .fc-issue-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .fc-issue-row:first-child { padding-top: 0; }
    .fc-issue-meta { font-size: 11px; color: #6b7280; margin-bottom: 4px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .fc-issue-meta a { color: var(--mode-color); text-decoration: none; font-weight: 600; }
    .fc-issue-meta a:hover { text-decoration: underline; }
    .fc-issue-meta .fc-state-pill {
      display: inline-block; padding: 1px 7px; border-radius: 999px;
      background: #f3f4f6; color: #6b7280; font-size: 10px;
    }
    .fc-issue-title { font-weight: 600; color: #111827; margin-bottom: 4px; }
    .fc-issue-note { color: #374151; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .fc-issue-edit-btn {
      font: 600 11px/1 inherit;
      padding: 4px 10px; border-radius: 4px; border: 0;
      background: #f3f4f6; color: #111827; cursor: pointer;
    }
    .fc-issue-edit-btn:hover { background: #e5e7eb; }
    .fc-issue-delete-btn {
      font: 600 11px/1 inherit;
      padding: 4px 10px; border-radius: 4px;
      background: transparent; color: #dc2626;
      border: 1px solid #fecaca;
      cursor: pointer;
    }
    .fc-issue-delete-btn:hover { background: rgba(220, 38, 38, 0.08); border-color: #fca5a5; }
    .fc-bubble-footer {
      margin-top: 10px; padding-top: 8px;
      border-top: 1px solid #f3f4f6;
      font-size: 11px; color: #6b7280;
    }
    .fc-bubble-footer strong { color: #111827; font-weight: 600; }
    .fc-bubble-footer a { color: var(--mode-color); text-decoration: none; font-weight: 600; }
    .fc-bubble-footer a:hover { text-decoration: underline; }
    /* Red "primary" button used by fcConfirm({ danger: true }) so destructive
       prompts read as destructive at a glance. */
    .fc-confirm-danger {
      background: #dc2626; color: #fff;
      border: 0; padding: 6px 14px; border-radius: 6px;
      font: 600 12px/1 inherit; cursor: pointer;
    }
    .fc-confirm-danger:hover { background: #b91c1c; }
    .fc-confirm-danger:focus { outline: 2px solid #fecaca; outline-offset: 2px; }
    .fc-edit-input {
      width: 100%; padding: 6px 8px; margin-bottom: 6px;
      border: 1px solid #d1d5db; border-radius: 4px;
      font: inherit; color: inherit;
      outline: none;
    }
    .fc-edit-input:focus { border-color: var(--mode-color); box-shadow: 0 0 0 2px var(--mode-color-glow); }
    .fc-edit-textarea {
      width: 100%; min-height: 56px; resize: vertical;
      padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 4px;
      font: inherit; color: inherit; outline: none;
    }
    .fc-edit-textarea:focus { border-color: var(--mode-color); box-shadow: 0 0 0 2px var(--mode-color-glow); }
    .fc-edit-actions {
      display: flex; gap: 6px; justify-content: flex-end; align-items: center;
      margin-top: 6px;
    }
    .fc-edit-actions .fc-edit-err {
      flex: 1; color: #dc2626; font-size: 11px; min-height: 14px;
    }
  `;
  shadow.appendChild(style);

  const frame = document.createElement('div');
  frame.className = 'frame';

  const indicator = document.createElement('div');
  indicator.className = 'indicator';

  const outline = document.createElement('div');
  outline.className = 'outline';
  outline.style.display = 'none';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = 'EDIT';
  bubble.style.display = 'none';

  shadow.appendChild(outline);
  shadow.appendChild(bubble);

  document.documentElement.appendChild(host);

  function updateIndicator() {
    // v0.9.7: stop hardcoding "EDIT MODE" — drive from MODES[activeMode].label
    // so Test and Todo modes show the right label. Test mode also surfaces
    // the open-issue count so "are bubbles working?" is answered at a glance.
    const m = MODES[activeMode];
    if (!m) return;
    let label = m.label;
    if (activeMode === 'edit' && !connected) label += ' (offline)';
    if (activeMode === 'test' && fcBubbles.length > 0) {
      const total = fcBubbles.reduce((s, b) => s + b.group.issues.length, 0);
      label += ' · ' + total + ' open';
    }
    indicator.textContent = label;
    indicator.classList.toggle('disconnected', activeMode === 'edit' && !connected);
  }

  function toast(message, kind = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = message;
    shadow.appendChild(t);
    setTimeout(() => t.remove(), 3600);
  }

  // ---------- WebSocket ----------
  function connect() {
    let socket;
    try {
      socket = new WebSocket(WS_URL);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.addEventListener('open', () => {
      connected = true;
       if (activeMode) updateIndicator();
    });
    socket.addEventListener('close', () => {
      connected = false;
      if (ws === socket) ws = null;
      if (activeMode) updateIndicator();
      scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      try { socket.close(); } catch {}
    });
    socket.addEventListener('message', (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      handleAgentMessage(data);
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1500);
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  function handleAgentMessage(data) {
    const cb = data.id != null ? pending.get(data.id) : null;
    if (cb) pending.delete(data.id);

    if (data.type === 'applied') {
      toast(`Saved → ${data.file}`, 'success');
      invalidateI18nMap();
      if (cb) cb(null, data);
    } else if (data.type === 'rejected') {
      let detail = data.message || 'Edit rejected';
      if (data.reason === 'ambiguous' && Array.isArray(data.files)) {
        detail += '\n' + data.files.map((f) => `• ${f.path} (${f.occurrences}×)`).join('\n');
      }
      toast(detail, 'error');
      if (cb) cb(new Error(data.message || 'rejected'));
    } else if (data.type === 'noop') {
      toast(data.message || 'No change', 'info');
      if (cb) cb(null, data);
    } else if (data.type === 'error') {
      toast('Error: ' + (data.message || 'unknown'), 'error');
      if (cb) cb(new Error(data.message || 'error'));
    }
  }

  // Agent WS is only needed by the dev-side modes. In production (Test-only)
  // we don't try to connect — there's no agent reachable anyway and the
  // reconnect loop would just spam errors.
  if (ENABLED.has('edit') || ENABLED.has('todo')) connect();

  // ---------- Hit testing ----------
  function isInsideHost(el) {
    if (!el) return false;
    if (el === host) return true;
    let node = el;
    while (node) {
      if (node.id === HOST_ID) return true;
      node = node.parentElement;
    }
    return false;
  }

  function isEditableHost(el) {
    if (!el || el.nodeType !== 1) return false;
    if (isInsideHost(el)) return false;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'HTML' || tag === 'BODY') return false;
    if (el.isContentEditable) return false;
    return true;
  }

  function textNodeRect(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect();
  }

  function findTextNodeAtPoint(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) {
        range = document.createRange();
        try { range.setStart(pos.offsetNode, pos.offset); } catch { range = null; }
      }
    }
    if (!range) return null;
    const node = range.startContainer;
    if (!node || node.nodeType !== 3) return null;
    if (!node.nodeValue || !node.nodeValue.trim()) return null;
    if (!isEditableHost(node.parentElement)) return null;
    if (isInsideHost(node.parentElement)) return null;
    return node;
  }

  function rectForTarget(t) {
    if (!t) return null;
    if (t.nodeType === 3) {
      const r = textNodeRect(t);
      if (!r || (r.width === 0 && r.height === 0)) {
        return t.parentElement && t.parentElement.getBoundingClientRect();
      }
      return r;
    }
    return t.getBoundingClientRect();
  }

  function positionOverlays(target) {
    const r = rectForTarget(target);
    if (!r) { outline.style.display = 'none'; bubble.style.display = 'none'; return; }
    outline.style.display = 'block';
    outline.style.top = r.top - 2 + 'px';
    outline.style.left = r.left - 2 + 'px';
    outline.style.width = r.width + 4 + 'px';
    outline.style.height = r.height + 4 + 'px';
    if (!editingTarget) {
      bubble.style.display = 'block';
      bubble.style.top = Math.max(0, r.top - 22) + 'px';
      bubble.style.left = r.left + 'px';
    }
  }

  function setTarget(target) {
    if (target === currentTarget) return;
    currentTarget = target;
    if (!target) {
      outline.style.display = 'none';
      bubble.style.display = 'none';
      return;
    }
    positionOverlays(target);
  }

  // Test + Dev TODO modes hover the whole *component*, not the text node — walk
  // up from the cursor to the nearest element carrying data-edit-source (which
  // the plugin emits on every real template element). If none is found (e.g.
  // an element coming from a third-party component or rendered by host-side
  // JavaScript), fall back to the deepest element under the cursor so hovering
  // still shows a highlight — the panel can decide what to do without a source
  // location.
  function findComponentAtPoint(x, y) {
    const root = document.elementFromPoint(x, y);
    if (!root || isInsideHost(root) || !isEditableHost(root)) return null;
    let el = root;
    while (el && el.nodeType === 1) {
      if (el.getAttribute && el.getAttribute('data-edit-source')) return el;
      el = el.parentElement;
    }
    return root;
  }

  function onMouseMove(e) {
    if (!activeMode || editingTarget) return;
    const elAt = document.elementFromPoint(e.clientX, e.clientY);
    if (isInsideHost(elAt)) return;
    let target = null;
    if (activeMode === 'edit') {
      target = findTextNodeAtPoint(e.clientX, e.clientY);
    } else {
      target = findComponentAtPoint(e.clientX, e.clientY);
    }
    setTarget(target);
  }

  function onScrollOrResize() {
    if (editingTarget) positionOverlays(editingTarget);
    else if (currentTarget) positionOverlays(currentTarget);
  }

  bubble.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); });
  bubble.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (currentTarget) openEditor(currentTarget);
  });

  // Click integration with the host site:
  //   - Click the EDIT bubble  → always opens editor
  //   - ⌥-click on text         → always opens editor (power-user override)
  //   - Click text inside an interactive element (button, a, input, [role=button]…)
  //                             → native behavior fires (button activates, link navigates)
  //   - Click text elsewhere   → opens editor
  const INTERACTIVE_SELECTOR =
    'button, a[href], a[role], input, select, textarea, label, summary, ' +
    '[role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
    '[role="checkbox"], [role="radio"], [role="switch"], [contenteditable=""], [contenteditable="true"]';
  function isInsideInteractive(el) {
    if (!el || el.nodeType !== 1) return false;
    return !!(el.closest && el.closest(INTERACTIVE_SELECTOR));
  }

  // Click model: in any active mode, the page is "frozen" — we capture every
  // mousedown/click. ⌥-click is the explicit escape hatch that bypasses
  // interception and lets the native action fire (open dropdowns, navigate
  // links, submit forms). On non-interactive text → click opens the mode's
  // editor directly. On interactive elements (button/a/[role=button]/…) →
  // click shows a two-choice picker so the user explicitly decides between
  // editing the text and triggering the action.
  let bypassClicks = false;
  function shouldInterceptClick(e) {
    if (bypassClicks) return false;
    if (!activeMode || editingTarget) return false;
    if (isInsideHost(e.target)) return false;
    if (e.altKey) return false;
    return true;
  }
  function onDocMouseDown(e) {
    if (shouldInterceptClick(e)) { e.preventDefault(); e.stopPropagation(); }
  }
  // Each mode supplies a label + handler for its primary action. The choice
  // picker (shown on interactive elements) uses these to render its first button.
  function getPrimaryActionForActiveMode() {
    if (activeMode === 'edit') return { label: '✎ Edit text',   run: openEditor };
    if (activeMode === 'todo') return { label: '✎ Add TODO',    run: openTodoPanel };
    if (activeMode === 'test') return { label: '✎ Report bug',  run: openTestPanel };
    return null;
  }
  function onDocClick(e) {
    if (!shouldInterceptClick(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!currentTarget) return;
    const action = getPrimaryActionForActiveMode();
    if (!action) return;
    const el = elementForTarget(currentTarget);
    if (isInsideInteractive(el)) {
      openChoicePicker(currentTarget, el, action);
    } else {
      action.run(currentTarget);
    }
  }

  function triggerNativeAction(el) {
    bypassClicks = true;
    try { el.click(); } catch {}
    bypassClicks = false;
  }

  let activePicker = null;
  function closeChoicePicker() {
    if (activePicker) { activePicker.remove(); activePicker = null; }
  }
  // Position a floating element near a target rect, clamped to the viewport.
  // Prefers placing it above the target; falls back below; finally clamps to bottom.
  function placeNear(el, targetRect) {
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Make sure we can measure size before placing.
    el.style.visibility = 'hidden';
    el.style.top = '0px';
    el.style.left = '0px';
    // Forces layout pass.
    const w = el.offsetWidth;
    const h = el.offsetHeight;

    let top = targetRect.top - h - 6;
    if (top < margin) top = targetRect.bottom + 6;
    if (top + h > vh - margin) top = vh - h - margin;
    if (top < margin) top = margin;

    let left = targetRect.left;
    if (left + w > vw - margin) left = vw - w - margin;
    if (left < margin) left = margin;

    el.style.top = top + 'px';
    el.style.left = left + 'px';
    el.style.visibility = '';
  }
  function openChoicePicker(target, interactiveEl, primaryAction) {
    closeChoicePicker();
    const r = rectForTarget(target) || { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
    const picker = document.createElement('div');
    picker.className = 'choice-picker';

    const editBtn = document.createElement('button');
    editBtn.className = 'picker-edit';
    editBtn.textContent = (primaryAction && primaryAction.label) || '✎ Edit text';
    editBtn.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      closeChoicePicker();
      (primaryAction && primaryAction.run || openEditor)(target);
    });

    const runBtn = document.createElement('button');
    runBtn.textContent = '▶ Run action';
    runBtn.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      closeChoicePicker();
      triggerNativeAction(interactiveEl);
    });

    const hint = document.createElement('span');
    hint.className = 'picker-hint';
    hint.textContent = '⌥-click to run directly';

    picker.appendChild(editBtn);
    picker.appendChild(runBtn);
    picker.appendChild(hint);
    shadow.appendChild(picker);
    placeNear(picker, r);
    activePicker = picker;
  }
  // Dismiss the picker on outside click, Esc, or scroll.
  document.addEventListener('mousedown', (e) => {
    if (!activePicker) return;
    if (isInsideHost(e.target)) return;
    closeChoicePicker();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (activePicker && e.key === 'Escape') { e.preventDefault(); closeChoicePicker(); }
  }, true);
  window.addEventListener('scroll', closeChoicePicker, true);

  // ---------- Source-map (data-edit-loc + i18n) ----------
  let i18nMap = null;
  let i18nMapPromise = null;
  // Cross-reference table: { file: [i18n keys] }. Populated alongside the map.
  // Used by the picker to boost candidates referenced by ancestor components.
  let i18nReferences = null;

  function fetchRefs() {
    if (!ENABLED.has('edit') || !CFG.refsUrl) { i18nReferences = i18nReferences || {}; return Promise.resolve(i18nReferences); }
    return fetch(CFG.refsUrl, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : {}))
      .then((m) => { i18nReferences = m && typeof m === 'object' ? m : {}; return i18nReferences; })
      .catch(() => { if (!i18nReferences) i18nReferences = {}; return i18nReferences; });
  }

  function fetchI18nMap() {
    // Only Edit mode needs the i18n source map. Skip the fetch entirely in
    // environments where Edit isn't enabled (production), and skip it when
    // the plugin didn't set a map URL.
    if (!ENABLED.has('edit') || !MAP_URL) {
      i18nMap = i18nMap || [];
      return Promise.resolve(i18nMap);
    }
    if (i18nMapPromise) return i18nMapPromise;
    i18nMapPromise = fetch(MAP_URL, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .then((m) => { i18nMap = Array.isArray(m) ? m : []; return i18nMap; })
      .catch(() => { if (!i18nMap) i18nMap = []; return i18nMap; });
    return i18nMapPromise;
  }
  // Forget the cached promise so the next fetch runs fresh, but keep the existing
  // map around so lookups don't suddenly return null between an edit and its
  // refetch. submit() always awaits the latest before sending, so stale offsets
  // can't reach the agent.
  function invalidateI18nMap() { i18nMapPromise = null; fetchI18nMap(); fetchRefs(); }

  function getActiveLocale() {
    if (typeof window.__activeLocale === 'string') return window.__activeLocale.toLowerCase();
    const lang = document.documentElement.lang;
    if (lang) return lang.toLowerCase().split('-')[0];
    return null;
  }

  function readAncestorAttr(el, attr) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.getAttribute) {
        const v = node.getAttribute(attr);
        if (v != null) return v;
      }
      node = node.parentElement;
    }
    return null;
  }

  function readDataEditLoc(el) {
    const loc = readAncestorAttr(el, 'data-edit-loc');
    if (!loc) return null;
    const idx2 = loc.lastIndexOf(':');
    if (idx2 < 0) return null;
    const idx1 = loc.lastIndexOf(':', idx2 - 1);
    if (idx1 < 0) return null;
    const length = Number(loc.slice(idx2 + 1));
    const offset = Number(loc.slice(idx1 + 1, idx2));
    const file = loc.slice(0, idx1);
    if (!Number.isFinite(offset) || !Number.isFinite(length)) return null;
    return { file, offset, length };
  }
  // Reads data-edit-script-loc="<file>:<offset>:<length>:<kind>" emitted by
  // the plugin when an interpolation traces to a literal JS string in the
  // component's script. Resolves to a synthetic entry the editor can use.
  function readDataEditScriptLoc(el) {
    const v = readAncestorAttr(el, 'data-edit-script-loc');
    if (!v) return null;
    const parts = v.split(':');
    if (parts.length < 4) return null;
    const kind = parts[parts.length - 1] || 'string-literal';
    const length = Number(parts[parts.length - 2]);
    const offset = Number(parts[parts.length - 3]);
    const file = parts.slice(0, parts.length - 3).join(':');
    if (!Number.isFinite(offset) || !Number.isFinite(length)) return null;
    return { file, offset, length, kind, path: 'script:' + file + ':' + offset, locale: null };
  }

  function findByPath(path, locale) {
    if (!i18nMap) return null;
    const inLocale = i18nMap.filter((e) => e.path === path && e.locale === locale);
    if (inLocale.length === 1) return inLocale[0];
    if (inLocale.length > 1) return null;
    const any = i18nMap.filter((e) => e.path === path);
    if (any.length === 1) return any[0];
    return null;
  }
  // Returns ALL entries for an i18n path, one per locale (deduplicated by locale).
  // Used by the multi-locale editor to show every translation side-by-side.
  function findAllByPath(path) {
    if (!i18nMap) return [];
    const byLocale = new Map();
    for (const e of i18nMap) {
      if (e.path !== path) continue;
      // Prefer non-empty locale, keep first occurrence per locale.
      const key = e.locale || '';
      if (!byLocale.has(key)) byLocale.set(key, e);
    }
    return Array.from(byLocale.values());
  }

  // Find ALL entries whose value matches the given text. Returns one per
  // (path, locale) pair so the picker shows distinct logical destinations
  // rather than duplicated rows.
  function findAllByValue(text, locale) {
    if (!i18nMap || i18nMap.length === 0) return [];
    const t = (text || '').trim();
    const matches = i18nMap.filter((e) => e.value && (e.value === text || e.value.trim() === t));
    // Group by path; one entry per path (locale-filter for relevance but include all locales as a hint).
    const byPath = new Map();
    for (const e of matches) {
      const key = e.path || (e.file + ':' + e.offset);
      if (!byPath.has(key)) byPath.set(key, []);
      byPath.get(key).push(e);
    }
    // Return one representative entry per path. Prefer the active-locale entry
    // when available so the picker shows the right value for the user's UI.
    const out = [];
    for (const [, entries] of byPath) {
      const localeMatch = locale ? entries.find((e) => e.locale === locale) : null;
      out.push(localeMatch || entries[0]);
    }
    return out;
  }

  function findByValue(text, locale) {
    if (!i18nMap || i18nMap.length === 0) return null;
    const t = text.trim();
    const all = i18nMap.filter((e) => e.value && (e.value === text || e.value.trim() === t));
    if (all.length === 0) return null;
    if (locale) {
      const inLocale = all.filter((e) => e.locale === locale);
      if (inLocale.length === 1) return inLocale[0];
      if (inLocale.length > 1) return null;
    }
    if (all.length === 1) return all[0];
    return null;
  }

  function findCompositions(text, locale) {
    if (!i18nMap || !text || text.length < 2) return [];
    const t = text.trim();
    const seen = new Set();
    const matches = [];
    for (const e of i18nMap) {
      if (!e.value || e.value.trim().length < 2) continue;
      const ev = e.value.trim();
      if (ev === t) continue; // direct match (handled by findByValue/path)
      if (e.locale && locale && e.locale !== locale) continue;
      if (t.indexOf(ev) < 0) continue;
      const key = e.file + ':' + e.offset;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(e);
    }
    matches.sort((a, b) => b.value.trim().length - a.value.trim().length);
    return matches.slice(0, 6);
  }

  function entryToMessage(entry, _userOldText, userNewText, id) {
    // The agent compares oldText against the COOKED form of the source literal
    // (including any \n, \t, or quote-escape sequences). The DOM/textarea only
    // shows the trimmed visible text, so we always send the entry's raw value
    // as oldText and wrap the user's input with the original's outer whitespace
    // so trailing escapes (e.g. \n at the end of a string literal) are preserved.
    const fullValue = entry.value == null ? '' : String(entry.value);
    const m = fullValue.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const leading = m ? m[1] : '';
    const trailing = m ? m[3] : '';
    return {
      type: 'edit-loc', id,
      file: entry.file, offset: entry.offset, length: entry.length,
      kind: entry.kind || 'string-literal',
      oldText: fullValue,
      newText: leading + userNewText + trailing,
      via: `${entry.kind || 'string-literal'}:${entry.path || '?'}`,
    };
  }

  function buildEditMessage(el, oldText, newText, id) {
    // 1. Exact byte range on the element itself (literal template text). The
    //    plugin recorded the trimmed-text byte range, so oldText (trimmed) matches.
    const loc = readDataEditLoc(el);
    if (loc) {
      return { type: 'edit-loc', id, file: loc.file, offset: loc.offset, length: loc.length, kind: 'raw', oldText, newText, via: 'data-edit-loc' };
    }
    const locale = getActiveLocale();
    // 2. i18n path emitted by the plugin at build time.
    const i18nPath = readAncestorAttr(el, 'data-edit-i18n-path');
    if (i18nPath) {
      const entry = findByPath(i18nPath, locale);
      if (entry) return entryToMessage(entry, oldText, newText, id);
    }
    // 2b. Multiple candidate paths (e.g. ternary `cond ? $t(a) : $t(b)`).
    //     Pick whichever path's value matches the currently displayed text.
    const i18nPaths = readAncestorAttr(el, 'data-edit-i18n-paths');
    if (i18nPaths) {
      const candidates = i18nPaths.split('|').filter(Boolean);
      for (const path of candidates) {
        const entry = findByPath(path, locale);
        if (entry && entry.value && (entry.value === oldText || entry.value.trim() === oldText.trim())) {
          return entryToMessage(entry, oldText, newText, id);
        }
      }
    }
    // 3. Value-based map lookup, locale-filtered.
    const byVal = findByValue(oldText, locale);
    if (byVal) return entryToMessage(byVal, oldText, newText, id);
    // 4. Last resort: global string search (v0 behavior).
    return { type: 'edit', id, oldText, newText };
  }

  // ---------- Editor panel ----------
  function getEditableTextFromTarget(target) {
    if (!target) return '';
    if (target.nodeType === 3) return (target.nodeValue || '').trim();
    for (const child of target.childNodes) {
      if (child.nodeType === 3 && child.nodeValue && child.nodeValue.trim().length > 0) {
        return child.nodeValue.trim();
      }
    }
    return '';
  }

  function applyLocalText(target, oldTextTrimmed, newText) {
    if (!target) return;
    const textNode = target.nodeType === 3
      ? target
      : Array.from(target.childNodes).find((c) => c.nodeType === 3 && c.nodeValue && c.nodeValue.trim());
    if (!textNode) return;
    const raw = textNode.nodeValue;
    const idx = raw.indexOf(oldTextTrimmed);
    if (idx === -1) textNode.nodeValue = newText;
    else textNode.nodeValue = raw.slice(0, idx) + newText + raw.slice(idx + oldTextTrimmed.length);
  }

  function elementForTarget(target) {
    return target && target.nodeType === 3 ? target.parentElement : target;
  }

  // Locale display labels — falls back to the locale code if no friendly label.
  const LOCALE_LABELS = { en: 'English', ar: 'العربية', fr: 'Français', es: 'Español', de: 'Deutsch', it: 'Italiano', tr: 'Türkçe', he: 'עברית', ja: '日本語', zh: '中文' };
  const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur']);

  // Multi-locale editor — shows one textarea per locale that exists for this
  // i18n path. User can change any subset; on submit, only changed locales
  // produce edit-loc messages. Designed for `$t('foo.bar')` where translations
  // live in parallel JSON locale files.
  async function openMultiLocaleEditor(target, i18nPath, entries) {
    editingTarget = target;
    bubble.style.display = 'none';
    positionOverlays(target);

    const r = rectForTarget(target) || { top: 0, left: 0, bottom: 0 };
    const panel = document.createElement('div');
    panel.className = 'panel';
    const panelWidth = 460;
    const top = Math.min(window.innerHeight - 360, Math.max(8, r.bottom + 6));
    const left = Math.min(window.innerWidth - panelWidth - 8, Math.max(8, r.left));
    panel.style.top = top + 'px';
    panel.style.left = left + 'px';
    panel.style.width = panelWidth + 'px';

    // Header with the i18n path so the user knows exactly what they're editing.
    const header = document.createElement('div');
    header.className = 'multi-header';
    header.innerHTML = `
      <div class="multi-title">Edit translation</div>
      <div class="multi-path">${escapeHtml(i18nPath)}</div>
    `;
    panel.appendChild(header);

    // Sort entries: active locale first, then alphabetical.
    const activeLocale = getActiveLocale();
    const sorted = entries.slice().sort((a, b) => {
      if (a.locale === activeLocale) return -1;
      if (b.locale === activeLocale) return 1;
      return (a.locale || '').localeCompare(b.locale || '');
    });

    const fields = [];  // { entry, textarea, originalValue }
    for (const entry of sorted) {
      const wrap = document.createElement('div');
      wrap.className = 'multi-field';

      const lab = document.createElement('label');
      const code = entry.locale || '(default)';
      const friendly = LOCALE_LABELS[entry.locale] || '';
      lab.textContent = friendly ? `${code} — ${friendly}` : code;
      wrap.appendChild(lab);

      const ta = document.createElement('textarea');
      ta.value = entry.value || '';
      ta.spellcheck = false;
      ta.rows = Math.min(5, Math.max(1, (entry.value || '').split('\n').length));
      // Auto-set RTL on Arabic-class locales so editing reads naturally.
      if (RTL_LOCALES.has((entry.locale || '').toLowerCase())) {
        ta.dir = 'rtl';
      } else {
        ta.dir = 'auto';
      }
      wrap.appendChild(ta);

      panel.appendChild(wrap);
      fields.push({ entry, textarea: ta, originalValue: entry.value || '' });
    }

    const row = document.createElement('div');
    row.className = 'row';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '⌘/Ctrl+Enter to save all · Esc to cancel';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel';
    cancelBtn.textContent = 'Cancel';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save';
    saveBtn.textContent = 'Save all';
    row.appendChild(hint);
    row.appendChild(cancelBtn);
    row.appendChild(saveBtn);
    panel.appendChild(row);

    shadow.appendChild(panel);

    // Focus the active-locale field (which we sorted to first).
    setTimeout(() => { if (fields[0]) { fields[0].textarea.focus(); fields[0].textarea.select(); } }, 0);

    function close() {
      panel.remove();
      editingTarget = null;
      currentTarget = null;
      outline.style.display = 'none';
    }

    cancelBtn.addEventListener('click', close);
    saveBtn.addEventListener('click', submit);
    for (const f of fields) {
      f.textarea.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
    }

    async function submit() {
      // Collect changed fields.
      const changed = fields.filter((f) => f.textarea.value !== f.originalValue);
      if (changed.length === 0) { close(); return; }
      if (!connected) { toast('Agent not connected', 'error'); return; }

      saveBtn.disabled = true;
      saveBtn.textContent = `Saving ${changed.length}…`;
      await fetchI18nMap();   // refresh offsets so writes don't drift

      // Track all in-flight edits — close panel when all settle.
      let pendingCount = changed.length;
      const failed = [];
      let anyAppliedForVisibleLocale = false;

      const finalize = () => {
        if (pendingCount > 0) return;
        if (failed.length === 0) {
          // Reflect in DOM: if active locale was edited, swap the visible text.
          if (anyAppliedForVisibleLocale) {
            const activeField = changed.find((f) => f.entry.locale === activeLocale);
            if (activeField) {
              applyLocalText(target, activeField.originalValue, activeField.textarea.value);
            }
          }
          toast(`Saved ${changed.length} ${changed.length === 1 ? 'translation' : 'translations'}`);
          close();
        } else {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save all';
          toast(`${failed.length} of ${changed.length} edits failed`, 'error');
        }
      };

      for (const f of changed) {
        const id = ++pendingId;
        pending.set(id, (err) => {
          pendingCount--;
          if (err) failed.push({ locale: f.entry.locale, err });
          else if (f.entry.locale === activeLocale) anyAppliedForVisibleLocale = true;
          finalize();
        });
        send(entryToMessage(f.entry, f.originalValue, f.textarea.value, id));
      }
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Rank candidates by relevance for the user's click. Heuristics:
  //   1. Entries in the active locale come first.
  //   2. Entries whose path semantically matches surrounding context (e.g. paths
  //      starting with 'nav.' when the element is inside a <nav> or NuxtLink).
  //   3. Shorter paths first (often the more "canonical" key).
  function rankCandidates(candidates, target, displayedText, locale) {
    const el = elementForTarget(target);
    // Detect context hints from ancestors.
    let inNav = false, inFooter = false, inHeader = false;
    let n = el;
    while (n && n.nodeType === 1) {
      const tag = (n.tagName || '').toLowerCase();
      if (tag === 'nav') inNav = true;
      if (tag === 'footer') inFooter = true;
      if (tag === 'header') inHeader = true;
      if (n.classList && (n.classList.contains('nav') || n.classList.contains('navbar') || n.classList.contains('navigation'))) inNav = true;
      n = n.parentElement;
    }
    return candidates.slice().sort((a, b) => {
      // Locale match: prefer active locale.
      const aLoc = a.locale === locale ? 0 : 1;
      const bLoc = b.locale === locale ? 0 : 1;
      if (aLoc !== bLoc) return aLoc - bLoc;
      // STRONGEST signal: candidate's key is literally referenced by an
      // ancestor component's script. This catches the cross-component case
      // (`{{ link.label }}` in a child where the parent does `t('nav.x')`).
      const aRef = ancestorReferences(a, target) ? 0 : 1;
      const bRef = ancestorReferences(b, target) ? 0 : 1;
      if (aRef !== bRef) return aRef - bRef;
      // Context match: prefer path starting with semantic prefix.
      const aPath = (a.path || '').toLowerCase();
      const bPath = (b.path || '').toLowerCase();
      const aCtx = (inNav && aPath.startsWith('nav.')) || (inFooter && aPath.startsWith('footer.')) || (inHeader && aPath.startsWith('header.')) ? 0 : 1;
      const bCtx = (inNav && bPath.startsWith('nav.')) || (inFooter && bPath.startsWith('footer.')) || (inHeader && bPath.startsWith('header.')) ? 0 : 1;
      if (aCtx !== bCtx) return aCtx - bCtx;
      // Tiebreaker: shorter path = more canonical.
      return aPath.length - bPath.length;
    });
  }

  // Render a picker UI when an element's text matches multiple sources and we
  // can't pick the right one statically. User selects a candidate; the editor
  // (single or multi-locale) opens with that as the active entry.
  function openCandidatePicker(target, displayedText, candidates, onPick) {
    editingTarget = target;
    bubble.style.display = 'none';
    positionOverlays(target);

    const r = rectForTarget(target) || { top: 0, left: 0, bottom: 0 };
    const panel = document.createElement('div');
    panel.className = 'panel';
    const panelWidth = 480;
    const top = Math.min(window.innerHeight - 380, Math.max(8, r.bottom + 6));
    const left = Math.min(window.innerWidth - panelWidth - 8, Math.max(8, r.left));
    panel.style.top = top + 'px';
    panel.style.left = left + 'px';
    panel.style.width = panelWidth + 'px';

    const locale = getActiveLocale();
    const ranked = rankCandidates(candidates, target, displayedText, locale);

    const intro = document.createElement('div');
    intro.className = 'picker-intro';
    intro.innerHTML = `Found <strong>${candidates.length}</strong> places this text comes from. Pick which one you want to edit:`;
    panel.appendChild(intro);

    const list = document.createElement('div');
    list.className = 'picker-list';
    ranked.forEach((entry, idx) => {
      const row = document.createElement('button');
      row.className = 'picker-row';
      const recommended = idx === 0 ? '<span class="picker-recommended">recommended</span>' : '';
      const pathLabel = entry.path || '(no key)';
      const fileLabel = entry.file + (entry.line ? ':' + entry.line : '');
      const localeBadge = entry.locale ? ` <span class="picker-recommended" style="color:#6b7280;">${entry.locale}</span>` : '';
      row.innerHTML = `
        <div class="picker-path">${escapeHtml(pathLabel)}${recommended}${localeBadge}</div>
        <div class="picker-file">${escapeHtml(fileLabel)}</div>
        <div class="picker-value">${escapeHtml(entry.value || '')}</div>
      `;
      row.addEventListener('click', () => {
        panel.remove();
        onPick(entry);
      });
      list.appendChild(row);
    });
    panel.appendChild(list);

    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginTop = '10px';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Tip: paths under nav.* / footer.* are ranked first when you click in those areas.';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel';
    cancelBtn.textContent = 'Cancel';
    row.appendChild(hint);
    row.appendChild(cancelBtn);
    panel.appendChild(row);

    shadow.appendChild(panel);

    function close() {
      panel.remove();
      editingTarget = null;
      currentTarget = null;
      outline.style.display = 'none';
    }
    cancelBtn.addEventListener('click', close);
    // Esc closes
    setTimeout(() => {
      const focusable = list.querySelector('.picker-row');
      if (focusable) focusable.focus();
    }, 0);
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  // Open the appropriate editor for a known entry — multi-locale if the entry's
  // path has parallel translations, single-field otherwise.
  function openEditorForEntry(target, entry) {
    if (entry.path && i18nMap) {
      const all = findAllByPath(entry.path);
      const distinctLocales = new Set(all.map((e) => e.locale).filter(Boolean));
      if (all.length > 1 && distinctLocales.size > 1) {
        return openMultiLocaleEditor(target, entry.path, all);
      }
    }
    // Single-field editor with this entry pre-resolved.
    return openSingleFieldEditor(target, entry);
  }

  // Detects whether a candidate's path semantically matches the DOM context
  // around the clicked target (e.g. `nav.*` inside `<nav>`). Returns true on
  // a hit. Used both to rank picker candidates and to decide whether the
  // top-ranked candidate is a unique strong winner that should be auto-picked.
  function contextMatches(target, path) {
    if (!path) return false;
    const p = path.toLowerCase();
    const el = elementForTarget(target);
    let n = el;
    const tags = new Set();
    const classes = new Set();
    while (n && n.nodeType === 1) {
      tags.add((n.tagName || '').toLowerCase());
      if (n.classList) n.classList.forEach((c) => classes.add(c.toLowerCase()));
      n = n.parentElement;
    }
    const isNav = tags.has('nav') || classes.has('nav') || classes.has('navbar') || classes.has('navigation');
    const isFooter = tags.has('footer') || classes.has('footer');
    const isHeader = tags.has('header');
    if (isNav && p.startsWith('nav.')) return true;
    if (isFooter && p.startsWith('footer.')) return true;
    if (isHeader && p.startsWith('header.')) return true;
    return false;
  }

  // Returns the set of .vue source files in the clicked element's ancestor
  // chain (from data-edit-source attributes). Used to check whether a
  // candidate's i18n key is referenced by any ancestor component.
  function ancestorSourceFiles(target) {
    const files = new Set();
    let n = elementForTarget(target);
    while (n && n.nodeType === 1) {
      const src = n.getAttribute && n.getAttribute('data-edit-source');
      if (src) {
        const i = src.lastIndexOf(':');
        if (i > 0) files.add(src.slice(0, i));
      }
      n = n.parentElement;
    }
    return files;
  }
  // Is this candidate's i18n key referenced by any of the ancestor components?
  // True = the parent file's script literally contains `$t('key')` — strong
  // signal that this is the right candidate even when the rendering child
  // component doesn't know about it.
  function ancestorReferences(candidate, target) {
    if (!candidate.path || !i18nReferences) return false;
    const ancestors = ancestorSourceFiles(target);
    if (ancestors.size === 0) return false;
    for (const file of ancestors) {
      const keys = i18nReferences[file];
      if (keys && keys.indexOf(candidate.path) >= 0) return true;
    }
    return false;
  }

  // From a ranked candidate list, return a single entry if it's a clear winner
  // (unique strong-context match in the active locale). Otherwise return null,
  // signalling the caller to show the picker.
  function pickClearWinner(candidates, target, locale) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const ranked = rankCandidates(candidates, target, null, locale);
    const top = ranked[0];

    // Strongest signal: unique ancestor-reference match. Catches cross-component
    // cases where the parent's script literally has `$t('key')` for one of the
    // candidates and no other.
    const topRef = ancestorReferences(top, target);
    if (topRef) {
      const otherRefs = ranked.slice(1).filter((c) => ancestorReferences(c, target));
      if (otherRefs.length === 0) return top;
    }

    // Next: unique semantic-context match (nav.* inside <nav> etc.).
    const topContextHit = contextMatches(target, top.path);
    if (topContextHit) {
      const otherHits = ranked.slice(1).filter((c) => contextMatches(target, c.path));
      if (otherHits.length === 0) return top;
    }

    return null;                              // ambiguous → picker
  }

  async function openEditor(target) {
    // Always pull a fresh i18n map before deciding which editor to open.
    // Without this, an edit that changed a value would leave the next click
    // looking at stale entries (no path match → no multi-locale editor).
    await fetchI18nMap();
    const targetElForCheck = elementForTarget(target);
    const displayedText = getEditableTextFromTarget(target);
    const locale = getActiveLocale();

    // 1. Direct data-edit-i18n-path → resolve and open editor (multi-locale if applicable)
    let resolvedPath = readAncestorAttr(targetElForCheck, 'data-edit-i18n-path');
    if (!resolvedPath) {
      // 1b. Compound expression (ternary etc.): match the candidate whose value
      //     matches displayed text.
      const i18nPaths = readAncestorAttr(targetElForCheck, 'data-edit-i18n-paths');
      if (i18nPaths && i18nMap) {
        for (const path of i18nPaths.split('|').filter(Boolean)) {
          const entry = findByPath(path, locale);
          if (entry && entry.value && (entry.value === displayedText || entry.value.trim() === displayedText.trim())) {
            resolvedPath = path;
            break;
          }
        }
      }
    }
    if (resolvedPath && i18nMap) {
      const all = findAllByPath(resolvedPath);
      const distinctLocales = new Set(all.map((e) => e.locale).filter(Boolean));
      if (all.length > 1 && distinctLocales.size > 1) {
        return openMultiLocaleEditor(target, resolvedPath, all);
      }
    }

    // 1c. data-edit-script-loc — literal string in a .vue script that the
    //     plugin's resolver traced to. Edit the byte range directly.
    if (!resolvedPath) {
      const scriptLoc = readDataEditScriptLoc(targetElForCheck);
      if (scriptLoc) {
        // Synthesize an entry with .value so the editor pre-fills correctly.
        const synth = { ...scriptLoc, value: displayedText };
        return openEditorForEntry(target, synth);
      }
    }

    // 2. No path attribute — try value-based resolution.
    //    (data-edit-loc on a literal template text never needs this — it's
    //    already exact byte-range.)
    if (!resolvedPath && !readDataEditLoc(targetElForCheck) && displayedText && i18nMap) {
      const candidates = findAllByValue(displayedText, locale);
      if (candidates.length === 1) {
        // Single match → route through openEditorForEntry so multi-locale
        // editor opens if the entry's path has parallel translations.
        return openEditorForEntry(target, candidates[0]);
      }
      if (candidates.length > 1) {
        // Try to auto-pick a unique strong-context winner. Picker shows only
        // if static analysis really can't decide.
        const winner = pickClearWinner(candidates, target, locale);
        if (winner) return openEditorForEntry(target, winner);
        return openCandidatePicker(target, displayedText, candidates, (chosen) => {
          openEditorForEntry(target, chosen);
        });
      }
    }

    // 3. Otherwise: fall through to the original single-field editor.
    return openSingleFieldEditor(target, null);
  }

  function openSingleFieldEditor(target, presetEntry) {
    // Outline keeps the active mode color via CSS variable — no inline override.
    bubble.style.display = 'none';
    positionOverlays(target);

    const r = rectForTarget(target) || { top: 0, left: 0, bottom: 0 };
    const panel = document.createElement('div');
    panel.className = 'panel';
    const panelWidth = 360;
    const top = Math.min(window.innerHeight - 180, Math.max(8, r.bottom + 6));
    const left = Math.min(window.innerWidth - panelWidth - 8, Math.max(8, r.left));
    panel.style.top = top + 'px';
    panel.style.left = left + 'px';

    const originalText = getEditableTextFromTarget(target);
    const targetEl = elementForTarget(target);

    // Pre-resolve to see if the full text has a direct edit target. If not,
    // probe the source map for substrings of the rendered text and show them
    // as chips — the user picks which piece to edit.
    // When openSingleFieldEditor is called from the candidate picker, presetEntry
    // is supplied — skip probing and use it directly.
    let activeEntry = presetEntry || null;
    let activeText = presetEntry ? presetEntry.value : originalText;
    const probe = presetEntry
      ? { type: 'edit-loc' }   // synthetic — picker already resolved
      : buildEditMessage(targetEl, originalText, originalText, 0);
    const directlyResolved = probe.type === 'edit-loc';
    const compositions = (directlyResolved || presetEntry) ? [] : findCompositions(originalText, getActiveLocale());

    const ta = document.createElement('textarea');
    ta.value = presetEntry ? (presetEntry.value || originalText) : originalText;
    ta.spellcheck = false;

    // Show the picked entry's identity at the top so the user knows what they're editing.
    let presetHeader = null;
    if (presetEntry) {
      presetHeader = document.createElement('div');
      presetHeader.className = 'multi-header';
      presetHeader.innerHTML = `
        <div class="multi-title">Edit this source</div>
        <div class="multi-path">${escapeHtml(presetEntry.path || presetEntry.file)}${presetEntry.locale ? ` · <span style="color:#9ca3af;">${escapeHtml(presetEntry.locale)}</span>` : ''}</div>
      `;
    }

    let chipsRow = null;
    if (compositions.length > 0) {
      chipsRow = document.createElement('div');
      chipsRow.className = 'chips';
      const label = document.createElement('div');
      label.className = 'chips-label';
      label.textContent = compositions.length === 1
        ? "Only this piece is a known source string — click to edit it"
        : 'This text is composed of multiple sources. Pick which piece to edit:';
      chipsRow.appendChild(label);
      for (const entry of compositions) {
        const chip = document.createElement('button');
        chip.className = 'chip';
        chip.textContent = entry.value;
        chip.title = `${entry.path || '?'}${entry.locale ? ' [' + entry.locale + ']' : ''} — ${entry.file}:${entry.line}`;
        chip.addEventListener('click', (ev) => {
          ev.preventDefault();
          activeEntry = entry;
          activeText = entry.value;
          ta.value = entry.value;
          ta.focus(); ta.select();
          chipsRow.querySelectorAll('.chip').forEach((b) => b.classList.remove('chip-active'));
          chip.classList.add('chip-active');
        });
        chipsRow.appendChild(chip);
      }
    }

    const row = document.createElement('div');
    row.className = 'row';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '⌘/Ctrl+Enter to save · Esc to cancel';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel';
    cancelBtn.textContent = 'Cancel';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save';
    saveBtn.textContent = 'Save';

    row.appendChild(hint);
    row.appendChild(cancelBtn);
    row.appendChild(saveBtn);
    if (presetHeader) panel.appendChild(presetHeader);
    if (chipsRow) panel.appendChild(chipsRow);
    panel.appendChild(ta);
    panel.appendChild(row);
    shadow.appendChild(panel);

    setTimeout(() => { ta.focus(); ta.select(); }, 0);

    function close() {
      panel.remove();
      editingTarget = null;
      currentTarget = null;
      outline.style.display = 'none';
    }

    cancelBtn.addEventListener('click', close);
    saveBtn.addEventListener('click', submit);
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });

    async function submit() {
      const newText = ta.value;
      const oldText = activeEntry ? activeText : originalText;
      if (newText === oldText) { close(); return; }
      if (!connected) { toast('Agent not connected', 'error'); return; }
      if (compositions.length > 0 && !activeEntry) {
        toast('Pick which piece to edit (click a chip above)', 'error');
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      // Always wait for the freshest map before building the message, otherwise
      // offsets from a previous edit can be stale and the agent will reject with
      // out-of-sync.
      await fetchI18nMap();

      const id = ++pendingId;
      pending.set(id, (err) => {
        if (!err) {
          applyLocalText(target, oldText, newText);
          close();
        } else {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
        }
      });
      const msg = activeEntry
        ? entryToMessage(activeEntry, oldText, newText, id)
        : buildEditMessage(targetEl, originalText, newText, id);
      send(msg);
    }
  }

  // ---------- Source location reader (for Test + Dev TODO modes) ----------
  function readDataEditSource(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.getAttribute) {
        const v = node.getAttribute('data-edit-source');
        if (v) {
          // v0.10.0+ format: file:offset:line:column (4 trailing numbers)
          // Pre-v0.10.0 format: file:offset (1 trailing number)
          // File path itself can contain ':' on Windows so we parse from
          // the right rather than splitting blindly.
          const parts = v.split(':');
          if (parts.length >= 4) {
            const col = Number(parts[parts.length - 1]);
            const line = Number(parts[parts.length - 2]);
            const offset = Number(parts[parts.length - 3]);
            if (Number.isFinite(col) && Number.isFinite(line) && Number.isFinite(offset)) {
              return { file: parts.slice(0, parts.length - 3).join(':'), offset, line, column: col };
            }
          }
          // Legacy 2-part fallback.
          const i = v.lastIndexOf(':');
          if (i < 0) return null;
          const file = v.slice(0, i);
          const offset = Number(v.slice(i + 1));
          if (!Number.isFinite(offset)) return null;
          return { file, offset };
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  // ---------- Dev TODO panel ----------
  function openTodoPanel(target) {
    editingTarget = target;
    closeChoicePicker();
    bubble.style.display = 'none';
    positionOverlays(target);

    const r = rectForTarget(target) || { top: 0, left: 0, bottom: 0, right: 0 };
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.width = '380px';

    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = 'ADD TODO';

    const src = readDataEditSource(elementForTarget(target));
    const sub = document.createElement('div');
    sub.className = 'panel-sub';
    sub.textContent = src
      ? `inserts above ${src.file}:${src.offset}`
      : 'no source location — this element is not in a template';

    const ta = document.createElement('textarea');
    ta.placeholder = 'What needs to be done here?';
    ta.spellcheck = false;

    const linearRow = document.createElement('div');
    linearRow.className = 'todo-linear';
    const linearLabel = document.createElement('span');
    linearLabel.textContent = 'Existing issue ID (optional):';
    const linearInput = document.createElement('input');
    linearInput.placeholder = '#123 or MES-456';
    linearInput.spellcheck = false;
    linearRow.appendChild(linearLabel);
    linearRow.appendChild(linearInput);

    const row = document.createElement('div');
    row.className = 'row';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '⌘/Ctrl+Enter to insert · Esc to cancel';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel';
    cancelBtn.textContent = 'Cancel';
    const insertBtn = document.createElement('button');
    insertBtn.className = 'save';
    insertBtn.textContent = 'Insert TODO';
    row.appendChild(hint);
    row.appendChild(cancelBtn);
    row.appendChild(insertBtn);

    panel.appendChild(title);
    panel.appendChild(sub);
    panel.appendChild(ta);
    panel.appendChild(linearRow);
    panel.appendChild(row);

    // Place near, with the panel measured against viewport.
    panel.style.top = '0px';
    panel.style.left = '0px';
    shadow.appendChild(panel);
    placeNear(panel, r);

    setTimeout(() => ta.focus(), 0);

    function close() {
      panel.remove();
      editingTarget = null;
      currentTarget = null;
      outline.style.display = 'none';
    }
    function submit() {
      const body = ta.value.trim();
      if (!body) { toast('Enter a TODO description', 'error'); return; }
      if (!src) { toast('No source location available for this element', 'error'); return; }
      if (!connected) { toast('Agent not connected', 'error'); return; }
      const id = ++pendingId;
      insertBtn.disabled = true;
      insertBtn.textContent = 'Inserting…';
      pending.set(id, (err) => {
        if (!err) close();
        else { insertBtn.disabled = false; insertBtn.textContent = 'Insert TODO'; }
      });
      const linearId = linearInput.value.trim();
      send({
        type: 'add-todo',
        id,
        file: src.file,
        offset: src.offset,
        body,
        linearId: linearId || undefined,
      });
    }
    cancelBtn.addEventListener('click', close);
    insertBtn.addEventListener('click', submit);
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    linearInput.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
  }

  // ---------- Test-mode report bubbles (v0.9.0) ----------
  // For every element with one or more open Linear issues filed against it
  // on the current page, render a small mode-colored dot at its top-right
  // corner. Hover/click → list panel with each issue's note + edit (if the
  // current tester is the filer). Bubbles disappear automatically when their
  // issues move to Linear state.type = completed or canceled — refresh
  // happens on Test-mode enter and on window focus (no background polling).
  let fcBubbleHost = null;
  let fcBubbles = [];                  // [{ anchorKey, group, element, dot }]
  let fcOpenedBubblePanel = null;
  let fcBubblePanelDismiss = null;
  let fcBubbleResizeHandler = null;
  function fcEscAttr(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
  // Build the bubble's contents: a small chat-bubble icon + the issue count.
  // Extracted so optimistic-insert (after submit), delete-time count update,
  // and the initial render all produce the same markup. v0.9.7: background
  // also reflects the most-advanced Linear state in the group (a soft signal
  // for "this is being worked on" vs "this is still unsorted").
  function fcRenderDotContents(dot, group) {
    const count = group.issues.length;
    dot.innerHTML = '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'fc-bubble-icon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M2 3a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7l-3 3v-3H4a2 2 0 0 1-2-2V3z');
    svg.appendChild(path);
    dot.appendChild(svg);
    const countSpan = document.createElement('span');
    countSpan.className = 'fc-bubble-count';
    countSpan.textContent = String(count);
    dot.appendChild(countSpan);
    dot.title = count === 1 ? (group.issues[0].title || '1 open issue') : count + ' open issues';
    // State-colored background. Most-advanced wins: started > unstarted > backlog.
    let highest = 0;
    for (const iss of group.issues) {
      const t = iss.state && iss.state.type;
      if (t === 'started') { highest = 2; break; }
      if (t === 'unstarted' && highest < 1) highest = 1;
    }
    dot.style.background = highest === 2 ? '#10b981' /* in progress/review */
                        : highest === 1 ? '#3b82f6' /* triaged/Todo */
                        : '';                       /* backlog → fall back to mode color */
  }
  function fcRelTime(iso) {
    const t = typeof iso === 'number' ? iso * 1000 : Date.parse(iso || '');
    if (!t || isNaN(t)) return '';
    const diff = Math.max(0, (Date.now() - t) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }
  function fcRemoveBubbles() {
    fcCloseBubblePanel();
    if (fcBubbleHost) { fcBubbleHost.remove(); fcBubbleHost = null; }
    fcBubbles = [];
    if (fcBubbleResizeHandler) {
      window.removeEventListener('resize', fcBubbleResizeHandler);
      window.removeEventListener('scroll', fcBubbleResizeHandler, true);
      fcBubbleResizeHandler = null;
    }
    updateIndicator();
  }
  function fcCloseBubblePanel() {
    if (fcOpenedBubblePanel) { fcOpenedBubblePanel.remove(); fcOpenedBubblePanel = null; }
    if (fcBubblePanelDismiss) {
      document.removeEventListener('mousedown', fcBubblePanelDismiss, true);
      fcBubblePanelDismiss = null;
    }
  }
  function fcEnsureBubbleHost() {
    if (fcBubbleHost && fcBubbleHost.isConnected) return;
    fcBubbleHost = document.createElement('div');
    fcBubbleHost.className = 'fc-bubble-host';
    shadow.appendChild(fcBubbleHost);
  }
  function fcPositionBubble(b) {
    const r = b.element.getBoundingClientRect();
    // The host is position:fixed at (0,0); we want viewport-relative coords,
    // which is exactly what getBoundingClientRect gives us. Place at top-right
    // of the element, peeking outside its edge.
    b.dot.style.top = (r.top - 9) + 'px';
    b.dot.style.left = (r.right - 9) + 'px';
    // Hide bubble if anchor is off-screen vertically — avoids stranded dots
    // when the page scrolls past where the element was.
    const offscreen = r.bottom < 0 || r.top > window.innerHeight;
    b.dot.style.display = offscreen ? 'none' : '';
  }
  function fcRepositionAll() {
    for (const b of fcBubbles) fcPositionBubble(b);
    if (fcOpenedBubblePanel && fcOpenedBubblePanel.__anchorDot) {
      fcPositionBubblePanel(fcOpenedBubblePanel, fcOpenedBubblePanel.__anchorDot);
    }
  }
  // v0.9.7: track the previous /api/issues snapshot so we can toast the
  // filer when one of their issues vanishes between refreshes (admin moved it
  // to Done/Canceled in Linear). Scoped by (page, email) — a page change
  // wipes the snapshot so cross-page navigation never produces a stale
  // "closed" toast. Issues the user deleted themselves are excluded.
  let fcLastListing = null;       // { page, email, issues: Map<id, {identifier, filer}> }
  const fcLocallyDeleted = new Set();
  function fcDiffAndToastClosed(newIssues, email, page) {
    const fresh = !fcLastListing || fcLastListing.page !== page || fcLastListing.email !== email;
    if (!fresh) {
      const newIds = new Set(newIssues.map((i) => i.id));
      const closedMine = [];
      for (const [id, info] of fcLastListing.issues) {
        if (newIds.has(id)) continue;
        if (info.filer !== email) continue;
        if (fcLocallyDeleted.has(id)) continue;  // user did it themselves
        closedMine.push(info.identifier || id.slice(0, 8));
      }
      if (closedMine.length === 1) toast(closedMine[0] + ' was closed.', 'success');
      else if (closedMine.length > 1) toast(closedMine.length + ' of your issues were closed.', 'success');
    }
    const m = new Map();
    for (const i of newIssues) m.set(i.id, { identifier: i.identifier, filer: i.filer });
    fcLastListing = { page, email, issues: m };
  }
  async function fcRefreshBubbles() {
    if (activeMode !== 'test') { fcRemoveBubbles(); fcLastListing = null; return; }
    const session = getStoredGateToken();
    if (!session) { fcRemoveBubbles(); fcLastListing = null; return; }
    const page = location.pathname + location.search;
    const res = await gateListIssues(session.token, page);
    if (!res.ok) return;  // Silent — bubbles are a soft feature, no toast on failure.
    fcDiffAndToastClosed(res.issues, session.email, page);
    fcRenderBubbles(res.issues, session.email);
  }
  // v0.9.7: optimistic insert after a successful report submit. The bubble
  // appears immediately (using the data we just sent) instead of waiting for
  // the next /api/issues roundtrip. If a bubble already exists at this anchor
  // (re-reporting), append to the existing group + bump the count. Otherwise
  // create a fresh dot in place.
  function fcInsertOptimisticBubble(issueData, currentUserEmail) {
    if (!issueData || !issueData.anchor || typeof issueData.anchor.file !== 'string') return;
    const anchorKey = issueData.anchor.file + ':' + issueData.anchor.offset;
    const existing = fcBubbles.find((b) => b.anchorKey === anchorKey);
    if (existing) {
      existing.group.issues.push({ ...issueData, mine: issueData.filer === currentUserEmail });
      fcRenderDotContents(existing.dot, existing.group);
      if (fcOpenedBubblePanel) {
        const header = fcOpenedBubblePanel.querySelector('.panel-title');
        if (header) header.textContent = existing.group.issues.length === 1 ? '1 OPEN ISSUE' : existing.group.issues.length + ' OPEN ISSUES';
      }
      updateIndicator();
      return;
    }
    // v0.11.3: prefix match — the plugin emits "file:offset:line:col" (4
    // parts) but the anchor identifies a node by file+offset alone. Was an
    // exact match, which silently failed when the plugin annotations included
    // line/col and the fc-meta only carried offset, so bubbles never rendered.
    const sel = `[data-edit-source^="${fcEscAttr(issueData.anchor.file + ':' + issueData.anchor.offset + ':')}"], [data-edit-source="${fcEscAttr(issueData.anchor.file + ':' + issueData.anchor.offset)}"]`;
    const element = document.querySelector(sel);
    if (!element) return;  // can't anchor — let the next refresh handle it
    fcEnsureBubbleHost();
    const group = { anchor: issueData.anchor, issues: [{ ...issueData, mine: issueData.filer === currentUserEmail }] };
    const dot = document.createElement('div');
    dot.className = 'fc-bubble';
    fcRenderDotContents(dot, group);
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      fcOpenBubblePanel(group, dot, currentUserEmail);
    });
    fcBubbleHost.appendChild(dot);
    const b = { anchorKey, group, element, dot };
    fcBubbles.push(b);
    fcPositionBubble(b);
    if (!fcBubbleResizeHandler) {
      let pending = false;
      fcBubbleResizeHandler = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; fcRepositionAll(); });
      };
      window.addEventListener('resize', fcBubbleResizeHandler);
      window.addEventListener('scroll', fcBubbleResizeHandler, true);
    }
    updateIndicator();
  }
  function fcRenderBubbles(issues, currentUserEmail) {
    fcRemoveBubbles();
    if (!issues.length) return;
    // Group by anchor identity. One bubble per unique data-edit-source target.
    const byAnchor = new Map();
    for (const iss of issues) {
      const a = iss.anchor;
      if (!a || typeof a.file !== 'string' || typeof a.offset !== 'number') continue;
      const k = a.file + ':' + a.offset;
      if (!byAnchor.has(k)) byAnchor.set(k, { anchor: a, issues: [] });
      byAnchor.get(k).issues.push({ ...iss, mine: iss.filer === currentUserEmail });
    }
    if (!byAnchor.size) return;
    fcEnsureBubbleHost();
    for (const [anchorKey, group] of byAnchor) {
      // v0.11.3: prefix match (see fcInsertOptimisticBubble for the why).
      const sel = `[data-edit-source^="${fcEscAttr(group.anchor.file + ':' + group.anchor.offset + ':')}"], [data-edit-source="${fcEscAttr(group.anchor.file + ':' + group.anchor.offset)}"]`;
      const element = document.querySelector(sel);
      if (!element) continue;  // anchor exists in Linear but element isn't on the page right now — skip silently
      const dot = document.createElement('div');
      dot.className = 'fc-bubble';
      fcRenderDotContents(dot, group);
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        fcOpenBubblePanel(group, dot, currentUserEmail);
      });
      fcBubbleHost.appendChild(dot);
      fcBubbles.push({ anchorKey, group, element, dot });
    }
    fcRepositionAll();
    if (!fcBubbleResizeHandler) {
      // v0.9.7: rAF-batched. A page with N bubbles + aggressive scroll was
      // doing N getBoundingClientRect reads on every wheel tick — janky past
      // ~30 bubbles. Coalesce to one per animation frame.
      let pending = false;
      fcBubbleResizeHandler = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; fcRepositionAll(); });
      };
      window.addEventListener('resize', fcBubbleResizeHandler);
      window.addEventListener('scroll', fcBubbleResizeHandler, true);
    }
    updateIndicator();
  }
  function fcPositionBubblePanel(panel, dot) {
    const r = dot.getBoundingClientRect();
    // Prefer below+right of the dot; if it would overflow, swap sides/up.
    let top = r.bottom + 6;
    let left = r.left - 16;
    const panelRect = panel.getBoundingClientRect();
    if (left + panelRect.width > window.innerWidth - 8) left = window.innerWidth - panelRect.width - 8;
    if (left < 8) left = 8;
    if (top + panelRect.height > window.innerHeight - 8) top = r.top - panelRect.height - 6;
    if (top < 8) top = 8;
    panel.style.top = top + 'px';
    panel.style.left = left + 'px';
  }
  function fcOpenBubblePanel(group, dot, currentUserEmail) {
    fcCloseBubblePanel();
    const panel = document.createElement('div');
    panel.className = 'panel fc-bubble-panel';
    panel.__anchorDot = dot;
    panel.addEventListener('click', (e) => e.stopPropagation());

    const header = document.createElement('div');
    header.className = 'panel-title';
    header.textContent = group.issues.length === 1 ? '1 OPEN ISSUE' : group.issues.length + ' OPEN ISSUES';
    panel.appendChild(header);

    for (const iss of group.issues) {
      panel.appendChild(fcBuildIssueRow(iss, group, currentUserEmail));
    }

    // v0.9.7: identity footer + sign-out. Lets a tester switch users without
    // pasting `sessionStorage.clear()` into devtools.
    if (currentUserEmail) {
      const footer = document.createElement('div');
      footer.className = 'fc-bubble-footer';
      const who = document.createElement('span');
      who.textContent = 'signed in as ';
      const whoBold = document.createElement('strong');
      whoBold.textContent = currentUserEmail;
      who.appendChild(whoBold);
      footer.appendChild(who);
      const sep = document.createElement('span');
      sep.textContent = ' · ';
      sep.style.color = '#d1d5db';
      footer.appendChild(sep);
      const signOut = document.createElement('a');
      signOut.href = '#';
      signOut.textContent = 'sign out';
      signOut.addEventListener('click', (e) => {
        e.preventDefault();
        clearGateToken();
        fcCloseBubblePanel();
        fcRemoveBubbles();
        toast('Signed out.', 'success');
      });
      footer.appendChild(signOut);
      panel.appendChild(footer);
    }

    shadow.appendChild(panel);
    fcOpenedBubblePanel = panel;
    fcPositionBubblePanel(panel, dot);

    // Dismiss on outside click. Defer to next tick so the click that opened
    // it doesn't immediately close it.
    //
    // We use a geometric hit-test against the panel/dot bounding rects rather
    // than DOM membership. The overlay shadow root is `mode: 'closed'`, which
    // means composedPath() called from a document-level listener does NOT
    // include nodes inside the shadow (per spec). `panel.contains(e.target)`
    // is similarly fooled because events retarget to the shadow host at the
    // document boundary. The bounding-rect approach sidesteps the whole
    // shadow-traversal problem — click coordinates are coordinates regardless
    // of which DOM tree the event came from.
    setTimeout(() => {
      fcBubblePanelDismiss = (e) => {
        if (!fcOpenedBubblePanel) return;
        const hit = (rect) => e.clientX >= rect.left && e.clientX <= rect.right
                            && e.clientY >= rect.top && e.clientY <= rect.bottom;
        if (hit(fcOpenedBubblePanel.getBoundingClientRect())) return;
        if (hit(dot.getBoundingClientRect())) return;
        fcCloseBubblePanel();
      };
      document.addEventListener('mousedown', fcBubblePanelDismiss, true);
    }, 0);
  }
  function fcBuildIssueRow(iss, group, currentUserEmail) {
    const row = document.createElement('div');
    row.className = 'fc-issue-row';

    const meta = document.createElement('div');
    meta.className = 'fc-issue-meta';
    if (iss.url) {
      const idLink = document.createElement('a');
      idLink.href = iss.url; idLink.target = '_blank'; idLink.rel = 'noreferrer';
      idLink.textContent = iss.identifier || '';
      meta.appendChild(idLink);
    } else if (iss.identifier) {
      const idSpan = document.createElement('strong');
      idSpan.textContent = iss.identifier;
      meta.appendChild(idSpan);
    }
    if (iss.state && iss.state.name) {
      const pill = document.createElement('span');
      pill.className = 'fc-state-pill';
      pill.textContent = iss.state.name;
      meta.appendChild(pill);
    }
    if (iss.filer) {
      const filerSpan = document.createElement('span');
      filerSpan.textContent = iss.filer;
      meta.appendChild(filerSpan);
    }
    if (iss.updatedAt) {
      const timeSpan = document.createElement('span');
      timeSpan.textContent = fcRelTime(iss.updatedAt);
      meta.appendChild(timeSpan);
    }
    row.appendChild(meta);

    const title = document.createElement('div');
    title.className = 'fc-issue-title';
    title.textContent = iss.title || '(no title)';
    row.appendChild(title);

    if (iss.note) {
      const note = document.createElement('div');
      note.className = 'fc-issue-note';
      note.textContent = iss.note;
      row.appendChild(note);
    }

    if (iss.mine) {
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
      const editBtn = document.createElement('button');
      editBtn.className = 'fc-issue-edit-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => fcSwapRowToEdit(row, iss, group, currentUserEmail));
      actions.appendChild(editBtn);
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'fc-issue-delete-btn';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => fcDeleteIssue(row, iss, group));
      actions.appendChild(deleteBtn);
      row.appendChild(actions);
    }

    return row;
  }
  async function fcDeleteIssue(row, iss, group) {
    const ok = await fcConfirm({
      title: 'DELETE ISSUE',
      body: 'Delete ' + (iss.identifier || 'this issue') + '?\n\nFor Linear-backed projects, it moves to Linear\'s trash for 30 days. For GitHub-backed projects, the Issue is closed (GitHub does not support hard delete via API). Either way, an admin can recover it.',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    const session = getStoredGateToken();
    if (!session) { toast('Session expired. Sign in again.', 'error'); return; }
    const res = await gateDeleteIssue(session.token, iss.id);
    if (!res.ok) {
      toast(res.status === 403 ? 'Only the original filer can delete this.' : (res.error || 'Delete failed.'), 'error');
      return;
    }
    // Mark so the next refresh doesn't fire a "closed in Linear" toast — the
    // user knows they just deleted it; reporting it back is noise.
    fcLocallyDeleted.add(iss.id);
    // Resolve the LIVE bubble entry by anchor identity rather than the
    // group-object reference we captured at click time. If a window.focus
    // re-rendered bubbles while the confirm dialog was open (or the user
    // paused inside it long enough for any other refresh to fire), the
    // closure's `group` is now an orphan and its `dot` is already detached.
    // Operating on the live entry guarantees the dot the user actually sees
    // gets updated.
    const anchorKey = iss.anchor ? (iss.anchor.file + ':' + iss.anchor.offset) : null;
    const liveB = anchorKey ? fcBubbles.find((x) => x.anchorKey === anchorKey) : null;
    const liveGroup = liveB ? liveB.group : group;
    row.remove();
    liveGroup.issues = liveGroup.issues.filter((x) => x.id !== iss.id);
    if (liveGroup.issues.length === 0) {
      fcCloseBubblePanel();
      if (liveB) {
        liveB.dot.remove();
        fcBubbles = fcBubbles.filter((x) => x !== liveB);
      }
    } else {
      if (liveB) fcRenderDotContents(liveB.dot, liveGroup);
      if (fcOpenedBubblePanel) {
        const header = fcOpenedBubblePanel.querySelector('.panel-title');
        if (header) header.textContent = liveGroup.issues.length === 1 ? '1 OPEN ISSUE' : liveGroup.issues.length + ' OPEN ISSUES';
      }
    }
    updateIndicator();
    toast('Deleted.', 'success');
    // Backstop: re-sync from server in case anything diverged. Cache was just
    // busted by the gate, so this hits Linear fresh.
    fcRefreshBubbles();
  }
  // Styled, in-shadow confirm dialog. Returns Promise<boolean>. Replaces
  // window.confirm() so destructive prompts match the overlay's look.
  function fcConfirm({ title, body, confirmText = 'OK', cancelText = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'palette-backdrop';

      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:400px;';
      panel.addEventListener('click', (e) => e.stopPropagation());

      const t = document.createElement('div');
      t.className = 'panel-title';
      t.textContent = title;
      panel.appendChild(t);

      const b = document.createElement('div');
      b.style.cssText = 'font-size:13px;line-height:1.5;color:#374151;margin-bottom:14px;white-space:pre-wrap;';
      b.textContent = body;
      panel.appendChild(b);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'cancel';
      cancelBtn.textContent = cancelText;

      const confirmBtn = document.createElement('button');
      confirmBtn.className = danger ? 'fc-confirm-danger' : 'save';
      confirmBtn.textContent = confirmText;

      row.appendChild(cancelBtn);
      row.appendChild(confirmBtn);
      panel.appendChild(row);
      backdrop.appendChild(panel);
      shadow.appendChild(backdrop);

      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        window.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      };
      cancelBtn.addEventListener('click', () => finish(false));
      confirmBtn.addEventListener('click', () => finish(true));
      backdrop.addEventListener('click', () => finish(false));
      window.addEventListener('keydown', onKey, true);
      setTimeout(() => confirmBtn.focus(), 50);
    });
  }
  function fcSwapRowToEdit(row, iss, group, currentUserEmail) {
    const editRow = document.createElement('div');
    editRow.className = 'fc-issue-row';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'fc-edit-input';
    titleInput.value = iss.title || '';
    titleInput.placeholder = 'Title';
    editRow.appendChild(titleInput);

    const noteTa = document.createElement('textarea');
    noteTa.className = 'fc-edit-textarea';
    noteTa.value = iss.note || '';
    noteTa.placeholder = 'Your note';
    editRow.appendChild(noteTa);

    const actions = document.createElement('div');
    actions.className = 'fc-edit-actions';
    const err = document.createElement('div');
    err.className = 'fc-edit-err';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'fc-issue-edit-btn';
    cancelBtn.textContent = 'Cancel';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'fc-issue-edit-btn';
    saveBtn.style.background = 'var(--mode-color)';
    saveBtn.style.color = '#fff';
    saveBtn.textContent = 'Save';
    actions.appendChild(err);
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    editRow.appendChild(actions);

    cancelBtn.addEventListener('click', () => {
      editRow.replaceWith(fcBuildIssueRow(iss, group, currentUserEmail));
    });
    saveBtn.addEventListener('click', async () => {
      const t = titleInput.value.trim();
      const n = noteTa.value.trim();
      if (!t) { err.textContent = 'Title required.'; titleInput.focus(); return; }
      err.textContent = '';
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      const session = getStoredGateToken();
      if (!session) { err.textContent = 'Session expired. Sign in again.'; saveBtn.disabled = false; saveBtn.textContent = 'Save'; return; }
      const res = await gateUpdateIssue(session.token, iss.id, { title: t, note: n });
      if (!res.ok) {
        err.textContent = res.status === 403 ? 'Only the original filer can edit this.' : (res.error || 'Update failed.');
        saveBtn.disabled = false; saveBtn.textContent = 'Save';
        return;
      }
      // Sync group + replace row in place.
      const updated = { ...res.issue, mine: true };
      for (let i = 0; i < group.issues.length; i++) {
        if (group.issues[i].id === iss.id) group.issues[i] = updated;
      }
      editRow.replaceWith(fcBuildIssueRow(updated, group, currentUserEmail));
    });

    row.replaceWith(editRow);
    titleInput.focus();
  }
  // Re-render on window focus + visibility change while in Test mode. This
  // is the live-update path for "admin moves issue to Done in Linear → next
  // time tester focuses the tab, bubble disappears." No background polling.
  window.addEventListener('focus', () => {
    if (activeMode === 'test') fcRefreshBubbles();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && activeMode === 'test') fcRefreshBubbles();
  });
  // v0.9.7: SPA route-change detection. Nuxt (and most SPA frameworks) navigate
  // via history.pushState — no `load` or `focus` event fires, so bubbles for
  // the new page never appear without intervention. Patch pushState +
  // replaceState to dispatch a synthetic event we can listen on, plus catch
  // the browser-driven back/forward via popstate. Small debounce lets the new
  // DOM mount before we look for anchor elements.
  (function patchHistory() {
    const fire = () => window.dispatchEvent(new Event('fc-route-change'));
    const wrap = (m) => {
      const orig = history[m];
      if (!orig || orig.__fcWrapped) return;
      const wrapped = function () { const r = orig.apply(this, arguments); fire(); return r; };
      wrapped.__fcWrapped = true;
      history[m] = wrapped;
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', fire);
  })();
  let fcRouteRefreshTimer = null;
  window.addEventListener('fc-route-change', () => {
    if (activeMode !== 'test') return;
    // Debounce — Nuxt sometimes fires multiple history events on a single
    // navigation. Wait for the dust to settle, then refresh + retry once more
    // 1.5s later in case client-rendered content arrives late.
    clearTimeout(fcRouteRefreshTimer);
    fcRouteRefreshTimer = setTimeout(() => {
      fcRefreshBubbles();
      setTimeout(fcRefreshBubbles, 1500);
    }, 150);
  });

  // ---------- Test mode (gate-backed) ----------
  // Renders an issue-report form on click; gates first use with an email +
  // password prompt that calls the gate's /api/login. JWT cached in
  // sessionStorage. Credentials are set per-tester by the gate admin.
  function openLoginPrompt(then) {
    const backdrop = document.createElement('div');
    backdrop.className = 'palette-backdrop';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:380px;';
    panel.addEventListener('click', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = 'SIGN IN TO REPORT';

    const sub = document.createElement('div');
    sub.className = 'panel-sub';
    sub.textContent = 'Use the email + password your admin set for you.';

    const inputStyle = 'width:100%;border:1px solid #d1d5db;border-radius:6px;padding:8px;font:inherit;outline:none;margin-bottom:6px;';
    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.placeholder = 'you@team.com';
    emailInput.autocomplete = 'username';
    emailInput.spellcheck = false;
    emailInput.style.cssText = inputStyle;
    const pwInput = document.createElement('input');
    pwInput.type = 'password';
    pwInput.placeholder = 'password';
    pwInput.autocomplete = 'current-password';
    pwInput.spellcheck = false;
    pwInput.style.cssText = inputStyle;
    for (const el of [emailInput, pwInput]) {
      el.addEventListener('focus', () => {
        el.style.borderColor = 'var(--mode-color)';
        el.style.boxShadow = '0 0 0 3px var(--mode-color-glow)';
      });
      el.addEventListener('blur', () => { el.style.borderColor = '#d1d5db'; el.style.boxShadow = ''; });
    }

    const err = document.createElement('div');
    err.className = 'err';
    err.style.cssText = 'font-size:11px;color:#dc2626;margin-top:2px;min-height:14px;';

    const row = document.createElement('div');
    row.className = 'row';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Esc to cancel';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel';
    cancelBtn.textContent = 'Cancel';
    const okBtn = document.createElement('button');
    okBtn.className = 'save';
    okBtn.textContent = 'Sign in';
    row.appendChild(hint); row.appendChild(cancelBtn); row.appendChild(okBtn);

    panel.appendChild(title);
    panel.appendChild(sub);
    panel.appendChild(emailInput);
    panel.appendChild(pwInput);
    panel.appendChild(err);
    panel.appendChild(row);
    backdrop.appendChild(panel);
    shadow.appendChild(backdrop);
    setTimeout(() => emailInput.focus(), 0);

    function close(result) {
      backdrop.remove();
      if (then) then(result);
    }
    async function submit() {
      const email = emailInput.value.trim();
      const password = pwInput.value;
      err.textContent = '';
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Enter a valid email.'; emailInput.focus(); return; }
      if (!password) { err.textContent = 'Enter your password.'; pwInput.focus(); return; }
      okBtn.disabled = true;
      okBtn.textContent = 'Signing in…';
      const v = await gateLogin(email, password);
      if (!v.ok) {
        if (v.status === 429) err.textContent = 'Too many attempts. Wait a minute and try again.';
        else if (v.status === 0) err.textContent = 'Could not reach the gate.';
        // 401 covers wrong password, unknown user, locked-out, no-password-set,
        // and disabled project — gate returns the same error for all of these.
        else err.textContent = 'Sign-in failed. Check with your admin if this persists.';
        okBtn.disabled = false;
        okBtn.textContent = 'Sign in';
        pwInput.select();
        return;
      }
      storeGateToken(v.token, v.expiresAt, email);
      close({ ok: true, email });
      // Fresh session → fetch the bubbles too. Test-mode was already active
      // when this prompt fired (it's how the user landed here).
      if (activeMode === 'test') fcRefreshBubbles();
    }
    cancelBtn.addEventListener('click', () => close({ ok: false }));
    okBtn.addEventListener('click', submit);
    for (const el of [emailInput, pwInput]) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); close({ ok: false }); }
      });
    }
    backdrop.addEventListener('click', () => close({ ok: false }));
  }

  function openTestPanel(target) {
    if (!GATE || !GATE.url) {
      toast('Test mode requires `gate: { url }` in the plugin config.', 'error');
      setMode(null);
      return;
    }
    const session = getStoredGateToken();
    if (!session) {
      openLoginPrompt((result) => {
        if (result && result.ok) openTestPanel(target);
        else setMode(null);
      });
      return;
    }

    editingTarget = target;
    closeChoicePicker();
    bubble.style.display = 'none';
    positionOverlays(target);

    const r = rectForTarget(target) || { top: 0, left: 0, bottom: 0, right: 0 };
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.width = '420px';

    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = 'REPORT AN ISSUE';

    const src = readDataEditSource(elementForTarget(target));
    const text = getEditableTextFromTarget(target);
    const sub = document.createElement('div');
    sub.className = 'panel-sub';
    sub.textContent = (src ? `${src.file}:${src.offset}` : 'no source ref') +
                      (session.email ? ` · ${session.email}` : '');

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.placeholder = 'Short title — what\'s wrong?';
    titleInput.spellcheck = false;
    titleInput.style.cssText = 'width:100%;border:1px solid #d1d5db;border-radius:6px;padding:8px;font:inherit;outline:none;margin-bottom:6px;';

    const ta = document.createElement('textarea');
    ta.placeholder = 'Optional: more detail, steps to reproduce…';
    ta.spellcheck = false;

    const row = document.createElement('div');
    row.className = 'row';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '⌘/Ctrl+Enter to send · Esc to cancel';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel';
    cancelBtn.textContent = 'Cancel';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'save';
    sendBtn.textContent = 'Send report';
    row.appendChild(hint); row.appendChild(cancelBtn); row.appendChild(sendBtn);

    panel.appendChild(title);
    panel.appendChild(sub);
    panel.appendChild(titleInput);
    panel.appendChild(ta);
    panel.appendChild(row);
    shadow.appendChild(panel);
    placeNear(panel, r);
    setTimeout(() => titleInput.focus(), 0);

    function close() {
      panel.remove();
      editingTarget = null;
      currentTarget = null;
      outline.style.display = 'none';
    }
    async function submit() {
      const titleVal = titleInput.value.trim();
      if (!titleVal) { toast('Add a title', 'error'); titleInput.focus(); return; }
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      const issue = {
        title: titleVal,
        description: ta.value.trim(),
        meta: {
          // v0.9.0+: structured anchor for the bubble feature. The gate persists
          // this in an fc-meta marker on the description so subsequent page
          // loads can find this element again via [data-edit-source].
          // v0.10.0+: also includes line + column so the gate can emit
          // IDE-clickable "file:line:col" in the visible issue body.
          anchor: src ? {
            file: src.file,
            offset: src.offset,
            line: src.line != null ? src.line : null,
            column: src.column != null ? src.column : null,
          } : null,
          where: src ? `${src.file}:${src.offset}` : null,
          page: location.pathname + location.search,
          locale: getActiveLocale(),
          text: text || null,
          userAgent: navigator.userAgent,
        },
      };
      const r2 = await gateReportIssue(session.token, issue);
      if (!r2.ok) {
        if (r2.status === 401) {
          clearGateToken();
          toast('Session expired or revoked. Sign in again.', 'error');
          close();
          openLoginPrompt(() => {});
          return;
        }
        // v0.11.3: prefer the human-readable .message (when present) over the
        // machine-readable .error code. The gate sets .message to a clear
        // explanation for known failure modes (e.g. PAT missing Issues:W).
        const msg = (r2.data && (r2.data.message || r2.data.error)) || 'Submission failed';
        toast(msg, 'error');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send report';
        return;
      }
      const created = r2.data && r2.data.issue;
      const ref = created ? (created.identifier || created.id) : 'created';
      toast(`Reported: ${ref}${created && created.mock ? ' (mock)' : ''}`, 'success');
      close();
      // v0.9.7: optimistically render the bubble using the data we just sent
      // — no network roundtrip in the visible path. The next refresh
      // reconciles to canonical Linear state.
      if (activeMode === 'test' && created) {
        fcInsertOptimisticBubble({
          id: created.id,
          identifier: created.identifier,
          url: created.url,
          title: titleVal,
          note: ta.value.trim(),
          filer: session.email,
          anchor: src ? {
            file: src.file,
            offset: src.offset,
            line: src.line != null ? src.line : null,
            column: src.column != null ? src.column : null,
          } : null,
          page: location.pathname + location.search,
          updatedAt: new Date().toISOString(),
          // v0.11.3: was { name: 'Backlog', type: 'unstarted' }, but
          // 'unstarted' maps to blue in fcRenderDotContents (Linear-flavored
          // "triaged Todo"). A freshly-filed bug is in the backlog and the
          // gate's reconcile pass 1.5s later returns type='backlog' → mode
          // color. Matching it here keeps the dot one color throughout, no
          // blue→yellow flash.
          state: { name: 'Open', type: 'backlog' },
        }, session.email);
      }
    }
    cancelBtn.addEventListener('click', close);
    sendBtn.addEventListener('click', submit);
    [titleInput, ta].forEach((el) => {
      el.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
    });
  }

  // ---------- Mode toggling ----------
  function applyModeColor(modeKey) {
    const m = MODES[modeKey];
    if (!m) return;
    host.style.setProperty('--mode-color', m.color);
    host.style.setProperty('--mode-color-glow', m.glow);
  }
  function setMode(modeKey) {
    if (modeKey === activeMode) return;
    // Tear down the current mode
    if (activeMode) {
      if (frame.isConnected) frame.remove();
      if (indicator.isConnected) indicator.remove();
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('click', onDocClick, true);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize, true);
      setTarget(null);
      closeChoicePicker();
      if (activeMode === 'test') fcRemoveBubbles();
    }
    activeMode = modeKey;
    // Persist the state change BEFORE any early return below — otherwise
    // setMode(null) (the "exit mode" path) sets activeMode but never reaches
    // fcSaveMode, so sessionStorage still holds the prior mode and the next
    // page load restores it. Subtle but breaks the "double-shift to exit"
    // contract: user toggles off, refreshes, mode comes back.
    fcSaveMode(modeKey);
    if (!modeKey) return;
    applyModeColor(modeKey);
    shadow.appendChild(frame);
    shadow.appendChild(indicator);
    updateIndicator();
    fetchI18nMap();
    fetchRefs();
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('click', onDocClick, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize, true);
    if (modeKey === 'test') {
      fcRefreshBubbles();
      // v0.9.7: catch late-rendering client-side content with one retry pass.
      // The gate cache makes the second call near-free (~50ms cache hit).
      setTimeout(fcRefreshBubbles, 1500);
    }
  }
  // v0.9.5: persist the active mode across page navigation + reload so testers
  // don't lose Test mode every time they click an internal link. Tab-scoped
  // (sessionStorage) — when the tab closes, the mode resets. Only restored if
  // the saved mode is still in the overlay's enabled list (prod overlays
  // restrict to ['test']).
  const FC_MODE_STORAGE_KEY = '__fc_mode';
  function fcSaveMode(modeKey) {
    try {
      if (modeKey) sessionStorage.setItem(FC_MODE_STORAGE_KEY, modeKey);
      else sessionStorage.removeItem(FC_MODE_STORAGE_KEY);
    } catch {}
  }
  function fcRestoreMode() {
    try {
      const saved = sessionStorage.getItem(FC_MODE_STORAGE_KEY);
      if (saved && ENABLED.has(saved)) setMode(saved);
    } catch {}
  }

  // ---------- Mode palette (Shift-Shift) ----------
  let activePalette = null;
  function closeModePalette() {
    if (activePalette) {
      activePalette.backdrop.remove();
      activePalette = null;
    }
  }
  function openModePalette() {
    if (activePalette) { closeModePalette(); return; }
    const backdrop = document.createElement('div');
    backdrop.className = 'palette-backdrop';
    backdrop.addEventListener('click', closeModePalette);

    const panel = document.createElement('div');
    panel.className = 'palette';
    panel.addEventListener('click', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.className = 'palette-title';
    title.textContent = 'frontend-conqueror · pick a mode';
    panel.appendChild(title);

    const optionDefs = [
      { key: 'edit', name: 'Edit text', desc: 'Hover text, click to edit. Writes to source.', kbd: 'E' },
      { key: 'todo', name: 'Dev TODO', desc: 'Hover a component, drop a // TODO comment in source.', kbd: 'T', devOnly: true },
      { key: 'test', name: 'Test / report a bug', desc: 'Hover a component, file a Linear issue.', kbd: 'B' },
    ].filter((o) => ENABLED.has(o.key));

    const buttons = [];
    optionDefs.forEach((opt, idx) => {
      const btn = document.createElement('button');
      btn.className = 'palette-option';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = MODES[opt.key].color;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = opt.name;
      const desc = document.createElement('span');
      desc.className = 'desc';
      desc.textContent = opt.desc;
      const kbd = document.createElement('span');
      kbd.className = 'kbd';
      kbd.textContent = opt.kbd;
      btn.appendChild(dot);
      btn.appendChild(name);
      btn.appendChild(desc);
      btn.appendChild(kbd);
      btn.addEventListener('click', () => {
        closeModePalette();
        setMode(opt.key);
      });
      panel.appendChild(btn);
      buttons.push({ btn, key: opt.key });
    });

    backdrop.appendChild(panel);
    shadow.appendChild(backdrop);
    activePalette = { backdrop, panel, buttons, focusIdx: 0 };
    if (buttons[0]) buttons[0].btn.classList.add('focused');
  }

  // Palette keyboard nav (arrow up/down, Enter, letter-shortcut, Esc).
  window.addEventListener('keydown', (e) => {
    if (!activePalette) return;
    const { buttons } = activePalette;
    if (e.key === 'Escape') { e.preventDefault(); closeModePalette(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[activePalette.focusIdx].btn.classList.remove('focused');
      activePalette.focusIdx = (activePalette.focusIdx + 1) % buttons.length;
      buttons[activePalette.focusIdx].btn.classList.add('focused');
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[activePalette.focusIdx].btn.classList.remove('focused');
      activePalette.focusIdx = (activePalette.focusIdx - 1 + buttons.length) % buttons.length;
      buttons[activePalette.focusIdx].btn.classList.add('focused');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      buttons[activePalette.focusIdx].btn.click();
      return;
    }
    // letter shortcut
    const key = e.key.toLowerCase();
    const hit = buttons.find((b) => MODES[b.key] && b.key[0] === key) ||
                buttons.find((b) => (b.btn.querySelector('.kbd')?.textContent || '').toLowerCase() === key);
    if (hit) { e.preventDefault(); hit.btn.click(); }
  }, true);

  // ---------- Activation: Shift-Shift mode palette + legacy ⌘+Shift+E ----------
  // v0.9.5: shift-shift toggles the active mode OFF when one is on.
  // v0.9.6: when only ONE mode is enabled (prod overlays default to ['test'])
  // there's nothing to pick — skip the palette and toggle that single mode
  // directly. Multi-mode setups (dev: edit + todo + test) keep the picker on
  // the way IN, and still toggle off on the way OUT.
  let lastShiftAt = 0;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      if (now - lastShiftAt < 300) {
        lastShiftAt = 0;
        e.preventDefault();
        if (activeMode) {
          setMode(null);
        } else if (ENABLED.size === 1) {
          const onlyMode = Array.from(ENABLED)[0];
          setMode(onlyMode);
        } else {
          openModePalette();
        }
        return;
      }
      lastShiftAt = now;
      return;
    }
    // Esc still exits any active mode (keeps existing power-user shortcut).
    if (e.key === 'Escape' && activeMode && !editingTarget && !activePicker) {
      setMode(null);
    }
  });

  // Restore the persisted mode on load. Deferred to next macrotask so all the
  // module-level functions and event listeners are wired up first.
  setTimeout(fcRestoreMode, 0);

  // While an editor panel is open, swallow any keydown that originated inside
  // our shadow DOM at the capture phase so page-level handlers (e.g., arrow-key
  // navigation on the host site) don't fire.
  window.addEventListener('keydown', (e) => {
    if (!editingTarget) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const insideOurUi = path.some((n) => n && (n === host || (n.id === HOST_ID)));
    if (insideOurUi) e.stopImmediatePropagation();
  }, true);
})();