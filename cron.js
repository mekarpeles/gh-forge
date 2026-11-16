'use strict';

// Minimal 5-field cron matcher: "minute hour day-of-month month day-of-week".
// Evaluated in UTC, like GitHub Actions' `schedule`. Supports the common forms:
//   *            any
//   a            a single value
//   a,b,c        a list
//   a-b          a range
//   */n, a-b/n   a step over * or a range
// Day-of-week is 0-6 (Sun=0); 7 is also accepted for Sunday. Per cron convention,
// if BOTH day-of-month and day-of-week are restricted, a match on EITHER counts.

function parseField(expr, min, max) {
  const set = new Set();
  for (const part of String(expr).split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (!step || step < 1) continue;
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { const [a, b] = range.split('-'); lo = parseInt(a, 10); hi = parseInt(b, 10); }
    else { lo = hi = parseInt(range, 10); }
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
    for (let v = lo; v <= hi; v += step) if (v >= min && v <= max) set.add(v);
  }
  return set;
}

// True if `cron` fires at the given Date (defaults to now), evaluated in UTC.
function matches(cron, date = new Date()) {
  const f = String(cron || '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  const [minE, hrE, domE, monE, dowE] = f;

  const minute = parseField(minE, 0, 59).has(date.getUTCMinutes());
  const hour = parseField(hrE, 0, 23).has(date.getUTCHours());
  const month = parseField(monE, 1, 12).has(date.getUTCMonth() + 1);
  if (!(minute && hour && month)) return false;

  const domSet = parseField(domE, 1, 31);
  const dowSet = parseField(dowE, 0, 7);
  const dowVal = date.getUTCDay(); // 0..6, Sun=0
  const domOk = domSet.has(date.getUTCDate());
  const dowOk = dowSet.has(dowVal) || (dowVal === 0 && dowSet.has(7));

  // Restricted = not "*". Both restricted -> OR; otherwise -> AND.
  const domR = domE !== '*';
  const dowR = dowE !== '*';
  return (domR && dowR) ? (domOk || dowOk) : (domOk && dowOk);
}

module.exports = { matches, parseField };
