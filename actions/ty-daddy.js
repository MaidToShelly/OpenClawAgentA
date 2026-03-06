#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const algosdk = require('algosdk');
const {
  loadAlgorandNetworkConfig,
  resolveAlgodSettings
} = require('../lib/algorand-network');

const ROOT = path.join(__dirname, '..');
const SECRETS_PATH = path.join(ROOT, 'secrets', 'algorand-account.json');
const TRANSFER_DIR = path.join(ROOT, 'portfolio', 'transfers');
const MIN_REPLY_MICRO = 1_000_000n; // 1 ALGO/VOI
const NOTE_TEXT = 'Ty Daddy';

async function main() {
  const args = parseArgs(process.argv);
  const config = loadAlgorandNetworkConfig();
  const targets = resolveTargets(args.networks, config);
  if (!targets.length) {
    console.log('No matching networks to scan.');
    return;
  }

  ensureDir(TRANSFER_DIR);
  const secrets = loadJson(SECRETS_PATH, 'Algorand secrets');
  if (!secrets.mnemonic) throw new Error('Mnemonic missing in secrets/algorand-account.json');
  const account = algosdk.mnemonicToSecretKey(secrets.mnemonic);
  account.address = account.addr.toString();

  for (const networkKey of targets) {
    const entry = config[networkKey];
    if (!entry) continue;
    try {
      await handleNetwork({ networkKey, entry, account });
    } catch (err) {
      console.warn(`[${networkKey}] error: ${err.stack || err.message}`);
    }
  }
}

async function handleNetwork({ networkKey, entry, account }) {
  console.log(`[${networkKey}] scanning for transfers...`);
  const algodSettings = resolveAlgodSettings({ network: networkKey });
  const algod = new algosdk.Algodv2(
    algodSettings.token || '',
    algodSettings.url,
    algodSettings.port || '',
    algodSettings.headers || {}
  );
  const indexer = buildIndexerClient(entry);
  if (!indexer) {
    console.warn(`[${networkKey}] no indexer configured; skipping`);
    return;
  }

  const tracker = loadTracker(networkKey);
  const minRound = tracker.last_round ? tracker.last_round + 1 : 0;
  const deposits = await fetchIncomingPayments({ indexer, address: account.addr, minRound });
  console.log(`[${networkKey}] fetched ${deposits.length} payments since round ${minRound}`);
  if (!deposits.length) {
    console.log(`[${networkKey}] no new transfers`);
    return;
  }

  for (const txn of deposits) {
    const txid = txn.id;
    if (tracker.processed_txids.includes(txid)) continue;
    const pay = txn['payment-transaction'] || txn['paymentTransaction'];
    if (!pay || pay.receiver !== account.address) continue;
    const rawAmount = pay.amount ?? 0;
    const amountMicro = BigInt(rawAmount);
    const amountNumber = typeof rawAmount === 'bigint' ? Number(rawAmount) : rawAmount;
    const confirmedRoundRaw = txn['confirmed-round'] ?? txn.confirmedRound ?? 0;
    const roundTimeRaw = txn['round-time'] ?? txn.roundTime ?? null;
    const confirmedRound = typeof confirmedRoundRaw === 'bigint' ? Number(confirmedRoundRaw) : confirmedRoundRaw;
    const roundTime = typeof roundTimeRaw === 'bigint' ? Number(roundTimeRaw) : roundTimeRaw;
    const noteBase64 = txn.note ?? txn.noteBase64 ?? null;
    const event = {
      txid,
      sender: txn.sender,
      receiver: pay.receiver,
      amount_micro: amountNumber,
      confirmed_round: confirmedRound,
      round_time: roundTime,
      note_base64: noteBase64
    };
    tracker.events.push(event);
    tracker.processed_txids.push(txid);
    const currentRound = typeof tracker.last_round === 'number' ? tracker.last_round : Number(tracker.last_round || 0);
    tracker.last_round = Math.max(currentRound, Number(confirmedRound));

    if (amountMicro >= MIN_REPLY_MICRO) {
      console.log(`[${networkKey}] responding to sender ${txn.sender}`);
      try {
        const responseTxId = await sendTyDaddy({ algod, account, recipient: txn.sender, networkKey });
        tracker.responses.push({
          deposit_txid: txid,
          response_txid: responseTxId,
          amount_micro: amountNumber,
          network: networkKey,
          sent_at: new Date().toISOString()
        });
        console.log(`[${networkKey}] thanked ${txn.sender} for ${(amountNumber / 1_000_000).toFixed(6)} with ${responseTxId}`);
      } catch (err) {
        console.warn(`[${networkKey}] failed to send Ty Daddy for ${txid}: ${err.message}`);
      }
    } else {
      console.log(`[${networkKey}] logged ${txid} (${amountNumber / 1_000_000} < 1)`);
    }
  }

  saveTracker(networkKey, tracker);
}

async function sendTyDaddy({ algod, account, recipient, networkKey }) {
  const params = await algod.getTransactionParams().do();
  const note = new Uint8Array(Buffer.from(NOTE_TEXT));
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.address,
    receiver: recipient,
    amount: 0,
    note,
    suggestedParams: params
  });
  const signed = txn.signTxn(account.sk);
  const sendResult = await algod.sendRawTransaction(signed).do();
  const txId = sendResult.txId || sendResult.txid;
  console.log(`[${networkKey}] submitted Ty Daddy tx ${txId}`);
  try {
    await algosdk.waitForConfirmation(algod, txId, 10);
  } catch (err) {
    console.warn(`[${networkKey}] waitForConfirmation warning for ${txId}: ${err.message}`);
  }
  return txId;
}

async function fetchIncomingPayments({ indexer, address, minRound }) {
  const results = [];
  const limit = 100;
  let next = undefined;
  let keepGoing = true;
  while (keepGoing) {
    let query = indexer.lookupAccountTransactions(address).txType('pay').limit(limit);
    if (minRound > 0) query = query.minRound(minRound);
    if (next) query = query.nextToken(next);
    const resp = await query.do();
    const txns = resp.transactions || [];
    for (const txn of txns) {
      const confirmed = txn['confirmed-round'] ?? txn.confirmedRound ?? 0;
      if (confirmed >= minRound) {
        results.push(txn);
      } else {
        keepGoing = false;
        break;
      }
    }
    next = resp['next-token'];
    if (!next) break;
    if (results.length >= 500) break;
  }
  return results;
}

function buildIndexerClient(entry) {
  const idx = entry?.indexer;
  if (!idx || !idx.url) return null;
  return new algosdk.Indexer(idx.token || '', idx.url, idx.port || '', idx.headers || {});
}

function loadTracker(networkKey) {
  const file = path.join(TRANSFER_DIR, `${networkKey}.json`);
  if (!fs.existsSync(file)) {
    return { last_round: 0, processed_txids: [], events: [], responses: [] };
  }
  return loadJson(file);
}

function saveTracker(networkKey, tracker) {
  const file = path.join(TRANSFER_DIR, `${networkKey}.json`);
  fs.writeFileSync(file, JSON.stringify(tracker, null, 2));
  console.log(`[${networkKey}] tracker updated: ${file}`);
}

function parseArgs(argv) {
  const args = { networks: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--network' || arg === '--networks') && argv[i + 1]) {
      args.networks = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function resolveTargets(flagValue, config) {
  const enabledKeys = Object.entries(config)
    .filter(([, entry]) => entry.enabled !== false)
    .map(([key]) => key);
  if (!flagValue) return enabledKeys;
  return flagValue
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k && config[k] && config[k].enabled !== false);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (label) {
      throw new Error(`${label} (${filePath}) could not be read: ${err.message}`);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
