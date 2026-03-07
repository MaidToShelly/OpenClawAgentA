#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { watchAddress, INTERVALS } = require('./watch-address');
const { parseArgs } = require('../lib/parse-args');

const ROOT = path.join(__dirname, '..');
const WATCHLIST_PATH = path.join(ROOT, 'address-book', 'watchlist.json');
const TEMPLATE_PATH = path.join(ROOT, 'address-book', 'watchlist.template.json');
const STATE_PATH = path.join(ROOT, 'address-book', 'watchlist-state.json');

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

async function main() {
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

  const eligible = watchlist.filter((entry) => {
    const key = entry.contact || entry.address;
    if (!key) return false;
    if (target && key !== target) return false;
    if (shouldThrottle(entry, state, now, force)) return false;
    return true;
  });

  const results = await Promise.all(
    eligible.map(async (entry) => {
      try {
        const digest = await watchAddress({
          contact: entry.contact,
          address: entry.address,
          interval: entry.interval,
          network: entry.network,
          quiet: true,
        });
        return { entry, digest, error: null };
      } catch (err) {
        return { entry, digest: null, error: err };
      }
    })
  );

  let stateDirty = false;
  const digests = [];

  for (const { entry, digest, error } of results) {
    if (error) {
      console.error(`[${entry.contact || entry.address}] ${error.message || error}`);
      continue;
    }
    if (digest) {
      digests.push(digest);
      updateState(entry, state, now);
      stateDirty = true;
    } else if (force) {
      updateState(entry, state, now);
      stateDirty = true;
    }
  }

  if (stateDirty) {
    saveState(state);
  }

  if (digests.length) {
    console.log(digests.join('\n\n---\n\n'));
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
