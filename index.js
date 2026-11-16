'use strict';

// Library entry. Install github-forge, point it at your project (FORGE_HOME),
// and supply your own forge.yml + jobs/:
//
//   const { createServer, record } = require('github-forge');
//   process.env.FORGE_HOME = __dirname;           // your project root
//   createServer().listen(process.env.FORGE_PORT || 3000, '127.0.0.1');
//
// A job gets `record` for the shared events.jsonl sink; makeContext/dispatch are
// what a test harness uses to replay a synthetic payload without a live webhook.

const forge = require('./forge');
const { load, CONFIG_PATH } = require('./config');
const record = require('./record');

module.exports = { ...forge, load, CONFIG_PATH, record };
