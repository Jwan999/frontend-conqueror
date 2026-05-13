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
  async function gateVerifyEmail(email) {
    const r = await fetch(`${GATE.url}/api/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, project: gateProject() || undefined }),
    });
    if (!r.ok) return { ok: false, status: r.status };
    const data = await r.json();
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

  // ---------- Heartbeat ----------
  // Lets the gate auto-discover this project and surface activity to the admin.
  // Fired on load and every 5 minutes while the page stays open.
  // No-op (and fail-silent) when no gate or no project key configured.
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
      }).catch(() => {});
    } catch {}
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
  if (GATE && GATE.url) {
    fetch(GATE.url + '/api/mode-colors', { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (j) applyModeColorsFromGate(j.modeColors); })
      .catch(() => {});
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
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host, * { box-sizing: border-box; }
    :host {
      /* Single source of truth for the active mode color. Future modes will
         only need to swap --mode-color on the host. */
      --mode-color: #2563eb;
      --mode-color-glow: rgba(37, 99, 235, 0.45);
    }
    .frame {
      position: fixed; inset: 0;
      pointer-events: none;
      box-shadow: inset 0 0 0 4px var(--mode-color),
                  inset 0 0 32px var(--mode-color-glow);
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
    indicator.textContent = connected ? 'EDIT MODE' : 'EDIT MODE (offline)';
    indicator.classList.toggle('disconnected', !connected);
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
  function invalidateI18nMap() { i18nMapPromise = null; fetchI18nMap(); }

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

  function findByPath(path, locale) {
    if (!i18nMap) return null;
    const inLocale = i18nMap.filter((e) => e.path === path && e.locale === locale);
    if (inLocale.length === 1) return inLocale[0];
    if (inLocale.length > 1) return null;
    const any = i18nMap.filter((e) => e.path === path);
    if (any.length === 1) return any[0];
    return null;
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

  function openEditor(target) {
    editingTarget = target;
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
    let activeEntry = null;   // when set, overrides buildEditMessage with explicit entry
    let activeText = originalText;
    const probe = buildEditMessage(targetEl, originalText, originalText, 0);
    const directlyResolved = probe.type === 'edit-loc';
    const compositions = directlyResolved ? [] : findCompositions(originalText, getActiveLocale());

    const ta = document.createElement('textarea');
    ta.value = originalText;
    ta.spellcheck = false;

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
    linearLabel.textContent = 'Linear ticket (optional):';
    const linearInput = document.createElement('input');
    linearInput.placeholder = 'MES-123';
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

  // ---------- Test mode (gate-backed) ----------
  // Renders an issue-report form on click; gates first use with an email prompt
  // that calls the gate's /api/verify-email. JWT is cached in sessionStorage.
  function openEmailPrompt(then) {
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
    sub.textContent = 'Enter your team email. We verify against the project allowlist.';

    const input = document.createElement('input');
    input.type = 'email';
    input.placeholder = 'you@team.com';
    input.spellcheck = false;
    input.style.cssText = 'width:100%;border:1px solid #d1d5db;border-radius:6px;padding:8px;font:inherit;outline:none;';
    input.addEventListener('focus', () => {
      input.style.borderColor = 'var(--mode-color)';
      input.style.boxShadow = '0 0 0 3px var(--mode-color-glow)';
    });
    input.addEventListener('blur', () => { input.style.borderColor = '#d1d5db'; input.style.boxShadow = ''; });

    const err = document.createElement('div');
    err.className = 'err';
    err.style.cssText = 'font-size:11px;color:#dc2626;margin-top:6px;min-height:14px;';

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
    okBtn.textContent = 'Continue';
    row.appendChild(hint); row.appendChild(cancelBtn); row.appendChild(okBtn);

    panel.appendChild(title);
    panel.appendChild(sub);
    panel.appendChild(input);
    panel.appendChild(err);
    panel.appendChild(row);
    backdrop.appendChild(panel);
    shadow.appendChild(backdrop);
    setTimeout(() => input.focus(), 0);

    function close(result) {
      backdrop.remove();
      if (then) then(result);
    }
    async function submit() {
      const email = input.value.trim();
      err.textContent = '';
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Enter a valid email.'; return; }
      okBtn.disabled = true;
      okBtn.textContent = 'Verifying…';
      try {
        const v = await gateVerifyEmail(email);
        if (!v.ok) {
          // Identical message for 403 and 404 so an outsider can't enumerate.
          err.textContent = 'Sign-in failed.';
          okBtn.disabled = false;
          okBtn.textContent = 'Continue';
          return;
        }
        storeGateToken(v.token, v.expiresAt, email);
        close({ ok: true, email });
      } catch (e) {
        err.textContent = 'Could not reach the gate.';
        okBtn.disabled = false;
        okBtn.textContent = 'Continue';
      }
    }
    cancelBtn.addEventListener('click', () => close({ ok: false }));
    okBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close({ ok: false }); }
    });
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
      openEmailPrompt((result) => {
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
    sendBtn.textContent = 'Send to Linear';
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
          openEmailPrompt(() => {});
          return;
        }
        toast((r2.data && r2.data.error) || 'Submission failed', 'error');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send to Linear';
        return;
      }
      const created = r2.data && r2.data.issue;
      const ref = created ? (created.identifier || created.id) : 'created';
      toast(`Reported: ${ref}${created && created.mock ? ' (mock)' : ''}`, 'success');
      close();
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
    }
    activeMode = modeKey;
    if (!modeKey) return;
    applyModeColor(modeKey);
    shadow.appendChild(frame);
    shadow.appendChild(indicator);
    updateIndicator();
    fetchI18nMap();
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('click', onDocClick, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize, true);
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
  let lastShiftAt = 0;
  window.addEventListener('keydown', (e) => {
    // Shift-Shift double-tap (≤300 ms) — opens the mode picker palette.
    if (e.key === 'Shift' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      if (now - lastShiftAt < 300) {
        lastShiftAt = 0;
        e.preventDefault();
        openModePalette();
        return;
      }
      lastShiftAt = now;
      return;
    }
    // Esc exits any active mode.
    if (e.key === 'Escape' && activeMode && !editingTarget && !activePicker) {
      // Only if no editor panel is open (Esc inside panel closes the panel)
      setMode(null);
    }
  });

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