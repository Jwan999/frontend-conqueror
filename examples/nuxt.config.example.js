// Nuxt 3 / Nuxt 4 example.
// Drop this into your nuxt.config.js (merge with your existing config).

import frontendConquerorPlugin from 'frontend-conqueror/plugin';

const isDev = process.env.NODE_ENV !== 'production';

export default defineNuxtConfig({
  app: {
    head: {
      script: isDev
        ? [{ src: '/__frontend-conqueror/overlay.js', defer: true }]
        : (process.env.NUXT_PUBLIC_GATE_URL
            ? [{ src: `${process.env.NUXT_PUBLIC_GATE_URL}/overlay.js`, defer: true }]
            : []),
    },
  },

  vite: {
    plugins: isDev ? [
      frontendConquerorPlugin({
        projectRoot: process.cwd(),
        // Your i18n locales. Falls back to ['en'] if not provided.
        locales: ['en', 'ar'],
        // Optional: path to your i18n file. The plugin auto-discovers common
        // locations (app/i18n.ts, src/i18n.ts, etc.) if omitted.
        // i18nFile: 'app/i18n.ts',
        // Auto-spawns the agent on this port. Use a unique port per project
        // if you run multiple dev servers simultaneously.
        agentPort: 54321,
        // Gate URL for Test mode. Use a public URL in prod; localhost in dev.
        gate: {
          url: process.env.NUXT_PUBLIC_GATE_URL || 'http://localhost:54322',
        },
      }),
    ] : [],
  },
});