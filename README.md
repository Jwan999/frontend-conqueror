# frontend-conqueror

> Three modes, one overlay. Your text, your TODOs, your testers' bugs.

A tiny browser overlay + a couple of Node services that turn any local site into a write-back surface. Hover, click, type — the source file changes. Drop a TODO from your browser; it lands in your code. Hand a tester your staging URL; they file a Linear issue with the component they were looking at.

No SaaS. No tracking. The gate has zero dependencies.

---

## Three modes

Press **`Shift Shift`** anywhere on a site that's running this. A palette opens.

| Mode | What you do | Where it lands |
|---|---|---|
| **Edit** | Hover text, edit in place | The exact byte range in your source — Vue templates, JSON / TS / JS i18n, hardcoded script literals, v-for items, computed text |
| **Dev TODO** | Hover a component, drop a `// TODO (TICKET-XXX): …` note | Your source file at that element's opening tag |
| **Test** | Hover a component, file a Linear issue | Linear (via the gate, server-side) |

Edit and Dev TODO are **local-only.** Test is the only mode that ships to production.

---

## Install

```bash
npm install --save-dev github:Jwan999/frontend-conqueror#v0.13.0
```

Pin to a tag — see [Releases](https://github.com/Jwan999/frontend-conqueror/releases) for the latest. Watch the repo (Watch → Custom → Releases) to get notified of new versions. Changes per version live in [CHANGELOG.md](./CHANGELOG.md).

The overlay reports its version to the gate on each heartbeat; when a site is pinned to a different version than the gate it talks to, you get a one-time console warning (and a dev toast) telling you the exact `npm install` line to resync.

---

## Wire it up

Run `npx frontend-conqueror init` in your project — it detects your stack (Nuxt / Vite / Laravel) and prints the exact config to paste, with the gate URL and project key filled in:

```bash
npx frontend-conqueror init --gate-url=https://gate.your-domain.com --project=my-app
```

Or wire it by hand:

```js
// nuxt.config.js (or vite.config.js)
import frontendConquerorPlugin from 'frontend-conqueror/plugin'

const isDev = process.env.NODE_ENV !== 'production'

export default defineNuxtConfig({
  vite: { plugins: isDev ? [frontendConquerorPlugin({
    projectRoot: process.cwd(),
    locales: ['en', 'ar'],
    gate: { url: 'http://localhost:54322', project: 'my-app' },
  })] : [] },
  app: { head: { script: isDev
    ? [{ src: '/__frontend-conqueror/overlay.js', defer: true }]
    : [] } },
})
```

That's it. Run `npm run dev` — the plugin auto-spawns the agent. No second terminal.

For Test mode (any environment), also run the gate once:
```bash
GATE_JWT_SECRET=$(openssl rand -hex 32) node node_modules/frontend-conqueror/gate/server.js
```

Open your dev site, press `Shift Shift`, pick a mode.

Per-stack configs (Nuxt / Vite / Laravel-Blade) live in [`examples/`](./examples).

---

## Production (Test mode only)

In production, only Test mode is reachable — Edit and Dev TODO are config-trimmed out. Deploy the gate alongside your app and point your prod overlay tag at it. **Full step-by-step in [DEPLOY.md](./DEPLOY.md)** — covers PM2, Docker, systemd, Caddy, nginx.

```html
<script src="https://gate.your-domain.com/<project>/overlay.js?v=0.13.0" defer></script>
```

The `?v=` is the plugin version you pinned — the gate uses it to warn you when a site drifts from the gate's version. The gate is the auth boundary. No host-app auth integration needed.

### One gate, many sites — routing by domain (v0.13.0+)

A single gate can serve many projects. Bind each project's domain(s) in the gate admin (Configure → Domains, or the project's Integration tab), and a site can then load a **bare** overlay with no project key in its URL:

```html
<script src="https://gate.your-domain.com/overlay.js?v=0.13.0" defer></script>
```

The gate maps the request to the right project by its `Origin` host. A site whose domain isn't bound yet auto-registers as a pending project named after its hostname, ready to configure. Pinning the project into the URL (`/<project>/overlay.js`) still works and takes precedence.

### GitHub backend (v0.10.0+) — one PAT, every gate

Bugs filed in Test mode can land as GitHub Issues instead of Linear. Configure once per gate:

1. Generate a fine-grained PAT at [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta). Scope: pick the repos you'll route bugs to (or "All repositories"), permissions: **Issues: Read & Write**.
2. Open the gate admin → Settings → "GitHub access token" card → **Connect GitHub** → paste the PAT.
3. Per project: Project detail → Destination → **Switch to GitHub** → pick the repo from the live searchable picker.

**The same PAT works on every gate.** You don't issue a separate token for local and production — generate it once, paste it into each gate's Settings card. To rotate, issue a new PAT and paste it into each gate (Replace button). The PAT is stored in each gate's `data.json` independently — there is no cross-gate sync (intentional: no shared-secret leak surface).

---

## Read more

- [**DEPLOY.md**](./DEPLOY.md) — production setup walkthrough
- [**STACKS.md**](./STACKS.md) — what frameworks work today (Vue/Nuxt: full · React/Svelte/Astro: Test-only · Laravel: partial)
- [**CHECKLIST.md**](./CHECKLIST.md) — security audit before installing in your org
- [**CHANGELOG.md**](./CHANGELOG.md) — what's in each version
- [**examples/**](./examples) — copy-pasteable configs

---

## License

[MIT](./LICENSE). Just don't commit your `gate/data.json` to a public repo.