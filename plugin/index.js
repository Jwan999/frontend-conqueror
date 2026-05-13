// frontend-conqueror — Vite plugin
//
// Three jobs in dev mode:
//   1. Scan the project's i18n source file once and on each request to build a
//      path-keyed map of every leaf string literal — e.g. `en.about.h1Top` →
//      {file, offset, length}. Served at `/__frontend-conqueror/map.json`.
//   2. Transform every `.vue` template: literal text-bearing elements get
//      `data-edit-loc="file:offset:length"`. Interpolations whose expression
//      is a member-chain on a configured i18n root (e.g. `t.about.h1Top`) get
//      `data-edit-i18n-path="about.h1Top"`. Other interpolations get
//      `data-edit-dyn="1"` so the overlay knows to fall back to value lookup.
//   3. Serve `/__frontend-conqueror/overlay.js` and inject the script tag into
//      every HTML response. No symlinks, no manual setup.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OVERLAY_URL = '/__frontend-conqueror/overlay.js';
const MAP_URL = '/__frontend-conqueror/map.json';

function relPath(root, p) {
  return path.relative(root, p).replace(/\\/g, '/');
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function getLineCol(content, offset) {
  const before = content.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length };
}

// ----- Resolve dependencies from the consuming project, falling back to the plugin's own deps -----
function resolveDep(name, fromRoot) {
  for (const fromPath of [fromRoot, __dirname]) {
    try {
      const p = require.resolve(name, { paths: [fromPath] });
      return require(p);
    } catch {}
  }
  return null;
}

// ----- Parse simple member-chain expressions like `t.about.h1Top` or `t["about"].h1Top` -----
// Returns { root, path: 'about.h1Top' } or null when the expression isn't a clean static chain.
function parseMemberChain(expr, allowedRoots) {
  expr = String(expr || '').trim();
  const idRe = /^[A-Za-z_$][\w$]*/;
  const m = expr.match(idRe);
  if (!m) return null;
  const root = m[0];
  if (!allowedRoots.includes(root)) return null;
  let i = root.length;
  const segments = [];
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '.') {
      i++;
      while (i < expr.length && /\s/.test(expr[i])) i++;
      const seg = expr.slice(i).match(idRe);
      if (!seg) return null;
      // Skip `value` for ref/computed unwrap in script setup access — not seen in templates but safe.
      if (seg[0] === 'value' && segments.length === 0) { i += seg[0].length; continue; }
      segments.push(seg[0]);
      i += seg[0].length;
    } else if (ch === '[') {
      i++;
      while (i < expr.length && /\s/.test(expr[i])) i++;
      const q = expr[i];
      if (q !== '"' && q !== "'") return null;
      i++;
      let s = '';
      while (i < expr.length && expr[i] !== q) {
        if (expr[i] === '\\') { s += expr[i + 1]; i += 2; }
        else { s += expr[i]; i++; }
      }
      i++;
      while (i < expr.length && /\s/.test(expr[i])) i++;
      if (expr[i] !== ']') return null;
      i++;
      segments.push(s);
    } else {
      // Anything else (call, ternary, operator) — not a static chain.
      return null;
    }
  }
  if (segments.length === 0) return null;
  return { root, path: segments.join('.') };
}

// ----- Walk an i18n source file as an AST and emit one entry per leaf string literal -----
function scanI18nAst(content, fileRel, localeNames, babelParser) {
  let ast;
  try {
    ast = babelParser.parse(content, {
      sourceType: 'module',
      plugins: ['typescript'],
      allowImportExportEverywhere: true,
      errorRecovery: true,
    });
  } catch {
    return [];
  }

  const entries = [];

  function walk(node, segments, locale) {
    if (!node) return;
    if (node.type === 'ObjectExpression') {
      for (const prop of node.properties || []) {
        if (prop.type !== 'ObjectProperty' && prop.type !== 'Property') continue;
        let key = null;
        if (prop.key) {
          if (prop.key.type === 'Identifier') key = prop.key.name;
          else if (prop.key.type === 'StringLiteral') key = prop.key.value;
          else if (prop.key.type === 'NumericLiteral') key = String(prop.key.value);
        }
        if (key == null) continue;
        walk(prop.value, segments.concat(key), locale);
      }
    } else if (node.type === 'ArrayExpression') {
      (node.elements || []).forEach((el, i) => {
        if (el) walk(el, segments.concat(String(i)), locale);
      });
    } else if (node.type === 'StringLiteral') {
      const offset = node.start;
      const length = node.end - node.start;
      const { line, col } = getLineCol(content, offset);
      entries.push({
        value: node.value,
        path: segments.join('.'),
        locale,
        file: fileRel,
        offset, length, line, col,
        kind: 'string-literal',
      });
    } else if (node.type === 'TemplateLiteral') {
      // Each TemplateElement (quasi) is a static chunk between `${...}` interpolations.
      // We record each non-empty quasi as its own editable entry. When edited, the
      // agent must re-escape backticks and `${` so the template literal stays valid.
      (node.quasis || []).forEach((q, i) => {
        if (!q || !q.value) return;
        const cooked = q.value.cooked == null ? q.value.raw : q.value.cooked;
        if (!cooked) return;
        const offset = q.start;
        const length = q.end - q.start;
        if (length === 0) return;
        const { line, col } = getLineCol(content, offset);
        entries.push({
          value: cooked,
          path: segments.join('.'),
          locale,
          file: fileRel,
          offset, length, line, col,
          kind: 'template-quasi',
          quasiIndex: i,
        });
      });
    } else if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
      // Recurse into expression-body arrows like `(s) => \`prefix ${s} suffix\``.
      // Block-body functions are deliberately skipped — too easy to misattribute.
      if (node.body && node.body.type !== 'BlockStatement') walk(node.body, segments, locale);
    } else if (node.type === 'ConditionalExpression') {
      walk(node.consequent, segments, locale);
      walk(node.alternate, segments, locale);
    }
  }

  function topLevelDecls(body) {
    const out = [];
    for (const node of body) {
      if (node.type === 'VariableDeclaration') out.push(...node.declarations);
      else if (node.type === 'ExportNamedDeclaration' && node.declaration && node.declaration.type === 'VariableDeclaration') {
        out.push(...node.declaration.declarations);
      }
    }
    return out;
  }

  for (const d of topLevelDecls(ast.program.body)) {
    const name = d.id && d.id.name;
    if (!name) continue;
    const isLocale = localeNames.includes(name);
    if (!d.init) continue;
    walk(d.init, [], isLocale ? name : null);
  }

  return entries;
}

// ----- Transform a .vue source string: emit data-edit-loc / data-edit-i18n-path / data-edit-dyn -----
function transformVueSource(code, fileRel, deps, options) {
  if (!deps.compilerSfc) return null;
  let parsed;
  try { parsed = deps.compilerSfc.parse(code); } catch { return null; }
  const tpl = parsed && parsed.descriptor && parsed.descriptor.template;
  if (!tpl) return null;
  const templateInner = tpl.content;
  const templateOffset = tpl.loc.start.offset;

  let ast;
  try { ast = deps.compilerDom.parse(templateInner); }
  catch { return null; }

  const transforms = [];
  function insertionPoint(node) {
    if (node.props && node.props.length > 0) {
      return templateOffset + node.props[node.props.length - 1].loc.end.offset;
    }
    return templateOffset + node.loc.start.offset + 1 + node.tag.length;
  }

  function exprOf(interp) {
    return interp && interp.content && interp.content.content;
  }

  function walk(node) {
    if (!node) return;
    if (node.type === 1) {
      // Every real element gets a data-edit-source pointer back to its opening tag
      // offset in the source file. Used by Test mode (Linear issue source ref) and
      // Dev TODO mode (comment insertion point) — both modes hover the whole
      // component, not individual text nodes.
      const elementSourceOffset = templateOffset + node.loc.start.offset;
      transforms.push({
        at: insertionPoint(node),
        str: ` data-edit-source="${escapeAttr(fileRel)}:${elementSourceOffset}"`,
      });

      const children = node.children || [];
      const interpChildren = children.filter((c) => c.type === 5);
      const elementChildren = children.filter((c) => c.type === 1);
      const nonEmptyTextChildren = children.filter((c) => c.type === 2 && c.content && c.content.trim().length > 0);
      const isOnlyText = nonEmptyTextChildren.length > 0 && elementChildren.length === 0 && interpChildren.length === 0;
      const isSingleInterpolationOnly =
        interpChildren.length === 1 &&
        elementChildren.length === 0 &&
        nonEmptyTextChildren.length === 0;
      const hasMixedInterpolations = interpChildren.length > 0 && !isSingleInterpolationOnly;

      if (isOnlyText) {
        const textNode = nonEmptyTextChildren[0];
        const raw = textNode.content;
        const leadingWs = raw.length - raw.replace(/^\s*/, '').length;
        const trailingWs = raw.length - raw.replace(/\s*$/, '').length;
        const trimmedOffset = templateOffset + textNode.loc.start.offset + leadingWs;
        const trimmedLength = raw.length - leadingWs - trailingWs;
        transforms.push({
          at: insertionPoint(node),
          str: ` data-edit-loc="${escapeAttr(fileRel)}:${trimmedOffset}:${trimmedLength}"`,
        });
      } else if (isSingleInterpolationOnly) {
        const chain = parseMemberChain(exprOf(interpChildren[0]), options.i18nRoots);
        if (chain) {
          transforms.push({ at: insertionPoint(node), str: ` data-edit-i18n-path="${escapeAttr(chain.path)}"` });
        } else {
          transforms.push({ at: insertionPoint(node), str: ' data-edit-dyn="1"' });
        }
      } else if (hasMixedInterpolations) {
        // Wrap each interpolation in <span data-edit-i18n-path="...">{{ … }}</span>
        // so each text node has its own resolvable ancestor attribute. The wrapper
        // <span> is an inline element and stays transparent to most CSS.
        for (const interp of interpChildren) {
          const chain = parseMemberChain(exprOf(interp), options.i18nRoots);
          const attr = chain
            ? `data-edit-i18n-path="${escapeAttr(chain.path)}"`
            : 'data-edit-dyn="1"';
          const openAt = templateOffset + interp.loc.start.offset;
          const closeAt = templateOffset + interp.loc.end.offset;
          transforms.push({ at: openAt, str: `<span ${attr}>` });
          transforms.push({ at: closeAt, str: '</span>' });
        }
      }
      for (const c of children) walk(c);
    } else if (node.children) {
      for (const c of node.children) walk(c);
    }
  }
  walk(ast);

  if (transforms.length === 0) return null;
  transforms.sort((a, b) => b.at - a.at);
  let out = code;
  for (const t of transforms) {
    out = out.slice(0, t.at) + t.str + out.slice(t.at);
  }
  return out;
}

// ===================================================================================
module.exports = function frontendConquerorPlugin(options = {}) {
  const opt = {
    locales: options.locales || ['en'],
    i18nFile: options.i18nFile || null,
    i18nRoots: options.i18nRoots || ['t', '$t', 'i18n', 'messages'],
    projectRoot: options.projectRoot || null,
    overlayFile: options.overlayFile || path.join(__dirname, '..', 'overlay', 'overlay.js'),
    autoInject: options.autoInject !== false,
    agentPort: options.agentPort || 54321,
    // Auto-spawn the agent when the Vite dev server starts so devs don't have
    // to run it in a second terminal. Set `autoStartAgent: false` to keep the
    // old behavior (useful if you want to run the agent under a debugger).
    autoStartAgent: options.autoStartAgent !== false,
    agentPath: options.agentPath || path.join(__dirname, '..', 'agent', 'server.js'),
    // Test mode wiring. Pass `{ url, project }`:
    //   url:     base URL of the gate service (dev: http://localhost:54322)
    //   project: project key registered in the gate (v0.5.0+; omit for
    //            single-project gates falling back to the default project).
    // Without `gate`, Test mode shows a "configure gate" toast.
    gate: options.gate || null,
  };

  let projectRoot;
  let i18nFile = null;
  let deps = { compilerDom: null, compilerSfc: null, babelParser: null };

  function loadDeps() {
    deps.compilerDom = resolveDep('@vue/compiler-dom', projectRoot);
    deps.compilerSfc = resolveDep('@vue/compiler-sfc', projectRoot);
    deps.babelParser = resolveDep('@babel/parser', projectRoot);
  }

  function buildI18nMap() {
    if (!i18nFile || !fs.existsSync(i18nFile) || !deps.babelParser) return [];
    try {
      const content = fs.readFileSync(i18nFile, 'utf8');
      return scanI18nAst(content, relPath(projectRoot, i18nFile), opt.locales, deps.babelParser);
    } catch {
      return [];
    }
  }

  return {
    name: 'frontend-conqueror',
    enforce: 'pre',

    configResolved(config) {
      const viteRoot = config.root || process.cwd();
      projectRoot = opt.projectRoot
        ? path.resolve(viteRoot, opt.projectRoot)
        : viteRoot;

      const candidates = opt.i18nFile
        ? [path.resolve(projectRoot, opt.i18nFile)]
        : [
            'app/i18n.ts', 'app/i18n.js',
            'src/i18n.ts', 'src/i18n.js',
            'i18n.ts', 'i18n.js',
            'locales/index.ts', 'locales/index.js',
          ].map((p) => path.join(projectRoot, p));
      for (const c of candidates) {
        if (fs.existsSync(c)) { i18nFile = c; break; }
      }

      loadDeps();

      const flags = [
        `i18n=${i18nFile ? relPath(projectRoot, i18nFile) : '(none)'}`,
        `roots=[${opt.i18nRoots.join(',')}]`,
        `vue=${deps.compilerDom && deps.compilerSfc ? 'on' : 'off'}`,
        `ast=${deps.babelParser ? 'on' : 'off'}`,
      ].join(' ');
      console.log(`[frontend-conqueror] ${flags}`);
    },

    configureServer(server) {
      if (opt.autoStartAgent) {
        if (!fs.existsSync(opt.agentPath)) {
          console.warn(`[frontend-conqueror] agent not found at ${opt.agentPath} — Edit/TODO modes won't write to disk`);
        } else {
          const child = spawn(process.execPath, [opt.agentPath, projectRoot, String(opt.agentPort)], {
            stdio: ['ignore', 'inherit', 'inherit'],
            env: process.env,
          });
          child.on('error', (err) => {
            console.warn(`[frontend-conqueror] agent failed to start: ${err.message}`);
          });
          const stop = () => {
            try { if (!child.killed) child.kill(); } catch {}
          };
          server.httpServer?.once('close', stop);
          process.once('exit', stop);
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
          console.log(`[frontend-conqueror] agent spawned (pid ${child.pid}, port ${opt.agentPort}, root ${projectRoot})`);
        }
      }

      server.middlewares.use(MAP_URL, (_req, res) => {
        const m = buildI18nMap();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(m));
      });
      server.middlewares.use(OVERLAY_URL, (_req, res) => {
        try {
          const body = fs.readFileSync(opt.overlayFile, 'utf8');
          // Prepend the plugin config so Nuxt/Nitro-rendered HTML (which never
          // goes through Vite's transformIndexHtml) still has it. For vanilla
          // Vite projects the transformIndexHtml hook *also* sets this; the
          // duplicate assignment is harmless.
          const cfg = {
            mapUrl: MAP_URL,
            wsUrl: `ws://localhost:${opt.agentPort}`,
            locales: opt.locales,
            gate: opt.gate || null,
            enabledModes: ['edit', 'todo', 'test'],
          };
          const prelude = `window.__frontendConquerorConfig=${JSON.stringify(cfg)};\n`;
          res.setHeader('Content-Type', 'application/javascript');
          res.setHeader('Cache-Control', 'no-store');
          res.end(prelude + body);
        } catch (e) {
          res.statusCode = 500;
          res.end(`/* frontend-conqueror: overlay file missing (${e.message}) */`);
        }
      });
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!opt.autoInject) return html;
        const cfg = {
          mapUrl: MAP_URL,
          wsUrl: `ws://localhost:${opt.agentPort}`,
          locales: opt.locales,
          gate: opt.gate || null,
          enabledModes: ['edit', 'todo', 'test'],
        };
        const tag = `<script>window.__frontendConquerorConfig=${JSON.stringify(cfg)};</script>` +
                    `<script src="${OVERLAY_URL}" defer></script>`;
        if (html.includes('</head>')) return html.replace('</head>', `${tag}</head>`);
        return html + tag;
      },
    },

    transform(code, id) {
      if (!deps.compilerDom || !deps.compilerSfc) return null;
      if (id.includes('?')) return null;
      if (!id.endsWith('.vue')) return null;
      const fileRel = relPath(projectRoot, id);
      try {
        const out = transformVueSource(code, fileRel, deps, opt);
        if (out) return { code: out, map: null };
      } catch {}
      return null;
    },
  };
};

module.exports.default = module.exports;