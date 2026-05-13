// Vanilla Vite + Vue SPA example.
// Drop this into your vite.config.js (merge with your existing plugins).

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import frontendConquerorPlugin from 'frontend-conqueror/plugin';

const isDev = process.env.NODE_ENV !== 'production';

export default defineConfig({
  plugins: [
    vue(),
    ...(isDev ? [
      frontendConquerorPlugin({
        projectRoot: process.cwd(),
        locales: ['en'],
        agentPort: 54321,
        gate: {
          url: process.env.VITE_GATE_URL || 'http://localhost:54322',
          project: 'my-app',
        },
      }),
    ] : []),
  ],
});

// In your index.html, for PRODUCTION add this script tag inside <head>:
//
//   <script src="https://gate.YOUR-DOMAIN.com/overlay.js" defer></script>
//
// Vite injects the dev overlay automatically; you only need this tag for prod.
// For environment-specific HTML, use Vite's transformIndexHtml or a build-time
// replacement.
