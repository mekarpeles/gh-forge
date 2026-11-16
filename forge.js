#!/usr/bin/env node
'use strict';

/*
 * forge — run local "actions" in response to GitHub webhooks.
 *
 * It listens on localhost, verifies each delivery's signature, and runs the
 * job wired to that event in forge.yml. Config and jobs are reloaded on every
 * delivery, so you can edit either and the next event picks up the change.
 *
 * Forge home. forge.yml and job paths resolve against FORGE_HOME (default: the
 * current working directory). Run `node forge.js` from your project and it just
 * works; install forge as a library and set FORGE_HOME to your project root so
 * the engine runs YOUR forge.yml + jobs/ without vendoring the engine.
 */

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { load } = require('./config');

const PORT = parseInt(process.env.FORGE_PORT || '3000', 10);
const SECRET = process.env.FORGE_SECRET || '';
// Where forge.yml + jobs/ live. Default cwd so standalone `node forge.js` from a
// project dir works; a library consumer sets FORGE_HOME to its own root.
const HOME = path.resolve(process.env.FORGE_HOME || process.cwd());

function log(...a) {
  console.log(`[${new Date().toISOString()}]`, ...a);
}

// GitHub signs the raw body (HMAC-SHA256) as `X-Hub-Signature-256`. With no
// secret we run in open dev mode; with one set, bad/unsigned deliveries are 401.
function verify(raw, sig, secret = SECRET) {
  if (!secret) return true;
  if (!sig) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The object every job receives. `run`/`gh` take an optional opts object (passed
// through to execFile), e.g. { env, cwd } — so a job can run a command as a
// different identity or in another directory.
function makeContext(event, action, payload, config) {
  const run = (cmd, args = [], opts = {}) =>
    new Promise((resolve) => {
      execFile(cmd, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
        resolve({ code: err ? err.code || 1 : 0, stdout, stderr })
      );
    });

  return {
    event,
    action,
    payload,
    config: config || {}, // this route's `config:` block from forge.yml
    repo: payload.repository && payload.repository.full_name,
    sender: payload.sender && payload.sender.login,
    log: (...a) => log('  ↳', ...a),
    run, // run any local command: run(cmd, args, opts?)
    gh: (args, opts) => run('gh', args, opts), // act back on GitHub
  };
}

// Resolve ALL handlers for an event/action: every forge.yml route whose `on`
// matches the exact "event.action" (or, if none do, the bare "event"), else the
// jobs/<event>.<action>.js filename convention. Returns an array of
// { file, config } — usually one, but several routes may share a key (e.g. two
// `pull_request.labeled` routes split by the `label:` discriminator below).
//
// Label discriminator: on labeled/unlabeled events, a route may pin
// `config.label` so it only runs for that one label. Routes without `label`
// match any label. The filter is skipped when no payload is given, so resolve()
// stays usable as a pure route lookup. Job paths resolve against FORGE_HOME.
function resolveAll(routes, event, action, payload) {
  const key = action ? `${event}.${action}` : event;
  const matchLabel = (r) => {
    if (!r.config || !r.config.label) return true;
    if (action !== 'labeled' && action !== 'unlabeled') return true;
    if (!payload || !payload.label) return true; // no context: don't filter
    return payload.label.name === r.config.label;
  };
  // Exact event.action routes first; fall back to bare-event routes only if no
  // exact route matched (preserves "specific wins over general").
  let matched = (routes || []).filter((r) => r.on === key && matchLabel(r));
  if (!matched.length) matched = (routes || []).filter((r) => r.on === event && matchLabel(r));

  const hits = [];
  for (const r of matched) {
    if (!r.run) continue;
    const p = path.isAbsolute(r.run) ? r.run : path.join(HOME, r.run);
    if (fs.existsSync(p)) hits.push({ file: p, config: r.config });
  }
  // No configured route at all -> jobs/<event>.<action>.js filename convention.
  if (!hits.length && !matched.length) {
    for (const rel of [path.join('jobs', `${key}.js`), path.join('jobs', `${event}.js`)]) {
      const p = path.join(HOME, rel);
      if (fs.existsSync(p)) {
        hits.push({ file: p, config: undefined });
        break;
      }
    }
  }
  return hits;
}

// Back-compat single-route lookup: the first matching handler, or null.
function resolve(routes, event, action, payload) {
  return resolveAll(routes, event, action, payload)[0] || null;
}

async function dispatch(event, action, payload) {
  const key = action ? `${event}.${action}` : event;
  const hits = resolveAll(load().routes, event, action, payload);
  if (!hits.length) {
    log(`• ${key} — no route, ignored`);
    return;
  }
  for (const hit of hits) {
    log(`▶ ${key} — ${path.relative(HOME, hit.file)}`);
    try {
      delete require.cache[require.resolve(hit.file)]; // hot reload
      const job = require(hit.file);
      await job(makeContext(event, action, payload, hit.config));
      log(`✓ ${key} — done`);
    } catch (err) {
      log(`✗ ${key} — ${err.stack || err}`);
    }
  }
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!verify(raw, req.headers['x-hub-signature-256'])) {
        log('✗ signature verification failed — rejected');
        res.writeHead(401).end('bad signature');
        return;
      }
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        res.writeHead(400).end('bad json');
        return;
      }
      // Ack immediately, then run the job, so a slow job never trips the timeout.
      res.writeHead(200).end('ok');
      dispatch(req.headers['x-github-event'] || 'unknown', payload.action, payload);
    });
  });
}

// List the configured workflows (routes) with their trigger — the local
// equivalent of `gh workflow list`. Returns structured rows; the CLI prints them.
function listWorkflows() {
  return (load().routes || [])
    .filter((r) => r.run)
    .map((r) => ({
      trigger: r.on === 'schedule' ? 'schedule' : 'event',
      on: r.on,
      cron: r.cron || null,
      run: r.run,
      label: (r.config && r.config.label) || null,
    }));
}

function printWorkflows() {
  const wf = listWorkflows();
  const pad = (s, n) => s + ' '.repeat(Math.max(1, n - s.length));
  log(`workflows in ${require('./config').CONFIG_PATH} — ${wf.length} total`);
  const event = wf.filter((w) => w.trigger === 'event');
  const sched = wf.filter((w) => w.trigger === 'schedule');
  if (event.length) {
    console.log('\nEVENT (webhook)');
    for (const w of event) console.log('  ' + pad(w.on + (w.label ? ` [${w.label}]` : ''), 46) + w.run);
  }
  if (sched.length) {
    console.log('\nSCHEDULE (cron)');
    for (const w of sched) console.log('  ' + pad(w.cron || '?', 46) + w.run);
  }
  if (!wf.length) console.log('(none)');
}

if (require.main === module) {
  if (process.argv[2] === 'list') {
    printWorkflows();
    process.exit(0);
  }
  createServer().listen(PORT, '127.0.0.1', () => {
    log(`forge listening on http://127.0.0.1:${PORT}`);
    log(`forge home: ${HOME}`);
    log(SECRET ? 'signature verification: ON' : 'signature verification: OFF (no FORGE_SECRET)');
  });
  // Run `on: schedule` routes alongside the webhook server (no-op if there are none).
  require('./scheduler').startScheduler();
}

module.exports = { verify, resolve, resolveAll, makeContext, dispatch, createServer, listWorkflows, HOME };
