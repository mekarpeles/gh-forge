'use strict';

// Tests for the library-use additions: FORGE_HOME resolution, the labeled-route
// discriminator, run/gh opts passthrough, and the exported record helper.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshForge(home) {
  if (home) process.env.FORGE_HOME = home;
  else delete process.env.FORGE_HOME;
  delete require.cache[require.resolve('../forge')];
  return require('../forge');
}

test('resolveAll resolves job paths against FORGE_HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'));
  fs.mkdirSync(path.join(home, 'jobs'));
  fs.writeFileSync(path.join(home, 'jobs', 'foo.js'), 'module.exports = async () => {};');

  const forge = freshForge(home);
  const hits = forge.resolveAll([{ on: 'issues', run: 'jobs/foo.js' }], 'issues', 'opened');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, path.join(home, 'jobs', 'foo.js'));

  freshForge(); // reset module + env
});

test('resolveAll splits labeled routes by the label discriminator', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'));
  fs.mkdirSync(path.join(home, 'jobs'));
  fs.writeFileSync(path.join(home, 'jobs', 'bug.js'), 'module.exports = async () => {};');
  fs.writeFileSync(path.join(home, 'jobs', 'docs.js'), 'module.exports = async () => {};');
  const forge = freshForge(home);

  const routes = [
    { on: 'issues.labeled', run: 'jobs/bug.js', config: { label: 'bug' } },
    { on: 'issues.labeled', run: 'jobs/docs.js', config: { label: 'docs' } },
  ];
  const hits = forge.resolveAll(routes, 'issues', 'labeled', { label: { name: 'bug' } });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, path.join(home, 'jobs', 'bug.js'));

  freshForge();
});

test('ctx.run passes opts (env) through to the command', async () => {
  const forge = freshForge();
  const ctx = forge.makeContext('issues', 'opened', {});
  const r = await ctx.run('node', ['-e', 'process.stdout.write(process.env.FOO || "")'], {
    env: { ...process.env, FOO: 'bar' },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'bar');
});

test('record writes to <FORGE_HOME>/logs/events.jsonl and returns the record', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'));
  process.env.FORGE_HOME = home;
  delete require.cache[require.resolve('../record')];
  const record = require('../record');

  const rec = record({
    event: 'pull_request',
    action: 'closed',
    repo: 'o/r',
    sender: 'alice',
    payload: { pull_request: { number: 9, title: 't' } },
  });
  assert.equal(rec.number, 9);
  const line = fs.readFileSync(path.join(home, 'logs', 'events.jsonl'), 'utf8').trim();
  assert.equal(JSON.parse(line).number, 9);

  delete process.env.FORGE_HOME;
});

test('config loads forge.yml from FORGE_HOME (not the package dir)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'));
  fs.writeFileSync(
    path.join(home, 'forge.yml'),
    'repo: ${MY_R}\nevents: [issues]\nroutes:\n  - on: issues\n    run: jobs/x.js\n'
  );
  process.env.FORGE_HOME = home;
  process.env.MY_R = 'owner/name';
  delete require.cache[require.resolve('../config')];
  const { load } = require('../config');

  const cfg = load();
  assert.equal(cfg.repo, 'owner/name');
  assert.equal(cfg.routes.length, 1);
  assert.equal(cfg.routes[0].run, 'jobs/x.js');

  delete process.env.FORGE_HOME;
  delete process.env.MY_R;
});
