# Changelog

All notable changes to frontend-conqueror are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

When you read this in a project that depends on the plugin: each entry describes what's new since the version you have. Bump and read forward.

---

## [Unreleased]

Nothing yet. Open issues are tracked at https://github.com/Jwan999/frontend-conqueror/issues.

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

[Unreleased]: https://github.com/Jwan999/frontend-conqueror/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/Jwan999/frontend-conqueror/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Jwan999/frontend-conqueror/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Jwan999/frontend-conqueror/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Jwan999/frontend-conqueror/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Jwan999/frontend-conqueror/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Jwan999/frontend-conqueror/releases/tag/v0.3.0
