#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../lib/parse-args');

const ROOT = path.join(__dirname, '..');
const BOOK_PATH = path.join(ROOT, 'address-book', 'address-book.json');

const INTERVALS = {
  '1m': 60,
  '5m': 5 * 60,
  '30m': 30 * 60,
  '1h': 60 * 60,
  '1d': 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
};

function readAddressBook() {
  if (!fs.existsSync(BOOK_PATH)) {
    return [];
  }
  const data = fs.readFileSync(BOOK_PATH, 'utf8');
  if (!data.trim()) return [];
  return JSON.parse(data);
}

function pickAddress(args, entries) {
  if (args.address) {
    return { address: args.address, label: args.address };
  }
  if (!args.contact) {
    throw new Error('Specify --contact <id> or --address <addr>');
  }
  const entry = entries.find((item) => item.id === args.contact);
  if (!entry) {
    throw new Error(`Contact id "${args.contact}" not found in address book.`);
  }
  return { address: entry.address, label: `${entry.label} (${entry.id})` };
}

function getBaseUrl(network) {
  switch ((network || 'mainnet').toLowerCase()) {
    case 'mainnet':
      return 'https://mainnet-idx.algonode.cloud';
    case 'testnet':
      return 'https://testnet-idx.algonode.cloud';
    default:
      throw new Error(`Unsupported network: ${network}`);
  }
}

function microToAlgo(value) {
  const num = Number(value) / 1_000_000;
  const fixed = num.toFixed(6);
  return fixed.replace(/\.?(0)+$/, (match) => (match.startsWith('.') ? '' : match)) || '0';
}

function decodeNote(note) {
  if (!note) return '';
  if (typeof note === 'string') {
    return Buffer.from(note, 'base64').toString('utf8').replace(/[^\x20-\x7E]+/g, '').trim();
  }
  if (!note.data) return '';
  const bytes = Object.values(note.data);
  const text = Buffer.from(bytes).toString('utf8');
  return text.replace(/[^\x20-\x7E]+/g, '').trim();
}

async function fetchTransactions(baseUrl, address, sinceIso, maxPages = 10) {
  let nextToken = null;
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${baseUrl}/v2/accounts/${address}/transactions`);
    url.searchParams.set('after-time', sinceIso);
    url.searchParams.set('limit', '100');
    if (nextToken) {
      url.searchParams.set('next', nextToken);
    }
    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Indexer request failed (${response.status}): ${body}`);
    }
    const payload = await response.json();
    const txns = payload.transactions || [];
    all.push(...txns);
    nextToken = payload['next-token'];
    if (!nextToken) break;
  }
  return all;
}

function summarize(address, txns) {
  const summary = {
    total: txns.length,
    sent: { count: 0, microAlgos: 0 },
    received: { count: 0, microAlgos: 0 },
    zeroPay: 0,
    recent: [],
  };

  txns.forEach((tx) => {
    const isSent = tx.sender === address;
    const payment = tx['payment-transaction'];
    if (payment) {
      const amount = payment.amount || 0;
      if (isSent) {
        summary.sent.count += 1;
        summary.sent.microAlgos += amount;
      } else {
        summary.received.count += 1;
        summary.received.microAlgos += amount;
      }
      if (amount === 0) {
        summary.zeroPay += 1;
      }
    }

    let direction = 'involved';
    let counterparty = tx.sender;
    let amountValue = 0;
    if (payment) {
      amountValue = payment.amount || 0;
      if (isSent) {
        direction = 'sent';
        counterparty = payment.receiver;
      } else if (payment.receiver === address) {
        direction = 'received';
        counterparty = tx.sender;
      } else {
        counterparty = payment.receiver;
      }
    }

    summary.recent.push({
      round: tx['confirmed-round'],
      txid: tx.id,
      type: tx['tx-type'],
      direction,
      amount: amountValue,
      counterparty,
      note: decodeNote(tx.note),
      time: tx['round-time'] ? new Date(tx['round-time'] * 1000).toISOString() : null,
    });
  });

  summary.recent.sort((a, b) => (b.round || 0) - (a.round || 0));
  return summary;
}

function formatDigest({ label, address, intervalKey, sinceIso, network, summary, quiet }) {
  const sentAlgo = microToAlgo(summary.sent.microAlgos);
  const receivedAlgo = microToAlgo(summary.received.microAlgos);

  const lines = [];
  lines.push(`Watching ${label} [${address}] over last ${intervalKey} (since ${sinceIso})`);
  lines.push(`Network: ${(network || 'mainnet').toUpperCase()}`);
  lines.push('');
  lines.push(`Total transactions: ${summary.total}`);
  lines.push(`Sent: ${summary.sent.count} tx (${sentAlgo} ALGO)`);
  lines.push(`Received: ${summary.received.count} tx (${receivedAlgo} ALGO)`);
  lines.push(`Zero-pay handshakes: ${summary.zeroPay}`);
  lines.push('');

  if (summary.recent.length === 0) {
    if (!quiet) {
      lines.push('No activity in this window.');
      return lines.join('\n');
    }
    return null;
  }

  lines.push('Recent activity:');
  summary.recent.slice(0, 10).forEach((entry) => {
    const amountStr = `${microToAlgo(entry.amount)} ALGO`;
    const cp = entry.counterparty || 'n/a';
    const verb = entry.direction === 'sent' ? 'to' : 'from';
    const note = entry.note ? ` note:"${entry.note}"` : '';
    lines.push(`- [round ${entry.round}] ${entry.direction} ${amountStr} ${verb} ${cp}${note}`);
  });

  return lines.join('\n');
}

async function watchAddress({ contact, address, interval, network, quiet } = {}) {
  const intervalKey = (interval || '1h').toLowerCase();
  if (!INTERVALS[intervalKey]) {
    throw new Error(`Unsupported interval "${intervalKey}". Choose one of ${Object.keys(INTERVALS).join(', ')}`);
  }

  const lookbackSeconds = INTERVALS[intervalKey];
  const sinceIso = new Date(Date.now() - lookbackSeconds * 1000).toISOString();

  const entries = readAddressBook();
  const resolved = pickAddress({ contact, address }, entries);
  const baseUrl = getBaseUrl(network || 'mainnet');

  const transactions = await fetchTransactions(baseUrl, resolved.address, sinceIso);
  const summary = summarize(resolved.address, transactions);

  return formatDigest({
    label: resolved.label,
    address: resolved.address,
    intervalKey,
    sinceIso,
    network,
    summary,
    quiet: Boolean(quiet),
  });
}

module.exports = { watchAddress, readAddressBook, pickAddress, getBaseUrl, fetchTransactions, summarize, formatDigest, microToAlgo, decodeNote, INTERVALS };

if (require.main === module) {
  const args = parseArgs(process.argv);
  watchAddress({
    contact: args.contact,
    address: args.address,
    interval: args.interval,
    network: args.network,
    quiet: Boolean(args.quiet),
  }).then((digest) => {
    if (digest) console.log(digest);
  }).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
