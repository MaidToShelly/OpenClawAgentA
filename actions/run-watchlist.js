#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WATCHLIST_PATH = path.join(ROOT, 'address-book', 'watchlist.json');
const TEMPLATE_PATH = path.join(ROOT, 'address-book', 'watchlist.template.json');
const STATE_PATH = path.join(ROOT, 'address-book', 'watchlist-state.json');
const WATCH_SCRIPT = path.join(__dirname, 'watch-address.js');
const INTERVALS = {
  '1m': 60,
  '5m': 5 * 60,
  '30m': 30 * 60,
  '1h': 60 * 60,
  '1d': 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
};

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        const key = token.slice(2, eq);
        const val = token.slice(eq + 1);
        args[key] = val;
      } else {
        const key = token.slice(2);
        const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
        args[key] = val;
      }
    }
  }
  return args;
}

function loadWatchlist() {
  const source = fs.existsSync(WATCHLIST_PATH) ? WATCHLIST_PATH : (fs.existsSync(TEMPLATE_PATH) ? TEMPLATE_PATH : null);
  if (!source) {
    return [];
  }
  const data = fs.readFileSync(source, 'utf8');
  if (!data.trim()) return [];
  return JSON.parse(data);
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try {
    const data = fs.readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(data || '{}');
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function buildArgs(entry) {
  const args = [];
  if (entry.contact) {
    args.push('--contact', entry.contact);
  } else if (entry.address) {
    args.push('--address', entry.address);
  } else {
    return null;
  }
  if (entry.interval) {
    args.push('--interval', entry.interval);
  }
  if (entry.network) {
    args.push('--network', entry.network);
  }
  args.push('--quiet');
  return args;
}

function shouldThrottle(entry, state, now, force) {
  if (force) return false;
  const key = entry.contact || entry.address;
  if (!key) return false;
  const intervalKey = (entry.interval || '1h').toLowerCase();
  const seconds = INTERVALS[intervalKey] || INTERVALS['1h'];
  const last = state[key]?.lastReport;
  if (!last) return false;
  const elapsed = (now - new Date(last).getTime()) / 1000;
  return elapsed < seconds;
}

function updateState(entry, state, now) {
  const key = entry.contact || entry.address;
  if (!key) return;
  state[key] = { lastReport: new Date(now).toISOString() };
}

function main() {
  const args = parseArgs(process.argv);
  const target = args.contact || args.address || null;
  const force = Boolean(args.force);
  const watchlist = loadWatchlist();
  if (!watchlist.length) {
    console.error('Watchlist is empty. Populate address-book/watchlist.json');
    process.exit(1);
  }

  const state = loadState();
  const now = Date.now();
  let stateDirty = false;
  const digests = [];

  watchlist.forEach((entry) => {
    const key = entry.contact || entry.address;
    if (target && key !== target) return;
    if (shouldThrottle(entry, state, now, force)) return;

    const argv = buildArgs(entry);
    if (!argv) return;
    const result = spawnSync(WATCH_SCRIPT, argv, { encoding: 'utf8' });
    if (result.error) {
      throw result.error;
    }
    if (result.stdout && result.stdout.trim()) {
      digests.push(result.stdout.trim());
      updateState(entry, state, now);
      stateDirty = true;
    } else if (!result.stdout && force) {
      updateState(entry, state, now);
      stateDirty = true;
    }
    if (result.stderr && result.stderr.trim()) {
      console.error(result.stderr.trim());
    }
  });

  if (stateDirty) {
    saveState(state);
  }

  if (digests.length) {
    console.log(digests.join('\n\n---\n\n'));
  }
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
