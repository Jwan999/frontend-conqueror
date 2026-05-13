#!/usr/bin/env node
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const projectArg = process.argv[2];
const portArg = process.argv[3];
const PORT = portArg ? Number(portArg) : 54321;

if (!projectArg) {
  console.error('Usage: node server.js /path/to/project [port]');
  process.exit(1);
}
if (Number.isNaN(PORT) || PORT <= 0) {
  console.error(`Invalid port: ${portArg}`);
  process.exit(1);
}

const PROJECT_ROOT = path.resolve(projectArg);

if (!fs.existsSync(PROJECT_ROOT) || !fs.statSync(PROJECT_ROOT).isDirectory()) {
  console.error(`Not a directory: ${PROJECT_ROOT}`);
  process.exit(1);
}

const IGNORE_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.nitro',
  '.data',
  '.svelte-kit',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.vercel',
  '.netlify',
  'coverage',
  '.idea',
  '.vscode',
  'storage',
  'bootstrap/cache',
]);

// Config / lockfile / tooling files that aren't user-facing content.
// These pollute the v0 string-search pool with matches that shouldn't count
// (e.g., ecosystem.config.cjs, package.json values like "production").
const IGNORE_FILE_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'composer.json',
  'composer.lock',
  'tsconfig.json',
  'jsconfig.json',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.editorconfig',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.gitattributes',
  'CHANGELOG.md',
]);
const IGNORE_FILE_RE = /^(?:.*\.config\.[cm]?[jt]s|.*\.config\.json|ecosystem\.config\.[cm]?js|\.env(?:\..+)?|.*\.lock|.*\.lockb?)$/i;

const TEXT_EXTENSIONS = new Set([
  '.html', '.htm',
  '.vue', '.svelte', '.astro',
  '.jsx', '.tsx', '.js', '.ts', '.mjs', '.cjs',
  '.php',
  '.twig', '.erb', '.ejs', '.hbs', '.liquid',
  '.json', '.md', '.mdx',
]);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

function walk(dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.isFile()) {
      const name = entry.name.toLowerCase();
      if (IGNORE_FILE_BASENAMES.has(name)) continue;
      if (IGNORE_FILE_RE.test(name)) continue;
      const ext = path.extname(name);
      if (TEXT_EXTENSIONS.has(ext) || name.endsWith('.blade.php')) {
        files.push(full);
      }
    }
  }
  return files;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function findMatches(oldText) {
  const files = walk(PROJECT_ROOT);
  const matches = [];
  for (const file of files) {
    let content;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_SIZE) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const occurrences = countOccurrences(content, oldText);
    if (occurrences > 0) matches.push({ file, occurrences, content });
  }
  return matches;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function decodeStringLiteral(raw, quote) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '\\') {
      const next = raw[i + 1];
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === '\\') out += '\\';
      else if (next === quote) out += quote;
      else if (next === '0') out += '\0';
      else if (next === undefined) {}
      else out += next;
      i += 2;
    } else {
      out += raw[i];
      i++;
    }
  }
  return out;
}

function escapeForStringLiteral(value, quote) {
  let out = '';
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + quote;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else out += ch;
  }
  return out;
}

function decodeTemplateQuasi(raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === '`') out += '`';
      else if (next === '\\') out += '\\';
      else if (next === '$') out += '$';
      else if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else out += next;
      i += 2;
    } else {
      out += raw[i];
      i++;
    }
  }
  return out;
}

function escapeTemplateQuasi(value) {
  let out = '';
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '`') out += '\\`';
    else out += ch;
  }
  return out.replace(/\$\{/g, '\\${');
}

function findLineStart(content, offset) {
  let i = Math.min(offset, content.length);
  while (i > 0 && content[i - 1] !== '\n') i--;
  return i;
}
function getLineIndent(content, offset) {
  const start = findLineStart(content, offset);
  let i = start;
  while (i < content.length && (content[i] === ' ' || content[i] === '\t')) i++;
  return content.slice(start, i);
}

function handleAddTodo(ws, msg) {
  const { id, file, offset, body, linearId } = msg;
  if (typeof file !== 'string' || typeof offset !== 'number' || typeof body !== 'string') {
    ws.send(JSON.stringify({ type: 'error', id, message: 'invalid add-todo payload' }));
    return;
  }
  const safeBody = String(body).replace(/\r?\n/g, ' ').trim();
  if (!safeBody) {
    ws.send(JSON.stringify({ type: 'error', id, message: 'TODO body is empty' }));
    return;
  }

  const abs = path.resolve(PROJECT_ROOT, file);
  if (!isInsideRoot(abs)) {
    ws.send(JSON.stringify({ type: 'error', id, message: 'file outside project root' }));
    return;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    ws.send(JSON.stringify({ type: 'error', id, message: `file not found: ${file}` }));
    return;
  }
  let content;
  try { content = fs.readFileSync(abs, 'utf8'); }
  catch (e) {
    ws.send(JSON.stringify({ type: 'error', id, message: `read failed: ${e.message}` }));
    return;
  }
  if (offset < 0 || offset > content.length) {
    ws.send(JSON.stringify({
      type: 'rejected', id, reason: 'out-of-range',
      message: `offset out of file range — refresh and try again.`,
    }));
    return;
  }

  const indent = getLineIndent(content, offset);
  const lineStart = findLineStart(content, offset);
  // The plugin only emits data-edit-source on template elements, so .vue offsets
  // are always inside the <template> block — HTML comment is correct.
  // For .ts/.js/.tsx/.jsx we use a // line comment.
  const isHtml = /\.(vue|html?|svelte|astro)$/i.test(file);
  const prefix = linearId ? `TODO (${linearId}): ` : 'TODO: ';
  const safeLinear = linearId ? String(linearId).replace(/[^A-Za-z0-9_\-]/g, '') : '';
  const finalBody = safeBody.slice(0, 500); // hard cap so a runaway paste doesn't blow up the source line
  const commentLine = isHtml
    ? `${indent}<!-- ${safeLinear ? `TODO (${safeLinear}): ` : 'TODO: '}${finalBody} -->\n`
    : `${indent}// ${safeLinear ? `TODO (${safeLinear}): ` : 'TODO: '}${finalBody}\n`;

  const updated = content.slice(0, lineStart) + commentLine + content.slice(lineStart);
  try { fs.writeFileSync(abs, updated, 'utf8'); }
  catch (e) {
    ws.send(JSON.stringify({ type: 'error', id, message: `write failed: ${e.message}` }));
    return;
  }

  const lineNum = content.slice(0, lineStart).split('\n').length;
  console.log(`Add-todo ${file}:${lineNum}  ${truncate(finalBody, 60)}`);
  ws.send(JSON.stringify({ type: 'applied', id, file, kind: 'todo', line: lineNum }));
}

function isInsideRoot(absPath) {
  const rel = path.relative(PROJECT_ROOT, absPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function handleEditLoc(ws, msg) {
  const { id, file, offset, length, kind, oldText, newText } = msg;

  if (typeof file !== 'string' || typeof offset !== 'number' || typeof length !== 'number') {
    ws.send(JSON.stringify({ type: 'error', id, message: 'invalid edit-loc payload' }));
    return;
  }
  if (typeof oldText !== 'string' || typeof newText !== 'string') {
    ws.send(JSON.stringify({ type: 'error', id, message: 'oldText and newText must be strings' }));
    return;
  }
  if (oldText === newText) {
    ws.send(JSON.stringify({ type: 'noop', id, message: 'No change' }));
    return;
  }

  const abs = path.resolve(PROJECT_ROOT, file);
  if (!isInsideRoot(abs)) {
    ws.send(JSON.stringify({ type: 'error', id, message: 'file outside project root' }));
    return;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    ws.send(JSON.stringify({ type: 'error', id, message: `file not found: ${file}` }));
    return;
  }

  let content;
  try { content = fs.readFileSync(abs, 'utf8'); }
  catch (e) {
    ws.send(JSON.stringify({ type: 'error', id, message: `read failed: ${e.message}` }));
    return;
  }

  if (offset < 0 || offset + length > content.length) {
    ws.send(JSON.stringify({
      type: 'rejected', id, reason: 'out-of-range',
      message: `byte range out of file — the file changed since the page rendered. Refresh and try again.`,
    }));
    return;
  }

  let updated;
  if (kind === 'raw') {
    const actual = content.slice(offset, offset + length);
    if (actual !== oldText) {
      ws.send(JSON.stringify({
        type: 'rejected', id, reason: 'out-of-sync',
        message: `text at ${file}:${offset} no longer matches — refresh and try again.`,
      }));
      return;
    }
    updated = content.slice(0, offset) + newText + content.slice(offset + length);
  } else if (kind === 'template-quasi') {
    const raw = content.slice(offset, offset + length);
    const cooked = decodeTemplateQuasi(raw);
    if (cooked !== oldText) {
      ws.send(JSON.stringify({
        type: 'rejected', id, reason: 'out-of-sync',
        message: `template quasi at ${file}:${offset} no longer matches "${truncate(oldText, 40)}"`,
      }));
      return;
    }
    const newRaw = escapeTemplateQuasi(newText);
    updated = content.slice(0, offset) + newRaw + content.slice(offset + length);
  } else if (kind === 'string-literal') {
    const q = content[offset];
    if ((q !== '"' && q !== "'") || content[offset + length - 1] !== q) {
      ws.send(JSON.stringify({
        type: 'rejected', id, reason: 'out-of-sync',
        message: `expected string literal at ${file}:${offset} — file may have changed.`,
      }));
      return;
    }
    const innerRaw = content.slice(offset + 1, offset + length - 1);
    const decoded = decodeStringLiteral(innerRaw, q);
    if (decoded !== oldText) {
      ws.send(JSON.stringify({
        type: 'rejected', id, reason: 'out-of-sync',
        message: `value at ${file}:${offset} no longer matches "${truncate(oldText, 40)}"`,
      }));
      return;
    }
    const newInner = escapeForStringLiteral(newText, q);
    updated = content.slice(0, offset) + q + newInner + q + content.slice(offset + length);
  } else if (kind === 'json-string') {
    // JSON string literal: always double-quoted; escape only what JSON requires.
    if (content[offset] !== '"' || content[offset + length - 1] !== '"') {
      ws.send(JSON.stringify({
        type: 'rejected', id, reason: 'out-of-sync',
        message: `expected JSON string at ${file}:${offset} — file may have changed.`,
      }));
      return;
    }
    const innerRaw = content.slice(offset + 1, offset + length - 1);
    let decoded;
    try { decoded = JSON.parse('"' + innerRaw + '"'); }
    catch {
      ws.send(JSON.stringify({
        type: 'rejected', id, reason: 'out-of-sync',
        message: `JSON string at ${file}:${offset} could not be decoded.`,
      }));
      return;
    }
    if (decoded !== oldText) {
      ws.send(JSON.stringify({
        type: 'rejected', id, reason: 'out-of-sync',
        message: `value at ${file}:${offset} no longer matches "${truncate(oldText, 40)}"`,
      }));
      return;
    }
    // JSON.stringify produces a properly-escaped string with surrounding quotes.
    const newJson = JSON.stringify(newText);
    updated = content.slice(0, offset) + newJson + content.slice(offset + length);
  } else {
    ws.send(JSON.stringify({ type: 'error', id, message: `unknown kind: ${kind}` }));
    return;
  }

  try { fs.writeFileSync(abs, updated, 'utf8'); }
  catch (e) {
    ws.send(JSON.stringify({ type: 'error', id, message: `write failed: ${e.message}` }));
    return;
  }

  console.log(`Edit-loc ${file} @ ${offset}: "${truncate(oldText, 40)}" -> "${truncate(newText, 40)}"`);
  ws.send(JSON.stringify({ type: 'applied', id, file }));
}

const wss = new WebSocketServer({ port: PORT });

console.log(`frontend-conqueror agent listening on ws://localhost:${PORT}`);
console.log(`Project root: ${PROJECT_ROOT}`);

wss.on('connection', (ws) => {
  console.log('Overlay connected');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    const { id } = msg;

    if (msg.type === 'edit-loc') {
      handleEditLoc(ws, msg);
      return;
    }
    if (msg.type === 'add-todo') {
      handleAddTodo(ws, msg);
      return;
    }
    if (msg.type !== 'edit') {
      ws.send(JSON.stringify({ type: 'error', id, message: `Unknown message type: ${msg.type}` }));
      return;
    }

    const { oldText, newText } = msg;

    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      ws.send(JSON.stringify({ type: 'error', id, message: 'oldText and newText must be strings' }));
      return;
    }
    if (oldText.length === 0) {
      ws.send(JSON.stringify({ type: 'error', id, message: 'oldText is empty' }));
      return;
    }
    if (oldText === newText) {
      ws.send(JSON.stringify({ type: 'noop', id, message: 'No change' }));
      return;
    }

    const matches = findMatches(oldText);
    console.log(`v0 fallback search: "${truncate(oldText, 60)}" → ${matches.reduce((s,m)=>s+m.occurrences,0)} occurrence(s) across ${matches.length} file(s)`);

    if (matches.length === 0) {
      ws.send(JSON.stringify({
        type: 'rejected',
        id,
        reason: 'not-found',
        message: `Text not found in any source file: "${truncate(oldText, 80)}"`,
      }));
      return;
    }

    const totalOccurrences = matches.reduce((sum, m) => sum + m.occurrences, 0);

    if (totalOccurrences > 1) {
      ws.send(JSON.stringify({
        type: 'rejected',
        id,
        reason: 'ambiguous',
        message: `Found ${totalOccurrences} match(es) across ${matches.length} file(s). Cannot safely edit.`,
        files: matches.map((m) => ({
          path: path.relative(PROJECT_ROOT, m.file),
          occurrences: m.occurrences,
        })),
      }));
      return;
    }

    const target = matches[0];
    const idx = target.content.indexOf(oldText);
    const updated = target.content.slice(0, idx) + newText + target.content.slice(idx + oldText.length);

    try {
      fs.writeFileSync(target.file, updated, 'utf8');
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', id, message: `Write failed: ${err.message}` }));
      return;
    }

    const relPath = path.relative(PROJECT_ROOT, target.file);
    console.log(`Edited ${relPath}: "${truncate(oldText, 40)}" -> "${truncate(newText, 40)}"`);
    ws.send(JSON.stringify({ type: 'applied', id, file: relPath }));
  });

  ws.on('close', () => {
    console.log('Overlay disconnected');
  });
});