#!/usr/bin/env node

const algosdk = require('algosdk');
const { resolveAlgodSettings } = require('../lib/algorand-network');

function usage() {
  console.error('Usage: send_algorand_tx.js <network> <base64_txn>');
  process.exit(1);
}

const [,, network, base64Txn] = process.argv;
if (!network || !base64Txn) {
  usage();
}

async function main() {
  const settings = resolveAlgodSettings({ network });
  const algodClient = new algosdk.Algodv2(
    settings.token || '',
    settings.url,
    settings.port || '',
    settings.headers || {}
  );

  const rawTxn = Buffer.from(base64Txn, 'base64');
  const res = await algodClient.sendRawTransaction(rawTxn).do();
  console.log(JSON.stringify(res, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
