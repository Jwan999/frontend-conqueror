# Deploying Test mode

Step-by-step guide to put **frontend-conqueror Test mode** into production for a single project. By the end of this, your team types `Shift Shift` on the prod site, picks Test mode, and a Linear issue lands in your project.

**Key principle (v0.5.0+):** one gate serves **N projects**. Each project has its own Linear destination and its own tester allowlist; the Linear API key is shared across them by default (overridable per project).

This means you usually deploy **one gate per company / domain group**, not per project. Drop the plugin into any number of sites under that domain, give each a `project` key, and they all surface in the same admin panel.

```
┌─ your sites (any stack) ──────────────────────────────────┐
│  messarat.com               → project: 'messarat'          │
│  back.messarat.com/admin    → project: 'messarat'          │
│  tm.example.com             → project: 'tm'                │
│  tawtheef.example.com       → project: 'tawtheef'          │
│       │                                                    │
│       │  overlay.js loaded from gate, project key baked in │
│       ▼                                                    │
│  ┌─ your gate (one per domain group) ──────────────────┐   │
│  │  - global Linear API key (shared default)           │   │
│  │  - per-project Linear destination + allowlist       │   │
│  │  - heartbeat-based auto-discovery (pending projects)│   │
│  │  - admin UI at /frontend-conqueror                  │   │
│  └────────┬─────────────────────────────────────────────┘   │
│           ▼                                                │
│       Linear API (issues land in each project's Linear)   │
└────────────────────────────────────────────────────────────┘
```

### Project keys

Each surface that hosts the overlay has a `project` key. Two surfaces with the *same* key (e.g. `messarat.com` and `back.messarat.com` both set to `'messarat'`) report into the same Linear project and share an allowlist. Two surfaces with *different* keys (e.g. `'messarat-frontend'` and `'messarat-admin'`) are tracked separately.

If a heartbeat arrives from an **unknown** project key, the gate auto-creates it as `pending` and surfaces it to the admin with one-click "Configure". This makes "install on a new project" smooth: drop in the plugin, set the key, open the site once, then configure in the admin.

---

## Step 1 — Install the plugin

In each project that should expose Test mode:

```bash
npm install --save-dev github:Jwan999/frontend-conqueror#v0.4.0
```

Pin to a tag. `#main` is fine for dev but fragile for shared installs. Update by bumping the tag and re-running `npm install` — see [CHANGELOG.md](./CHANGELOG.md) for what's in each release.

---

## Step 2 — Wire the plugin in your config

Each stack needs:
1. The plugin added in dev (Edit + TODO + Test).
2. A script tag for the overlay in **production** that points at your gate.

Copy-pasteable examples live in [`examples/`](./examples). Below is the gist per stack — see the example file for the full working config.

### Nuxt 3 / Nuxt 4

`nuxt.config.js` — see [examples/nuxt.config.example.js](./examples/nuxt.config.example.js):

```js
import frontendConquerorPlugin from 'frontend-conqueror/plugin';
const isDev = process.env.NODE_ENV !== 'production';

export default defineNuxtConfig({
  app: { head: {
    script: isDev
      ? [{ src: '/__frontend-conqueror/overlay.js', defer: true }]
      : (process.env.NUXT_PUBLIC_GATE_URL
          ? [{ src: `${process.env.NUXT_PUBLIC_GATE_URL}/overlay.js`, defer: true }]
          : []),
  }},
  vite: { plugins: isDev ? [frontendConquerorPlugin({
    projectRoot: process.cwd(),
    locales: ['en', 'ar'],
    gate: {
      url: process.env.NUXT_PUBLIC_GATE_URL || 'http://localhost:54322',
      project: 'my-app',          // project key in the gate's admin
    },
  })] : [] },
});
```

### Vite + Vue SPA

See [examples/vite.config.example.js](./examples/vite.config.example.js).

The overlay tag goes in your `index.html`:

```html
<!-- production-only: pointed at your gate -->
<script src="https://gate.YOUR-DOMAIN.com/overlay.js" defer></script>
```

(In dev, the plugin's middleware auto-serves the overlay; no manual tag needed for vanilla Vite.)

### Laravel + Vite + Vue (Inertia, admin SPAs, etc.)

`vite.config.js` — see [examples/vite.config.laravel.example.js](./examples/vite.config.laravel.example.js). Same plugin pattern as above.

The Blade view that hosts your Vue app needs both the dev and prod overlay tags, since Vite's `transformIndexHtml` doesn't see Blade-rendered HTML. See [examples/admin.blade.example.php](./examples/admin.blade.example.php):

```blade
@php
    $fcDevUrl  = file_exists(public_path('hot')) ? trim(file_get_contents(public_path('hot'))) : null;
    $fcGateUrl = env('FRONTEND_CONQUEROR_GATE_URL');
    $fcProject = env('FRONTEND_CONQUEROR_PROJECT', 'my-app');
@endphp
@if(app()->environment('local') && $fcDevUrl)
    <script src="{{ $fcDevUrl }}/__frontend-conqueror/overlay.js" defer></script>
@elseif(!app()->environment('local') && $fcGateUrl)
    <script src="{{ $fcGateUrl }}/{{ $fcProject }}/overlay.js" defer></script>
@endif
```

The `/<project>/overlay.js` path form is recommended (v0.5.0+). The gate bakes the project key into the overlay config server-side, so the page doesn't need to know about it.

### Other stacks

See [STACKS.md](./STACKS.md) for the compatibility matrix. Tier 3 (React/Svelte/Astro) and Tier 4 (raw Blade) currently get Test mode only — Edit and Dev TODO depend on per-framework scanners tracked in issues [#5](https://github.com/Jwan999/frontend-conqueror/issues/5) and [#6](https://github.com/Jwan999/frontend-conqueror/issues/6).

---

## Step 3 — Deploy the gate alongside your project

The gate is a single zero-dependency Node script at `node_modules/frontend-conqueror/gate/server.js`. Run it as a long-lived process on the same server as your project, exposed via your reverse proxy at a stable URL like `https://gate.YOUR-DOMAIN.com`.

Pick whichever fits your existing stack.

### Option A — PM2 sidecar (recommended for Node-based projects)

If you already run your app via PM2, add the gate as a second app entry. See [examples/ecosystem.config.example.cjs](./examples/ecosystem.config.example.cjs):

```js
module.exports = {
  apps: [
    {
      name: 'my-app',
      script: '.output/server/index.mjs',
      env: { NODE_ENV: 'production', NUXT_PUBLIC_GATE_URL: 'https://gate.my-domain.com' },
    },
    {
      name: 'my-app-gate',
      script: 'node_modules/frontend-conqueror/gate/server.js',
      env: {
        NODE_ENV: 'production',
        GATE_PORT: 54322,
        GATE_HOST: '127.0.0.1',                       // localhost only — reverse proxy exposes it
        GATE_PUBLIC_URL: 'https://gate.my-domain.com',
        GATE_PROJECT_NAME: 'my-app',                   // controls admin path: /my-app
        GATE_DATA: '/var/data/my-app-gate.json',       // persist across deploys
        // GATE_ADMIN_PASSWORD + GATE_JWT_SECRET set via server env, not committed
      },
    },
  ],
};
```

Then on the server:

```bash
export GATE_ADMIN_PASSWORD="$(openssl rand -hex 12)"   # write this down once
export GATE_JWT_SECRET="$(openssl rand -hex 32)"
pm2 start ecosystem.config.cjs
pm2 save
```

### Option B — Docker sidecar (for containerized projects)

Add a second service to your `docker-compose.yml`. See [examples/docker-compose.example.yml](./examples/docker-compose.example.yml).

### Option C — systemd unit (for plain VPS deploys)

See [examples/frontend-conqueror-gate.service.example](./examples/frontend-conqueror-gate.service.example).

---

## Step 4 — Reverse proxy `gate.your-domain.com` → port 54322

The gate binds to 127.0.0.1:54322 by default. Your existing reverse proxy (Caddy, nginx, Traefik) maps the public hostname to it.

### Caddy

See [examples/Caddyfile.example](./examples/Caddyfile.example):

```caddyfile
gate.my-domain.com {
    reverse_proxy 127.0.0.1:54322
}
```

That's it. Caddy auto-provisions HTTPS.

### nginx

See [examples/nginx.example.conf](./examples/nginx.example.conf).

---

## Step 5 — First-time admin setup

Visit `https://gate.YOUR-DOMAIN.com/frontend-conqueror`.

1. Log in with the default password — **shown on the login page until you change it**.
2. You'll be force-prompted to change it. New password ≥ 8 chars.
3. **Setup wizard (5 steps):**
   1. Paste your Linear API key.
   2. Pick your team (auto-skipped if you have only one).
   3. Name your first project — display name + key (e.g. "Messarat" / `messarat`). The key is what you put in `gate.project` in plugin configs.
   4. Pick or create a Linear project for it. Bugs from this project land there.
   5. Add at least one tester email.
4. Done — you're on the project's detail page.

After setup, adding more projects is a 2-step wizard (Linear destination + testers), and **auto-detected pending projects** (from heartbeats) show up at the top of the project list with a one-click "Configure" button.

Bookmark `https://gate.YOUR-DOMAIN.com/frontend-conqueror` — that's the only URL the admin uses.

---

## Step 6 — Have a tester file a bug

Tell your tester:

1. Visit the prod site (`https://my-domain.com`).
2. Press **Shift Shift**.
3. Pick **Test** in the palette.
4. Enter their email (the one you allowlisted).
5. Hover the component that's broken → click → fill in the report → submit.

The issue lands in Linear within ~1 second, with the page URL, component hint, and reporter email attached. The tester sees a green confirmation.

---

## Operating notes

### Updating the plugin

```bash
# in each project
# 1. bump the tag in package.json (e.g. v0.4.0 → v0.4.1)
# 2. npm install
# 3. rebuild + redeploy
```

PM2's `messarat-gate` entry will pick up the new gate code on the next `pm2 reload`. No data loss — `GATE_DATA` is outside `node_modules`.

### Persisting `data.json`

The gate writes admin password hash, JWT-rotated state, allowlist, and Linear key to `GATE_DATA`. Make sure that path is **outside your deployment directory** so deploys don't wipe it. `/var/data/<project>-gate.json` is a safe default.

Back it up like any database. If you lose it, run setup again from Step 5.

### Rotating secrets

- Rotating `GATE_ADMIN_PASSWORD` (env var): only takes effect on the *next first login* if you've never changed it from the default. After first change, the hash in `data.json` is authoritative.
- Rotating `GATE_JWT_SECRET`: instantly invalidates every active session — useful "kick everyone" button. Restart PM2 to apply.

### Logs

PM2 captures stdout/stderr. `pm2 logs my-app-gate --lines 200`. The gate logs every request, plus auth events. Linear API errors surface here.

### Costs

The gate is one tiny Node process. For a 50-tester team filing < 100 issues a day:
- RAM: ~30MB
- Disk: < 1MB
- CPU: negligible
- Network: < 1MB/day

It fits anywhere your app already runs.

---

## Troubleshooting

**Overlay doesn't appear in prod.**
- Open browser devtools → Network → look for `overlay.js`. Should return 200.
- If 404: `NUXT_PUBLIC_GATE_URL` / `FRONTEND_CONQUEROR_GATE_URL` is unset or wrong.
- If CORS error: gate isn't reachable from the page's origin. Check reverse proxy.

**Tester gets `403 not-allowed`.**
- Email isn't in the allowlist, or has a typo. Admin → check allowlist.
- The 300ms delay is intentional — prevents email enumeration.

**Issues file but don't appear in Linear.**
- Linear API key is missing or revoked. Admin → re-paste it.
- Linear project was deleted. Admin → pick a different project.

**Admin can't log in.**
- Default password was changed but new one was lost. SSH the server, delete `GATE_DATA`, restart. You'll be back to default password (and an empty allowlist — re-add testers).

**Multiple projects, each needs Test mode.**
- One gate per project. Spin up additional PM2 entries on different ports (54322, 54323, …) with different `GATE_PUBLIC_URL`, `GATE_PROJECT_NAME`, `GATE_DATA`. Reverse-proxy each at a different hostname.
