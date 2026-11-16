#!/usr/bin/env node
'use strict';

// Per-furnace supervisor: the runtime a `gh-forge up <furnace>` spawns (detached).
// It runs the gh-forge engine IN-PROCESS (webhook server + scheduler) for the
// furnace, and keeps a `gh webhook forward` child alive — reconnecting on drops
// and clearing a stale `cli` hook (the 422 we used to fix by hand). One process
// per furnace; `gh-forge down` kills it (and its forwarder child) via its group.
//
//   node supervise.js <furnace-path>
//
// The furnace is a directory with its own forge.yml + jobs/ + .env, and gh-forge
// installed (the jobs resolve `require('gh-forge')` from there).

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const home = process.argv[2];
if (!home) { console.error('usage: supervise.js <furnace-path>'); process.exit(2); }

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }

// Load the furnace's .env (minimal reader), then point the engine at the furnace.
for (const line of fs.readFileSync(path.join(home, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
process.env.FORGE_HOME = home;
process.env.FORGE_CONFIG = process.env.FORGE_CONFIG || path.join(home, 'forge.yml');

const PORT = parseInt(process.env.FORGE_PORT || '3000', 10);
const REPO = process.env.FORGE_REPO || '';
const EVENTS = process.env.FORGE_EVENTS || 'issues,pull_request,issue_comment';
const SECRET = process.env.FORGE_SECRET || '';

// Engine, in-process (the furnace's own installed copy, so jobs' require('gh-forge') matches).
const engine = require(path.join(home, 'node_modules', 'gh-forge'));
engine.createServer().listen(PORT, '127.0.0.1', () => {
  log(`engine up on :${PORT} (home ${home}, verify ${SECRET ? 'ON' : 'OFF'})`);
});
engine.startScheduler();

// Forwarder, supervised.
let stopping = false;
let fwd = null;

function deleteStaleCliHook() {
  try {
    const hooks = JSON.parse(execFileSync('gh', ['api', `repos/${REPO}/hooks`], { encoding: 'utf8' }));
    for (const h of hooks) {
      if (h.name === 'cli') {
        execFileSync('gh', ['api', '-X', 'DELETE', `repos/${REPO}/hooks/${h.id}`]);
        log(`deleted stale cli hook ${h.id}`);
      }
    }
  } catch (e) {
    log('cli-hook cleanup failed:', e.message);
  }
}

function startForward() {
  if (stopping) return;
  fwd = spawn('gh', ['webhook', 'forward', `--repo=${REPO}`, `--events=${EVENTS}`,
    `--url=http://127.0.0.1:${PORT}/`, `--secret=${SECRET}`], { stdio: ['ignore', 'inherit', 'pipe'] });
  let err = '';
  fwd.stderr.on('data', (d) => { err += d; process.stderr.write(d); });
  fwd.on('exit', (code) => {
    if (stopping) return;
    if (/already exists|HTTP 422/i.test(err)) { log('forwarder: stale cli hook — clearing'); deleteStaleCliHook(); }
    log(`forwarder exited (${code}); reconnecting in 5s`);
    setTimeout(startForward, 5000);
  });
}
startForward();
log(`supervising furnace: ${REPO} on :${PORT}`);

function shutdown() {
  stopping = true;
  if (fwd) try { fwd.kill(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
