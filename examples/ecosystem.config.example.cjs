// PM2 ecosystem example: your app + the frontend-conqueror gate, side-by-side.
//
// The gate runs as a sidecar Node process bound to localhost:54322.
// Your reverse proxy (Caddy/nginx) maps a public hostname to it.
//
// Secrets (GATE_ADMIN_PASSWORD, GATE_JWT_SECRET) should be set in the server
// environment, NOT committed here.

module.exports = {
  apps: [
    {
      name: 'my-app',
      script: '.output/server/index.mjs',   // Nuxt example; adapt to your framework
      env: {
        NODE_ENV: 'production',
        NUXT_PUBLIC_GATE_URL: 'https://gate.my-domain.com',
        // ...your other prod env vars
      },
    },
    {
      // frontend-conqueror gate.
      name: 'my-app-gate',
      script: 'node_modules/frontend-conqueror/gate/server.js',
      env: {
        NODE_ENV: 'production',
        GATE_PORT: 54322,
        GATE_HOST: '127.0.0.1',                          // localhost only; reverse proxy exposes it
        GATE_PUBLIC_URL: 'https://gate.my-domain.com',   // your gate's public URL
        GATE_PROJECT_NAME: 'my-app',                      // admin path: /my-app
        GATE_DATA: '/var/data/my-app-gate.json',          // persist across deploys
        // GATE_ADMIN_PASSWORD: set this in the server env, e.g. via .env or systemd EnvironmentFile
        // GATE_JWT_SECRET: same — 32+ random bytes
      },
    },
  ],
};
