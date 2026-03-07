#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../lib/parse-args');

const ROOT = path.join(__dirname, '..');
const BOOK_PATH = path.join(ROOT, 'address-book', 'address-book.json');
const SECRETS_PATH = path.join(ROOT, 'secrets', 'algorand-account.json');

function readJson(filePath, defaultValue) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return data.trim() ? JSON.parse(data) : defaultValue;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return defaultValue;
    }
    throw err;
  }
}

async function fetchZeroPaymentSeen(network, targetAddress, senderAddress) {
  const base = network === 'testnet'
    ? 'https://testnet-idx.algonode.cloud'
    : network === 'mainnet'
      ? 'https://mainnet-idx.algonode.cloud'
      : null;
  if (!base) {
    throw new Error(`Unsupported network: ${network}`);
  }

  let nextToken = null;
  const maxPages = 5;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${base}/v2/accounts/${senderAddress}/transactions`);
    url.searchParams.set('address-role', 'sender');
    url.searchParams.set('tx-type', 'pay');
    url.searchParams.set('limit', '1000');
    if (nextToken) {
      url.searchParams.set('next', nextToken);
    }

    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Indexer request failed (${response.status}): ${body}`);
    }
    const payload = await response.json();
    const transactions = payload.transactions || [];
    const match = transactions.some((tx) => {
      const payment = tx['payment-transaction'];
      if (!payment) return false;
      return (
        payment.amount === 0 &&
        payment.receiver === targetAddress
      );
    });
    if (match) {
      return true;
    }
    nextToken = payload['next-token'];
    if (!nextToken) break;
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv);
  const required = ['id', 'label', 'address'];
  for (const key of required) {
    if (!args[key]) {
      console.error(`Missing required argument --${key}`);
      process.exit(1);
    }
  }

  const network = (args.network || 'mainnet').toLowerCase();
  const tags = args.tags ? args.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [];
  const notes = args.notes || '';
  const allowUnverified = Boolean(args['allow-unverified']);

  const secrets = readJson(SECRETS_PATH, null);
  if (!secrets || !secrets.address) {
    console.error(`Secrets file missing address at ${SECRETS_PATH}`);
    process.exit(1);
  }

  const entries = readJson(BOOK_PATH, []);
  if (!Array.isArray(entries)) {
    console.error('Address book JSON must be an array.');
    process.exit(1);
  }

  if (entries.some((entry) => entry.id === args.id)) {
    console.error(`Entry with id "${args.id}" already exists.`);
    process.exit(1);
  }

  if (entries.some((entry) => entry.address === args.address)) {
    console.error(`Address ${args.address} already exists in the book.`);
    process.exit(1);
  }

  const senderAddress = secrets.address;
  const hasZeroPayment = await fetchZeroPaymentSeen(network, args.address, senderAddress);
  if (!hasZeroPayment && !allowUnverified) {
    console.error(`No zero-payment transaction found from ${senderAddress} to ${args.address}.`);
    console.error('Send a handshake tx first or re-run with --allow-unverified to override.');
    process.exit(1);
  }

  const now = new Date().toISOString();
  const newEntry = {
    id: args.id,
    label: args.label,
    address: args.address,
    network,
    tags,
    notes,
    verified_by_zero_payment: hasZeroPayment,
    last_verified: hasZeroPayment ? now : null,
  };

  entries.push(newEntry);
  fs.writeFileSync(BOOK_PATH, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`Added ${args.label} (${args.address}) to the address book.`);
  if (!hasZeroPayment) {
    console.log('⚠️  Marked as unverified (no zero-payment handshake yet).');
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
