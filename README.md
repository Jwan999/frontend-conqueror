# frontend-conqueror

> Three modes, one overlay. Your text, your TODOs, your testers' bugs.

A tiny browser overlay + a couple of Node services that turn any local site into a write-back surface. Hover, click, type — the source file changes. Drop a TODO from your browser; it lands in your code at the right line. Hand a tester your staging URL; they file a Linear issue with the component they were looking at attached.

No SaaS. No tracking. No `npm install --save-fingers-crossed`. The gate has zero dependencies.

---

## What it actually does

Press **`Shift Shift`** anywhere on a site that's running this. A palette opens:

```
┌─ frontend-conqueror · pick a mode ────────┐
│   Edit text  · hover text, edit in place  │
│   Dev TODO   · drop a // TODO in source   │
│   Test       · file a Linear issue        │
└────────────────────────────────────────────┘
```

| Mode | Hover targets | Action | Writes to |
|---|---|---|---|
| **Edit** | a text node | edit the visible text | source file (Vue templates, i18n object literals, template-literal quasis) at the exact byte range |
| **Dev TODO** | a component | leave a `// TODO (TICKET-XXX): …` note above it | source file at the element's opening tag, indentation preserved |
| **Test** | a component | file a Linear issue with component + page context | Linear (via the gate, server-side) |

Edit and Dev TODO are **local-only.** Test is the only mode that ships to production.

---

## Why edits land in the *right* place

Most "click-to-edit" tools just do `Element.textContent` and hope the source has a unique match. That breaks on the second i18n key with the same value, or on any string that appears in two `.vue` files. This one cheats:

1. The plugin walks every `.vue` template and emits **byte-range attributes** at build time:
   - `data-edit-loc="<file>:<offset>:<length>"` on literal-text elements
   - `data-edit-i18n-path="about.h1Top"` on `{{ t.x.y }}` interpolations
   - `data-edit-source="<file>:<offset>"` on every element (for component-level hovers)
2. The plugin walks your `i18n.ts` with Babel and records every leaf string's exact source position — including template-literal quasis inside arrow functions.
3. At edit time, the overlay reads the data attribute, looks up `<locale>.<path>` in the live source map, and sends `{file, offset, length}` to the agent.
4. The agent validates the on-disk bytes match the expected `oldText` **before** writing — so if anything's drifted, it rejects with `out-of-sync` instead of silently editing the wrong thing.

There's a v0 string-search fallback for stragglers, but it's a last resort. Most edits land via path identity.

---

## Pieces

```
plugin/   Vite/Nuxt plugin. Annotates .vue templates, scans i18n, exposes a
          source-map endpoint, serves the dev overlay, injects the script tag.
overlay/  Closed-Shadow-DOM browser script. Mode palette, hover detection,
          edit/TODO/test panels. Vanilla JS, no framework.
agent/    Node WebSocket daemon. Receives edit-loc and add-todo messages,
          writes to source files by exact byte range. One dep (`ws`).
gate/     Node HTTP server. Holds the tester email allowlist + Linear API key,
          issues short JWTs, proxies issue reports to Linear, hosts the admin
          UI. Zero dependencies — uses Node built-ins for crypto, HTTP, JSON.
```

---

## Quick start (local dev)

```bash
# 1. From your project root, install the plugin
npm install --save-dev /path/to/frontend-conqueror/plugin

# 2. Add it to your Vite or Nuxt config
import frontendConquerorPlugin from 'frontend-conqueror-plugin'

vite: { plugins: [frontendConquerorPlugin({
  projectRoot: process.cwd(),
  locales: ['en', 'ar', 'fr'],
  i18nFile: 'app/i18n.ts',
  gate: { url: 'http://localhost:54322' },  // optional, only needed for Test mode
})]}

# 3. Add the overlay script tag (Nuxt needs this; vanilla Vite gets it auto-injected)
app.head.script: process.env.NODE_ENV !== 'production'
  ? [{ src: '/__frontend-conqueror/overlay.js', defer: true }]
  : []

# 4. Run the agent (separate terminal)
node /path/to/frontend-conqueror/agent/server.js /path/to/your/project

# 5. (Optional) Run the gate for Test mode
GATE_JWT_SECRET=<random-string> node /path/to/frontend-conqueror/gate/server.js
```

Open your dev site, press `Shift Shift`, pick a mode.

---

## Production deploy (Test mode only)

In production, only Test mode is reachable. The overlay is config-trimmed at load time so Edit and Dev TODO never appear in the palette, the agent WebSocket isn't attempted, and the i18n-map fetch is skipped.

```
1. Deploy gate/ somewhere reachable from your prod site
   (Cloudflare Workers, Fly, Render, a VPS — anything that runs Node)

   Required env vars:
     GATE_ADMIN_PASSWORD=<your-default>    (shown on login page until changed)
     GATE_JWT_SECRET=<32+ random bytes>    (rotating this invalidates all sessions)
     GATE_PUBLIC_URL=https://gate.your-domain.com
     GATE_PROJECT_NAME=my-portal           (display name)

2. Visit https://gate.your-domain.com/frontend-conqueror
   - Sign in with the default password (shown on the page)
   - You'll be force-prompted to set a real one before continuing
   - Paste your Linear API key → gate auto-resolves your team
   - Pick or create the Linear project where issues should land
   - Add the emails of the testers you want to allow

3. In your production HTML, add:
   <script src="https://gate.your-domain.com/overlay.js" defer></script>

4. Testers visit your prod site, press Shift Shift, type their email,
   file an issue → lands in the right Linear project.
```

No host-app auth integration required. The gate is the auth boundary.

---

## What makes it trustworthy

| Concern | What's in place |
|---|---|
| Admin password storage | `crypto.scrypt` with a random 16-byte salt per password. Format `scrypt$<salt>$<hash>` in `data.json`. |
| Default password leak | Shown on the login page only while it's still active. Force-change on first login. |
| Login brute-force | Rate limit **5 attempts / 60s per IP** on the login route. Verified with `401 401 429 429 429 429 429` after a wrong-password loop. |
| Constant-time compare | `crypto.timingSafeEqual` everywhere — no timing side-channel on either password verify or signature check. |
| Session | HMAC-signed JWT, `HttpOnly; SameSite=Lax` cookie, 12h TTL. Add `Secure` once you serve over HTTPS. |
| Email allowlist | Verified server-side on every report (revocation is instant, not waiting for JWT expiry). Same 403 + ~300ms delay for unknown email and malformed input — no enumeration. |
| Linear API key | Lives only in the gate's `data.json`. Never sent to a browser. Never logged. |
| Production gating | Edit + Dev TODO are config-trimmed out (`enabledModes: ['test']`). The agent WebSocket isn't connected, the i18n-map fetch is skipped, those palette options don't render. |
| Gate dependencies | **Zero.** Node built-ins only. No supply-chain risk surface. |
| Agent scope | Only reads/writes files under the project root passed at startup. Walks skip `node_modules`, build outputs, config files, lock files, dot-dirs. |
| Source | All of it is here. Read it before trusting it. |

---

## Stack compatibility

See [STACKS.md](./STACKS.md) for the full matrix of where this plugin works today, where it falls back, and what's tracked to lift each row up.

Short version:

- **Tier 1 (full Edit + TODO + Test):** Vue 3 + Vite, Nuxt 3/4, TS/JS object-literal i18n
- **Tier 2 (Vue works, translations fall back):** vue-i18n JSON bundles, Laravel `lang/*.json`, Inertia + Vue
- **Tier 3 (Test only — needs framework scanner):** React/Next, Svelte, Astro, Solid, Qwik
- **Tier 4 (Test only — needs Laravel work):** Laravel + Blade, `lang/*.php`, Vue admin in Laravel apps
- **Tier 5 (Test only by design):** Nova, Filament, Webflow, Shopify themes

## What it doesn't have (yet)

Honest list — all tracked, all linked from [STACKS.md](./STACKS.md):

- **No magic-link email verification.** Tracked in [#1](https://github.com/Jwan999/frontend-conqueror/issues/1).
- **No TOTP / 2FA** on the admin. Tracked in [#2](https://github.com/Jwan999/frontend-conqueror/issues/2).
- **No real-time mode-color sync** to running tabs. Tracked in [#3](https://github.com/Jwan999/frontend-conqueror/issues/3).
- **No JSON-based i18n scan.** Tracked in [#4](https://github.com/Jwan999/frontend-conqueror/issues/4).
- **No source map for JSX/TSX/Svelte/Astro.** Tracked in [#5](https://github.com/Jwan999/frontend-conqueror/issues/5).
- **No Blade scanner or PHP-`lang` scanner.** Tracked in [#6](https://github.com/Jwan999/frontend-conqueror/issues/6).

None are blockers for the Vue/Nuxt use case.

---

## License

[MIT](./LICENSE). Take it, ship it, change it, sell it. Just don't sue me if you accidentally commit your `gate/data.json` to a public repo.