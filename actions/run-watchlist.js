#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WATCHLIST_PATH = path.join(ROOT, 'address-book', 'watchlist.json');
const TEMPLATE_PATH = path.join(ROOT, 'address-book', 'watchlist.template.json');
const WATCH_SCRIPT = path.join(__dirname, 'watch-address.js');

function loadWatchlist() {
  const source = fs.existsSync(WATCHLIST_PATH) ? WATCHLIST_PATH : (fs.existsSync(TEMPLATE_PATH) ? TEMPLATE_PATH : null);
  if (!source) {
    return [];
  }
  const data = fs.readFileSync(source, 'utf8');
  if (!data.trim()) return [];
  return JSON.parse(data);
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

function main() {
  const watchlist = loadWatchlist();
  if (!watchlist.length) {
    console.error('Watchlist is empty. Populate address-book/watchlist.json');
    process.exit(1);
  }

  const digests = [];

  watchlist.forEach((entry) => {
    const args = buildArgs(entry);
    if (!args) return;
    const result = spawnSync(WATCH_SCRIPT, args, { encoding: 'utf8' });
    if (result.error) {
      throw result.error;
    }
    if (result.stdout && result.stdout.trim()) {
      digests.push(result.stdout.trim());
    }
    if (result.stderr && result.stderr.trim()) {
      console.error(result.stderr.trim());
    }
  });

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
