#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const algosdk = require('algosdk');
const { poolUtils, Swap, SwapType } = require('@tinymanorg/tinyman-js-sdk');
const { resolveAlgodNetworkConfig } = require('../lib/algorand-network');

const ROOT = path.join(__dirname, '..');
const SECRETS_PATH = path.join(ROOT, 'secrets', 'algorand-account.json');
const TRADES_PATH = path.join(ROOT, 'portfolio', 'trades.json');
const POSITIONS_PATH = path.join(ROOT, 'portfolio', 'positions.json');
const ROLES_PATH = path.join(ROOT, 'roles', 'roles.json');
const TASKS_DIR = path.join(ROOT, 'roles', 'trader', 'tasks');
const DEFAULT_ALGOD_URL = 'https://mainnet-api.4160.nodely.dev';
const DEFAULT_TASK_ID = 'tinyman-algo-wad';

async function runSwap(options = {}) {
  const {
    taskId = DEFAULT_TASK_ID,
    direction = 'forward',
    amountMicro,
    amountAlgo,
    slippageBps,
    dryRun = false,
    quiet = false
  } = options;

  const log = quiet ? () => {} : console.log;
  const taskPath = path.join(TASKS_DIR, `${taskId}.json`);
  if (!fs.existsSync(taskPath)) {
    throw new Error(`Task config not found: ${taskPath}`);
  }
  const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));

  const roles = JSON.parse(fs.readFileSync(ROLES_PATH, 'utf8'));
  if (!roles.Trader || !roles.Trader.actions.includes('swap')) {
    throw new Error('Trader role is not authorized for swaps.');
  }

  const secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
  if (!secrets || !secrets.mnemonic) {
    throw new Error('Mnemonic missing in secrets/algorand-account.json');
  }
  const account = algosdk.mnemonicToSecretKey(secrets.mnemonic);
  const networkConfig = resolveAlgodNetworkConfig(task) || {};
  const algodSettings = networkConfig.algod || {};
  const algodUrl = algodSettings.url || process.env.ALGOD_URL || DEFAULT_ALGOD_URL;
  const algodToken = algodSettings.token || process.env.ALGOD_TOKEN || '';
  const algodHeaders = algodSettings.headers || {};
  const algodClient = new algosdk.Algodv2(algodToken, algodUrl, '', algodHeaders);

  const normalizedDirection = direction === 'reverse' ? 'reverse' : 'forward';
  const assetInDef = normalizedDirection === 'forward' ? task.pair.asset_in : task.pair.asset_out;
  const assetOutDef = normalizedDirection === 'forward' ? task.pair.asset_out : task.pair.asset_in;
  const assetIn = normalizeAsset(assetInDef);
  const assetOut = normalizeAsset(assetOutDef);

  log(`Using account ${account.addr}`);

  if (assetOut.id !== 0) {
    await ensureAssetOptIn({ algodClient, account, assetID: assetOut.id });
  }

  const poolAssetA = Number(task.pair.asset_in.id);
  const poolAssetB = Number(task.pair.asset_out.id);
  const asset1ID = Math.min(poolAssetA, poolAssetB);
  const asset2ID = Math.max(poolAssetA, poolAssetB);

  const pool = await poolUtils.v2.getPoolInfo({
    network: task.network,
    client: algodClient,
    asset1ID,
    asset2ID
  });

  const swapAmount = deriveAmountMicro({
    amountMicro,
    amountAlgo,
    task,
    direction: normalizedDirection,
    assetIn
  });

  const slippage = (
    typeof slippageBps === 'number'
      ? slippageBps
      : (task.strategy.slippage_tolerance_bps || 100)
  ) / 10_000;

  const quote = await Swap.v2.getQuote({
    type: SwapType.FixedInput,
    pool,
    amount: swapAmount,
    assetIn,
    assetOut,
    network: task.network,
    slippage
  });

  const quoteSummary = summarizeQuote(quote);
  log('Quote:', quoteSummary);

  if (dryRun) {
    log('Dry run complete (no transactions sent).');
    return buildResult({
      dryRun: true,
      task,
      direction: normalizedDirection,
      amountMicro: swapAmount,
      quoteSummary,
      assetIn,
      assetOut
    });
  }

  const txns = await Swap.v2.generateTxns({
    client: algodClient,
    network: task.network,
    quote,
    swapType: SwapType.FixedInput,
    slippage,
    initiatorAddr: account.addr
  });

  const signedTxns = await Swap.v2.signTxns({
    txGroup: txns,
    initiatorSigner: signerWithSecretKey(account)
  });

  const execution = await Swap.v2.execute({
    quote,
    client: algodClient,
    signedTxns,
    txGroup: txns
  });

  log('Swap executed:', execution.txnID);

  await appendTradeLog({
    execution,
    task,
    quoteSummary,
    amountMicro: swapAmount,
    assetIn,
    assetOut
  });

  await updatePositions({ algodClient, address: account.addr });

  return buildResult({
    dryRun: false,
    task,
    direction: normalizedDirection,
    amountMicro: swapAmount,
    quoteSummary,
    assetIn,
    assetOut,
    txid: execution.txnID
  });
}

function signerWithSecretKey(account) {
  return function (txGroups) {
    const txnsToSign = txGroups.flatMap((group) =>
      group.filter((item) => !item.signers || item.signers.includes(account.addr))
    );
    const signed = txnsToSign.map(({ txn }) => txn.signTxn(account.sk));
    return Promise.resolve(signed);
  };
}

async function ensureAssetOptIn({ algodClient, account, assetID }) {
  if (!assetID) return;
  const info = await algodClient.accountInformation(account.addr).do();
  const hasAsset = (info.assets || []).some((a) => {
    const id = a['asset-id'] ?? a['assetId'];
    return Number(id) === Number(assetID);
  });
  if (hasAsset) return;
  const params = await algodClient.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: account.addr,
    assetIndex: assetID,
    amount: 0,
    suggestedParams: params
  });
  const signed = txn.signTxn(account.sk);
  const { txId } = await algodClient.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algodClient, txId, 10);
  console.log(`Opted into asset ${assetID} (tx ${txId})`);
}

async function appendTradeLog({ execution, task, quoteSummary, amountMicro, assetIn, assetOut, options = {} }) {
  if (!fs.existsSync(TRADES_PATH)) {
    fs.writeFileSync(TRADES_PATH, JSON.stringify({ trades: [] }, null, 2));
  }
  const trades = JSON.parse(fs.readFileSync(TRADES_PATH, 'utf8'));
  const entry = {
    timestamp: options.timestamp || new Date().toISOString(),
    role: task.role,
    task_id: task.id,
    dex: task.dex,
    network: task.network,
    txid: options.txidOverride || execution?.txnID || null,
    direction: `${assetIn.symbol || assetIn.id}->${assetOut.symbol || assetOut.id}`,
    input: {
      asset_id: assetIn.id,
      symbol: assetIn.symbol,
      amount_micro: amountMicro.toString()
    },
    output: {
      asset_id: assetOut.id,
      symbol: assetOut.symbol,
      amount_micro: quoteSummary.assetOutAmount.toString()
    },
    price_impact: quoteSummary.priceImpact,
    swap_fee_microalgo: quoteSummary.swapFee
  };
  if (options.paper) {
    entry.paper = true;
  }
  if (options.executionMode) {
    entry.execution_mode = options.executionMode;
  }
  trades.trades.push(entry);
  fs.writeFileSync(TRADES_PATH, JSON.stringify(trades, null, 2));
}

async function updatePositions({ algodClient, address }) {
  if (!fs.existsSync(POSITIONS_PATH)) {
    fs.writeFileSync(POSITIONS_PATH, JSON.stringify({ assets: {}, last_updated: null }, null, 2));
  }
  const info = await algodClient.accountInformation(address).do();
  const positions = { assets: {}, last_updated: new Date().toISOString() };
  const algoMicro = typeof info.amount === 'bigint' ? info.amount : BigInt(info.amount);
  positions.assets.ALGO = {
    amount_micro: Number(algoMicro),
    amount: Number(algoMicro) / 1_000_000
  };
  (info.assets || []).forEach((asset) => {
    const id = asset['asset-id'] ?? asset['assetId'];
    const amountMicro = typeof asset.amount === 'bigint' ? Number(asset.amount) : asset.amount;
    positions.assets[id] = {
      amount_micro: amountMicro
    };
  });
  fs.writeFileSync(POSITIONS_PATH, JSON.stringify(positions, null, 2));
}

function summarizeQuote(quote) {
  if (quote.type === 'direct') {
    return {
      assetInAmount: quote.data.quote.assetInAmount,
      assetOutAmount: quote.data.quote.assetOutAmount,
      rate: quote.data.quote.rate,
      priceImpact: quote.data.quote.priceImpact,
      swapFee: Number(quote.data.quote.swapFee || 0)
    };
  }
  const router = quote.data;
  return {
    assetInAmount: BigInt(router.input_amount),
    assetOutAmount: BigInt(router.output_amount),
    rate: Number(router.output_amount) / Number(router.input_amount),
    priceImpact: Number(router.price_impact),
    swapFee: Number(router.swap_fee_in_input_asset || 0)
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        const key = token.slice(2, eq);
        const value = token.slice(eq + 1);
        args[key] = value;
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
          args[key] = true;
        } else {
          args[key] = next;
          i += 1;
        }
      }
    }
  }
  return args;
}

function deriveAmountMicro({ amountMicro, amountAlgo, task, direction, assetIn }) {
  if (amountMicro !== undefined) {
    return BigInt(amountMicro);
  }
  if (amountAlgo !== undefined) {
    const decimals = typeof assetIn.decimals === 'number' ? assetIn.decimals : 6;
    const micro = Math.round(parseFloat(amountAlgo) * 10 ** decimals);
    return BigInt(micro);
  }
  if (direction === 'forward') {
    return BigInt(task.strategy.min_trade_amount_micro_algo);
  }
  throw new Error('amount_micro (or amount_algo) is required for reverse direction trades.');
}

function normalizeAsset(def) {
  return {
    id: Number(def.id),
    symbol: def.symbol,
    decimals: typeof def.decimals === 'number' ? def.decimals : 6
  };
}

function buildResult({ dryRun, task, direction, amountMicro, quoteSummary, assetIn, assetOut, txid }) {
  const amountOut = quoteSummary.assetOutAmount;
  const rate = Number(amountOut) / Number(quoteSummary.assetInAmount || amountMicro);
  return {
    dryRun,
    task_id: task.id,
    direction,
    asset_in: assetIn,
    asset_out: assetOut,
    amount_in_micro: amountMicro.toString(),
    amount_out_micro: amountOut.toString(),
    estimated_rate: rate,
    price_impact: quoteSummary.priceImpact,
    swap_fee_microalgo: quoteSummary.swapFee,
    txid: txid || null
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const options = {
    taskId: args.task,
    direction: args.direction,
    amountMicro: args.amount_micro,
    amountAlgo: args.amount_algo,
    slippageBps: args.slippage_bps ? Number(args.slippage_bps) : undefined,
    dryRun: Boolean(args.dry || args['dry-run']),
    quiet: Boolean(args.quiet)
  };
  await runSwap(options);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  runSwap,
  summarizeQuote,
  appendTradeLog
};
