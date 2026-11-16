'use strict';

// Scheduled workflows — the `on: schedule` trigger, the time-based sibling of the
// webhook routes. A route like:
//
//   - on: schedule
//     cron: "0 * * * *"      # UTC, 5-field, like GitHub Actions
//     run: jobs/label-conflicts.js
//
// runs its job on a cadence, dispatched through the SAME job(ctx) path the webhook
// routes use (just with a synthetic `schedule` payload instead of a webhook body).
//
// This is additive: `on: schedule` routes never match a webhook event, and the
// webhook path never calls into here, so existing event routes are untouched. The
// loop re-reads forge.yml every tick, so edits hot-reload like everywhere else.

const path = require('path');

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }

// Run every `on: schedule` route whose cron matches `now` (default: now, UTC).
async function tick(now = new Date()) {
  const { load } = require('./config');
  const { makeContext, HOME } = require('./forge');
  const { matches } = require('./cron');

  const cfg = load();
  const routes = (cfg.routes || []).filter((r) => r.on === 'schedule' && r.cron && r.run);
  for (const r of routes) {
    if (!matches(r.cron, now)) continue;
    const file = path.isAbsolute(r.run) ? r.run : path.join(HOME, r.run);
    log(`▶ schedule (${r.cron}) — ${r.run}`);
    try {
      delete require.cache[require.resolve(file)]; // hot reload
      const job = require(file);
      const payload = {
        schedule: { cron: r.cron },
        repository: cfg.repo ? { full_name: cfg.repo } : undefined,
      };
      await job(makeContext('schedule', null, payload, r.config));
      log(`✓ schedule — ${r.run} done`);
    } catch (err) {
      log(`✗ schedule — ${r.run} — ${err.stack || err}`);
    }
  }
}

// Start a minute-aligned loop. Returns { stop() } so a consumer (or a test) can
// cancel it. Fires at each minute boundary and re-reads config each time.
function startScheduler() {
  const { load } = require('./config');
  const count = (load().routes || []).filter((r) => r.on === 'schedule').length;
  let interval = null;
  const delay = 60000 - (Date.now() % 60000); // align to the next minute
  const boot = setTimeout(() => {
    tick(new Date());
    interval = setInterval(() => tick(new Date()), 60000);
  }, delay);
  log(`scheduler started — ${count} schedule route(s), first tick in ${Math.round(delay / 1000)}s`);
  return { stop() { clearTimeout(boot); if (interval) clearInterval(interval); } };
}

module.exports = { startScheduler, tick };
