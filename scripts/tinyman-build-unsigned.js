#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const algosdk = require('algosdk');
const {
  Swap,
  SwapType,
  AddLiquidity,
  poolUtils
} = require('@tinymanorg/tinyman-js-sdk');
const { resolveAlgodSettings } = require('../lib/algorand-network');

const ROOT = path.join(__dirname, '..');
const TASKS_DIR = path.join(ROOT, 'roles', 'trader', 'tasks');
const SECRETS_PATH = path.join(ROOT, 'secrets', 'algorand-account.json');
const OUTPUT_DIR = path.join(ROOT, 'transactions');

const USDC_WAD_TASK_PATH = path.join(TASKS_DIR, 'tinyman-usdc-wad.json');
const ALGO_WAD_TASK_PATH = path.join(TASKS_DIR, 'tinyman-algo-wad.json');

const USDC_DECIMALS = 6;
const WAD_DECIMALS = 6;
const ALGO_DECIMALS = 6;
const WAD_ASSET_ID = 3334160924;

const DEFAULTS = {
  swapAmountMicro: 40_000_000n,
  wadAmountMicro: 1_000_000n,
  liquidityAlgoMicro: null,
  slippageBps: 100,
  waitRounds: 20,
  includeSwap: true,
  includeLiquidity: true,
  mode: 'unsigned',
  submitSigned: true
};

async function main() {
  ensureFile(USDC_WAD_TASK_PATH, 'tinyman-usdc-wad.json');
  ensureFile(ALGO_WAD_TASK_PATH, 'tinyman-algo-wad.json');
  ensureFile(SECRETS_PATH, 'secrets/algorand-account.json');

  const cli = parseCliArgs(process.argv.slice(2));

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
  if (!secrets.address) {
    throw new Error('secrets/algorand-account.json is missing "address"');
  }
  if (cli.mode === 'sign' && !secrets.mnemonic) {
    throw new Error('secrets/algorand-account.json must include "mnemonic" for sign mode');
  }

  const initiatorAddr = secrets.address;
  const initiatorAccount = cli.mode === 'sign'
    ? algosdk.mnemonicToSecretKey(secrets.mnemonic)
    : null;

  const usdcTask = JSON.parse(fs.readFileSync(USDC_WAD_TASK_PATH, 'utf8'));
  const algoTask = JSON.parse(fs.readFileSync(ALGO_WAD_TASK_PATH, 'utf8'));
  const timestamp = new Date().toISOString();

  const operations = [];

  if (cli.includeSwap) {
    const swapBuild = await buildUsdcWadSwap({
      task: usdcTask,
      initiatorAddr,
      amountMicro: cli.swapAmountMicro,
      slippageBps: cli.slippageBps,
      timestamp
    });
    operations.push({
      label: `USDC→WAD swap (${formatUnits(cli.swapAmountMicro, USDC_DECIMALS)} USDC)` ,
      fileName: 'tinyman-usdc-wad-swap.json',
      metadata: swapBuild.metadata,
      txGroup: swapBuild.txGroup,
      algodClient: swapBuild.algodClient
    });
  }

  if (cli.includeLiquidity) {
    const liquidityBuild = await buildAlgoWadAddLiquidity({
      task: algoTask,
      initiatorAddr,
      wadAmountMicro: cli.wadAmountMicro,
      algoAmountOverride: cli.liquidityAlgoMicro,
      slippageBps: cli.slippageBps,
      timestamp
    });
    operations.push({
      label: `ALGO/WAD add-liquidity (${formatUnits(cli.wadAmountMicro, WAD_DECIMALS)} WAD)`,
      fileName: 'tinyman-algo-wad-add-liquidity.json',
      metadata: liquidityBuild.metadata,
      txGroup: liquidityBuild.txGroup,
      algodClient: liquidityBuild.algodClient
    });
  }

  if (!operations.length) {
    console.warn('No operations selected (use --swap/--liquidity flags). Nothing to do.');
    return;
  }

  if (cli.mode === 'unsigned') {
    operations.forEach((op) => {
      const targetPath = path.join(OUTPUT_DIR, op.fileName);
      fs.writeFileSync(targetPath, JSON.stringify(op.metadata, null, 2));
      console.log('Wrote unsigned bundle →', targetPath);
    });
    return;
  }

  for (const op of operations) {
    const signedGroup = signTxnGroup(op.txGroup, initiatorAccount);
    if (!cli.submitSigned) {
      console.log(`[dry-run] Signed ${op.label} (${signedGroup.length} txns)`);
      continue;
    }
    const submitRes = await op.algodClient.sendRawTransaction(signedGroup).do();
    const txId = submitRes.txId || submitRes.txid;
    console.log(`Submitted ${op.label}: ${txId}`);
    await waitForConfirmation(op.algodClient, txId, cli.waitRounds);
    console.log(`Confirmed ${op.label}: ${txId}`);
  }
}

async function buildUsdcWadSwap({ task, initiatorAddr, amountMicro, slippageBps, timestamp }) {
  const algodClient = createAlgodClient(task);
  const pool = await poolUtils.v2.getPoolInfo({
    network: task.network,
    client: algodClient,
    asset1ID: Math.min(task.pair.asset_in.id, task.pair.asset_out.id),
    asset2ID: Math.max(task.pair.asset_in.id, task.pair.asset_out.id)
  });

  const assetIn = {
    id: Number(task.pair.asset_in.id),
    decimals: task.pair.asset_in.decimals ?? USDC_DECIMALS
  };
  const assetOut = {
    id: Number(task.pair.asset_out.id),
    decimals: task.pair.asset_out.decimals ?? WAD_DECIMALS
  };
  const slippage = (slippageBps ?? 100) / 10_000;

  const quote = await Swap.v2.getQuote({
    type: SwapType.FixedInput,
    pool,
    amount: amountMicro,
    assetIn,
    assetOut,
    network: task.network,
    slippage
  });

  const txGroup = await Swap.v2.generateTxns({
    client: algodClient,
    network: task.network,
    quote,
    swapType: SwapType.FixedInput,
    slippage,
    initiatorAddr
  });

  return {
    algodClient,
    txGroup,
    metadata: {
      description: `Tinyman v2 USDC→WAD fixed-input swap (${formatUnits(amountMicro, USDC_DECIMALS)} USDC)` ,
      generated_at: timestamp,
      task_id: task.id,
      network: task.network,
      initiator: initiatorAddr,
      parameters: {
        amount_in_micro: amountMicro.toString(),
        slippage_bps: slippageBps,
        estimated_output_micro: quote.data?.output_amount ?? null,
        price_impact_pct: quote.data?.price_impact
          ? Number(quote.data.price_impact) * 100
          : null,
        swap_fee_micro_asset_in: quote.data?.swap_fee ?? null
      },
      transactions: formatTransactions(txGroup)
    }
  };
}

async function buildAlgoWadAddLiquidity({ task, initiatorAddr, wadAmountMicro, algoAmountOverride, slippageBps, timestamp }) {
  const algodClient = createAlgodClient(task);
  const pool = await poolUtils.v2.getPoolInfo({
    network: task.network,
    client: algodClient,
    asset1ID: Math.min(task.pair.asset_in.id, task.pair.asset_out.id),
    asset2ID: Math.max(task.pair.asset_in.id, task.pair.asset_out.id)
  });

  const { asset1Amount, asset2Amount, asset1Decimals, asset2Decimals, algoAmountMicro } =
    deriveAddLiquidityInputs({ pool, wadAmountMicro, algoAmountOverride });

  const slippage = (slippageBps ?? 100) / 10_000;

  const quote = AddLiquidity.v2.flexible.getQuote({
    pool,
    slippage,
    asset1: {
      id: Number(pool.asset1ID),
      decimals: asset1Decimals,
      amount: asset1Amount
    },
    asset2: {
      id: Number(pool.asset2ID),
      decimals: asset2Decimals,
      amount: asset2Amount
    }
  });

  const poolAddress = algosdk.encodeAddress(pool.account.address().publicKey);

  const txGroup = await AddLiquidity.v2.flexible.generateTxns({
    client: algodClient,
    network: task.network,
    poolAddress,
    asset1In: quote.asset1In,
    asset2In: quote.asset2In,
    poolTokenOut: quote.poolTokenOut,
    initiatorAddr,
    minPoolTokenAssetAmount: quote.minPoolTokenAssetAmountWithSlippage
  });

  return {
    algodClient,
    txGroup,
    metadata: {
      description: `Tinyman v2 ALGO/WAD add-liquidity (${formatUnits(wadAmountMicro, WAD_DECIMALS)} WAD + ${formatUnits(algoAmountMicro, ALGO_DECIMALS)} ALGO)`,
      generated_at: timestamp,
      task_id: task.id,
      network: task.network,
      initiator: initiatorAddr,
      parameters: {
        wad_in_micro: wadAmountMicro.toString(),
        algo_in_micro: quote.asset2In?.amount?.toString() ?? null,
        slippage_bps: slippageBps,
        expected_pool_token_out: quote.poolTokenOut?.amount?.toString() ?? null,
        estimated_share_pct: quote.share ? quote.share * 100 : null
      },
      transactions: formatTransactions(txGroup)
    }
  };
}

function deriveAddLiquidityInputs({ pool, wadAmountMicro, algoAmountOverride }) {
  const wadIsAsset1 = Number(pool.asset1ID) === WAD_ASSET_ID;
  const wadReserves = wadIsAsset1 ? pool.asset1Reserves : pool.asset2Reserves;
  const algoReserves = wadIsAsset1 ? pool.asset2Reserves : pool.asset1Reserves;

  if (!wadReserves || !algoReserves) {
    throw new Error('Pool reserves missing; cannot derive add-liquidity ratio.');
  }

  const computedAlgoAmount = wadAmountMicro * BigInt(algoReserves) / BigInt(wadReserves);
  const algoAmountMicro = algoAmountOverride ?? computedAlgoAmount;

  return {
    asset1Amount: wadIsAsset1 ? wadAmountMicro : algoAmountMicro,
    asset2Amount: wadIsAsset1 ? algoAmountMicro : wadAmountMicro,
    asset1Decimals: wadIsAsset1 ? WAD_DECIMALS : ALGO_DECIMALS,
    asset2Decimals: wadIsAsset1 ? ALGO_DECIMALS : WAD_DECIMALS,
    algoAmountMicro
  };
}

function createAlgodClient(task) {
  const settings = resolveAlgodSettings(task);
  return new algosdk.Algodv2(settings.token || '', settings.url, settings.port || '', settings.headers || {});
}

function signTxnGroup(txGroup, account) {
  return txGroup.map(({ txn }) => txn.signTxn(account.sk));
}

async function waitForConfirmation(client, txId, waitRounds) {
  await algosdk.waitForConfirmation(client, txId, waitRounds ?? DEFAULTS.waitRounds);
}

function formatTransactions(txGroup) {
  return txGroup.map(({ txn, signers }, index) => {
    const base64 = Buffer.from(txn.toByte()).toString('base64');
    const sender = encodeAddrSafe(txn.from);
    const receiver = txn.to ? encodeAddrSafe(txn.to) : undefined;
    const closeRemainderTo = txn.closeRemainderTo ? encodeAddrSafe(txn.closeRemainderTo) : undefined;
    const amount = txn.amount !== undefined ? txn.amount.toString() : undefined;
    const assetIndex = txn.assetIndex !== undefined ? Number(txn.assetIndex) : undefined;
    const appId = txn.appIndex !== undefined ? Number(txn.appIndex) : undefined;
    const appArgs = txn.appArgs ? txn.appArgs.map((arg) => Buffer.from(arg).toString('base64')) : undefined;
    const accounts = txn.appAccounts ? txn.appAccounts.map((acct) => encodeAddrSafe(acct)) : undefined;
    const foreignApps = txn.foreignApps ? txn.foreignApps.map((id) => Number(id)) : undefined;
    const foreignAssets = txn.foreignAssets ? txn.foreignAssets.map((id) => Number(id)) : undefined;

    return {
      index,
      type: txn.type,
      sender,
      receiver,
      close_remainder_to: closeRemainderTo,
      fee: txn.fee !== undefined ? Number(txn.fee) : undefined,
      first_valid: txn.firstRound !== undefined ? Number(txn.firstRound) : undefined,
      last_valid: txn.lastRound !== undefined ? Number(txn.lastRound) : undefined,
      amount,
      asset_id: assetIndex,
      app_id: appId,
      app_args_base64: appArgs,
      app_accounts: accounts,
      foreign_apps: foreignApps,
      foreign_assets: foreignAssets,
      note_base64: txn.note ? Buffer.from(txn.note).toString('base64') : undefined,
      group: txn.group ? Buffer.from(txn.group).toString('base64') : undefined,
      lease: txn.lease ? Buffer.from(txn.lease).toString('base64') : undefined,
      signers: signers && signers.length ? signers : undefined,
      base64
    };
  });
}

function encodeAddrSafe(value) {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (value.publicKey) {
    return algosdk.encodeAddress(value.publicKey);
  }
  return undefined;
}

function ensureFile(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Missing required file: ${label}`);
  }
}

function parseCliArgs(argv) {
  const options = { ...DEFAULTS };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [rawKey, rawValueFromEquals] = token.slice(2).split('=');
    const key = rawKey;
    const hasInline = rawValueFromEquals !== undefined;
    const rawValue = hasInline ? rawValueFromEquals : argv[i + 1];
    if (!hasInline && rawValue === undefined) {
      throw new Error(`Flag --${key} is missing a value`);
    }
    if (!hasInline) {
      i += 1;
    }

    switch (key) {
      case 'mode':
        options.mode = String(rawValue).toLowerCase();
        break;
      case 'swap':
        options.includeSwap = toBoolean(rawValue);
        break;
      case 'liquidity':
        options.includeLiquidity = toBoolean(rawValue);
        break;
      case 'swap-usdc-micro':
        options.swapAmountMicro = BigInt(rawValue);
        break;
      case 'liquidity-wad-micro':
        options.wadAmountMicro = BigInt(rawValue);
        break;
      case 'liquidity-algo-micro':
        options.liquidityAlgoMicro = BigInt(rawValue);
        break;
      case 'slippage-bps':
        options.slippageBps = Number(rawValue);
        break;
      case 'wait-rounds':
        options.waitRounds = Number(rawValue);
        break;
      case 'submit':
        options.submitSigned = toBoolean(rawValue);
        break;
      default:
        console.warn(`Unknown flag --${key} (ignored)`);
    }
  }

  return options;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  const lowered = String(value).toLowerCase();
  if (lowered === 'true' || lowered === '1') return true;
  if (lowered === 'false' || lowered === '0') return false;
  throw new Error(`Cannot convert "${value}" to boolean`);
}

function formatUnits(amountMicro, decimals) {
  const factor = 10 ** decimals;
  return Number(amountMicro) / factor;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
