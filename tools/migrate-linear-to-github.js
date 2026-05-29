#!/usr/bin/env node
// frontend-conqueror — Linear → GitHub one-time migration script
//
// For ONE gate project, lists all open Linear issues with an fc-meta marker
// and recreates each in a target GitHub repo, preserving the marker so bubbles
// keep working without any browser refresh on the testers' side. Comments on
// each Linear original with the GitHub link, then flips the gate project's
// backend to 'github' so all future writes go to GitHub.
//
// Idempotent — re-runs skip Linear issues that already have a "Migrated to"
// comment, so it's safe to abort and restart.
//
// Usage:
//   GATE_DATA=/var/data/messarat-gate.json \
//   GITHUB_TOKEN=ghp_xxx \
//   node tools/migrate-linear-to-github.js \
//     --project messarat \
//     --repo Makers-of-Baghdad/messarat-frontend-nuxt \
//     [--dry-run]
//
// Run on the same machine the gate runs on — it edits the gate's data.json
// in place when it flips the backend. Restart the gate after the script
// completes so the new backend setting picks up.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf('--' + name);
  if (i < 0) return null;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const DATA_FILE = process.env.GATE_DATA || path.resolve(process.cwd(), 'gate/data.json');
const PROJECT_KEY = flag('project');
const TARGET_REPO = flag('repo');
const DRY_RUN = !!flag('dry-run');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!PROJECT_KEY || !TARGET_REPO || !GITHUB_TOKEN) {
  console.error('Usage: GATE_DATA=... GITHUB_TOKEN=... node tools/migrate-linear-to-github.js --project KEY --repo owner/repo [--dry-run]');
  process.exit(2);
}

const FC_META_B64_RE = /<!--\s*fc-meta-b64:\s*([A-Za-z0-9+/=_-]+)\s*-->/;

async function linearGraphQL(apiKey, query, variables) {
  const r = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const data = await r.json();
  if (data.errors) throw new Error('Linear: ' + JSON.stringify(data.errors));
  return data.data;
}
async function github(method, p, body) {
  const r = await fetch('https://api.github.com' + p, {
    method,
    headers: {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fc-migration',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const d = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`GitHub ${method} ${p} → ${r.status}: ${(d && d.message) || r.statusText}`);
  return d;
}

(async () => {
  console.log(`[migrate] reading ${DATA_FILE}`);
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const proj = (data.projects || {})[PROJECT_KEY];
  if (!proj) throw new Error(`No gate project "${PROJECT_KEY}" in data.json`);
  const linearApiKey = proj.linearApiKey || (data.linear && data.linear.apiKey);
  const linearProjectId = proj.linearProjectId;
  if (!linearApiKey || !linearProjectId) throw new Error('Project has no Linear apiKey/projectId — nothing to migrate.');

  // Validate target repo + ensure fc:bug label exists.
  const [owner, repo] = TARGET_REPO.split('/');
  if (!owner || !repo) throw new Error('--repo must be owner/repo');
  const repoInfo = await github('GET', `/repos/${owner}/${repo}`);
  if (!repoInfo.has_issues) throw new Error('Target repo has Issues disabled. Enable them in GitHub repo settings first.');
  try { await github('GET', `/repos/${owner}/${repo}/labels/fc%3Abug`); }
  catch {
    if (!DRY_RUN) {
      await github('POST', `/repos/${owner}/${repo}/labels`, {
        name: 'fc:bug', color: 'f59e0b',
        description: 'Filed via frontend-conqueror Test mode (auto-managed).',
      });
      console.log('[migrate] created fc:bug label');
    } else {
      console.log('[migrate] (dry-run) would create fc:bug label');
    }
  }

  // Fetch all open Linear issues in the project (paginated, up to 500).
  let all = [];
  let after = null;
  for (let pageCount = 0; pageCount < 5; pageCount++) {
    const d = await linearGraphQL(linearApiKey, `
      query($projectId: ID!, $after: String) {
        issues(first: 100, after: $after,
          filter: { project: { id: { eq: $projectId } }, state: { type: { nin: ["completed", "canceled"] } } },
          orderBy: createdAt) {
          nodes { id identifier url title description comments(first: 50) { nodes { body } } }
          pageInfo { hasNextPage endCursor }
        }
      }`, { projectId: linearProjectId, after });
    const conn = d.issues || {};
    if (conn.nodes) all = all.concat(conn.nodes);
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  console.log(`[migrate] ${all.length} open Linear issues to consider`);

  let migrated = 0, skipped = 0, noMeta = 0;
  for (const issue of all) {
    // Skip already-migrated (look for our marker in any comment).
    const alreadyMigrated = (issue.comments && issue.comments.nodes || []).some(
      (c) => /Migrated to GitHub/.test(c.body || ''));
    if (alreadyMigrated) { skipped++; continue; }

    // Only migrate issues we created (have fc-meta). Hand-filed Linear issues
    // are someone else's concern.
    const m = (issue.description || '').match(FC_META_B64_RE);
    if (!m) { noMeta++; continue; }

    if (DRY_RUN) {
      console.log(`[migrate] (dry-run) would migrate ${issue.identifier}: ${issue.title}`);
      migrated++;
      continue;
    }

    // Create the GitHub issue with the SAME body — fc-meta-b64 stays intact,
    // so the overlay's bubble matching keeps working without any tester action.
    const gh = await github('POST', `/repos/${owner}/${repo}/issues`, {
      title: issue.title,
      body: issue.description,
      labels: ['fc:bug'],
    });
    // Add a comment on the Linear original so anyone glancing there sees the
    // redirect.
    await linearGraphQL(linearApiKey, `
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }`, { issueId: issue.id, body: `Migrated to GitHub: ${gh.html_url}` });
    console.log(`[migrate] ${issue.identifier} → ${gh.html_url}`);
    migrated++;
  }

  console.log(`[migrate] done: migrated=${migrated}, skipped(already)=${skipped}, no-fc-meta=${noMeta}`);

  if (DRY_RUN) {
    console.log('[migrate] (dry-run) NOT flipping gate project backend.');
    return;
  }

  // Flip the gate project to GitHub backend.
  proj.backend = 'github';
  proj.githubRepo = `${owner}/${repo}`;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`[migrate] gate project "${PROJECT_KEY}" backend = github, repo = ${owner}/${repo}.`);
  console.log('[migrate] RESTART THE GATE for the new backend to take effect.');
})().catch((e) => { console.error('[migrate] FAILED:', e.message); process.exit(1); });