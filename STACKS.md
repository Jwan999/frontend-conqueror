# Stack compatibility

Where the plugin works today, where it falls back, and what's tracked to lift each row up.

This file is kept in lockstep with the open issues. If a row says "tracked in #N" and that issue is closed, the row's status should change in the next commit. PRs welcome to keep this honest.

**Legend**
- ✅ **Full** — Edit, Dev TODO, and Test all work end-to-end
- ⚠️ **Partial** — Some modes work; specific surfaces fall back to v0 string-search or are unreachable
- 🟡 **Test only** — Production bug-filing works (gate + Linear); Edit/TODO blocked on tracked work
- ❌ **Out of scope** — Won't be supported (wrong target, no source on disk, etc.)

---

## Tier 1 — Full support today

| Stack | Edit | TODO | Test | Notes |
|---|:-:|:-:|:-:|---|
| Vue 3 SFC + Vite | ✅ | ✅ | ✅ | Reference target. `data-edit-loc` byte ranges + `data-edit-source` on every element |
| Nuxt 3 / Nuxt 4 + Vue 3 | ✅ | ✅ | ✅ | Pass `projectRoot: process.cwd()` since Nuxt 4's Vite root is `<project>/app` |
| Vue 2.7 + Vite (rare) | ✅ | ✅ | ✅ | `@vue/compiler-sfc` covers it; untested but expected to work |
| TS/JS object-literal i18n (`MESSAGES`, `t.x.y`) | ✅ | n/a | n/a | Full path identity via `@babel/parser`. Handles arrow functions, conditionals, template-literal quasis |
| Hardcoded text inside `.vue` templates | ✅ | n/a | n/a | Edits land via raw `file:offset:length` |

## Tier 2 — Vue works, translations fall back

| Stack | Edit | TODO | Test | Tracked in |
|---|:-:|:-:|:-:|---|
| Vue + vue-i18n with JSON bundles | ✅ | ✅ | ✅ | v0.5.1 — path identity via JSON scanner |
| Vue + Laravel `lang/*.json` | ✅ | ✅ | ✅ | v0.5.1 |
| Inertia + Vue (Laravel) | ⚠️ | ✅ | ✅ | Templates work; `lang/*.php` blocked on [#6](https://github.com/Jwan999/frontend-conqueror/issues/6) |
| Vue + i18n imported across files | ⚠️ | ✅ | ✅ | Scanner is single-file; cross-file resolution not yet built |

## Tier 3 — Test only, needs framework scanner

All blocked on [#5 — Source-map annotation pass for JSX/Svelte/Astro/Blade](https://github.com/Jwan999/frontend-conqueror/issues/5).

| Stack | Edit | TODO | Test | Notes |
|---|:-:|:-:|:-:|---|
| React + Vite | 🟡 | 🟡 | ✅ | Needs JSX/TSX scanner |
| Next.js (App or Pages router) | 🟡 | 🟡 | ✅ | Needs JSX scanner + Next-specific build hook |
| Remix | 🟡 | 🟡 | ✅ | Vite-based; JSX scanner unlocks Edit |
| SvelteKit | 🟡 | 🟡 | ✅ | Needs `svelte/compiler` scanner |
| Astro | 🟡 | 🟡 | ✅ | Needs `@astrojs/compiler` scanner |
| SolidJS | 🟡 | 🟡 | ✅ | Covered by the JSX scanner |
| Qwik | 🟡 | 🟡 | ✅ | Covered by the JSX scanner |

## Tier 4 — Test only, needs Laravel/PHP work

All blocked on [#6 — Laravel Blade + PHP-lang scanners](https://github.com/Jwan999/frontend-conqueror/issues/6).

| Stack | Edit | TODO | Test | Notes |
|---|:-:|:-:|:-:|---|
| Laravel + Blade (server-rendered) | 🟡 | 🟡 | ✅ | Needs Blade scanner + a Laravel middleware that injects `data-edit-loc` into rendered HTML |
| Laravel + `lang/*.php` translations | 🟡 | n/a | n/a | Needs the PHP-array scanner from [#6](https://github.com/Jwan999/frontend-conqueror/issues/6) |
| Laravel + Vue admin in `resources/admin/*.vue` (e.g. messarat-backend) | ⚠️ | ⚠️ | ✅ | `.vue` files already work; PHP lang and Blade views need [#6](https://github.com/Jwan999/frontend-conqueror/issues/6) |
| WordPress / PHP-rendered sites | 🟡 | 🟡 | ✅ | Realistic ceiling is Test mode + a Blade-style scanner if you control the theme |
| Plain static HTML | 🟡 | 🟡 | ✅ | A static-HTML scanner is small work; not yet tracked — open an issue if you want this |

## Tier 5 — Test only, Edit/TODO unlikely

These stacks bundle their own Vue/React internals or don't expose source-on-disk that the agent can write back to.

| Stack | Edit | TODO | Test | Why |
|---|:-:|:-:|:-:|---|
| Laravel Nova (e.g. tawtheef-backend) | ❌ | ❌ | ✅ | Nova bundles Vue internals; you don't control the source tree |
| Filament v3 | ❌ | ❌ | ✅ | Livewire + Alpine; no SFC to map back to |
| Webflow / Framer / Wix / Squarespace exports | ❌ | ❌ | ✅ | No source on disk |
| Shopify themes | ❌ | ❌ | ✅ | Same — Liquid runs server-side at Shopify, not in your repo at request time |
| Storybook standalone | ❌ | ❌ | ✅ | Already has its own editing surface |

## Out of scope

| Target | Why |
|---|---|
| React Native | Not a browser |
| Flutter | Not a browser |
| Native iOS/Android | Not a browser |
| Email templates | No browser context; consider a separate tool |

---

## Roadmap at a glance

| Issue | Stack ceiling it lifts | Status |
|---|---|---|
| [#1 — Magic-link email verification](https://github.com/Jwan999/frontend-conqueror/issues/1) | Hardens Tester auth across all stacks | Open |
| [#2 — TOTP / 2FA on admin](https://github.com/Jwan999/frontend-conqueror/issues/2) | Admin security, all stacks | Open |
| [#3 — Real-time mode-color sync](https://github.com/Jwan999/frontend-conqueror/issues/3) | UX polish, all stacks | Open |
| [#4 — JSON i18n scanner](https://github.com/Jwan999/frontend-conqueror/issues/4) | Tier 2 → Tier 1 for JSON-bundle projects | ✅ Closed in v0.5.1 |
| [#5 — JSX/Svelte/Astro scanners](https://github.com/Jwan999/frontend-conqueror/issues/5) | Tier 3 → Tier 1 for React/Svelte/Astro | Open |
| [#6 — Blade + PHP-lang scanners](https://github.com/Jwan999/frontend-conqueror/issues/6) | Tier 4 → Tier 1 for Laravel | Open |

---

## How to update this file

When a tracked issue closes:
1. Edit the affected row(s) — change `⚠️`/`🟡` to `✅`, remove the "Tracked in #N" link.
2. Move the row up a tier if appropriate.
3. Update the roadmap table status.
4. Commit with a message like `STACKS: lift JSON i18n from Tier 2 to Tier 1 (#4)`.

When a new stack is requested:
1. Open an issue with a `stack-request` label (create the label if it doesn't exist).
2. Add a row to the relevant tier with a link to the issue.
3. If it's truly out of scope, add it to Tier 5 or "Out of scope" with a one-line reason.

Don't add stacks you haven't actually verified. A row in Tier 1 is a promise.