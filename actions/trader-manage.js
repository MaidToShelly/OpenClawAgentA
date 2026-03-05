#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const algosdk = require('algosdk');
const { poolUtils, Swap, SwapType } = require('@tinymanorg/tinyman-js-sdk');
const { runSwap, summarizeQuote, appendTradeLog } = require('./trader-swap');

const ROOT = path.join(__dirname, '..');
const TASKS_DIR = path.join(ROOT, 'roles', 'trader', 'tasks');
const STATE_DIR = path.join(ROOT, 'portfolio');
const DEFAULT_STATE_PATH = path.join(STATE_DIR, 'trader-state.json');
const PAUSE_FLAG_PATH = path.join(ROOT, '.trader-paused');
const TRADES_PATH = path.join(ROOT, 'portfolio', 'trades.json');
const SECRETS_PATH = path.join(ROOT, 'secrets', 'algorand-account.json');
const ALGOD_URL = 'https://mainnet-api.algonode.cloud';
const DEFAULT_TASK_ID = 'tinyman-algo-wad';
const POSITION_DUST = 1_000n; // 0.001 units (micro)
const PAPER_DUST = 1_000n;

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
  const executionMode = (task.execution_mode || 'live').toLowerCase();
  const isPaper = executionMode !== 'live';
  const statePath = resolveStatePath(taskId, executionMode);
  const state = loadState(statePath, taskId, executionMode);

  const assetIn = normalizeAsset(task.pair.asset_in);
  const assetOut = normalizeAsset(task.pair.asset_out);

  const pool = await poolUtils.v2.getPoolInfo({
    network: task.network,
    client: algodClient,
    asset1ID: Math.min(Number(task.pair.asset_in.id), Number(task.pair.asset_out.id)),
    asset2ID: Math.max(Number(task.pair.asset_in.id), Number(task.pair.asset_out.id))
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
  const holdings = isPaper
    ? extractPaperHoldings(state)
    : extractHoldings({ info: accountInfo, assetOutId: assetOut.id });
  const hasPosition = isPaper
    ? holdings.assetOutMicro > PAPER_DUST
    : holdings.assetOutMicro > POSITION_DUST;

  if (isPaper) {
    state.position.open = holdings.assetOutMicro > PAPER_DUST;
  }

  if (hasPosition && !state.position.open && !isPaper) {
    const bootstrap = bootstrapEntry(taskId, `${assetIn.symbol || assetIn.id}->${assetOut.symbol || assetOut.id}`);
    if (bootstrap) {
      state.position = { ...state.position, ...bootstrap, open: true };
    } else {
      state.position.open = true;
    }
  } else if (!hasPosition && state.position.open) {
    state.position.open = false;
    state.position.entry_price = null;
    state.position.entry_timestamp = null;
    state.position.entry_txid = null;
  }

  const now = new Date();
  const updates = [];
  const actions = [];

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
      const dustThreshold = isPaper ? PAPER_DUST : POSITION_DUST;
      if (holdings.assetOutMicro <= dustThreshold) {
        actions.push('Skip close: position size under dust threshold');
      } else if (dryRun) {
        actions.push(`DRY RUN: would close ${holdings.assetOutMicro.toString()} micro ${assetOut.symbol}`);
      } else if (isPaper) {
        await closePaperPosition({
          state,
          statePath,
          task,
          taskId,
          markPrice,
          holdings,
          now,
          executionMode,
          pool,
          algodClient,
          assetIn,
          assetOut,
          actions
        });
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
      actions.push(isPaper ? '[paper] Holding position (no exit conditions met)' : 'Holding position (no exit conditions met)');
    }
  } else {
    const readyToOpen = shouldReenter({ state, reentryRule, markPrice, now, forceOpen });
    const minTrade = BigInt(task.strategy.min_trade_amount_micro_algo);
    if (readyToOpen) {
      if (!isPaper && holdings.algoSpendable <= minTrade) {
        actions.push('Skip open: insufficient spendable ALGO');
      } else if (dryRun) {
        actions.push(`DRY RUN: would open position with ${minTrade} micro ALGO`);
      } else if (isPaper) {
        await openPaperPosition({
          state,
          statePath,
          task,
          taskId,
          now,
          executionMode,
          pool,
          algodClient,
          assetIn,
          assetOut,
          amountMicro: minTrade,
          actions
        });
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
      actions.push(isPaper ? '[paper] No re-entry signal yet' : 'No re-entry signal yet');
    }
  }

  state.last_check = now.toISOString();
  state.last_mark_price = markPrice;
  saveState(statePath, state);

  const summaryLines = [
    `Trader manager (${executionMode}) @ ${now.toISOString()}`
  ];
  if (isPaper) {
    const paper = state.paper || { asset_out_micro: 0, algo_spent_micro: 0, algo_realized_micro: 0 };
    const virtualAlgo = (paper.algo_realized_micro || 0) - (paper.algo_spent_micro || 0);
    summaryLines.push(
      `- Virtual ALGO PnL: ${(virtualAlgo / 1_000_000).toFixed(6)} (spent ${(paper.algo_spent_micro || 0) / 1_000_000}, realized ${(paper.algo_realized_micro || 0) / 1_000_000})`
    );
    summaryLines.push(`- Simulated holdings: ${(paper.asset_out_micro || 0) / 1_000_000} ${assetOut.symbol}`);
  } else {
    summaryLines.push(`- Holdings: ${Number(holdings.algoTotal) / 1_000_000} ALGO / ${Number(holdings.assetOutMicro) / 1_000_000} ${assetOut.symbol}`);
  }
  summaryLines.push(`- Position open: ${state.position.open ? 'yes' : 'no'}`);
  updates.forEach((u) => summaryLines.push(`- ${u}`));
  actions.forEach((a) => summaryLines.push(`- ${a}`));

  const summary = summaryLines.join('\n');
  if (verbose || dryRun) {
    console.log(summary);
  } else {
    console.log(actions.join('\n'));
  }
}

async function openPaperPosition({
  state,
  statePath,
  task,
  taskId,
  now,
  executionMode,
  pool,
  algodClient,
  assetIn,
  assetOut,
  amountMicro,
  actions
}) {
  state.paper = state.paper || { asset_out_micro: 0, algo_spent_micro: 0, algo_realized_micro: 0 };
  const slippage = task.strategy.slippage_tolerance_bps;
  const quote = await getSwapQuote({
    direction: 'forward',
    pool,
    task,
    amountMicro,
    slippageBps: slippage
  });
  state.paper.asset_out_micro += Number(quote.quoteSummary.assetOutAmount);
  state.paper.algo_spent_micro += Number(amountMicro);
  state.position = {
    open: true,
    entry_price: Number(quote.quoteSummary.assetOutAmount) / Number(amountMicro),
    entry_timestamp: now.toISOString(),
    entry_amount_in_micro: amountMicro.toString(),
    entry_amount_out_micro: quote.quoteSummary.assetOutAmount.toString(),
    entry_txid: `[paper-open-${Date.now()}]`
  };
  await appendTradeLog({
    task,
    quoteSummary: quote.quoteSummary,
    amountMicro,
    assetIn,
    assetOut,
    options: {
      paper: true,
      executionMode,
      txidOverride: state.position.entry_txid,
      timestamp: now.toISOString()
    }
  });
  saveState(statePath, state);
  actions.push('[paper] Opened virtual position');
}

async function closePaperPosition({
  state,
  statePath,
  task,
  taskId,
  markPrice,
  holdings,
  now,
  executionMode,
  pool,
  algodClient,
  assetIn,
  assetOut,
  actions
}) {
  state.paper = state.paper || { asset_out_micro: 0, algo_spent_micro: 0, algo_realized_micro: 0 };
  const amountMicro = holdings.assetOutMicro;
  if (amountMicro <= PAPER_DUST) {
    actions.push('[paper] Skip close: simulated position too small');
    return;
  }
  const quote = await getSwapQuote({
    direction: 'reverse',
    pool,
    task,
    amountMicro,
    slippageBps: task.strategy.slippage_tolerance_bps
  });
  state.paper.asset_out_micro = Math.max(0, state.paper.asset_out_micro - Number(amountMicro));
  state.paper.algo_realized_micro += Number(quote.quoteSummary.assetOutAmount);
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
    reason: 'paper_take_profit',
    txid: `[paper-close-${Date.now()}]`,
    amount_in_micro: amountMicro.toString(),
    amount_out_micro: quote.quoteSummary.assetOutAmount.toString()
  };
  await appendTradeLog({
    task,
    quoteSummary: quote.quoteSummary,
    amountMicro,
    assetIn: assetOut,
    assetOut: assetIn,
    options: {
      paper: true,
      executionMode,
      txidOverride: state.last_exit.txid,
      timestamp: now.toISOString()
    }
  });
  saveState(statePath, state);
  actions.push('[paper] Closed virtual position');
}

async function getSwapQuote({ direction, pool, task, amountMicro, slippageBps }) {
  const normalizedDirection = direction === 'reverse' ? 'reverse' : 'forward';
  const assetInDef = normalizedDirection === 'forward' ? task.pair.asset_in : task.pair.asset_out;
  const assetOutDef = normalizedDirection === 'forward' ? task.pair.asset_out : task.pair.asset_in;
  const assetIn = normalizeAsset(assetInDef);
  const assetOut = normalizeAsset(assetOutDef);
  const slippage = (typeof slippageBps === 'number' ? slippageBps : (task.strategy.slippage_tolerance_bps || 100)) / 10_000;
  const quote = await Swap.v2.getQuote({
    type: SwapType.FixedInput,
    pool,
    amount: BigInt(amountMicro),
    assetIn,
    assetOut,
    network: task.network,
    slippage
  });
  return { quoteSummary: summarizeQuote(quote), assetIn, assetOut };
}

function loadTask(taskId) {
  const taskPath = path.join(TASKS_DIR, `${taskId}.json`);
  if (!fs.existsSync(taskPath)) {
    throw new Error(`Task config not found at ${taskPath}`);
  }
  return JSON.parse(fs.readFileSync(taskPath, 'utf8'));
}

function resolveStatePath(taskId, executionMode) {
  if (taskId === DEFAULT_TASK_ID && executionMode === 'live') {
    return DEFAULT_STATE_PATH;
  }
  const safeMode = executionMode.replace(/[^a-z0-9_-]/gi, '') || 'mode';
  return path.join(STATE_DIR, `${taskId}-${safeMode}-state.json`);
}

function loadState(statePath, taskId, executionMode) {
  if (!fs.existsSync(statePath)) {
    return {
      task_id: taskId,
      execution_mode: executionMode,
      position: { open: false },
      last_exit: null,
      last_check: null,
      last_mark_price: null
    };
  }
  const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  data.task_id = data.task_id || taskId;
  data.execution_mode = executionMode;
  data.position = data.position || { open: false };
  return data;
}

function saveState(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
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

function extractPaperHoldings(state) {
  const paper = state.paper || { asset_out_micro: 0, algo_spent_micro: 0, algo_realized_micro: 0 };
  return {
    algoTotal: BigInt((paper.algo_realized_micro || 0) - (paper.algo_spent_micro || 0)),
    algoSpendable: 0n,
    assetOutMicro: BigInt(paper.asset_out_micro || 0)
  };
}

function bootstrapEntry(taskId, direction) {
  if (!fs.existsSync(TRADES_PATH)) return null;
  const trades = JSON.parse(fs.readFileSync(TRADES_PATH, 'utf8'))?.trades || [];
  const last = [...trades].reverse().find((t) => t.task_id === taskId && t.direction === direction && !t.paper);
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
