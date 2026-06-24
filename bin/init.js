#!/usr/bin/env node
// frontend-conqueror — `fc init`
//
// Detects the consuming project's stack (Nuxt / vanilla Vite / Laravel+Vite)
// and prints the exact, ready-to-paste wiring for it: the plugin block, the
// prod overlay <script> tag, and the gate url/project values filled in. This
// removes the "hand-copy two snippets from the README into two files and hope
// you got the right prod URL" friction the install flow had.
//
// It deliberately does NOT rewrite the user's vite.config / nuxt.config for
// them — those files vary too much to edit blindly. Instead it gives a precise
// snippet keyed to the detected stack, with values already substituted, plus a
// short checklist. Safe to run repeatedly.
//
// Flags (all optional — sensible defaults derived from the project):
//   --gate-url=<url>     gate base URL          (default: http://localhost:54322)
//   --project=<key>      gate project key       (default: package.json "name", slugified)
//   --locales=en,ar      editable locales       (default: en)
//   --side=frontend|backend   split-repo side   (default: none)

'use strict';

const fs = require('fs');
const path = require('path');

const cwd = process.cwd();

// ---- tiny flag parser (--k=v and --k v) ----
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq >= 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function slugify(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/^@[^/]+\//, '')        // drop npm scope, e.g. @acme/site → site
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64);
}

function pluginVersion() {
  const pkg = readJsonSafe(path.join(__dirname, '..', 'package.json'));
  return pkg && pkg.version ? pkg.version : '0.0.0';
}

// ---- stack detection ----
function exists(...rel) { return fs.existsSync(path.join(cwd, ...rel)); }
function detectStack() {
  if (exists('nuxt.config.ts') || exists('nuxt.config.js') || exists('nuxt.config.mjs')) return 'nuxt';
  const hasVite = exists('vite.config.ts') || exists('vite.config.js') || exists('vite.config.mjs');
  if (exists('artisan') && hasVite) return 'laravel';
  if (hasVite) return 'vite';
  return 'unknown';
}

// ---- ANSI (skipped when not a TTY, so piped output stays clean) ----
const tty = process.stdout.isTTY;
const c = {
  b: (s) => tty ? '\x1b[1m' + s + '\x1b[0m' : s,
  dim: (s) => tty ? '\x1b[2m' + s + '\x1b[0m' : s,
  cyan: (s) => tty ? '\x1b[36m' + s + '\x1b[0m' : s,
  green: (s) => tty ? '\x1b[32m' + s + '\x1b[0m' : s,
  yellow: (s) => tty ? '\x1b[33m' + s + '\x1b[0m' : s,
};

function main() {
  const flags = parseFlags(process.argv.slice(2));
  const version = pluginVersion();
  const consumerPkg = readJsonSafe(path.join(cwd, 'package.json'));

  const gateUrl = String(flags['gate-url'] || 'http://localhost:54322').replace(/\/+$/, '');
  const project = slugify(flags.project || (consumerPkg && consumerPkg.name) || path.basename(cwd)) || 'my-app';
  const locales = String(flags.locales || 'en').split(',').map((s) => s.trim()).filter(Boolean);
  const localesLit = locales.map((l) => `'${l}'`).join(', ');
  const side = (flags.side === 'frontend' || flags.side === 'backend') ? flags.side : null;
  const sideProp = side ? `, side: '${side}'` : '';
  const sideQ = side ? `&side=${side}` : '';

  const stack = detectStack();

  // Dependency status (informational — guides the install line).
  const dep = consumerPkg && ((consumerPkg.devDependencies && consumerPkg.devDependencies['frontend-conqueror'])
    || (consumerPkg.dependencies && consumerPkg.dependencies['frontend-conqueror']));

  const out = [];
  const p = (s) => out.push(s == null ? '' : s);

  p('');
  p(c.b('frontend-conqueror · init'));
  p(c.dim(`  detected stack: ${stack}   ·   plugin v${version}`));
  p('');

  // 1) install
  p(c.b('1. Install (pin to a tag)'));
  if (dep) {
    p(c.green(`   ✓ already a dependency: ${dep}`));
    p(c.dim(`     to move to this version:  npm install --save-dev github:Jwan999/frontend-conqueror#v${version}`));
  } else {
    p(`   npm install --save-dev github:Jwan999/frontend-conqueror#v${version}`);
  }
  p('');

  // 2) wiring (stack-specific)
  const prodTag = `<script src="${gateUrl}/${project}/overlay.js?v=${version}${sideQ}" defer></script>`;

  if (stack === 'nuxt') {
    p(c.b('2. Wire it into nuxt.config'));
    p(c.dim('   Add the import at the top, the plugin under vite.plugins (dev only),'));
    p(c.dim('   and the overlay script under app.head.script:'));
    p('');
    p(c.cyan([
      `import frontendConquerorPlugin from 'frontend-conqueror/plugin'`,
      `const isDev = process.env.NODE_ENV !== 'production'`,
      `const fcVersion = '${version}'`,
      ``,
      `export default defineNuxtConfig({`,
      `  vite: {`,
      `    plugins: isDev ? [frontendConquerorPlugin({`,
      `      projectRoot: process.cwd(),`,
      `      locales: [${localesLit}],`,
      `      gate: { url: process.env.NUXT_PUBLIC_GATE_URL || '${gateUrl}', project: '${project}'${sideProp} },`,
      `    })] : [],`,
      `  },`,
      `  app: {`,
      `    head: {`,
      `      script: [`,
      `        isDev`,
      `          ? { src: '/__frontend-conqueror/overlay.js', defer: true }`,
      `          : { src: \`${gateUrl}/${project}/overlay.js?v=\${fcVersion}${sideQ}\`, defer: true },`,
      `      ],`,
      `    },`,
      `  },`,
      `})`,
    ].join('\n')));
  } else if (stack === 'laravel') {
    p(c.b('2a. Wire the plugin into vite.config.js'));
    p(c.cyan([
      `import frontendConquerorPlugin from 'frontend-conqueror/plugin'`,
      `const isDev = process.env.NODE_ENV !== 'production'`,
      ``,
      `export default defineConfig({`,
      `  plugins: [`,
      `    // ...your existing plugins (laravel(), vue(), ...)`,
      `    ...(isDev ? [frontendConquerorPlugin({`,
      `      projectRoot: process.cwd(),`,
      `      locales: [${localesLit}],`,
      `      gate: { url: process.env.FRONTEND_CONQUEROR_GATE_URL || '${gateUrl}', project: '${project}'${sideProp} },`,
      `    })] : []),`,
      `  ],`,
      `})`,
    ].join('\n')));
    p('');
    p(c.b('2b. Add the prod overlay tag to your Blade layout'));
    p(c.dim('   In the <head> of the layout testers use (guard it to non-local if you like):'));
    p('');
    p(c.cyan(prodTag));
  } else if (stack === 'vite') {
    p(c.b('2. Wire it into vite.config'));
    p(c.dim('   The dev overlay is auto-injected into index.html — no script tag needed in dev.'));
    p('');
    p(c.cyan([
      `import frontendConquerorPlugin from 'frontend-conqueror/plugin'`,
      `const isDev = process.env.NODE_ENV !== 'production'`,
      ``,
      `export default defineConfig({`,
      `  plugins: [`,
      `    // ...your existing plugins`,
      `    ...(isDev ? [frontendConquerorPlugin({`,
      `      projectRoot: process.cwd(),`,
      `      locales: [${localesLit}],`,
      `      gate: { url: '${gateUrl}', project: '${project}'${sideProp} },`,
      `    })] : []),`,
      `  ],`,
      `})`,
    ].join('\n')));
    p('');
    p(c.b('   For production, add the overlay tag to your built index.html <head>:'));
    p(c.cyan(prodTag));
  } else {
    p(c.yellow('2. Could not detect a Nuxt/Vite/Laravel config in this directory.'));
    p(c.dim('   Run `fc init` from your project root, or see README "Wire it up".'));
    p(c.dim('   The prod overlay tag for this project would be:'));
    p('');
    p(c.cyan(prodTag));
  }

  p('');
  p(c.b('3. Configure the gate'));
  p(c.dim(`   Open the gate admin, find the auto-detected "${project}" project,`));
  p(c.dim('   click Configure → bind its domain(s) + GitHub repo + a tester, then Activate.'));
  p(`   gate admin: ${gateUrl}/frontend-conqueror`);
  p('');
  p(c.dim('   Tip: re-run with --gate-url / --project / --locales / --side to change values.'));
  p('');

  process.stdout.write(out.join('\n') + '\n');
}

main();