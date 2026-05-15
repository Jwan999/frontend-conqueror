# Changelog

All notable changes to frontend-conqueror are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

When you read this in a project that depends on the plugin: each entry describes what's new since the version you have. Bump and read forward.

---

## [Unreleased]

Nothing yet. Open issues are tracked at https://github.com/Jwan999/frontend-conqueror/issues.

## [0.9.6] — 2026-05-15

### Changed
- **Single-mode setups now toggle directly with Shift-Shift instead of opening the picker.** Production overlays ship with `enabledModes: ['test']` — only one mode is available, so the picker step is wasted clicks. With one mode enabled, Shift-Shift turns Test mode on; another Shift-Shift turns it off. Dev/local setups (which usually have all three modes — edit + todo + test) keep the picker palette on the way in, since there's a real choice to make.

### Fixed
- **Double-shift to exit didn't actually exit across reloads.** `setMode(null)` set `activeMode = null` and then hit the early `return` before the new `fcSaveMode(null)` call could clear sessionStorage. The user toggled off, refreshed, and the mode came back from stored state. Move the persistence write to before the early return so every state change — including "off" — is persisted.

## [0.9.5] — 2026-05-15

### Added
- **Mode persists across navigation + reload** (tab-scoped via sessionStorage). Click an internal link, accidentally hit F5, or paste a deep URL — Test mode stays on. When the tab closes, the mode clears. The saved mode is only restored if it's still in the overlay's `enabledModes` list, so a prod overlay that ships `['test']` never restores a stale `'edit'` saved from dev.
- **Shift-Shift now toggles the active mode off.** Same shortcut, dual purpose: with no mode active it opens the picker palette (existing behavior); with a mode active it exits. Matches "double-shift is the on/off switch" mental model. The Escape shortcut still exits — kept for power-user muscle memory.
- **Styled confirm dialog** (`fcConfirm`) replacing `window.confirm()` for destructive prompts. Matches the overlay's panel aesthetic — title, body, [Cancel] / [Delete] buttons, Enter to confirm, Escape/backdrop to cancel. Reusable across any future destructive action.

### Fixed
- **Deleted issue's bubble dot didn't disappear until refresh.** The local-update path looked up the live bubble entry by *object reference* (`x.group === group`). If anything triggered `fcRefreshBubbles` between the panel opening and the confirm-dialog being acknowledged — most commonly `window.focus` if the user paused on the dialog — the closure's captured `group` is suddenly an orphan and its `dot` is detached from the DOM. The local update operated on the orphan; the freshly-rendered visible dot stayed put. Fix: look up the live entry by anchor identity (`x.anchorKey === file + ":" + offset`). A second-pass `fcRefreshBubbles()` runs as a backstop after a successful delete in case something else diverged.

## [0.9.4] — 2026-05-15

### Added
- **Delete button in the bubble panel** alongside Edit. Same ownership rules: only the original filer sees the button, and the gate enforces the same check server-side from the fc-meta marker — a stolen token can't delete someone else's issue. Click → native confirm() → Linear `issueDelete` mutation. Soft-delete (30-day trash); an admin can restore from the Linear UI if it was a mistake. On success the row disappears from the panel locally; if it was the last issue at that anchor, the panel closes and the bubble dot is removed too — no extra Linear round-trip.
- **`DELETE /api/issues/:id`** on the gate. JWT-bearer-gated, rate-limited (10/min/IP), busts the issues cache so other testers see the deletion on their next refresh.

## [0.9.3] — 2026-05-15

### Fixed
- **Edit button STILL dismissed the bubble panel after the v0.9.2 `composedPath` attempt.** Per spec, `composedPath()` called from outside a *closed* shadow root **does not include** the nodes inside the shadow — so the document-level dismiss listener saw an empty-ish path, decided the click was outside the panel, and removed it before the Edit button's click handler could fire. Our overlay shadow root is `mode: 'closed'` (a deliberate isolation choice), so neither `Node.contains` nor `composedPath` can detect inside-panel clicks from a document listener. Fix: do a plain geometric hit-test against the panel/dot bounding rects. Click coordinates work the same regardless of which DOM tree the event originated in.

## [0.9.2] — 2026-05-15

Two UI fixes on top of v0.9.1's data fixes.

### Fixed
- **Edit button in the bubble panel did nothing — and the panel disappeared instead.** The outside-click dismiss handler listens on `document` for `mousedown`. The bubble panel lives inside a closed shadow root, so the event gets retargeted to the shadow host before reaching the document listener — `panel.contains(e.target)` returned false even for clicks *inside* the panel, so the handler thought you'd clicked outside and dismissed before the Edit button's click could fire. Fix: use `e.composedPath()` (which walks through the shadow boundary) for the inside-panel check.
- **Bubble dots floated above the new-issue report form.** `.fc-bubble-host` had `z-index: 2147483645`, beating every `.panel` (none of which set an explicit z-index). Fix: drop the z-index from `.fc-bubble-host` entirely. The bubble host now stacks at the default within the shadow root, so any panel opened later (test-report form, edit popup, login prompt) paints on top via normal document order. Bubbles still float above page content because the shadow host itself is already pinned at the top of the page's stacking order.

## [0.9.1] — 2026-05-15

Hotfix for v0.9.0's bubble feature. Two prod issues surfaced the day after release:

### Fixed
- **Linear auto-linker mangled the fc-meta JSON.** When the filer email (or any URL) appeared inside the `<!-- fc-meta: {…} -->` HTML comment, Linear's renderer rewrote it as a Markdown link with a `<mailto:…>` URL — even inside HTML comments — corrupting the JSON. `parseFcMeta` would fail and the issue dropped out of `/api/issues`, so no bubble. Fix: payload is now base64-encoded as `<!-- fc-meta-b64: BASE64 -->`. No `@` or `://` for the auto-linker to grab onto. Parser still reads the v0.9.0 raw-JSON form and applies a salvage regex (`[CONTENT](<mailto:…>)` → `CONTENT`) so issues filed in the brief v0.9.0 window are recoverable on the next refresh.
- **Cloudflare ignored the gate's overlay `Cache-Control`** and pinned the file for 4 hours under its default policy, meaning overlay hotfixes didn't reach testers until the proxy TTL expired. Fix: the gate now sends `Cache-Control: public, max-age=300, s-maxage=300, must-revalidate` — `s-maxage` is the one Cloudflare honors. Pair with a `?v=<version>` query on the consumer's `<script src>` to bust already-cached entries on each upgrade.

### Doc
- DEPLOY hint: when shipping an overlay change, bump the `?v=` query in your `nuxt.config.js` `head.script` entry. The gate's `s-maxage` only helps once Cloudflare fetches the new file; the version query forces that fetch immediately.

## [0.9.0] — 2026-05-15

**Persistent report bubbles.** When a tester files an issue from Test mode, a small mode-colored dot now stays anchored to that element on the page. Hover/click → list of every open issue at that anchor, with the filer, the note, a link to Linear, and an inline edit button for the original filer. Bubbles disappear automatically the next time the tester focuses the tab if the issue has moved to a Linear state of `type: completed` or `type: canceled` — covering Done / Canceled / Duplicate / any other "closed" state the team has, regardless of display name.

### Added
- **`<!-- fc-meta: {…} -->` marker** appended to every issue description the gate creates. Carries `{ v, anchor, page, filer, title, note }` so the overlay can recover the bubble anchor on later page loads. Plain HTML comment → invisible in Linear's rendered view.
- **`GET /api/issues?page=`** (gate). JWT-gated (Bearer). Returns open issues for the current project filtered to the requested page URL. Filters out `state.type IN (completed, canceled)` at the Linear level. 30s in-memory cache keyed by project so dozens of testers loading the same page share a single Linear call.
- **`PUT /api/issues/:id`** (gate). JWT-gated. Body `{ title?, note? }`. Server-side ownership check against `fc-meta.filer` — returns `403 not-owner` if anyone else tries to edit. Rebuilds the description (preserving the marker) and calls `issueUpdate`. Busts the cache.
- **Bubble UI** (overlay). Renders only while in Test mode and only for logged-in testers. One bubble per unique `data-edit-source` anchor; if N>1 issues share the anchor, the dot shows a count and the panel lists all N. Hover panel surfaces filer, state name, relative time, issue ID linking to Linear. Edit button only appears on issues you filed. Click outside to dismiss; Escape from the edit form to cancel.
- **`window.focus` refresh.** When the tester switches back to the tab, the bubble list re-fetches — that's how Done/Canceled state changes propagate from Linear back into the overlay. No background polling: zero traffic while the tab is idle.

### Changed
- Overlay's `report-issue` payload now carries a structured `meta.anchor = { file, offset }` alongside the existing human-readable `meta.where` string. Older overlays (v0.7/v0.8) still work — the gate salvages anchor data from the legacy `where` string when no structured anchor is present.
- Linear API helpers expanded: `fetchLinearOpenIssues`, `fetchLinearIssue`, `updateLinearIssue`.

### Compatibility
- **Mixed-version safe.** v0.7/v0.8 overlays talking to a v0.9 gate keep working — they just don't render bubbles. v0.9 overlays talking to a v0.7/v0.8 gate get a 404 on the bubble endpoints and silently skip rendering (bubbles are a soft feature, no user-facing error).
- Issues filed before v0.9.0 don't have an fc-meta marker so they never get a bubble. Only new reports surface. No backfill needed.

### What you'll need to test in prod
- File a new test-mode issue → confirm the bubble appears on the element after a brief delay.
- Move it to Done (or Canceled) in Linear → switch focus to another tab and back → bubble should disappear.
- File a second issue on the same element → bubble should now show `2` and list both.
- Try to edit a teammate's issue → server returns 403 (UI just doesn't show the Edit button for non-filers).

## [0.8.0] — 2026-05-14

**Test-mode auth: email → email + password.** The email-only allowlist was theatre — anyone who knew an allowlisted address could file issues. v0.8.0 replaces it with per-tester passwords set by the gate admin.

### Added
- **Per-tester credentials.** The gate now stores `users: { [email]: { passwordHash, lastLoginAt, lockedUntil, ... } }` per project. Passwords are scrypt-hashed (Node built-in, no deps). Min length 8.
- **`POST /api/login`** — overlay endpoint. Returns the same JWT shape as before (`token`, `expiresAt`) on success, identical `invalid-credentials` response for every failure mode (unknown user, wrong password, locked, no password set, project disabled) so callers can't enumerate.
- **Per-email lockout.** 5 wrong passwords for the same email triggers a 15-minute lock. Correct password is rejected during lockout. Lock clears on password reset.
- **Admin user CRUD.** `PUT /frontend-conqueror/projects/:key/users { email, password }` adds or sets a password; `DELETE /frontend-conqueror/projects/:key/users/:email` removes. Per-IP rate limits on `/api/login` (20/min) and existing limits on `/api/report-issue` apply unchanged.
- **Setup wizard step 5** now collects email **and** password for the first tester so a freshly configured project is immediately usable.

### Changed
- **Admin Testers card rebuilt.** Shows each tester's status (active / needs-password / locked), last login, and per-row "set password" + "remove" controls. Add-tester row takes email + password together.
- **Overlay sign-in panel rebuilt.** Two fields (email + password) instead of one. Surfaces 429 rate-limit and network-unreachable distinctly; collapses every other failure into "Sign-in failed. Check with your admin if this persists."
- **`POST /api/verify-email`** now returns `410 Gone` with a hint pointing at `/api/login`. Old overlay versions get a clear error rather than a silent break.
- Project shape: `emails: []` → `users: {}`. The admin list summary surfaces `usersCount` + `usersNeedingPassword`; the project detail returns a `users[]` array (with `hasPassword`, `locked`, `lastLoginAt`) — password hashes are never sent to the client.

### Migration (automatic, in-place)
- On first load, every project's `emails: ["x@y.com", ...]` is converted to `users: { "x@y.com": { passwordHash: null, ... } }` and the legacy `emails` field is deleted. **No tester can log in until the admin sets a password** — the project page shows a "⚠ N tester(s) migrated from email-only mode and need a password set before they can log in." line.
- The legacy `PUT /projects/:key/emails` admin endpoint returns `410 Gone` with a pointer to the new shape.

### Compatibility
- **Breaking for the overlay.** v0.7.x overlays talking to a v0.8.0 gate will get a 410 on sign-in and fail clearly. Update the overlay (or use the gate-served `/<project>/overlay.js`, which is always in lock-step with the gate).
- v0.8.0 overlays talking to a v0.7.x gate will fail on `/api/login` with 404. Upgrade the gate.
- Existing JWTs issued by the v0.7.x gate continue to be honoured by the v0.8.0 gate **only if the email still maps to a user record** (which the migration guarantees) — but reports filed with those tokens still work transparently until they expire.

## [0.7.2] — 2026-05-14

### Fixed
- **Overlay UI no longer mirrors on RTL host pages.** When the plugin ran on Arabic / Hebrew / Persian / Urdu sites (anywhere `<html dir="rtl">`), the chrome (palette, panels, buttons, hint text) inherited the host page's direction and rendered mirrored — labels on the wrong side, buttons reversed, "?" appearing at the start of placeholder text instead of end. The shadow root now explicitly locks `direction: ltr; text-align: left; unicode-bidi: isolate;` and the host element gets `dir="ltr" lang="en"`. Per-locale RTL still applies inside the multi-locale editor's individual translation textareas (where it should — Arabic translations should render RTL).

## [0.7.1] — 2026-05-14

Hotfix for two JS-syntax errors in the gate's admin UI that produced a blank page on first visit.

### Fixed
- Step 3 of the setup wizard had unescaped backticks in display text (`gate.project = '...'`) that closed the surrounding tagged-template-literal early. Replaced with `<code>` HTML tags.
- Step 4 of the setup wizard used `await` inside a non-async function. Wrapped the affected block in an `(async () => { ... })()` IIFE matching the same pattern used by the project-configure wizard.

### Compatibility
- No behavior change. Pure parse-error fix. Existing v0.7.0 deploys with a configured gate keep working — only the first-time setup wizard render was broken.

## [0.7.0] — 2026-05-13

**The big bullet-proofing release.** Edit mode now traces template expressions through the component's script back to their actual source — i18n calls, hardcoded literals, v-for iterations, computed properties — without needing the user to know about i18n keys. Picker stays as last resort.

### Added
- **Per-`.vue` symbol table.** Each `.vue` file's `<script>` is parsed once and every top-level declaration is resolved to its value shape: `i18n-call` (with key), `string-literal` (with byte offset), `array` (with item shapes), `object` (with property map), `conditional` (with branches). Walks through `computed(() => ...)`, `ref(...)`, arrow-function expression bodies, single-return block bodies.
- **Template expression resolver.** For each `{{ expr }}` interpolation, parses the expression with Babel and traces it: Identifier → lookup, MemberExpression → chain into property tree (supports numeric indices `arr[3]`), CallExpression → i18n call detection, ConditionalExpression / LogicalExpression / BinaryExpression+ → recurse all branches.
- **v-for binding tracking.** Template walker maintains a scope stack: entering a node with `v-for="link in links"` pushes `{ variable: 'link', source: resolved(links) }`. When the resolver hits `link.label`, it broadcasts the property access across every array item, yielding all candidate i18n keys. Multi-locale editor opens with the right one auto-picked by displayed value.
- **`data-edit-script-loc` attribute** emitted when an interpolation traces to a literal JS string in the script (`const TITLE = 'Welcome'; <h1>{{ TITLE }}</h1>`). Overlay reads it, opens editor with the script byte range — no grep, no value lookup.
- **Cross-reference table** (`/__frontend-conqueror/refs.json`). Each `.vue` file records which i18n keys its script references. Overlay fetches this alongside the map and uses it for ancestor-aware ranking.
- **Ancestor-aware picker ranking.** When ranking picker candidates, the overlay walks DOM ancestors collecting `data-edit-source` files. Candidates whose key is referenced by any ancestor file get the strongest boost — solves the cross-component v-for case (parent passes prop to child that renders it) without full data-flow analysis. If the boosted candidate is unique, the picker is skipped entirely.

### Changed
- `resolveInterpolationAttr()` is now the single entry point for interpolation attribute emission. Tries the new resolver first; falls back to the legacy `parseMemberChain` / `parseI18nCall` / `findAllI18nCalls` chain when the resolver can't decide. No behavior regression for cases that worked before.
- `rankCandidates()` and `pickClearWinner()` now factor in ancestor-reference signal before semantic-context signal.

### Behavior matrix (what each pattern resolves to now)

| Template pattern | Plugin emits | Resolution path |
|---|---|---|
| `<h1>Hello</h1>` | `data-edit-loc` | Direct byte range |
| `<h1>{{ $t('foo') }}</h1>` | `data-edit-i18n-path="foo"` | Path identity |
| `<h1>{{ cond ? $t('a') : $t('b') }}</h1>` | `data-edit-i18n-paths="a\|b"` | Value match |
| `<h1>{{ pageTitle }}</h1>` (computed = $t('foo')) | `data-edit-i18n-path="foo"` | **NEW: traced via symbol table** |
| `<li v-for="x in arr">{{ x.label }}` (arr = `[{label: $t('a')}, ...]`) | `data-edit-i18n-paths="a\|b\|..."` | **NEW: v-for scope tracking** |
| `<h1>{{ items[0] }}</h1>` (items = `['Hello']`) | `data-edit-script-loc="<file>:<off>:<len>:string-literal"` | **NEW: script byte range** |
| `<a>{{ link.label }}` in child where parent passes prop | (resolver dyn) | **NEW: picker boosts by ancestor-references** |

### Compatibility
- **No breaking changes.** All existing modes work identically. Plugin options unchanged. Agent kinds unchanged. Adds new emit (`data-edit-script-loc`) and new endpoint (`/refs.json`) — old overlay versions ignore both gracefully.
- Resolver is additive: when it can't decide (`dyn: true`), the existing detectors take over unchanged.

## [0.6.1] — 2026-05-13

Three focused fixes to make the resolver behave the way a user expects.

### Fixed
- **`openEditor` now awaits a fresh i18n map** before deciding which editor to open. Previously the map was invalidated after a write but the next click read the stale cached copy synchronously — meaning after editing a value, the next click on the same text could miss the path match and fall through to single-field instead of opening the multi-locale editor.
- **Single-candidate value-lookup now routes through `openEditorForEntry`**, which runs the multi-locale check. Previously the single-field editor opened directly, missing parallel translations.
- **Picker auto-picks when there's a clear winner.** When ranking yields exactly one candidate with a strong semantic-context match (e.g., only one path matches `nav.*` and the element is inside `<nav>`), the picker is skipped and the editor opens directly. Picker is now truly a last resort.

### Behavior change
- For multilingual sites: any edit that resolves to an i18n key with parallel locale entries now opens the multi-locale editor, regardless of whether the entry came from a path attribute, value lookup, or the picker. One uniform path through `openEditorForEntry`.

## [0.6.0] — 2026-05-13

Bullet-proofs Edit mode against the most common dynamic-text patterns. **Path identity now works for indirect cases (v-for items, computed text, hardcoded arrays), with a disambiguation picker as the fallback when static analysis can't pick a single source.**

### Added
- **Disambiguation picker.** When a clicked text matches multiple sources (e.g., a translation value reused across N keys, or text rendered via `{{ item.label }}` in a v-for), the overlay now shows a panel listing every candidate ranked by relevance — clicking one opens the editor (single or multi-locale) with that as the active entry. Replaces silent "Cannot safely edit" rejections.
- **Candidate ranking heuristic.** Picker entries are ordered by: (1) active-locale match first, (2) semantic context match (paths starting with `nav.` when clicked inside `<nav>`, `footer.` inside `<footer>`, etc.), (3) shorter paths preferred as more canonical. The first row gets a "recommended" badge.
- **`.vue` script-block scanner.** Plugin now parses every `.vue` file's `<script>` / `<script setup>` block and indexes top-level variable declarations containing strings:
  - `const navItems = ['Home', 'About']` → each string editable by byte range
  - `const links = [{ label: 'Home', to: '/' }]` → each `label` editable; skips non-text keys (`to`, `href`, `src`, `icon`, etc.)
  - `const PAGE_TITLE = 'Welcome'` → editable
  - Template literals supported with quasi-level byte ranges (like the existing TS i18n scanner)
- **Per-file script-entry cache** that updates on every `transform()` Vite invocation and merges into the `/__frontend-conqueror/map.json` endpoint.

### Improved
- **Editor opens with the picker's chosen path baked in.** When you pick a candidate from the picker, the editor shows a header like `Edit this source — nav.contests · ar` so you can see exactly what byte range you're about to write.
- **`openEditor` is now a router.** Decides between three paths: direct multi-locale editor (when an i18n path has parallel translations), picker (when multiple candidates match by value), or single-field editor (when there's one or zero matches).

### Fixed
- "Found N matches across N files. Cannot safely edit." rejection on text rendered through indirection patterns. The picker now surfaces those candidates instead.
- Navbar-style v-for patterns (`navLinks.value = [{ label: t('nav.contests') }]; <a v-for="link in navLinks">{{ link.label }}</a>`) — value lookup finds the i18n entry, picker disambiguates if multiple keys share the same translation.

### Plugin output diagnostic
- Startup log now reads e.g. `[frontend-conqueror] i18n=app/i18n.ts json=en:i18n/locales/en.json,ar:i18n/locales/ar.json roots=[t,$t,i18n,messages] vue=on ast=on script-scan=on` — the new `script-scan` flag shows the .vue-script extractor is active.

### Compatibility
- No breaking changes. Plugin options unchanged. Adds entries to the existing map endpoint shape; overlay falls back to single-field editor if it can't find candidates.

## [0.5.2] — 2026-05-13

### Added
- **Compound i18n expressions get path identity.** Templates like `{{ cond ? $t('a') : $t('b') }}` (ternary), `{{ x || $t('y') }}` (logical), and `{{ prefix + $t('z') }}` (concat) now emit `data-edit-i18n-paths="a|b|..."`. The overlay picks whichever path's value matches the displayed text — no more falling through to grep. Unblocks the most common "dynamic copy" patterns in production Vue templates.
- `findAllI18nCalls()` helper in the plugin: scans an expression string for every i18n call (`$t('key')`, `t('key')`, `this.$t('key')`), deduped.

### Fixed
- Editing text rendered by a ternary expression (`isAuthenticated ? $t('a') : $t('b')`) no longer falls back to v0 grep — which was causing "Found 2 matches across 2 files" errors on projects with duplicate locale directories or repeated string values.

## [0.5.1] — 2026-05-13

Lands the rest of [#4](https://github.com/Jwan999/frontend-conqueror/issues/4) — **JSON i18n is now Tier 1**. Edit mode works precisely on Nuxt + `@nuxtjs/i18n` JSON bundles, Laravel `lang/*.json`, and any vue-i18n JSON-mode project.

### Added
- **JSON locale-file scanner.** New plugin option `i18nJsonFiles: { en: 'i18n/locales/en.json', ar: 'i18n/locales/ar.json', ... }`. If omitted, the plugin auto-discovers common Nuxt-i18n paths (`i18n/locales/<locale>.json`, then root `locales/<locale>.json`). Each leaf string in the JSON becomes an editable entry with byte-range identity, so edits land in the exact spot — no grep, no ambiguity.
- **`$t('key.path')` call-form detection** in `.vue` templates. Previously only member-chain access (`$t.foo.bar`) was recognized for path identity. Function-call form is now first-class, which unblocks Nuxt + vue-i18n which always uses `$t('...')`.
- **Multi-locale editor.** When you click an i18n-keyed text in Edit mode, the panel now shows **one field per locale** side-by-side (English, Arabic, French, …) with each translation pre-filled. Edit any subset, hit Save, and the agent writes each changed locale's JSON file by exact byte range. Arabic / Hebrew / Persian / Urdu fields automatically render RTL.
- **Agent: `json-string` edit kind.** Validates the on-disk JSON string matches `oldText` (after JSON-unescape), then replaces with `JSON.stringify(newText)` so output stays a valid JSON literal regardless of newlines, quotes, or escapes in the new value.

### Changed
- Plugin's startup log line now shows JSON locales found: `[frontend-conqueror] i18n=app/i18n.ts json=en:i18n/locales/en.json,ar:i18n/locales/ar.json …`.

### Fixed
- "Found N matches across N files. Cannot safely edit." rejection on Nuxt + JSON i18n projects (was the v0.5.0 reality, now resolved when keys exist in the plugin's i18n map).

### Compatibility
- Existing plugin configs without `i18nJsonFiles` automatically benefit from auto-discovery if locale files exist at conventional paths.
- TS object-literal i18n scanner unchanged.
- Agent's other edit kinds (`raw`, `string-literal`, `template-quasi`) unchanged.

## [0.5.0] — 2026-05-13

Major feature release: **one gate can now serve any number of projects**, with a redesigned admin and heartbeat-based auto-discovery. Existing v0.4.x singleton deploys keep working — data migrates on first load.

### Added
- **Multi-project gate.** A single gate process now hosts N projects with shared Linear API key (overridable per project) and per-project tester allowlists. The Linear destination is per-project.
- **Plugin option:** `gate: { url, project }`. The `project` key identifies which project on the gate to report to.
- **Two overlay URL forms** so prod HTML can be project-aware without inline config:
  - `/<project>/overlay.js` (recommended) — gate bakes project key into the overlay config server-side.
  - `/overlay.js?project=<key>` — query-string form for callers that can't customize paths.
- **Heartbeat endpoint** (`POST /api/heartbeat`). Overlay pings on load and every 5 minutes while the page stays open. Auto-creates pending projects so new plugin installs surface in the admin without manual "Add project" clicks.
- **Per-project activity tracking:** origins seen, page URLs (rolling 100), daily-unique-IP count (IPs hashed daily, never stored raw), heartbeat counts, reports filed.
- **Rewritten admin UI** — three focused screens (project list, project detail, global settings), a 5-step first-time setup wizard, and a 2-step quick wizard for activating pending projects.
- **Pending / active / disabled** project statuses. Pending projects appear at the top of the list with a one-click "Configure" CTA.

### Changed
- **Admin URL is now stable** at `/frontend-conqueror` regardless of `GATE_PROJECT_NAME`. Each project's detail page is at `/frontend-conqueror#/p/<key>`.
- **Gate routes refactored:**
  - `POST /api/verify-email` now takes `project` in the body (falls back to the gate's default project if exactly one active project exists).
  - `POST /api/report-issue` reads `project` from the tester JWT.
  - New project CRUD: `POST/PUT/GET/DELETE /frontend-conqueror/projects[/:key][/emails|/linear-project]`.
  - Global Linear endpoints operate on top-level `data.linear` instead of `data.settings.linear`.
- **JWT shape:** tester tokens now include a `project` claim. Tokens issued by v0.4.x are rejected with `stale-token` — testers re-verify their email once. One-time UX cost on upgrade.
- Overlay heartbeats fire automatically when `gate.project` is set; no-op otherwise.

### Migration
- **Old `data.json`** (`settings: { projectName, emails, linear }`) is migrated on first load into the new shape: top-level `linear` (shared key + team) and `projects: { [key]: { ... } }` with the migrated singleton as the first project (status: `active`). The migration is non-destructive and idempotent.
- **Existing plugin configs** with `gate: { url }` (no `project`) keep working as long as exactly one active project exists on the gate (the gate falls back to it). Set `gate.project` explicitly once you have multiple.

### Compatibility
- Existing PM2 / Docker / systemd deploys unchanged. Same env vars (`GATE_PORT`, `GATE_HOST`, `GATE_DATA`, `GATE_PUBLIC_URL`, `GATE_JWT_SECRET`, `GATE_ADMIN_PASSWORD`).
- New optional env var: `GATE_DEFAULT_PROJECT` — picks which project handles ambiguous-project requests when multiple are active.

## [0.4.1] — 2026-05-13

### Added
- **[DEPLOY.md](./DEPLOY.md)** — full step-by-step production deployment guide. Covers the gate-is-project-specific architecture, per-stack wiring (Nuxt / Vite / Laravel-Blade), three deploy targets (PM2 sidecar / Docker sidecar / systemd unit), reverse proxy (Caddy / nginx), first-time admin setup, and troubleshooting.
- **[examples/](./examples)** directory with copy-pasteable, working config templates:
  - `nuxt.config.example.js`, `vite.config.example.js`, `vite.config.laravel.example.js`
  - `admin.blade.example.php` for Laravel views
  - `ecosystem.config.example.cjs` for PM2
  - `docker-compose.example.yml` for containerized deploys
  - `frontend-conqueror-gate.service.example` for systemd
  - `Caddyfile.example` + `nginx.example.conf` for reverse proxying
  - `.env.example` for gate secrets

### Changed
- README now points at DEPLOY.md and examples/ instead of inlining a short production-deploy snippet.

### Notes
- No code changes; this is a docs + templates release. Adopters on v0.4.0 don't need to bump for functionality, but bumping picks up the examples.

## [0.4.0] — 2026-05-13

### Added
- **Auto-spawned agent.** The plugin now spawns the agent as a child process when the Vite dev server starts and kills it on shutdown. No more "run this in a second terminal." Opt-out with `autoStartAgent: false`. ([install docs](./README.md#quick-start-local-dev))
- **`STACKS.md`** — full compatibility matrix across Vue/Nuxt/React/Svelte/Astro/Laravel and more, with each gap row linking to its tracking issue. Updated as issues close.
- **GitHub issues #1–#6** filed for every gap in `STACKS.md` so adopters can vote / watch / contribute.

### Changed
- Agent CLI now accepts a port as the second positional arg (`node agent/server.js /path 54322`) so multiple projects can run side-by-side.
- README "What it doesn't have yet" section now links to live issue trackers instead of free-text bullets.

### Compatibility
- No breaking changes. v0.3.0 configs work unchanged; auto-spawn defaults to `true` but old "second terminal" workflow still works if you pass `autoStartAgent: false`.

## [0.3.0] — 2026-05-13

### Added
- Initial public release.
- **Edit mode** — hover any text node in `.vue` template, edit in-place, source file rewritten by exact byte range. Supports raw template text, i18n object-literal leaves, and template-literal quasis. Validates on-disk bytes match expected `oldText` before writing (rejects with `out-of-sync` if drifted).
- **Dev TODO mode** — hover any component, drop a `// TODO (TICKET-XXX): …` note that lands at the element's opening tag with indentation preserved.
- **Test mode** — production-safe; hover a component, file a Linear issue via the gate (server-side allowlist + Linear API key never leaves the gate).
- **Gate service** — zero-dep Node HTTP server. scrypt-hashed admin password, HMAC-signed JWT cookies, per-IP rate limiting (login 5/min, verify-email 10/min, report-issue 20/min). Constant-time compares throughout.
- **Production gating** — Edit and Dev TODO are config-trimmed out in prod bundles (`enabledModes: ['test']`). Agent WebSocket isn't attempted, i18n-map fetch is skipped.
- **Shift+Shift palette** — double-tap activation, works cross-platform without conflicting with browser shortcuts.

### Stack support
- Tier 1: Vue 3 + Vite, Nuxt 3/4, TS/JS object-literal i18n.
- Tier 3 (Test mode only): React/Next/Svelte/Astro/Solid/Qwik.
- Tier 4 (Test mode only): Laravel + Blade, `lang/*.php`.

See [STACKS.md](./STACKS.md) for the full matrix.

---

[Unreleased]: https://github.com/Jwan999/frontend-conqueror/compare/v0.7.2...HEAD
[0.7.2]: https://github.com/Jwan999/frontend-conqueror/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/Jwan999/frontend-conqueror/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Jwan999/frontend-conqueror/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/Jwan999/frontend-conqueror/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Jwan999/frontend-conqueror/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/Jwan999/frontend-conqueror/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Jwan999/frontend-conqueror/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Jwan999/frontend-conqueror/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Jwan999/frontend-conqueror/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Jwan999/frontend-conqueror/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Jwan999/frontend-conqueror/releases/tag/v0.3.0
