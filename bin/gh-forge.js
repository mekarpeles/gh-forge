#!/usr/bin/env node
'use strict';

// gh-forge — run furnaces (projects) on the gh-forge engine. Think docker/pm2 for
// local GitHub webhook + schedule workflows: register a furnace (a directory with
// its own forge.yml + jobs/ + .env), then up/down/ls/status it.
//
// There's no central daemon process; each furnace is its own supervised, detached
// process (supervise.js) that survives this shell. State lives in ~/.config/gh-forge.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..'); // the gh-forge repo (holds supervise.js)
const CFG = path.join(os.homedir(), '.config', 'gh-forge');
const REG = path.join(CFG, 'furnaces.json');
const RUN = path.join(CFG, 'run');
const LOGS = path.join(CFG, 'logs');

const ensure = () => { for (const d of [CFG, RUN, LOGS]) fs.mkdirSync(d, { recursive: true }); };
const reg = () => { try { return JSON.parse(fs.readFileSync(REG, 'utf8')); } catch { return { furnaces: {} }; } };
const saveReg = (r) => { ensure(); fs.writeFileSync(REG, JSON.stringify(r, null, 2) + '\n'); };
const pidPath = (n) => path.join(RUN, `${n}.pid`);
const getPid = (n) => { try { return parseInt(fs.readFileSync(pidPath(n), 'utf8'), 10) || null; } catch { return null; } };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const pad = (s, n) => String(s) + ' '.repeat(Math.max(1, n - String(s).length));
const die = (m) => { console.error(m); process.exit(1); };

function envOf(p) {
  const e = {};
  try { for (const l of fs.readFileSync(p, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) e[m[1]] = m[2]; } } catch {}
  return e;
}
const mustFurnace = (n) => { const f = reg().furnaces[n]; if (!f) die(`no such furnace: ${n}`); return f; };
function portUp(port, cb) {
  const s = net.connect(port, '127.0.0.1');
  let done = false; const fin = (v) => { if (!done) { done = true; s.destroy(); cb(v); } };
  s.on('connect', () => fin(true)); s.on('error', () => fin(false)); s.setTimeout(500, () => fin(false));
}

function add(name, p) {
  if (!name || !p) die('usage: gh-forge add <name> <path>');
  const abs = path.resolve(p);
  if (!fs.existsSync(path.join(abs, 'forge.yml'))) die(`no forge.yml in ${abs}`);
  const repo = envOf(path.join(abs, '.env')).FORGE_REPO || '';
  const r = reg(); r.furnaces[name] = { path: abs, repo }; saveReg(r);
  console.log(`added furnace ${name} -> ${abs} (${repo || 'repo?'})`);
}

function rm(name) { down(name); const r = reg(); delete r.furnaces[name]; saveReg(r); console.log(`removed furnace ${name}`); }

function up(name) {
  const f = mustFurnace(name); ensure();
  if (alive(getPid(name))) { console.log(`${name}: already up (pid ${getPid(name)})`); return; }
  const out = fs.openSync(path.join(LOGS, `${name}.log`), 'a');
  const child = spawn('node', [path.join(ROOT, 'supervise.js'), f.path], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.writeFileSync(pidPath(name), String(child.pid));
  const port = envOf(path.join(f.path, '.env')).FORGE_PORT || '3000';
  console.log(`${name}: up (pid ${child.pid}, ${f.repo} on :${port})`);
}

function down(name) {
  const pid = getPid(name);
  if (alive(pid)) { try { process.kill(-pid); } catch { try { process.kill(pid); } catch {} } console.log(`${name}: down (pid ${pid})`); }
  else console.log(`${name}: not running`);
  try { fs.unlinkSync(pidPath(name)); } catch {}
}

function lsWorkflows(name) {
  const f = mustFurnace(name);
  process.env.FORGE_HOME = f.path;
  process.env.FORGE_CONFIG = path.join(f.path, 'forge.yml');
  let wf;
  try { wf = require(path.join(f.path, 'node_modules', 'gh-forge')).listWorkflows(); }
  catch (e) { die(`could not read ${name}'s workflows: ${e.message}`); }
  console.log(`${name} workflows — ${wf.length} total`);
  const ev = wf.filter((w) => w.trigger === 'event'), sc = wf.filter((w) => w.trigger === 'schedule');
  if (ev.length) { console.log('\nEVENT (webhook)'); for (const w of ev) console.log('  ' + pad(w.on + (w.label ? ` [${w.label}]` : ''), 46) + w.run); }
  if (sc.length) { console.log('\nSCHEDULE (cron)'); for (const w of sc) console.log('  ' + pad(w.cron || '?', 46) + w.run); }
}

function lsFurnaces() {
  const fur = reg().furnaces, names = Object.keys(fur);
  if (!names.length) { console.log('no furnaces registered — `gh-forge add <name> <path>`'); return; }
  console.log(pad('FURNACE', 14) + pad('STATUS', 8) + pad('PID', 8) + 'REPO');
  for (const n of names) { const pid = getPid(n), up = alive(pid); console.log(pad(n, 14) + pad(up ? 'up' : 'down', 8) + pad(up ? pid : '-', 8) + fur[n].repo); }
}

function status() {
  const fur = reg().furnaces, names = Object.keys(fur);
  if (!names.length) { console.log('no furnaces registered'); return; }
  let pending = names.length;
  for (const n of names) {
    const f = fur[n], pid = getPid(n), up = alive(pid), port = parseInt(envOf(path.join(f.path, '.env')).FORGE_PORT || '3000', 10);
    portUp(port, (listening) => {
      console.log(`${n}: ${up ? 'UP' : 'DOWN'}  supervisor=${up ? pid : '-'}  :${port}=${listening ? 'listening' : 'down'}  ${f.repo}`);
      if (--pending === 0) process.exit(0);
    });
  }
}

function logs(name) {
  mustFurnace(name); const lp = path.join(LOGS, `${name}.log`);
  try { console.log(fs.readFileSync(lp, 'utf8').split('\n').slice(-40).join('\n')); } catch { console.log('(no log yet)'); }
  console.log(`\n(live: tail -f ${lp})`);
}

const [cmd, a, b] = process.argv.slice(2);
switch (cmd) {
  case 'add': add(a, b); break;
  case 'rm': rm(a); break;
  case 'up': up(a); break;
  case 'down': down(a); break;
  case 'start': { const ns = Object.keys(reg().furnaces); if (!ns.length) console.log('no furnaces'); ns.forEach(up); break; }
  case 'stop': Object.keys(reg().furnaces).forEach(down); break;
  case 'ls': a ? lsWorkflows(a) : lsFurnaces(); break;
  case 'status': status(); break;
  case 'logs': logs(a); break;
  default:
    console.log(`gh-forge — run furnaces on the gh-forge engine

  gh-forge add <name> <path>   register a furnace (a dir with forge.yml + .env)
  gh-forge rm   <name>         unregister (stops it first)
  gh-forge up   <name>         start a furnace (engine + forwarder, supervised, detached)
  gh-forge down <name>         stop a furnace
  gh-forge start | stop        start / stop all furnaces
  gh-forge ls                  list furnaces + status
  gh-forge ls   <name>         that furnace's workflows (event + schedule)
  gh-forge status              detailed health (supervisor + port)
  gh-forge logs <name>         recent log  (tail -f hint)
`);
}
