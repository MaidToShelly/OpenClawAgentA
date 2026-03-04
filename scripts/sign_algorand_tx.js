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

const { sk } = algosdk.mnemonicToSecretKey(secrets.mnemonic);
const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject(paymentParams);
const signedBlob = txn.signTxn(sk);

const output = {
  txID: txn.txID(),
  blob: Buffer.from(signedBlob).toString('base64'),
};

console.log(JSON.stringify(output, null, 2));
