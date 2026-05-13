// Laravel + Vite + Vue example.
// Merge this with your existing vite.config.js.

import { defineConfig } from 'vite';
import laravel from 'laravel-vite-plugin';
import vue from '@vitejs/plugin-vue';
import frontendConquerorPlugin from 'frontend-conqueror/plugin';

const isDev = process.env.NODE_ENV !== 'production';

export default defineConfig({
  plugins: [
    laravel({
      input: [
        'resources/css/app.css',
        'resources/js/app.js',
        // ...your existing inputs
      ],
      refresh: true,
    }),
    vue({
      template: {
        transformAssetUrls: { base: null, includeAbsolute: false },
      },
    }),
    ...(isDev ? [
      frontendConquerorPlugin({
        projectRoot: process.cwd(),
        locales: ['en'],
        agentPort: 54321,
        gate: {
          url: process.env.FRONTEND_CONQUEROR_GATE_URL || 'http://localhost:54322',
        },
      }),
    ] : []),
  ],
});

// The Blade view that hosts your Vue app needs an overlay <script> tag.
// See ./admin.blade.example.php for the snippet.