#!/usr/bin/env node
// frontend-conqueror CLI dispatcher.
//
// Single binary, subcommand-based — same pattern as vite/nuxt/next/tsc/jest.
// Dispatches `frontend-conqueror <command> ...` to the appropriate module by
// rewriting argv and require()-ing it. The required module sees argv exactly
// as if it had been invoked directly via `node`.
//
// Subcommands today:
//   gate                              Run the gate HTTP server
//   gate --reset-admin-password       Reset the admin password (server stopped or
//                                     running — operates on the data file directly)
//   agent <root> <port>               Run the dev agent (advanced, dev-only)
//
// New subcommands plug in by adding a case below.

'use strict';

const path = require('path');

const subcommand = process.argv[2];
const remainingArgs = process.argv.slice(3);

const HELP = [
  'Usage: frontend-conqueror <command> [options]',
  '',
  'Commands:',
  '  gate                          Run the gate HTTP server',
  '  gate --reset-admin-password   Reset the admin password (use the default printed',
  '                                on stderr to log in, then change it from Settings)',
  '  agent <root> <port>           Run the dev agent (advanced; usually auto-started',
  '                                by the Vite plugin in dev)',
  '',
  'Environment:',
  '  GATE_DATA              Path to the gate data file (default: gate/data.json)',
  '  GATE_PORT              Gate HTTP port (default: 54322)',
  '  GATE_HOST              Gate bind address (default: 0.0.0.0)',
  '  GATE_ADMIN_PASSWORD    Admin default password (default: frontend-conqueror)',
  '  GATE_JWT_SECRET        JWT signing secret (default: random per process)',
  '',
].join('\n');

function showHelpAndExit(code) {
  // Help to stdout when explicitly requested, stderr otherwise — same convention
  // as most CLIs (vite, nuxt, jest, etc.).
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(HELP);
  process.exit(code);
}

if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
  showHelpAndExit(subcommand ? 0 : 2);
}

function runModule(rel) {
  // Rewrite argv so the required module sees: [node, /abs/path/to/module.js, ...rest]
  // identical to what it'd see if invoked as `node /abs/path/to/module.js ...rest`.
  const abs = require.resolve(path.join('..', rel));
  process.argv = [process.argv[0], abs, ...remainingArgs];
  require(abs);
}

switch (subcommand) {
  case 'gate':
    runModule('gate/server.js');
    break;
  case 'agent':
    runModule('agent/server.js');
    break;
  default:
    process.stderr.write(`Unknown command: ${subcommand}\n\n`);
    showHelpAndExit(2);
}