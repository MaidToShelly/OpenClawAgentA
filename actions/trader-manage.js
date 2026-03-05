#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const algosdk = require('algosdk');
const { poolUtils, Swap, SwapType } = require('@tinymanorg/tinyman-js-sdk');
const { runSwap, summarizeQuote } = require('./trader-swap');

const ROOT = path.join(__dirname, '..');
const TASKS_DIR = path.join(ROOT, 'roles', 'trader', 'tasks');
const STATE_PATH = path.join(ROOT, 'portfolio', 'trader-state.json');
const PAUSE_FLAG_PATH = path.join(ROOT, '.trader-paused');
const TRADES_PATH = path.join(ROOT, 'portfolio', 'trades.json');
const SECRETS_PATH = path.join(ROOT, 'secrets', 'algorand-account.json');
const ALGOD_URL = 'https://mainnet-api.algonode.cloud';
const DEFAULT_TASK_ID = 'tinyman-algo-wad';
const POSITION_DUST = 1_000n; // 0.001 units (micro)

async function main() {
  const args = parseArgs(process.argv);
  const taskId = args.task || DEFAULT_TASK_ID;
  const dryRun = Boolean(args.dry || args['dry-run']);
  const forceOpen = Boolean(args['force-open']);
  const forceClose = Boolean(args['force-close']);
  const verbose = Boolean(args.verbose);
  const ignorePause = Boolean(args['ignore-pause']);

  if (fs.existsSync(PAUSE_FLAG_PATH) && !ignorePause) {
    const msg = `[paused] ${PAUSE_FLAG_PATH} exists — skipping trader run.`;
    if (verbose || dryRun) {
      console.log(msg);
    } else {
      console.log('Trader manager paused (remove .trader-paused to resume).');
    }
    return;
  }

  const secrets = requireJson(SECRETS_PATH, 'Algorand secrets file');
  if (!secrets.mnemonic) {
    throw new Error('Mnemonic missing in secrets/algorand-account.json');
  }
  const account = algosdk.mnemonicToSecretKey(secrets.mnemonic);
  const algodClient = new algosdk.Algodv2('', ALGOD_URL, '');

  const task = loadTask(taskId);
  const state = loadState(taskId);

  const assetIn = normalizeAsset(task.pair.asset_in);
  const assetOut = normalizeAsset(task.pair.asset_out);

  const pool = await poolUtils.v2.getPoolInfo({
    network: task.network,
    client: algodClient,
    asset1ID: Number(task.pair.asset_out.id),
    asset2ID: Number(task.pair.asset_in.id)
  });

  const priceQuote = await Swap.v2.getQuote({
    type: SwapType.FixedInput,
    pool,
    amount: BigInt(1_000_000),
    assetIn,
    assetOut,
    network: task.network,
    slippage: 0.0
  });
  const priceSummary = summarizeQuote(priceQuote);
  const markPrice = Number(priceSummary.assetOutAmount) / Number(priceSummary.assetInAmount);

  const accountInfo = await algodClient.accountInformation(account.addr).do();
  const holdings = extractHoldings({ info: accountInfo, assetOutId: assetOut.id });
  const hasPosition = holdings.assetOutMicro > POSITION_DUST;

  const now = new Date();
  const updates = [];
  const actions = [];

  if (hasPosition && !state.position.open) {
    const bootstrap = bootstrapEntry(taskId, `${assetIn.symbol || assetIn.id}->${assetOut.symbol || assetOut.id}`);
    if (bootstrap) {
      state.position = { ...state.position, ...bootstrap, open: true };
      updates.push('Bootstrapped open position from trade log');
    } else {
      state.position.open = true;
    }
  } else if (!hasPosition && state.position.open) {
    state.position.open = false;
    state.position.entry_price = null;
    state.position.entry_timestamp = null;
    state.position.entry_txid = null;
  }

  const exitRule = task.strategy.exit_rule || {};
  const reentryRule = task.strategy.reentry_rule || {};

  if (hasPosition) {
    const entryPrice = state.position.entry_price;
    const profitTarget = exitRule.take_profit_pct;
    let profitPct = null;
    if (entryPrice) {
      profitPct = ((markPrice / entryPrice) - 1) * 100;
    }
    const shouldTakeProfit = typeof profitTarget === 'number' && profitPct !== null && profitPct >= profitTarget;

    if (forceClose || shouldTakeProfit) {
      if (holdings.assetOutMicro <= POSITION_DUST) {
        actions.push('Skip close: position size under dust threshold');
      } else if (dryRun) {
        actions.push(`DRY RUN: would close position (${holdings.assetOutMicro} micro ${assetOut.symbol}) reason=${forceClose ? 'force' : 'take_profit'}`);
      } else {
        const closeResult = await runSwap({
          taskId,
          direction: 'reverse',
          amountMicro: holdings.assetOutMicro.toString(),
          slippageBps: task.strategy.slippage_tolerance_bps,
          dryRun: false
        });
        actions.push(`Closed position via tx ${closeResult.txid}`);
        state.position = {
          open: false,
          entry_price: null,
          entry_timestamp: null,
          entry_amount_in_micro: null,
          entry_amount_out_micro: null,
          entry_txid: null
        };
        state.last_exit = {
          timestamp: now.toISOString(),
          price: markPrice,
          reason: forceClose ? 'manual' : 'take_profit',
          txid: closeResult.txid,
          amount_in_micro: closeResult.amount_in_micro,
          amount_out_micro: closeResult.amount_out_micro
        };
      }
    } else {
      actions.push('Holding position (no exit conditions met)');
    }
  } else {
    const readyToOpen = shouldReenter({ state, reentryRule, markPrice, now, forceOpen });
    const minTrade = BigInt(task.strategy.min_trade_amount_micro_algo);
    if (readyToOpen) {
      if (holdings.algoSpendable <= minTrade) {
        actions.push('Skip open: insufficient spendable ALGO');
      } else if (dryRun) {
        actions.push(`DRY RUN: would open position with ${minTrade} micro ALGO`);
      } else {
        const openResult = await runSwap({
          taskId,
          direction: 'forward',
          amountMicro: minTrade.toString(),
          slippageBps: task.strategy.slippage_tolerance_bps,
          dryRun: false
        });
        actions.push(`Opened position via tx ${openResult.txid}`);
        const entryPrice = Number(openResult.amount_out_micro) / Number(openResult.amount_in_micro);
        state.position = {
          open: true,
          entry_price: entryPrice,
          entry_timestamp: now.toISOString(),
          entry_amount_in_micro: openResult.amount_in_micro,
          entry_amount_out_micro: openResult.amount_out_micro,
          entry_txid: openResult.txid
        };
      }
    } else {
      actions.push('No re-entry signal yet');
    }
  }

  state.last_check = now.toISOString();
  state.last_mark_price = markPrice;
  saveState(state);

  const summary = [
    `Trader manager @ ${now.toISOString()}`,
    `- Mark price (WAD/ALGO): ${markPrice.toFixed(6)}`,
    `- Holdings: ${Number(holdings.algoTotal) / 1_000_000} ALGO / ${Number(holdings.assetOutMicro) / 1_000_000} ${assetOut.symbol}`,
    `- Position open: ${state.position.open ? 'yes' : 'no'}`,
    ...updates.map((u) => `- ${u}`),
    ...actions.map((a) => `- ${a}`)
  ].join('\n');

  if (verbose || dryRun) {
    console.log(summary);
  } else {
    console.log(actions.join('\n'));
  }
}

function loadTask(taskId) {
  const taskPath = path.join(TASKS_DIR, `${taskId}.json`);
  if (!fs.existsSync(taskPath)) {
    throw new Error(`Task config not found at ${taskPath}`);
  }
  return JSON.parse(fs.readFileSync(taskPath, 'utf8'));
}

function loadState(taskId) {
  if (!fs.existsSync(STATE_PATH)) {
    return {
      task_id: taskId,
      position: { open: false },
      last_exit: null,
      last_check: null,
      last_mark_price: null
    };
  }
  const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  if (!data.task_id || data.task_id !== taskId) {
    data.task_id = taskId;
  }
  data.position = data.position || { open: false };
  return data;
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function extractHoldings({ info, assetOutId }) {
  const algoTotal = BigInt(info.amount);
  const minBalance = BigInt(info['min-balance'] || 0);
  const spendable = algoTotal > minBalance ? algoTotal - minBalance : 0n;
  const assetOutMicro = BigInt(
    ((info.assets || []).find((a) => Number((a['asset-id'] ?? a['assetId'])) === Number(assetOutId))?.amount) || 0
  );
  return {
    algoTotal,
    algoSpendable: spendable,
    assetOutMicro
  };
}

function bootstrapEntry(taskId, direction) {
  if (!fs.existsSync(TRADES_PATH)) return null;
  const trades = JSON.parse(fs.readFileSync(TRADES_PATH, 'utf8'))?.trades || [];
  const last = [...trades].reverse().find((t) => t.task_id === taskId && t.direction === direction);
  if (!last) return null;
  const price = Number(last.output.amount_micro) / Number(last.input.amount_micro);
  return {
    entry_price: price,
    entry_timestamp: last.timestamp,
    entry_amount_in_micro: last.input.amount_micro,
    entry_amount_out_micro: last.output.amount_micro,
    entry_txid: last.txid
  };
}

function shouldReenter({ state, reentryRule, markPrice, now, forceOpen }) {
  if (forceOpen) return true;
  if (!state.last_exit) return true;
  const exitTime = state.last_exit.timestamp ? new Date(state.last_exit.timestamp) : null;
  const sinceExitMinutes = exitTime ? (now - exitTime) / (1000 * 60) : null;
  const graceMinutes = reentryRule.grace_period_minutes || 60;
  const forcedHours = reentryRule.forced_reopen_after_hours || 24;
  const minDrawdown = reentryRule.min_drawdown_percent || 0;
  if (sinceExitMinutes !== null && sinceExitMinutes >= forcedHours * 60) {
    return true;
  }
  if (sinceExitMinutes === null || sinceExitMinutes < graceMinutes) {
    return false;
  }
  if (!state.last_exit.price) return false;
  const drawdownPct = ((state.last_exit.price - markPrice) / state.last_exit.price) * 100;
  return drawdownPct >= minDrawdown;
}

function normalizeAsset(def) {
  return {
    id: Number(def.id),
    symbol: def.symbol || String(def.id),
    decimals: typeof def.decimals === 'number' ? def.decimals : 6
  };
}

function requireJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} missing at ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8') || '{}';
  return JSON.parse(raw);
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
