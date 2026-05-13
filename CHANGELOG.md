# Changelog

All notable changes to frontend-conqueror are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

When you read this in a project that depends on the plugin: each entry describes what's new since the version you have. Bump and read forward.

---

## [Unreleased]

Nothing yet. Open issues are tracked at https://github.com/Jwan999/frontend-conqueror/issues.

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

[Unreleased]: https://github.com/Jwan999/frontend-conqueror/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Jwan999/frontend-conqueror/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Jwan999/frontend-conqueror/releases/tag/v0.3.0
