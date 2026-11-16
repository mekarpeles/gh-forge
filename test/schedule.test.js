'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { matches } = require('../cron');

// --- cron matcher ----------------------------------------------------------

const at = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo, d, h, mi, 0));

test('cron: hourly "0 * * * *" matches on the hour, not otherwise', () => {
  assert.equal(matches('0 * * * *', at(2026, 0, 1, 9, 0)), true);
  assert.equal(matches('0 * * * *', at(2026, 0, 1, 9, 30)), false);
});

test('cron: step "*/15 * * * *" matches 0/15/30/45', () => {
  for (const m of [0, 15, 30, 45]) assert.equal(matches('*/15 * * * *', at(2026, 0, 1, 3, m)), true);
  assert.equal(matches('*/15 * * * *', at(2026, 0, 1, 3, 7)), false);
});

test('cron: specific time, list and range', () => {
  assert.equal(matches('30 9 * * *', at(2026, 0, 1, 9, 30)), true);
  assert.equal(matches('30 9 * * *', at(2026, 0, 1, 10, 30)), false);
  assert.equal(matches('0 9,17 * * *', at(2026, 0, 1, 17, 0)), true);
  assert.equal(matches('0 9-11 * * *', at(2026, 0, 1, 10, 0)), true);
  assert.equal(matches('0 9-11 * * *', at(2026, 0, 1, 12, 0)), false);
});

test('cron: rejects malformed expressions', () => {
  assert.equal(matches('0 *', at(2026, 0, 1, 0, 0)), false);
  assert.equal(matches('', at(2026, 0, 1, 0, 0)), false);
});

// --- scheduled dispatch (tick runs matching routes through the job path) ----

function setupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sched-'));
  fs.mkdirSync(path.join(home, 'jobs'));
  const marker = path.join(home, 'ran.txt');
  fs.writeFileSync(
    path.join(home, 'jobs', 'marker.js'),
    `module.exports = async (ctx) => { require('fs').writeFileSync(${JSON.stringify(marker)}, ctx.event + ':' + (ctx.config && ctx.config.note || '')); };`
  );
  fs.writeFileSync(
    path.join(home, 'forge.yml'),
    'repo: owner/name\nroutes:\n  - on: schedule\n    cron: "30 9 * * *"\n    run: jobs/marker.js\n    config:\n      note: hi\n'
  );
  process.env.FORGE_HOME = home;
  for (const m of ['../forge', '../config', '../scheduler', '../cron']) {
    delete require.cache[require.resolve(m)];
  }
  return { home, marker, sched: require('../scheduler') };
}

test('tick runs an on:schedule route whose cron matches now', async () => {
  const { marker, sched } = setupHome();
  await sched.tick(at(2026, 0, 1, 9, 30)); // matches "30 9 * * *"
  assert.equal(fs.existsSync(marker), true);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'schedule:hi'); // event + route config passed through
  delete process.env.FORGE_HOME;
});

test('tick does NOT run a schedule route when the cron does not match', async () => {
  const { marker, sched } = setupHome();
  await sched.tick(at(2026, 0, 1, 10, 0)); // does not match "30 9 * * *"
  assert.equal(fs.existsSync(marker), false);
  delete process.env.FORGE_HOME;
});
