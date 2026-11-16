'use strict';

// Append one line per delivery to <FORGE_HOME>/logs/events.jsonl — the shared
// event sink. Optional helper: a job can `const { record } = require('github-forge')`
// (library use) to record and get back the normalized record it wrote.

const fs = require('fs');
const path = require('path');

const HOME = path.resolve(process.env.FORGE_HOME || process.cwd());
const DIR = path.join(HOME, 'logs');

module.exports = function record(ctx) {
  const o = ctx.payload.issue || ctx.payload.pull_request || {};
  const rec = {
    at: new Date().toISOString(),
    event: ctx.event,
    action: ctx.action || null,
    repo: ctx.repo,
    sender: ctx.sender,
    number: o.number || null,
    title: o.title || null,
  };
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(path.join(DIR, 'events.jsonl'), JSON.stringify(rec) + '\n');
  } catch {
    /* logging must never drop a delivery */
  }
  return rec;
};
