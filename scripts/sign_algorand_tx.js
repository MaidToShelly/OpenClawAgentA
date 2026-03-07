#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const algosdk = require('algosdk');

function usage() {
  console.error('Usage: sign_algorand_tx.js <unsigned_txn.json> <secrets.json>');
  process.exit(1);
}

const [,, unsignedPath, secretsPath] = process.argv;
if (!unsignedPath || !secretsPath) {
  usage();
}

function readJson(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    throw new Error(`Failed to read ${path.resolve(filePath)}: ${err.message}`);
  }
}

const txnObj = readJson(unsignedPath);
const secrets = readJson(secretsPath);

if (!secrets.mnemonic) {
  throw new Error('Secrets file must contain a "mnemonic" field');
}

const { sk } = algosdk.mnemonicToSecretKey(secrets.mnemonic);

if (Array.isArray(txnObj.txns)) {
  const unsignedTxns = txnObj.txns.map((b64) => algosdk.decodeUnsignedTransaction(Buffer.from(b64, 'base64')));
  const signedBlobs = unsignedTxns.map((txn) => ({ tx: txn, blob: txn.signTxn(sk) }));
  const blobs = signedBlobs.map(({ blob }) => Buffer.from(blob).toString('base64'));
  const txIDs = signedBlobs.map(({ tx }) => tx.txID());
  if (blobs.length === 1) {
    console.log(JSON.stringify({ txID: txIDs[0], blob: blobs[0] }, null, 2));
  } else {
    console.log(JSON.stringify({ txIDs, blobs }, null, 2));
  }
  process.exit(0);
}

if (!txnObj.sender || !txnObj.receiver) {
  throw new Error('Transaction JSON must include sender and receiver');
}

const suggestedParams = {
  fee: Math.max(1000, txnObj.fee ?? 0),
  firstValid: txnObj.firstValid,
  lastValid: txnObj.lastValid,
  genesisID: txnObj.genesisID,
  genesisHash: txnObj.genesisHash ? Buffer.from(txnObj.genesisHash, 'base64') : undefined,
  flatFee: true,
};

const paymentParams = {
  sender: txnObj.sender,
  receiver: txnObj.receiver,
  amount: txnObj.amount,
  note: txnObj.note ? Buffer.from(txnObj.note, 'base64') : undefined,
  suggestedParams,
};

if (txnObj.closeRemainderTo) {
  paymentParams.closeRemainderTo = txnObj.closeRemainderTo;
}

if (txnObj.rekeyTo) {
  paymentParams.rekeyTo = txnObj.rekeyTo;
}

const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject(paymentParams);
const signedBlob = txn.signTxn(sk);

const output = {
  txID: txn.txID(),
  blob: Buffer.from(signedBlob).toString('base64'),
};

console.log(JSON.stringify(output, null, 2));
