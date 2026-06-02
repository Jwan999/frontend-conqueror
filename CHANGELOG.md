# Changelog

All notable changes to frontend-conqueror are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

When you read this in a project that depends on the plugin: each entry describes what's new since the version you have. Bump and read forward.

---

## [Unreleased]

Nothing yet. Open issues are tracked at https://github.com/Jwan999/frontend-conqueror/issues.

## [0.12.5] — 2026-05-31

### Fixed
- **Plugin double-spawned the dev agent in Nuxt, then killed it on every HMR.** Nuxt's dev server creates two Vite instances (client + SSR), both of which load this plugin and called `configureServer`. The second `configureServer` call spawned a second agent that immediately `EADDRINUSE`'d on the agent port — visible as a `listen EADDRINUSE :::54325` stack trace in the dev boot log. Worse, the per-Vite `server.httpServer.once('close', stop)` handler killed the shared agent whenever either Vite restarted (HMR, config change), leaving the overlay toasting `Agent not connected` until the next full reload.

  Fixed by promoting the spawned child to a module-level singleton: if an agent is already alive (`exitCode === null`), the second `configureServer` call no-ops. Removed the per-Vite close handler entirely — the existing process-level `exit` / `SIGINT` / `SIGTERM` handlers correctly tie agent lifetime to the whole `npm run dev` process. If the agent crashes or is killed externally, the singleton clears on its `exit` event so the next `configureServer` invocation can respawn cleanly.

  Single-Vite projects (Vue + Vite without Nuxt) behave identically as before — they only call `configureServer` once.

## [0.12.4] — 2026-05-31

### Fixed
- **Split-repo routing didn't actually take effect in production builds.** The plugin's `transformIndexHtml` hook injects `window.__frontendConquerorConfig` (including `gate.side`) at build time — but in prod most consumer apps load the overlay from `gate.example.com/<project>/overlay.js`, and that endpoint hard-coded the injected config to just `{ gate: { url, project } }`. So even when an app set `gate.side='backend'` in its plugin config, the overlay running in the browser saw `GATE.side === undefined`, and the gate's report-issue handler fell back to the `'frontend'` default for split projects. Now `?side=frontend|backend` on the overlay URL is honoured by the gate and propagated into the prelude.
- **Integration tab's `<script>` snippet for split-mode projects** now shows the `?side=...` query string with a comment reminding the user to pick one per app.

### Migration (consumer apps with split mode)
- Append `&side=frontend` or `&side=backend` to the `gate/overlay.js` script tag in your prod HTML head (`nuxt.config.js`'s `app.head.script` for Nuxt, `admin.blade.php` for Laravel). Single-mode projects: no change.

## [0.12.3] — 2026-05-31

### Fixed
- **Adding a second GitHub account felt like it was replacing the first.** It wasn't — v0.12.1 already deduped by exact token so two different PATs coexist — but the success toast was identical for both "added new" and "re-pasted the same token", and the SPA didn't auto-navigate to show the new card list. Reasonable users assumed the second PAT had silently replaced the first. Now the server returns `existed: boolean` and `totalCount`, and the SPA shows distinct toasts: `Added @label. Total: N account(s) connected.` vs `Already connected as @label — no change. Total: N.` After every add the SPA jumps to `#/settings/github` so the user sees the cards immediately.

### Added
- **`[gate] github account added: gh-X (@user); total=N`** server-log line on successful add — makes "did my add actually persist?" answerable from `tail /tmp/gate.log` without poking the data.json directly.

## [0.12.2] — 2026-05-31

**Split-repo projects.** One gate project key (e.g. `messarat`) can now route bugs to TWO repos based on which app they were filed from. The Nuxt frontend and the Laravel backend each declare `gate.side = 'frontend' | 'backend'` in their plugin config; the gate stores a `frontend repo + backend repo` pair on the project and routes reports + bubbles to the matching repo. Single-repo projects (TM-frontend, dawwama, makers-landing) are entirely unaffected — the feature is opt-in per project.

### Added
- **Project field `repoMode: 'single' | 'split'`** — default `'single'`; existing projects auto-backfill on first boot under v0.12.2.
- **Project fields `githubRepoFrontend`, `githubAccountIdFrontend`, `githubRepoBackend`, `githubAccountIdBackend`** — only consulted when `repoMode='split'`. The legacy `proj.githubRepo` / `proj.githubAccountId` are preserved untouched, so flipping back to single mode just restores the old routing.
- **Plugin config option `gate.side: 'frontend' | 'backend'`** — optional. Plugin forwards through `window.__frontendConquerorConfig.gate.side` to the overlay verbatim. Without it, behavior is identical to v0.12.1.
- **Overlay propagates side**: report submissions include `issue.meta.side`; bubble fetches append `&side=` to `/api/issues`. Both are no-ops when `GATE.side` is unset.
- **New route `PUT /frontend-conqueror/projects/:key/repo-mode`** (body: `{ mode }`) toggles a project between modes.
- **`PUT /projects/:key/github-repo` + `/github-account`** accept `body.side: 'frontend' | 'backend'` — writes to the split-mode slot instead of the single field.
- **`GET /api/issues?side=...`** filters bubble fetches to one side's repo. Without a side param on a split project, the gate fetches BOTH sides and merges (anchor lookup in the overlay then naturally filters per-page).
- **Project detail Destination tab** gets a Mode toggle. In split mode: shows two cards ("Frontend" and "Backend"), each with its own Change repo + Change account buttons backed by the same combobox + modal components used in single mode.
- **Project list card** shows split destination string (`owner/front + owner/back (split)`) when in split mode.
- **Helper `inferSideFromRepo(proj, repo)`** lets PUT/DELETE on existing issues auto-route to the right side's account token by decoding the repo from the issue ID — no schema change to the GitHub issue ID format.

### Changed
- **`projectGithub(data, proj, side?)`** — adds optional `side` parameter. Single-mode projects ignore it; split-mode default for unspecified side is `'frontend'` (most common origin for tester reports).
- **`fetchOpenIssuesForProject(data, proj, side?)`** — same. Caches per `(projectKey, side)` so frontend/backend don't collide.
- **Issue-create log line** now stamps `[gate] issue #N for tm (github side=frontend @acct) by …` when a side is in play.

### Backward compatibility
- Existing projects boot in single mode and behave EXACTLY as v0.12.1.
- Existing GitHub issue IDs (`gh-<base64(repo#number)>`) are unchanged — edit/delete auto-route via `inferSideFromRepo`.
- Plugin without `gate.side`: overlay-side behavior unchanged; gate routes via single-mode path even for split projects (with a graceful default to `'frontend'`).
- All v0.12.0 / v0.12.1 endpoints, including the legacy `PUT /github/token` shim, remain in place.

### Out of scope (deliberate)
- N-way splits (3+ repos per project) — covered by `repos: { sideName: {repo, accountId} }` if needed later.
- Cross-side bug migration tool — adding/removing bugs already filed in one side's repo is a manual operation today.
- Heartbeat awareness of side — heartbeats stay project-agnostic.

## [0.12.1] — 2026-05-31

### Fixed
- **Adding a second account replaced the first one** when both PATs were owned by the same GitHub user (e.g. a fine-grained PAT for personal repos + a separate fine-grained PAT for an org's repos). v0.12.0's `PUT /github/accounts` deduped by `username`, which collapsed two distinct PATs into one. Dedup is now by exact `token` value — re-pasting an identical token is still idempotent, but two different tokens owned by the same user coexist as separate accounts.

### Added
- **Account labels** (`label` field, user-supplied display name, default = GitHub username). Lets you distinguish multiple accounts owned by the same GitHub user. Settings card shows the label as the primary heading + the GitHub username + token prefix as fingerprint.
- **Token-prefix fingerprint** (first 12 chars of the PAT) on each Settings card — visually distinguishes accounts at a glance without revealing the full token.
- **`PUT /github/accounts/:id`** — rename an account in place (body: `{ label }`).
- **Rename button** on each account card in Settings → GitHub.

### Changed
- **"+ Add account" button** added in Settings → GitHub (was just "Connect GitHub"). Prompts for an optional label after the PAT.
- **Combobox badges** show the account label instead of the username, so two accounts owned by `@Jwan999` with labels `Personal` / `Makers org` are visually distinct on each repo row.
- **Destination card** shows the routing account by label (with GitHub-user as a secondary detail in the rename UI when label differs from username).

## [0.12.0] — 2026-05-31

**Multi-account GitHub support.** The gate now holds an arbitrary list of GitHub accounts (each its own PAT) so admins can route different projects through different orgs' tokens. Lands the use case "I have a personal PAT for my repos AND a separate PAT for my company's org repos that needed org-approval — let the gate use both, route each project through the right one."

### Added
- **`data.github.accounts` array** replaces the single-PAT shape. Each entry: `{ id, token, username, addedAt }`. ID is `gh-<username>` (collision-disambiguated).
- **Per-project routing** via `proj.githubAccountId`. Set when a project picks (or migrates to) a repo from a specific account. Falls back to the first account when null — keeps legacy single-account gates working unchanged.
- **Account picker in Settings → GitHub** — one card per connected account, each with Show & copy / Replace / Disconnect. New `+ Add account` button below.
- **Repo combobox shows the source account** per result (`@username` badge alongside the `private` badge). Click-pick captures the account ID alongside the repo and stores both on the project.
- **Change-account modal** on the project's Destination card (visible when >1 account connected). Switches the routing account without re-picking the repo. Validates the new account can still see the repo before saving.
- **CLI: `--account-id` flag** on `tools/migrate-linear-to-github.js`. Auto-detects from `GITHUB_TOKEN` env match when omitted.

### Routes (admin section)
- `PUT /frontend-conqueror/github/accounts` — add or replace an account (server dedups by username so re-pasting an existing account's PAT rotates it).
- `GET /frontend-conqueror/github/accounts` — list connected accounts (id + username, never tokens).
- `GET /frontend-conqueror/github/accounts/:id/token` — admin-only reveal for one account's stored PAT.
- `DELETE /frontend-conqueror/github/accounts/:id` — remove an account; any project routing through it has its `githubAccountId` nulled (Destination card surfaces a "pick an account" prompt).
- `GET /frontend-conqueror/github/repos` now queries every connected account in parallel, dedups by `full_name` (first account wins), tags each result with `accountId`. Direct-lookup fallback tries every account. Optional `?accountId=` constrains to one.
- `PUT /frontend-conqueror/projects/:key/github-account` — change a project's routing account without re-picking a repo.

### Deprecated shims (kept for back-compat)
- `PUT /github/token`, `DELETE /github`, `GET /github/token` route to the new endpoints. Lets prod gates on v0.11.x keep working when consumer-project deploy scripts call the old endpoints. Will be removed in v0.13.0.

### Migration (auto, on first boot under v0.12.0)
- `data.github = { token, username }` → `data.github = { accounts: [{ id: 'gh-<username>', token, username, addedAt }] }`. Idempotent.
- `proj.githubToken` (per-project override, unused by every project on every current gate) is migrated into a new `gh-proj-<key>` account and `proj.githubAccountId` set to it. Field is then deleted from the project schema.
- Existing `tm` project on local gate, plus messarat/makers/dawwama on prod, all keep filing reports through the same token they used before — only the resolution path changed.

### Removed
- `proj.githubToken` (per-project token override). Replaced by multi-account.
- `STATE.github.hasToken` and `STATE.github.username`. Replaced by `STATE.github.accounts: [{ id, username }]`.

## [0.11.3] — 2026-05-31

**PAT/repo onboarding overhaul + tabbed project detail + button-bug regression fix.** Three things in this release: tab-based navigation on the project detail page so it isn't one endless scroll; a research-backed rewrite of the PAT setup flow that surfaces the org-approval gotcha behind "private repo not found"; and a fix for the broken "Configure now →" button.

### Project detail page redesigned with tabs
- **Five tabs**: Activity (default for configured projects), Testers (with count badge + warning dot when migrations need passwords), Destination (with warning dot when unset, default tab for pending projects), Integration (plugin config + overlay tag), Settings (disable + delete).
- **Deep-linkable**: every tab has a URL like `#/p/:key/:tab`. Refresh, share, back-button all just work.
- **Pending banner stays above the tabs** when the project still needs configuring — can't be tab-clicked away.
- Each tab renders only its own content. No more 6-card scroll where the destination card is buried under the testers list.

### Global Settings page redesigned with tabs
- **Three tabs**: GitHub (with warning dot when no PAT is set), Appearance (mode colors), Security (admin password change).
- **Deep-linkable**: `#/settings/github`, `#/settings/appearance`, `#/settings/security`.
- Default tab is GitHub.

### Reporting / overlay UX
- **Submission errors now show the human-readable message instead of an error code.** Before: a tester filing a bug against a GitHub-backed project hit `Resource not accessible by personal access token` and saw the toast read `linear-failed` (both wrong: the message was hidden, and the backend label was hardcoded). Now: gate returns `error: 'github-failed'` (or `'linear-failed'` for legacy backends) plus a `message` field that the overlay displays preferentially. For the specific case of a fine-grained PAT lacking `Issues: Read & Write`, the message is rewritten to a direct instruction: "Re-issue the PAT with 'Issues: Read & Write' permission (fine-grained) or 'repo' scope (classic), then paste it again in admin Settings → GitHub."
- **Overlay copy de-Linearized.** "Send to Linear" button → "Send report". "X was closed in Linear" toast → "X was closed". TODO-mode "Linear ticket (optional)" label → "Existing issue ID (optional)" with placeholder `#123 or MES-456`. Delete-confirm dialog now explains both Linear (soft trash) and GitHub (close) deletion semantics.

### Fixed
- **"Configure now →" button on the project detail page did nothing.** Regression from v0.11.2: the onclick attribute used `JSON.stringify(detail.key)` inside a double-quoted HTML attribute, which injected unescaped `"` characters that prematurely terminated the attribute. Switched to the project's standard `'\${esc(detail.key)}'` pattern. Pending-project cards now navigate to the configure wizard on click.

### Added
- **Classic PAT support, called out as the easiest path.** Settings card + setup wizard PAT step now recommend a classic PAT with `repo` scope as the easiest option (sees every repo you can see, no org-approval dance) with the fine-grained PAT as the more-secure-but-more-work alternative. Direct GitHub UI links pre-fill the scopes (`/settings/tokens/new?scopes=repo&description=frontend-conqueror`).
- **Bare-repo-name fallback in search.** Typing `my-repo` (no owner) now triggers a direct lookup at `<connected-username>/my-repo` if the local filter returns nothing — catches the common "forgot the owner prefix" case.
- **Server returns a `hint` field in `/github/repos`** when an `owner/name`-shaped query couldn't be resolved (`hint: 'direct-lookup-404'`). The SPA uses this to render an inline explainer when a direct lookup 404s.

### Changed
- **Repo combobox empty-state is now diagnostic.** Three distinct messages:
  - Bare-name query with results = ""? → "PAT can't see any of your repos. Re-issue with All repositories or use classic with `repo` scope."
  - Generic miss → "No matches for X. Try the owner/repo field below."
  - Direct-lookup 404 on `owner/repo` query → an explainer about org Resource Owner + the org-approval URL at `github.com/organizations/<org>/settings/personal-access-tokens-pending`, plus the classic-PAT alternative.

## [0.11.2] — 2026-05-31

**Gate is GitHub-only UI-wise.** Linear remains as a server-side ingestion path for legacy projects so production gates with `backend: 'linear'` projects continue receiving bugs uninterrupted, but every wizard, settings card, and project-detail surface now assumes GitHub. New projects default to `backend: 'github'`. Legacy Linear-backed projects in the project list get a "(legacy)" tag and a one-click "Switch to GitHub" path that triggers `tools/migrate-linear-to-github.js`.

### Added
- **Reveal + copy stored GitHub PAT.** Settings → GitHub card has a "Show & copy" button next to Replace/Disconnect. Clicking it reveals the token in a read-only field with a Copy button (uses `navigator.clipboard` with an `execCommand` fallback for non-secure contexts), auto-hides after 20 s. Admin-only endpoint `GET /frontend-conqueror/github/token` backs it.
- **Direct-lookup fallback in repo search.** When the search query looks like `owner/repo` and `/user/repos` returns no match, the gate also tries `GET /repos/:owner/:repo` directly. Surfaces org repos that fine-grained PATs can reach via the per-repo endpoint but aren't listed in `/user/repos` (common when an org hasn't approved fine-grained PATs at the org level).

### Changed
- **Setup wizard collapsed to 4 GitHub steps**: PAT → project name → repo picker → first tester. The Linear branch (3 extra steps including team picker) is gone. Existing gates that already completed setup never re-enter it; this only affects fresh-gate first-runs.
- **Per-project configure wizard collapsed to 2 GitHub steps**: repo picker → first tester. Backend chooser removed entirely. Legacy projects with `backend='linear'` and an actual Linear destination set skip straight to the tester step.
- **Project detail Destination card is GitHub-first.** For `backend='github'` projects: shows the repo + Change-repo button. For `backend='linear'` projects: shows a legacy notice with the exact `node tools/migrate-linear-to-github.js …` command and a "Switch to GitHub →" button that triggers the migration wizard.
- **Project list cards** show the GitHub repo name (or "(legacy Linear)" for `backend='linear'` projects) in the destination meta line, not the Linear project name.
- **Global Settings Linear card removed.** Only the GitHub access token card remains.
- **First-run detection switched to GitHub.** `navigate()` triggers the setup wizard when there are zero projects AND no GitHub token. The pre-v0.11.2 check (no Linear API key) is gone.
- **`/user/repos` paginated to 3 pages (300 repos).** Single-page fetches missed accounts with >100 repos when the desired one was older than the top 100. Pages are fetched in parallel; cache TTL unchanged at 30 s.
- **New project default backend flipped to `'github'`.** Project schema at L118 and `loadData()` migration default. Existing projects with backend already set are untouched.

### Migration
- **Auto-cleanup on boot**: projects with `backend='linear'` but no `linearProjectId` AND no `linearApiKey` (a defaulted-but-never-configured artifact from v0.10.0–v0.11.1) are silently flipped to `backend='github'` so the new GitHub-only wizard can pick them up. Real Linear-backed projects with a destination set are untouched.

### Compatibility
- Linear backend ingestion path (`/api/report-issue` → `linearGraphQL`) is **untouched server-side**. Production gates with active Linear-backed projects keep working as-is — only the admin UI for managing them has changed.
- All Linear admin routes (`PUT /linear/api-key`, `/linear/team`, `GET /linear/projects`, `DELETE /linear`) are kept callable from ops scripts; only the SPA no longer surfaces them.
- `window.changeLinearProject` and `window.switchToLinear` remain on the window object as callable ops escape hatches.

## [0.11.1] — 2026-05-31

**Gate UX bundle — six pieces of feedback from the first v0.11.0 testing sitting.** Nothing structural changes; the gate just gets noticeably nicer to live with.

### Added
- **Eye toggle on every password input.** Login, forced-rotate (new + confirm), Linear API key, GitHub PAT, Settings → change admin password — every `<input type="password">` now has a show/hide button inside it. One MutationObserver wires new inputs on every render, so future password fields are covered automatically (idempotent via `data-pw-wired`).
- **Live searchable repo picker** (combobox) for GitHub repo selection. Replaces the previous "type → click Search → render results" flow in the setup wizard and the per-project configure wizard, AND replaces the `prompt()`-driven repo picker on the project detail page (now a modal hosting the same combobox). Features: debounced live search (220 ms), ↑/↓ keyboard navigation, Enter to pick, Esc to clear, private repos surface with a "private" pill, owner/repo direct-entry fallback. New helpers: `renderRepoCombobox()`, `openModal()`.
- **Same-PAT-everywhere copy.** Settings → GitHub card has a one-liner clarifying that the same fine-grained PAT can be pasted into local and production gates — both treat it identically. README's Production section grew a "GitHub backend" subsection spelling out the workflow (no env-var sharing, no cross-gate sync — paste it into each gate).

### Changed
- **Repo search now uses `/user/repos` + local filter** instead of `/search/repositories`. The Search Repositories endpoint biases against private repos when the query lacks an explicit `user:owner`/`org:owner` prefix; `/user/repos?affiliation=owner,collaborator,organization_member` returns every repo the PAT has access to, including private ones, and the gate filters locally by `full_name` and `description`. Combined with a 30 s per-token in-memory cache (`_ghRepoCache`), the live combobox doesn't hammer the GitHub API on every keystroke.

### Fixed
- **`saveData()` no longer crashes the gate on first write when the data file's parent directory is missing.** Defensive `fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })` before the `writeFileSync`. The auto-mkdir at `resolveDataFile()` only fires when `GATE_DATA` is unset; with an explicit `GATE_DATA` pointing at a never-created parent (common on fresh machines), the first password-rotate write would ENOENT and kill the process. Now idempotent and safe.
- **Backend chooser HTML rendered as blank dark navy on the per-project configure wizard.** `gate/server.js:2650` had `` `gh` `` (literal backticks for inline-code styling) inside the SPA's `html\`…\`` template literal — the inner backticks closed the template literal early and Firefox threw `SyntaxError: unexpected identifier 'gh'`. Switched to `<code>gh</code>` matching the convention used elsewhere in the file.

### Compatibility
- All existing projects, tokens, and data files keep working — no schema changes, no new env vars, no breaking API changes.
- Linear backend untouched. Removing Linear is reserved for a future Phase B once all consumer projects are migrated to GitHub.

## [0.11.0] — 2026-05-31

**Backend chooser lands in both wizards.** v0.10.0 introduced GitHub Issues as a peer backend to Linear in the data model and admin API, but the wizards still hardcoded Linear. v0.11.0 closes the gap — a fresh `/setup` flow lets you pick the tracker at step 1, and every per-project configure wizard does the same.

### Added
- **Setup wizard step 1 is now a backend chooser.** "Where will bugs land? [Linear] [GitHub]". The rest of the flow adapts: Linear path is 5 steps (single-team) or 6 (multi-team); GitHub path is 5 steps (PAT → project name → repo picker → tester). The dots widget shows 6 dots consistently with the visible "Step X of Y" label tracking the real count.
- **GitHub PAT paste step in the setup wizard** with a direct link to the fine-grained PAT generator and the exact scopes needed (`Issues: Read & Write` on destination repos).
- **GitHub repo picker step** in both the setup wizard AND the per-project configure wizard. Search by name or owner/repo prefix; results show description + private badge; or paste `owner/repo` directly. Hits `/frontend-conqueror/github/repos` which the gate proxies to GitHub's Search Repositories API.
- **Per-project configure wizard now adapts to backend.** Three logical steps (backend chooser → destination → tester) when both Linear and GitHub are configured globally and the project doesn't have a destination yet. Falls back to the previous 2-step flow when only one backend is configured globally. Existing Linear-configured projects skip straight to the tester step on re-entry.

### Changed
- The per-project wizard's "Where should bugs land?" step is now backend-aware. The Linear variant is unchanged; the GitHub variant is new.
- Setup wizard step labels moved from "Step X of 5" (hardcoded) to "Step X of \${totalSteps()}" (dynamic) so the count is honest in every flow shape.

### Compatibility
- Pre-v0.11.0 gate projects continue to work — they have `backend: 'linear'` from the v0.10.0 migration. The per-project wizard auto-skips the backend chooser when re-entered for a project with a destination already set.
- Setup wizard only runs on fresh gates (when there are no projects and no Linear key). Existing deployed gates never re-enter it.

## [0.10.6] — 2026-05-31

### Added
- **Pending-project hint in the overlay.** When a heartbeat to a brand-new gate project key auto-registers a pending entry, the overlay shows a one-time toast: `First time this project ("X") has been seen by the gate — open admin to configure`. Throttled per `(gate URL, project key)` via sessionStorage so a page reload doesn't re-toast. Previously the dev had no in-page signal that the gate had silently created a pending project.

### Changed
- **`/api/heartbeat`** now returns `200 { pending, justCreated }` instead of `204 No Content`. Backward compatible — pre-v0.10.6 overlays ignored the response body. The `justCreated` flag is true only on the heartbeat that performs the auto-registration; subsequent heartbeats for the same pending project return `justCreated: false` so the toast doesn't fire on every page load.

## [0.10.5] — 2026-05-31

### Fixed
- **`needsConfig` warning now respects the project's backend.** Previously it checked `linearProjectId` only, so a fully-set-up GitHub-backed project would forever show "Finish configuring this project — needs a Linear destination". Now: `hasDestination = backend === 'github' ? !!githubRepo : !!linearProjectId`.

### Changed
- **Friendlier empty Testers state** — "No testers yet — add the people who'll file feedback from this site." instead of bare "No testers yet."
- **Inline explainer below the Add tester form** — reminds the admin to share the credentials out-of-band (DM, password manager) rather than in a shared chat.

## [0.10.4] — 2026-05-31

### Added
- **"Gate not running" toast on the overlay.** When the overlay's initial `/api/mode-colors` fetch fails with a network error (most common cause: developer started `npm run dev` but didn't start the gate), a one-time toast surfaces the cause + the fix. For local gates (`localhost` / `127.0.0.1` URL): `Gate not running at <url> — run \`npx frontend-conqueror gate\``. For remote gates: `Can't reach gate at <url>`. Throttled to once per page session via a closure flag. Previously this failure was silent — first-time integrators had to open devtools and read a CORS / network error to figure out what was missing.

## [0.10.3] — 2026-05-31

Two coordinated security tightenings.

### Changed
- **Gate binds to `127.0.0.1` by default.** Previously `0.0.0.0`, which exposed every freshly-started gate to the local network — fine on a hardened dev laptop, dangerous on a cloud VM without a firewall rule or on hotel/conference wifi. Existing production deploys behind a reverse proxy already set `GATE_HOST=127.0.0.1` explicitly (because the proxy terminates TLS and forwards to localhost), so they're byte-identical. To get the old behaviour back: set `GATE_HOST=0.0.0.0`.

### Fixed
- **Default admin password can no longer be used indefinitely.** Previously, if you skipped changing the admin password after first login (via the existing `mustChangePassword: true` hint on the login response), the gate happily ran forever with the hardcoded default and any state-changing admin endpoint accepted writes. Now: as long as `adminPasswordHash` is null, every `POST`/`PUT`/`DELETE` admin endpoint returns `409 must-change-password` except `PUT /frontend-conqueror/password` itself (the rotation route) and `POST /frontend-conqueror/logout`. Reads (`/state`, project detail, `github/repos`, etc.) are still allowed so the UI can render the forced-rotate screen.
- **Admin UI handles the 409 gracefully.** The shared `api()` helper detects `must-change-password` and routes to `renderForcedPasswordChange()` instead of toasting a raw error, so a user who somehow lands past the initial login screen with a default password lands back in the rotate flow.

### Compatibility
- All your existing v0.10.x deploys are already past this gate (admin password was set during v0.7 / v0.8 setup) — zero impact.
- Fresh installs going forward: complete the password rotation before performing any other admin action.

## [0.10.2] — 2026-05-31

### Fixed
- **`data.json` is no longer wiped on `npm install`.** The gate's data file (admin password hash, tester credentials, Linear/GitHub tokens, all project records) used to default to `node_modules/frontend-conqueror/gate/data.json`. Every time you upgraded the plugin, npm replaced the package directory and silently erased all of it. New default: `~/.frontend-conqueror/data.json` — survives upgrades, follows the dotfile pattern most node tools use. **Existing deploys that set `GATE_DATA` explicitly are completely unaffected** — the env var always wins.

### Migration (automatic)
- On first boot of v0.10.2+, if `~/.frontend-conqueror/data.json` does not exist AND a legacy `node_modules/.../gate/data.json` does, the gate copies it to the new location and prints a loud stderr line: `[gate] migrated data file out of node_modules/...`. The old file is **left in place** for one boot cycle so the admin can verify the new location works before deleting. The startup log's `data:` line shows the active path either way.
- If the copy fails (permissions, disk full, whatever), the gate falls back to the legacy path and prints a warning explaining what to do. Falling forward is never silent.

### Compatibility
- Resolution order: `GATE_DATA` env > new `~/.frontend-conqueror/data.json` > legacy `node_modules` path (auto-migrated). Existing CI / Docker / PM2 setups that pass `GATE_DATA=/var/data/...` continue to work byte-identically.

## [0.10.1] — 2026-05-31

First of a series of usability fixes from real-world integrator feedback. Targets the worst foot-gun (no password-reset path) and the most leak-prone surface (default password being broadcast to anonymous callers in prod).

### Added
- **`frontend-conqueror` CLI bin.** New top-level `bin/fc.js` dispatcher that routes subcommands the same way mature self-hosted tools do (vite, nuxt, jest pattern). Lets you run `npx frontend-conqueror gate` instead of `node node_modules/frontend-conqueror/gate/server.js`. Lays the groundwork for additional subcommands in later releases.
- **`npx frontend-conqueror gate --reset-admin-password`** — operates on the gate's data file directly, clears `adminPasswordHash`, logs the default-password reminder + data-file path to stderr, exits. Mirrors the pattern used by Postgres / Discourse / Gitea / Nextcloud / Sentry for admin recovery: CLI-only, not an HTTP endpoint, so it requires shell access to the box rather than just a network connection. Closes the previously dead-end "I forgot the admin password" case where the only recovery was hand-editing `node_modules/frontend-conqueror/gate/data.json`.
- **CLI `help` / `--help` / `-h`** output documenting subcommands and the environment variables that affect the gate.

### Fixed
- **Default admin password is no longer broadcast to anonymous callers in production.** `/frontend-conqueror/login-state` previously returned `defaultPassword: 'frontend-conqueror'` (or whatever `GATE_ADMIN_PASSWORD` was set to) to *anyone* hitting the URL — convenient in dev, dangerous if a prod gate was misconfigured to skip changing the password. Now gated on `NODE_ENV !== 'production'`. `usingDefault: true` is still returned in prod so the login UI can render an appropriate hint pointing at the CLI reset command rather than silently leaving the user stuck.
- **Login-page hint adapted.** When `usingDefault` is true but `defaultPassword` is suppressed (prod), the hint reads: "Check the gate startup logs for the default password (or set `GATE_ADMIN_PASSWORD`). Locked out? Run `npx frontend-conqueror gate --reset-admin-password` on the server." When the password is visible (dev), the hint is unchanged from prior versions.

### Internal
- Top-level `package.json` gains `bin: { "frontend-conqueror": "./bin/fc.js" }` and `bin/` is added to `files` so the dispatcher actually ships in the published tarball.

## [0.10.0] — 2026-05-24

**GitHub Issues backend.** The gate now writes bugs to GitHub Issues in addition to Linear. Per-project `backend` flag selects between them; mixed-backend gates work fine. The overlay, the plugin, and the entire `nuxt.config.js` consumer-side config are unchanged.

### Added
- **Plugin emits `line:column` in `data-edit-source`** alongside the existing byte offset. New format: `file:offset:line:col`. The plugin reads the file once at build time and computes line/col cheaply.
- **Overlay parses the 4-part format** (with 2-part fallback so older plugin output keeps working) and forwards `line`/`column` through `meta.anchor` to the gate.
- **Structured Markdown issue body.** Replaces the old prose template. Clean `## What's wrong / ## Where / ## Page / ## What the tester saw / ## User agent` sections so terminal readers (humans and Claude Code alike) can extract fields deterministically. The visible "Where" line is `file:line:column` — every modern editor accepts that as a click-target. The byte offset stays inside the `fc-meta-b64` marker for the overlay's bubble matching.
- **GitHub helpers in the gate** parallel to the Linear ones: `fetchGithubOpenIssues` (paginated, 500 cap), `fetchGithubIssue`, `createGithubIssue`, `updateGithubIssue`, `deleteGithubIssue` (which maps to "close with `state_reason: not_planned`" — GitHub doesn't allow true deletion via PATs).
- **`fc:bug` label.** Auto-created on the target repo on first issue creation. The list query filters by this label so manually-filed Issues in the repo don't render as bubbles.
- **Per-project `backend` field** ('linear' | 'github'). Existing projects auto-default to `linear` on load. New projects can pick either via the admin UI; switching after the fact is supported.
- **Admin UI: GitHub PAT card** in Settings (mirrors the Linear API key card). Token validation on save — PATs that GitHub rejects don't get stored.
- **Admin UI: GitHub repo picker** in the project destination card. Type a query, the gate searches your accessible repos via the GitHub Search API and renders a numbered picker. Validates the repo has Issues enabled before linking. Switching to GitHub from Linear or back is a single click.
- **`GET /frontend-conqueror/github/repos`** admin route — backs the picker.
- **`PUT /frontend-conqueror/projects/:key/github-repo`** admin route — sets the destination and flips backend to `github`.
- **`tools/migrate-linear-to-github.js`** one-time migration script. Lists all open Linear issues in a gate project, recreates each in a target GitHub repo (preserving the `fc-meta-b64` marker so bubbles keep working without any tester refresh), comments on each Linear original with the new GitHub URL, flips the gate project's backend to `github`. Idempotent — re-runs skip issues that already have a "Migrated to" comment. Supports `--dry-run`.

### Changed
- **Issue ID format** for GitHub: `gh-<base64url(owner/repo#number)>`. The overlay receives this as `iss.id`; PUT/DELETE handlers decode it to route to the right repo. Linear UUID IDs continue to work unchanged.
- **Route regex** for `/api/issues/:id` extended to include `_` (base64url char) so encoded GitHub IDs fit.
- **Error names** in route catch blocks generalized from `linear-failed` to `backend-failed` since the same code path now serves both backends.

### Compatibility
- Existing Linear-backed gate projects keep working untouched. The data-shape migration is idempotent and additive (`backend: 'linear'` default + empty `githubRepo`/`githubToken` fields).
- Pre-v0.10.0 plugins (no line/col in `data-edit-source`) still work: the gate falls back to byte-offset-only in the visible "Where" line. Bubbles continue to match correctly.
- Pre-v0.10.0 overlays (no `line`/`column` in `meta.anchor`) work: the gate's `normalizeAnchor` treats the extra fields as optional.

## [0.9.8] — 2026-05-24

Admin-UI polish for the auto-discovery → configure flow. Gate-only release — overlay and plugin are byte-identical to v0.9.7, so consumer projects don't strictly need to bump (though they should, to stay in sync).

### Added
- **Configure → button on pending project cards.** Sits next to the "pending" pill on each card in the project list. One click jumps straight to the 2-step wizard, skipping the previous detour through the project detail page. The click intercepts the card's outer anchor so it doesn't navigate to detail by accident.
- **"Used by X, Y" suffix on Linear destination options** in both places that pick one: the project-configure wizard's existing-project `<select>`, and the changeLinearProject prompt. Now you can tell at a glance whether picking "Q3 Bugs" means "shared with tawtheef" vs "fresh destination" — instead of guessing or hunting through other projects' detail pages.
- **Richer auto-detect banner on pending projects' detail page** — names the most-active origin, total heartbeat count, and time since first heartbeat. Replaces the old generic "auto-detected from a heartbeat" copy. Helps confirm the plugin is wired up to the right gate project key before you commit to configuring it.

### Internal
- New `fcUsedByMap(excludeKey)` admin-side helper builds the projectId → list-of-gate-projects-using-it map from STATE.projects. Reused by both the prompt and the select-population paths.

## [0.9.7] — 2026-05-15

A focused polish pass turning v0.9.x's bubble feature into something a team can actually live with day-to-day. Eleven changes in one bundle — perceived latency, security, scale, and UX legibility.

### Added
- **Bubble icon + count.** The dot is now a small pill with a chat-bubble glyph and the open-issue count (always visible, even for `1`). Replaces the previous tiny circle that was easy to mistake for a notification dot from somewhere else on the page.
- **`TEST MODE · N open` in the top indicator pill.** When bubbles are loading or filtered out, the count answers "are bubbles even working?" at a glance. Also fixed a stale `EDIT MODE` hardcode in `updateIndicator()` — Test and Todo modes now show their own label.
- **State-colored bubbles.** Most-advanced state in a group wins: amber for backlog, blue for unstarted/Todo, green for started/In Progress/In Review. "This is in flight, don't refile it" vs "this is languishing, refile if you care" in a glance.
- **Toast when a filer's own issue closes.** Diff between consecutive `/api/issues` refreshes; if an issue you filed disappears (admin moved it to Done/Canceled in Linear), you see `MAK-264 was closed in Linear.` Excludes issues you deleted yourself. Page-scoped — navigating to a new URL doesn't fire stale "closed" toasts.
- **Sign-out UI in the bubble panel.** Footer reads "signed in as alice@example.com · sign out". Clears the gate token + bubbles; next test-mode interaction re-prompts. Replaces the "open devtools and clear sessionStorage" workaround.
- **`/api/issues` cursor pagination.** Loops `endCursor` until `hasNextPage` is false, capped at 500 issues (5 × 100). Projects with more than 100 simultaneously-open Test-mode bugs now show bubbles for all of them.
- **Admin cookie `Secure` attribute** when the connection is TLS (`x-forwarded-proto: https` or PUBLIC_URL is `https://`). Dev gates on `http://localhost:…` keep working — the flag only goes on where TLS actually exists.

### Changed
- **Mode indicator frame is thicker** (4px → 7px inset border + 32px → 36px glow). Easier to confirm "I'm actually in Test mode" at a glance, especially on sites with their own strong color palette.
- **Bubble repositioning is rAF-batched.** Pages with 30+ bubbles + aggressive scroll were calling `getBoundingClientRect()` N times per wheel tick. Now coalesced to one frame.
- **Post-submit bubble appears optimistically.** Used to wait for the next `/api/issues` roundtrip (~500–1000 ms) — now appears immediately using the just-submitted data. The next refresh reconciles to canonical Linear state silently. No more "did the submit work? where's my dot?"
- **SPA route changes refresh bubbles.** Patches `history.pushState` + `history.replaceState` to dispatch an `fc-route-change` event; combined with a `popstate` listener and a small debounce, navigating between pages via internal Nuxt links now refreshes bubbles automatically (with a 1.5s retry pass to catch client-rendered content). Previously, internal navigation left the bubbles from the prior page on screen.
- **`visibilitychange` joins `focus` as a refresh trigger.** Some browsers/scenarios fire one but not the other; both should reliably refresh bubbles when the user comes back from another tab.

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
