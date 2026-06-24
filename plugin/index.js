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
const REFS_URL = '/__frontend-conqueror/refs.json';

// v0.13.0: the plugin's own version, injected into the overlay config so the
// overlay can report it on heartbeat and the gate can warn on version drift.
let PLUGIN_VERSION = '0.0.0';
try { PLUGIN_VERSION = require('./package.json').version; }
catch { try { PLUGIN_VERSION = require('../package.json').version; } catch {} }

// v0.12.5: Module-level singleton for the spawned agent process. Nuxt's dev
// server runs TWO Vite instances under the hood (client + SSR), both of
// which load this plugin and call configureServer. Before this guard, the
// second configureServer call spawned a second agent that immediately
// EADDRINUSE'd on the agent port — see the EADDRINUSE log in TM-frontend's
// initial dev boot. The first agent kept running but the spawn log + crash
// noise was confusing, and the per-Vite `server.httpServer.once('close')`
// handler used to kill the shared agent any time either Vite restarted
// (HMR, config change), leaving the overlay showing "Agent not connected"
// until the next reload. Singleton + remove the per-Vite kill = the dev
// agent stays alive for the whole `npm run dev` lifetime, killed only on
// real process exit.
let _agentChild = null;

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

// ----- Scan a JSON locale file (e.g. i18n/locales/en.json) and emit one entry per leaf string. -----
// Tracks byte offsets manually because JSON.parse loses positions. Mini recursive-descent parser
// kept small and dep-free — JSON is simple enough that 80 lines covers the whole spec for our use case
// (we don't care about numbers/booleans/null leaves; only strings are editable values).
function scanI18nJsonFile(content, fileRel, locale) {
  const entries = [];
  let i = 0;
  function skipWs() { while (i < content.length && /\s/.test(content[i])) i++; }
  function expect(ch) { skipWs(); if (content[i] !== ch) throw new Error('expected ' + ch + ' at ' + i); i++; }
  function readString() {
    skipWs();
    if (content[i] !== '"') throw new Error('expected " at ' + i);
    const start = i;
    i++;
    let value = '';
    while (i < content.length && content[i] !== '"') {
      if (content[i] === '\\') {
        const esc = content[i + 1];
        i += 2;
        if (esc === 'n') value += '\n';
        else if (esc === 't') value += '\t';
        else if (esc === 'r') value += '\r';
        else if (esc === '"') value += '"';
        else if (esc === '\\') value += '\\';
        else if (esc === '/') value += '/';
        else if (esc === 'b') value += '\b';
        else if (esc === 'f') value += '\f';
        else if (esc === 'u') {
          const hex = content.slice(i, i + 4);
          value += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else value += esc;
      } else { value += content[i]; i++; }
    }
    if (content[i] !== '"') throw new Error('unterminated string at ' + start);
    i++;
    return { value, offset: start, length: i - start };
  }
  function readValue(segments) {
    skipWs();
    const ch = content[i];
    if (ch === '"') {
      const s = readString();
      const { line, col } = getLineCol(content, s.offset);
      entries.push({
        value: s.value, path: segments.join('.'), locale, file: fileRel,
        offset: s.offset, length: s.length, line, col, kind: 'json-string',
      });
    } else if (ch === '{') {
      i++; skipWs();
      if (content[i] === '}') { i++; return; }
      while (true) {
        skipWs();
        const key = readString();
        expect(':');
        readValue(segments.concat(key.value));
        skipWs();
        if (content[i] === ',') { i++; continue; }
        if (content[i] === '}') { i++; return; }
        throw new Error('expected , or } at ' + i);
      }
    } else if (ch === '[') {
      i++; skipWs();
      if (content[i] === ']') { i++; return; }
      let idx = 0;
      while (true) {
        readValue(segments.concat(String(idx++)));
        skipWs();
        if (content[i] === ',') { i++; continue; }
        if (content[i] === ']') { i++; return; }
        throw new Error('expected , or ] at ' + i);
      }
    } else {
      // number / bool / null — skip silently (not editable)
      while (i < content.length && /[a-zA-Z0-9_.+\-]/.test(content[i])) i++;
    }
  }
  try { readValue([]); } catch { return []; }
  return entries;
}

// Parse an i18n function-call form: `$t('foo.bar')`, `t('x')`, `this.$t('y')`, `i18n.t('z')`.
// Returns { root, path } for a single direct call, or null. Ignores trailing args
// like `$t('key', { name })` — we only need the key path.
function parseI18nCall(expr, allowedRoots) {
  const re = new RegExp('^\\s*(?:this\\.)?(' + allowedRoots.map(r => r.replace(/\$/g, '\\$')).join('|') + ')(?:\\.t)?\\s*\\(\\s*[\'"]([^\'"]+)[\'"]\\s*(?:,[\\s\\S]*)?\\)\\s*$');
  const m = String(expr || '').match(re);
  return m ? { root: m[1], path: m[2] } : null;
}

// Collect ALL i18n keys referenced in a more complex expression like a ternary
// (`cond ? $t('a') : $t('b')`), logical (`x || $t('y')`), or chained
// (`prefix + $t('z')`). Each call gets a key, and the overlay disambiguates at
// edit time by matching the displayed text to a map entry's value.
//
// Returns an array of key paths (deduped). Empty array if no i18n calls found.
function findAllI18nCalls(expr, allowedRoots) {
  const s = String(expr || '');
  const rootsPattern = allowedRoots.map(r => r.replace(/\$/g, '\\$')).join('|');
  // Match each `[this.]?<root>[.t]?('key'...)` occurrence within a longer expression.
  // Non-anchored, so picks up both arms of a ternary.
  const re = new RegExp('(?:this\\.)?(?:' + rootsPattern + ')(?:\\.t)?\\s*\\(\\s*[\'"]([^\'"]+)[\'"]', 'g');
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

// ----- Scan a .vue file's <script> block for editable strings at top-level data positions. -----
// Catches patterns that don't go through i18n but render via template interpolation:
//   const navItems = ['Home', 'About', 'Contact']
//   const links = [{ label: 'Home', to: '/' }, { label: 'About', to: '/about' }]
//   const PAGE_TITLE = 'Welcome'
//
// Each leaf string literal at an array-element or object-value position is recorded
// with its byte offset relative to the .vue file. Editing one writes that exact range.
function scanVueScript(scriptContent, scriptOffset, fileRel, babelParser) {
  if (!scriptContent || !babelParser) return [];
  let ast;
  try {
    ast = babelParser.parse(scriptContent, {
      sourceType: 'module',
      plugins: ['typescript'],
      allowImportExportEverywhere: true,
      errorRecovery: true,
    });
  } catch { return []; }

  const entries = [];
  // Record a string-literal node found at a value position.
  function record(node, pathSegments) {
    if (!node) return;
    const offset = scriptOffset + node.start;
    const length = node.end - node.start;
    if (!node.value || length < 2) return;     // skip empty strings
    // Skip strings used as imports, JSX, or type literals (heuristic: very short and matches identifier).
    entries.push({
      value: node.value,
      path: 'script:' + pathSegments.join('.'),
      locale: null,
      file: fileRel,
      offset, length,
      kind: 'string-literal',
    });
  }
  function recordTemplate(node, pathSegments) {
    if (!node || !node.quasis) return;
    node.quasis.forEach((q, i) => {
      const cooked = q.value && (q.value.cooked == null ? q.value.raw : q.value.cooked);
      if (!cooked) return;
      const offset = scriptOffset + q.start;
      const length = q.end - q.start;
      if (length === 0) return;
      entries.push({
        value: cooked,
        path: 'script:' + pathSegments.join('.') + '[' + i + ']',
        locale: null,
        file: fileRel,
        offset, length,
        kind: 'template-quasi',
        quasiIndex: i,
      });
    });
  }
  function walkValue(node, pathSegments) {
    if (!node) return;
    if (node.type === 'StringLiteral') {
      record(node, pathSegments);
    } else if (node.type === 'TemplateLiteral') {
      recordTemplate(node, pathSegments);
    } else if (node.type === 'ArrayExpression') {
      (node.elements || []).forEach((el, i) => walkValue(el, pathSegments.concat(String(i))));
    } else if (node.type === 'ObjectExpression') {
      for (const prop of node.properties || []) {
        if (prop.type !== 'ObjectProperty' && prop.type !== 'Property') continue;
        let key = null;
        if (prop.key) {
          if (prop.key.type === 'Identifier') key = prop.key.name;
          else if (prop.key.type === 'StringLiteral') key = prop.key.value;
        }
        if (key == null) continue;
        // Skip "to", "href", "src", "icon" — these are rarely user-visible text.
        if (['to', 'href', 'src', 'name', 'id', 'key', 'type', 'icon', 'class', 'role'].includes(key)) continue;
        walkValue(prop.value, pathSegments.concat(key));
      }
    } else if (node.type === 'CallExpression') {
      // Recurse into `computed(() => ...)`, `ref(...)`, etc.
      (node.arguments || []).forEach((a, i) => walkValue(a, pathSegments.concat('arg' + i)));
    } else if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
      if (node.body && node.body.type !== 'BlockStatement') walkValue(node.body, pathSegments);
    }
  }

  // Walk top-level variable declarations.
  for (const node of ast.program.body || []) {
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations || []) {
        if (!d.id || d.id.type !== 'Identifier' || !d.init) continue;
        walkValue(d.init, [d.id.name]);
      }
    } else if (node.type === 'ExportNamedDeclaration' && node.declaration && node.declaration.type === 'VariableDeclaration') {
      for (const d of node.declaration.declarations || []) {
        if (!d.id || d.id.type !== 'Identifier' || !d.init) continue;
        walkValue(d.init, [d.id.name]);
      }
    }
  }
  return entries;
}

// ============================================================================
// SYMBOL TABLE — for each .vue script block, resolve top-level declarations
// to their value shape. The template resolver uses this to trace expressions
// like {{ link.label }} back to a concrete i18n key or script literal range.
// ============================================================================

// Matches a CallExpression node against known i18n call forms:
//   $t('key'), t('key'), this.$t('key'), i18n.t('key'), messages.t('key')
// Returns the key string or null.
function matchI18nCallNode(node, allowedRoots) {
  if (!node || node.type !== 'CallExpression') return null;
  let callee = node.callee;
  let funcName = null;
  if (callee.type === 'Identifier') funcName = callee.name;
  else if (callee.type === 'MemberExpression') {
    if (callee.property && callee.property.type === 'Identifier') {
      funcName = callee.property.name;
    }
  }
  if (!funcName || !allowedRoots.includes(funcName)) return null;
  const arg = node.arguments && node.arguments[0];
  if (!arg || arg.type !== 'StringLiteral') return null;
  return arg.value;
}

// Returns a ResolvedValue describing what an AST expression node evaluates to,
// to the extent we can determine statically. Recurses into `computed(() => x)`,
// `ref(x)`, arrow-function expression bodies, ternaries.
function resolveScriptExpression(node, scriptOffset, allowedRoots, i18nCallsUsed) {
  if (!node) return { kind: 'unknown' };
  if (node.type === 'StringLiteral') {
    return {
      kind: 'string-literal',
      value: node.value,
      offset: scriptOffset + node.start,
      length: node.end - node.start,
    };
  }
  if (node.type === 'TemplateLiteral') {
    return {
      kind: 'template-literal',
      quasis: (node.quasis || []).map((q, i) => ({
        value: q.value && (q.value.cooked == null ? q.value.raw : q.value.cooked),
        offset: scriptOffset + q.start,
        length: q.end - q.start,
        quasiIndex: i,
      })),
    };
  }
  if (node.type === 'CallExpression') {
    const key = matchI18nCallNode(node, allowedRoots);
    if (key) {
      i18nCallsUsed.push(key);
      return { kind: 'i18n-call', key };
    }
    // Recognize Vue reactivity wrappers and unwrap them.
    const calleeName = node.callee && node.callee.type === 'Identifier' && node.callee.name;
    if ((calleeName === 'computed' || calleeName === 'ref' || calleeName === 'reactive' || calleeName === 'shallowRef' || calleeName === 'shallowReactive') && node.arguments[0]) {
      return resolveScriptExpression(node.arguments[0], scriptOffset, allowedRoots, i18nCallsUsed);
    }
    return { kind: 'unknown' };
  }
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    if (node.body && node.body.type !== 'BlockStatement') {
      return resolveScriptExpression(node.body, scriptOffset, allowedRoots, i18nCallsUsed);
    }
    // Block-body: try to find a single `return` statement and resolve its argument.
    if (node.body && node.body.type === 'BlockStatement') {
      const returns = (node.body.body || []).filter((s) => s.type === 'ReturnStatement');
      if (returns.length === 1 && returns[0].argument) {
        return resolveScriptExpression(returns[0].argument, scriptOffset, allowedRoots, i18nCallsUsed);
      }
    }
    return { kind: 'unknown' };
  }
  if (node.type === 'ArrayExpression') {
    return {
      kind: 'array',
      items: (node.elements || []).map((el) => resolveScriptExpression(el, scriptOffset, allowedRoots, i18nCallsUsed)),
    };
  }
  if (node.type === 'ObjectExpression') {
    const props = new Map();
    for (const p of node.properties || []) {
      if ((p.type !== 'ObjectProperty' && p.type !== 'Property') || !p.key) continue;
      let key = null;
      if (p.key.type === 'Identifier') key = p.key.name;
      else if (p.key.type === 'StringLiteral') key = p.key.value;
      if (key == null) continue;
      props.set(key, resolveScriptExpression(p.value, scriptOffset, allowedRoots, i18nCallsUsed));
    }
    return { kind: 'object', props };
  }
  if (node.type === 'ConditionalExpression') {
    return {
      kind: 'conditional',
      branches: [
        resolveScriptExpression(node.consequent, scriptOffset, allowedRoots, i18nCallsUsed),
        resolveScriptExpression(node.alternate, scriptOffset, allowedRoots, i18nCallsUsed),
      ],
    };
  }
  if (node.type === 'LogicalExpression') {
    // x || y, x && y — collect both sides' resolution.
    return {
      kind: 'conditional',
      branches: [
        resolveScriptExpression(node.left, scriptOffset, allowedRoots, i18nCallsUsed),
        resolveScriptExpression(node.right, scriptOffset, allowedRoots, i18nCallsUsed),
      ],
    };
  }
  return { kind: 'unknown' };
}

// Parse a .vue script block and return its symbol table.
function buildSymbolTable(scriptContent, scriptOffset, babelParser, allowedRoots) {
  const empty = { locals: new Map(), i18nCallsUsed: [] };
  if (!scriptContent || !babelParser) return empty;
  let ast;
  try {
    ast = babelParser.parse(scriptContent, {
      sourceType: 'module',
      plugins: ['typescript'],
      allowImportExportEverywhere: true,
      errorRecovery: true,
    });
  } catch { return empty; }

  const locals = new Map();
  const i18nCallsUsed = [];

  function visitDeclarations(declarations) {
    for (const d of declarations || []) {
      if (!d.id || d.id.type !== 'Identifier' || !d.init) continue;
      locals.set(d.id.name, resolveScriptExpression(d.init, scriptOffset, allowedRoots, i18nCallsUsed));
    }
  }

  for (const stmt of ast.program.body || []) {
    if (stmt.type === 'VariableDeclaration') {
      visitDeclarations(stmt.declarations);
    } else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration && stmt.declaration.type === 'VariableDeclaration') {
      visitDeclarations(stmt.declaration.declarations);
    } else if (stmt.type === 'ExpressionStatement' && stmt.expression && stmt.expression.type === 'CallExpression') {
      // Side-effect i18n calls (e.g. `useI18nKey('foo')`) still get recorded as referenced.
      const key = matchI18nCallNode(stmt.expression, allowedRoots);
      if (key) i18nCallsUsed.push(key);
    }
  }
  return { locals, i18nCallsUsed: Array.from(new Set(i18nCallsUsed)) };
}

// ============================================================================
// TEMPLATE EXPRESSION RESOLVER — given a `{{ expr }}` interpolation string and
// the .vue's symbol table, trace expr to a list of i18n key paths and/or
// script-literal byte ranges. Falls back to {dyn: true} when unresolvable.
// ============================================================================
function resolveTemplateExpr(exprStr, symbolTable, allowedRoots, babelParser, scopeStack) {
  const result = { paths: [], scriptLocs: [], dyn: false };
  if (!exprStr || !babelParser) { result.dyn = true; return result; }
  scopeStack = scopeStack || [];
  let exprAst;
  try {
    const parsed = babelParser.parse('(' + exprStr + ')', {
      sourceType: 'module',
      plugins: ['typescript'],
      errorRecovery: true,
    });
    exprAst = parsed.program.body[0] && parsed.program.body[0].expression;
  } catch { result.dyn = true; return result; }
  if (!exprAst) { result.dyn = true; return result; }

  // Lookup an identifier in scope stack (innermost first), then locals.
  function lookupIdent(name) {
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      if (scopeStack[i].variable === name) return scopeStack[i].source;
    }
    return symbolTable.locals.get(name) || null;
  }

  // Drill into a member chain to find the root identifier + property path.
  // Supports Identifier (literal property), StringLiteral (`obj['key']`), and
  // NumericLiteral (`arr[3]`).
  function resolveMember(node) {
    const segs = [];
    let cur = node;
    while (cur.type === 'MemberExpression') {
      let name = null;
      if (cur.property.type === 'Identifier' && !cur.computed) name = cur.property.name;
      else if (cur.property.type === 'StringLiteral') name = cur.property.value;
      else if (cur.property.type === 'NumericLiteral') name = String(cur.property.value);
      else return null;          // computed expression we can't resolve statically
      segs.unshift(name);
      cur = cur.object;
    }
    if (cur.type !== 'Identifier') return null;
    return { root: cur.name, props: segs };
  }
  // Apply prop chain to a resolved value. When the value is an array, expand
  // into every item (so `link.label` in a v-for over an array yields a path
  // per item).
  function followProps(val, props) {
    let current = [val];
    for (const p of props) {
      const next = [];
      for (const v of current) {
        if (!v) continue;
        if (v.kind === 'object' && v.props.has(p)) next.push(v.props.get(p));
        else if (v.kind === 'array') {
          if (/^\d+$/.test(p) && v.items[Number(p)]) next.push(v.items[Number(p)]);
          else {
            // Generic property access on an array → broadcast across items.
            for (const item of v.items) {
              if (item && item.kind === 'object' && item.props.has(p)) next.push(item.props.get(p));
            }
          }
        }
      }
      current = next;
      if (current.length === 0) return [];
    }
    return current;
  }
  function extract(resolved) {
    if (!resolved) return;
    if (Array.isArray(resolved)) { for (const r of resolved) extract(r); return; }
    if (resolved.kind === 'i18n-call') result.paths.push(resolved.key);
    else if (resolved.kind === 'string-literal') result.scriptLocs.push({ offset: resolved.offset, length: resolved.length, kind: 'string-literal' });
    else if (resolved.kind === 'template-literal') {
      for (const q of resolved.quasis) {
        if (q.length > 0) result.scriptLocs.push({ offset: q.offset, length: q.length, kind: 'template-quasi' });
      }
    } else if (resolved.kind === 'conditional') {
      for (const b of resolved.branches) extract(b);
    } else if (resolved.kind === 'array') {
      // Bare `{{ items }}` doesn't render usable text. Member access handles items.
    }
  }

  function walk(node) {
    if (!node) return;
    if (node.type === 'CallExpression') {
      const key = matchI18nCallNode(node, allowedRoots);
      if (key) { result.paths.push(key); return; }
      for (const a of node.arguments || []) walk(a);
      return;
    }
    if (node.type === 'Identifier') {
      const val = lookupIdent(node.name);
      if (val) extract(val);
      return;
    }
    if (node.type === 'MemberExpression') {
      const m = resolveMember(node);
      if (!m) return;
      const val = lookupIdent(m.root);
      if (!val) return;
      const reached = followProps(val, m.props);
      extract(reached);
      return;
    }
    if (node.type === 'ConditionalExpression') {
      walk(node.consequent); walk(node.alternate); return;
    }
    if (node.type === 'LogicalExpression') {
      walk(node.left); walk(node.right); return;
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      walk(node.left); walk(node.right); return;
    }
    if (node.type === 'TemplateLiteral') {
      for (const e of node.expressions || []) walk(e);
      return;
    }
  }
  walk(exprAst);
  result.paths = Array.from(new Set(result.paths));
  if (result.paths.length === 0 && result.scriptLocs.length === 0) result.dyn = true;
  return result;
}

// Build the most precise attribute we can for an interpolation expression.
// Order of preference (highest signal first):
//   1. New resolver finds i18n key(s)            → data-edit-i18n-path / data-edit-i18n-paths
//   2. New resolver finds script literal byte range → data-edit-script-loc
//   3. Legacy parseMemberChain (`t.foo.bar`)     → data-edit-i18n-path
//   4. Legacy parseI18nCall (`$t('foo')`)        → data-edit-i18n-path
//   5. Legacy findAllI18nCalls (compound expr)   → data-edit-i18n-paths
// Returns null when nothing resolves; caller emits `data-edit-dyn="1"`.
function resolveInterpolationAttr(expr, symbolTable, options, deps, fileRel, scopeStack) {
  // 1+2: new resolver (uses symbol table + active v-for scope to trace expr)
  const r = resolveTemplateExpr(expr, symbolTable, options.i18nRoots, deps.babelParser, scopeStack);
  if (r.paths.length === 1) {
    return `data-edit-i18n-path="${escapeAttr(r.paths[0])}"`;
  }
  if (r.paths.length > 1) {
    return `data-edit-i18n-paths="${escapeAttr(r.paths.join('|'))}"`;
  }
  if (r.scriptLocs.length === 1) {
    const s = r.scriptLocs[0];
    return `data-edit-script-loc="${escapeAttr(fileRel)}:${s.offset}:${s.length}:${s.kind || 'string-literal'}"`;
  }
  if (r.scriptLocs.length > 1) {
    // Emit pipe-separated script locations the overlay can match by value.
    const enc = r.scriptLocs.map((s) => `${s.offset}:${s.length}:${s.kind || 'string-literal'}`).join('|');
    return `data-edit-script-locs="${escapeAttr(fileRel + '|' + enc)}"`;
  }

  // 3+4+5: legacy fallbacks (unchanged behavior for compat)
  const chain = parseMemberChain(expr, options.i18nRoots) || parseI18nCall(expr, options.i18nRoots);
  if (chain) return `data-edit-i18n-path="${escapeAttr(chain.path)}"`;
  const allKeys = findAllI18nCalls(expr, options.i18nRoots);
  if (allKeys.length > 0) return `data-edit-i18n-paths="${escapeAttr(allKeys.join('|'))}"`;
  return null;
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

  // Build the symbol table from this .vue's script block. Empty table is fine —
  // resolver will then return dyn and we fall back to the existing detectors.
  const scriptBlock = parsed.descriptor.scriptSetup || parsed.descriptor.script;
  const symbolTable = scriptBlock && deps.babelParser
    ? buildSymbolTable(scriptBlock.content, scriptBlock.loc.start.offset, deps.babelParser, options.i18nRoots)
    : { locals: new Map(), i18nCallsUsed: [] };

  let ast;
  // v0.12.6: pass whitespace:'preserve' so the parser leaves leading/trailing
  // whitespace inside text nodes intact in .content. Vue 3's default
  // 'condense' mode trims that whitespace from .content but KEEPS
  // textNode.loc.start.offset pointing at the original pre-trim position —
  // which made our leadingWs math (a few lines below at the trimmedOffset
  // computation) always evaluate to 0, even for source like
  //   <p>\n      نقدم ... الصناعية\n    </p>
  // So the agent received an offset+length pair pointing at the indentation
  // before the text, never at the text itself. The agent's slice ≠ oldText
  // sanity check rejected every Edit-mode write on indented templates (which
  // is most well-formatted Vue, and universal in Arabic/RTL projects). With
  // 'preserve', .content keeps the raw whitespace and the existing math
  // resolves to the correct offset+length pair.
  try { ast = deps.compilerDom.parse(templateInner, { whitespace: 'preserve' }); }
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

  // Scope stack for v-for / v-slot bindings. Pushed when entering a node with
  // such a directive, popped when leaving. Resolvers in this scope can map a
  // loop variable like `link` to the array it iterates over.
  const scopeStack = [];

  // Parse a v-for expression like "link in navLinks" or "(item, idx) in items"
  // and push a scope frame for the loop variable. Returns whether we pushed
  // anything (caller pops on exit).
  function pushVForScope(node) {
    if (!node.props) return false;
    let pushed = false;
    for (const dir of node.props) {
      if (dir.type !== 7 || dir.name !== 'for') continue;
      // The for directive's value is the raw expression e.g. "(link, i) in navLinks".
      const exprStr = dir.exp && dir.exp.content;
      if (!exprStr) continue;
      const m = exprStr.match(/^\s*(?:\(([^)]+)\)|(\S+))\s+(?:in|of)\s+(.+?)\s*$/);
      if (!m) continue;
      const loopHead = m[1] || m[2];
      const sourceExpr = m[3].trim();
      // The loop variable is the first identifier in `loopHead` (skip ws / parens / commas).
      const loopVar = loopHead.split(',')[0].trim().replace(/[()]/g, '');
      if (!loopVar) continue;
      // Resolve the source expression statically (against the current symbol table + outer scopes).
      const srcResolved = resolveTemplateExpr(sourceExpr, symbolTable, options.i18nRoots, deps.babelParser, scopeStack);
      // We don't need the resolver's paths/scriptLocs here — we need the underlying ResolvedValue.
      // Cheat path: re-look up directly if sourceExpr is a single identifier we know.
      let sourceVal = null;
      if (/^[A-Za-z_$][\w$]*$/.test(sourceExpr)) {
        sourceVal = lookupIdentInScopes(sourceExpr, scopeStack, symbolTable.locals);
      }
      if (sourceVal) {
        scopeStack.push({ variable: loopVar, source: sourceVal });
        pushed = true;
      }
    }
    return pushed;
  }
  function lookupIdentInScopes(name, scopes, locals) {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].variable === name) return scopes[i].source;
    }
    return locals.get(name) || null;
  }

  function walk(node) {
    if (!node) return;
    if (node.type === 1) {
      // Every real element gets a data-edit-source pointer back to its opening
      // tag in the source file. v0.10.0+ extends the previous file:offset
      // format with line:column so the gate can emit IDE-clickable
      // "Where: app/components/Foo.vue:42:8" lines in GitHub issue bodies.
      // The byte offset remains the second field — every existing overlay
      // (and the bubble system) keeps working unchanged because they parse
      // by byte-offset, not by line/col.
      const elementSourceOffset = templateOffset + node.loc.start.offset;
      const { line: elLine, col: elCol } = getLineCol(code, elementSourceOffset);
      transforms.push({
        at: insertionPoint(node),
        str: ` data-edit-source="${escapeAttr(fileRel)}:${elementSourceOffset}:${elLine}:${elCol + 1}"`,
      });

      // v-for / v-slot bindings introduce new scope variables. Push for the
      // duration of this subtree.
      const pushedFrame = pushVForScope(node);

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
        const expr = exprOf(interpChildren[0]);
        const attr = resolveInterpolationAttr(expr, symbolTable, options, deps, fileRel, scopeStack);
        if (attr) {
          transforms.push({ at: insertionPoint(node), str: ' ' + attr });
        } else {
          transforms.push({ at: insertionPoint(node), str: ' data-edit-dyn="1"' });
        }
      } else if (hasMixedInterpolations) {
        // Wrap each interpolation in <span data-edit-i18n-path="...">{{ … }}</span>
        // so each text node has its own resolvable ancestor attribute.
        for (const interp of interpChildren) {
          const expr = exprOf(interp);
          const attr = resolveInterpolationAttr(expr, symbolTable, options, deps, fileRel, scopeStack) || 'data-edit-dyn="1"';
          const openAt = templateOffset + interp.loc.start.offset;
          const closeAt = templateOffset + interp.loc.end.offset;
          transforms.push({ at: openAt, str: `<span ${attr}>` });
          transforms.push({ at: closeAt, str: '</span>' });
        }
      }
      for (const c of children) walk(c);
      if (pushedFrame) scopeStack.pop();
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
    // Map of locale → JSON file path, e.g.
    //   { en: 'i18n/locales/en.json', ar: 'i18n/locales/ar.json' }
    // Each leaf string in those files becomes an editable entry with byte-range
    // identity. Required for projects that translate via JSON bundles (Nuxt i18n,
    // vue-i18n JSON mode, Laravel lang/*.json). If omitted, common Nuxt-i18n paths
    // are auto-discovered (`i18n/locales/<locale>.json`, `locales/<locale>.json`).
    i18nJsonFiles: options.i18nJsonFiles || null,
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
    // Test mode wiring. Pass `{ url, project, side? }`:
    //   url:     base URL of the gate service (dev: http://localhost:54322)
    //   project: project key registered in the gate (v0.5.0+; omit for
    //            single-project gates falling back to the default project).
    //   side:    v0.12.2+. 'frontend' | 'backend'. Omit for single-repo
    //            projects (default). Set when the same gate project covers
    //            two repos (e.g. messarat has a Nuxt frontend + Laravel
    //            backend) and bugs filed from each app should land in their
    //            respective repo. Forwarded as-is to the overlay; gate routes
    //            POST /api/report-issue and GET /api/issues by this value.
    // Without `gate`, Test mode shows a "configure gate" toast.
    gate: options.gate || null,
  };

  let projectRoot;
  let i18nFile = null;
  let i18nJsonResolved = null;  // { [locale]: absPath } after configResolved
  let deps = { compilerDom: null, compilerSfc: null, babelParser: null };
  // Per-file cache of editable strings extracted from .vue scripts. Populated
  // lazily by the transform() hook as Vite loads files. The map endpoint
  // concatenates these with the i18n source map.
  const scriptEntriesPerFile = new Map();
  // file (relPath) → Set<i18n key> referenced by that file's script. Used by
  // the overlay's picker to rank candidates referenced by ancestor components
  // (the cross-component case where a child renders a prop and we want to
  // match it to the parent's i18n call).
  const i18nReferencesPerFile = new Map();

  function loadDeps() {
    deps.compilerDom = resolveDep('@vue/compiler-dom', projectRoot);
    deps.compilerSfc = resolveDep('@vue/compiler-sfc', projectRoot);
    deps.babelParser = resolveDep('@babel/parser', projectRoot);
  }

  function buildI18nMap() {
    const entries = [];
    // TS / JS object-literal scanner
    if (i18nFile && fs.existsSync(i18nFile) && deps.babelParser) {
      try {
        const content = fs.readFileSync(i18nFile, 'utf8');
        entries.push(...scanI18nAst(content, relPath(projectRoot, i18nFile), opt.locales, deps.babelParser));
      } catch {}
    }
    // JSON locale-file scanner
    if (i18nJsonResolved) {
      for (const [locale, absPath] of Object.entries(i18nJsonResolved)) {
        if (!fs.existsSync(absPath)) continue;
        try {
          const content = fs.readFileSync(absPath, 'utf8');
          entries.push(...scanI18nJsonFile(content, relPath(projectRoot, absPath), locale));
        } catch {}
      }
    }
    // Per-.vue script-block entries — populated by transform() as Vite loads files.
    for (const fileEntries of scriptEntriesPerFile.values()) {
      entries.push(...fileEntries);
    }
    return entries;
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

      // Resolve i18nJsonFiles: either explicit map, or auto-discover common paths.
      i18nJsonResolved = null;
      if (opt.i18nJsonFiles && typeof opt.i18nJsonFiles === 'object') {
        i18nJsonResolved = {};
        for (const [locale, rel] of Object.entries(opt.i18nJsonFiles)) {
          if (typeof rel === 'string' && rel) {
            i18nJsonResolved[locale] = path.resolve(projectRoot, rel);
          }
        }
      } else {
        // Auto-discover: look for i18n/locales/<locale>.json then locales/<locale>.json.
        const candidates = [['i18n', 'locales'], ['locales']];
        for (const parts of candidates) {
          const dir = path.join(projectRoot, ...parts);
          if (!fs.existsSync(dir)) continue;
          const map = {};
          for (const locale of opt.locales) {
            const p = path.join(dir, locale + '.json');
            if (fs.existsSync(p)) map[locale] = p;
          }
          if (Object.keys(map).length) { i18nJsonResolved = map; break; }
        }
      }

      const jsonLocalesFound = i18nJsonResolved ? Object.keys(i18nJsonResolved).length : 0;

      const flags = [
        `i18n=${i18nFile ? relPath(projectRoot, i18nFile) : '(none)'}`,
        `json=${jsonLocalesFound ? Object.entries(i18nJsonResolved).map(([l, p]) => `${l}:${relPath(projectRoot, p)}`).join(',') : '(none)'}`,
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
        } else if (_agentChild && _agentChild.exitCode === null) {
          // v0.12.5: already started by a sibling Vite instance in the same
          // Node process (Nuxt's client+SSR case). Skip — one agent serves
          // both. The first spawn's process-level handlers cover shutdown.
        } else {
          const child = spawn(process.execPath, [opt.agentPath, projectRoot, String(opt.agentPort)], {
            stdio: ['ignore', 'inherit', 'inherit'],
            env: process.env,
          });
          _agentChild = child;
          child.on('error', (err) => {
            console.warn(`[frontend-conqueror] agent failed to start: ${err.message}`);
          });
          // Clear the singleton when the agent itself exits (crash or kill),
          // so a later HMR-triggered configureServer can respawn.
          child.on('exit', () => {
            if (_agentChild === child) _agentChild = null;
          });
          const stop = () => {
            try { if (!child.killed && child.exitCode === null) child.kill(); } catch {}
          };
          // v0.12.5: removed `server.httpServer?.once('close', stop)`. Each
          // Vite server in Nuxt closes + restarts on HMR/config changes,
          // which used to kill the shared agent and leave the overlay
          // toasting "Agent not connected" until the next page load. The
          // process-level handlers below correctly tie agent lifetime to
          // the whole `npm run dev` process.
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
      // Cross-reference table: { file: [i18n keys] } — used by the overlay's
      // picker to boost candidates referenced by ancestor components.
      server.middlewares.use(REFS_URL, (_req, res) => {
        const refs = {};
        for (const [file, keys] of i18nReferencesPerFile) refs[file] = keys;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(refs));
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
            refsUrl: REFS_URL,
            wsUrl: `ws://localhost:${opt.agentPort}`,
            locales: opt.locales,
            gate: opt.gate || null,
            enabledModes: ['edit', 'todo', 'test'],
            version: PLUGIN_VERSION,
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
          refsUrl: REFS_URL,
          wsUrl: `ws://localhost:${opt.agentPort}`,
          locales: opt.locales,
          gate: opt.gate || null,
          enabledModes: ['edit', 'todo', 'test'],
          version: PLUGIN_VERSION,
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

      // Scan the script block for editable strings AND collect i18n references
      // for cross-component picker ranking.
      try {
        const parsed = deps.compilerSfc.parse(code);
        const scriptBlock = parsed && parsed.descriptor && (parsed.descriptor.scriptSetup || parsed.descriptor.script);
        if (scriptBlock && deps.babelParser) {
          const entries = scanVueScript(scriptBlock.content, scriptBlock.loc.start.offset, fileRel, deps.babelParser);
          if (entries.length > 0) scriptEntriesPerFile.set(id, entries);
          else scriptEntriesPerFile.delete(id);
          // Build the symbol table once more here purely to harvest i18nCallsUsed.
          // (transformVueSource builds it independently for its own use — cheap.)
          const sym = buildSymbolTable(scriptBlock.content, scriptBlock.loc.start.offset, deps.babelParser, opt.i18nRoots);
          if (sym.i18nCallsUsed.length > 0) i18nReferencesPerFile.set(fileRel, sym.i18nCallsUsed);
          else i18nReferencesPerFile.delete(fileRel);
        }
      } catch {}

      try {
        const out = transformVueSource(code, fileRel, deps, opt);
        if (out) return { code: out, map: null };
      } catch {}
      return null;
    },
  };
};

module.exports.default = module.exports;