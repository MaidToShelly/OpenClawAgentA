#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const algosdk = require('algosdk');
const { poolUtils, Swap, SwapType } = require('@tinymanorg/tinyman-js-sdk');
const { runSwap, summarizeQuote } = require('./trader-swap');
const { resolveWalletNamespace, resolveAlgodSettings } = require('../lib/algorand-network');
const {
  normalizeBalances, resolveStatePath, loadState, saveState,
  extractHoldings, extractPaperHoldings, bootstrapEntry,
  loadTask, normalizeAsset,
  POSITION_DUST, PAPER_DUST, DEFAULT_TASK_ID,
} = require('../lib/trader-state');
const {
  loadVirtualWallet, syncVirtualWallet,
  updateVirtualWalletBalance, formatWalletSummary,
} = require('../lib/virtual-wallet');
const {
  shouldReenter, resolveMinTradeAmount,
  openPaperPosition, closePaperPosition,
} = require('../lib/trader-strategy');

const ROOT = path.join(__dirname, '..');
const PAUSE_FLAG_PATH = path.join(ROOT, '.trader-paused');
const SECRETS_PATH = path.join(ROOT, 'secrets', 'algorand-account.json');

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

  const task = loadTask(taskId);
  const algodSettings = resolveAlgodSettings(task);
  const algodClient = new algosdk.Algodv2(
    algodSettings.token || '',
    algodSettings.url,
    algodSettings.port || '',
    algodSettings.headers || {}
  );
  const executionMode = (task.execution_mode || 'live').toLowerCase();
  const isPaper = executionMode !== 'live';
  const statePath = resolveStatePath(taskId, executionMode);
  const state = loadState(statePath, taskId, executionMode);

  const assetIn = normalizeAsset(task.pair.asset_in);
  const assetOut = normalizeAsset(task.pair.asset_out);
  const walletNetwork = resolveWalletNamespace(task);
  const walletHandle = task.virtual_wallet_id
    ? loadVirtualWallet(task.virtual_wallet_id, walletNetwork, assetIn, assetOut)
    : null;
  const preflightWarnings = [];

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
    : extractHoldings({ info: accountInfo, assetInId: assetIn.id, assetOutId: assetOut.id });
  const virtualScoped = Boolean(walletHandle);
  let ledgerAssetOutMicro = BigInt(state.balances?.asset_out_micro || 0);
  if (virtualScoped && ledgerAssetOutMicro > holdings.assetOutMicro && !isPaper) {
    preflightWarnings.push(`[warn] Task ledger for ${taskId} exceeded on-chain balance; clamping from ${ledgerAssetOutMicro.toString()} to ${holdings.assetOutMicro.toString()} micro ${assetOut.symbol}`);
    ledgerAssetOutMicro = holdings.assetOutMicro;
    state.balances.asset_out_micro = Number(ledgerAssetOutMicro);
  }
  const dustThreshold = isPaper ? PAPER_DUST : POSITION_DUST;
  const actualHasPosition = holdings.assetOutMicro > dustThreshold;
  const ledgerHasPosition = ledgerAssetOutMicro > dustThreshold;
  const hasPosition = isPaper
    ? actualHasPosition
    : virtualScoped
      ? ledgerHasPosition
      : actualHasPosition;

  if (isPaper) {
    state.position.open = actualHasPosition;
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

  if (walletHandle) {
    syncVirtualWallet(walletHandle, assetIn, assetOut, state.balances);
  }

  const now = new Date();
  const updates = [];
  const actions = [];
  actions.push(...preflightWarnings);

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
      let closeMicro = virtualScoped ? ledgerAssetOutMicro : holdings.assetOutMicro;
      if (!isPaper && closeMicro > holdings.assetOutMicro) {
        actions.push(`[warn] Virtual ledger exceeds on-chain ${assetOut.symbol}; clamping close size to available balance`);
        closeMicro = holdings.assetOutMicro;
      }
      if (closeMicro <= dustThreshold) {
        actions.push('Skip close: position size under dust threshold');
      } else if (dryRun) {
        actions.push(`DRY RUN: would close ${closeMicro.toString()} micro ${assetOut.symbol}`);
      } else if (isPaper) {
        await closePaperPosition({
          state, statePath, task, taskId, markPrice, holdings, now,
          executionMode, pool, algodClient, assetIn, assetOut, actions, walletHandle
        });
      } else {
        const closeResult = await runSwap({
          taskId, direction: 'reverse',
          amountMicro: closeMicro.toString(),
          slippageBps: task.strategy.slippage_tolerance_bps,
          dryRun: false
        });
        actions.push(`Closed position via tx ${closeResult.txid}`);
        state.position = {
          open: false, entry_price: null, entry_timestamp: null,
          entry_amount_in_micro: null, entry_amount_out_micro: null, entry_txid: null
        };
        state.last_exit = {
          timestamp: now.toISOString(), price: markPrice,
          reason: forceClose ? 'manual' : 'take_profit',
          txid: closeResult.txid,
          amount_in_micro: closeResult.amount_in_micro,
          amount_out_micro: closeResult.amount_out_micro
        };
        state.balances = normalizeBalances(state.balances);
        const closeAmount = Number(closeMicro);
        state.balances.asset_out_micro = Math.max(0, state.balances.asset_out_micro - closeAmount);
        state.balances.algo_realized_micro += Number(closeResult.amount_out_micro);
        updateVirtualWalletBalance(walletHandle, assetOut, -closeAmount);
        updateVirtualWalletBalance(walletHandle, assetIn, Number(closeResult.amount_out_micro));
      }
    } else {
      actions.push(isPaper ? '[paper] Holding position (no exit conditions met)' : 'Holding position (no exit conditions met)');
    }
  } else {
    const readyToOpen = shouldReenter({ state, reentryRule, markPrice, now, forceOpen });
    const minTrade = resolveMinTradeAmount(task.strategy, assetIn);
    if (readyToOpen) {
      if (!isPaper && holdings.assetInMicro <= minTrade) {
        actions.push(`Skip open: insufficient spendable ${assetIn.symbol}`);
      } else if (dryRun) {
        actions.push(`DRY RUN: would open position with ${minTrade} micro ${assetIn.symbol}`);
      } else if (isPaper) {
        await openPaperPosition({
          state, statePath, task, taskId, now, executionMode,
          pool, algodClient, assetIn, assetOut, amountMicro: minTrade, actions, walletHandle
        });
      } else {
        const openResult = await runSwap({
          taskId, direction: 'forward',
          amountMicro: minTrade.toString(),
          slippageBps: task.strategy.slippage_tolerance_bps,
          dryRun: false
        });
        actions.push(`Opened position via tx ${openResult.txid}`);
        const entryPrice = Number(openResult.amount_out_micro) / Number(openResult.amount_in_micro);
        state.position = {
          open: true, entry_price: entryPrice,
          entry_timestamp: now.toISOString(),
          entry_amount_in_micro: openResult.amount_in_micro,
          entry_amount_out_micro: openResult.amount_out_micro,
          entry_txid: openResult.txid
        };
        state.balances = normalizeBalances(state.balances);
        state.balances.asset_out_micro += Number(openResult.amount_out_micro);
        state.balances.algo_spent_micro += Number(openResult.amount_in_micro);
        updateVirtualWalletBalance(walletHandle, assetIn, -Number(openResult.amount_in_micro));
        updateVirtualWalletBalance(walletHandle, assetOut, Number(openResult.amount_out_micro));
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
  const ledger = normalizeBalances(state.balances);
  if (isPaper) {
    const virtualAlgo = ledger.algo_realized_micro - ledger.algo_spent_micro;
    summaryLines.push(
      `- Virtual ALGO PnL: ${(virtualAlgo / 1_000_000).toFixed(6)} (spent ${(ledger.algo_spent_micro / 1_000_000).toFixed(6)}, realized ${(ledger.algo_realized_micro / 1_000_000).toFixed(6)})`
    );
    summaryLines.push(`- Simulated holdings: ${(ledger.asset_out_micro / 1_000_000).toFixed(6)} ${assetOut.symbol}`);
  } else {
    summaryLines.push(`- Holdings: ${Number(holdings.algoTotal) / 1_000_000} ALGO / ${Number(holdings.assetOutMicro) / 1_000_000} ${assetOut.symbol}`);
    summaryLines.push(
      `- Task ledger: spent ${(ledger.algo_spent_micro / 1_000_000).toFixed(6)} ALGO, realized ${(ledger.algo_realized_micro / 1_000_000).toFixed(6)} ALGO, outstanding ${(ledger.asset_out_micro / 1_000_000).toFixed(6)} ${assetOut.symbol}`
    );
  }
  if (walletHandle) {
    summaryLines.push(
      `- ${isPaper ? 'Virtual wallet' : 'Task wallet'}: ${formatWalletSummary(walletHandle, assetIn, assetOut)}`
    );
  } else {
    const walletLabel = isPaper ? 'Virtual wallet' : 'Task wallet';
    const initialWallet = Number(state.wallet?.initial_algo_micro || 0);
    const availableWallet = initialWallet - (ledger.algo_spent_micro - ledger.algo_realized_micro);
    summaryLines.push(
      `- ${walletLabel}: start ${(initialWallet / 1_000_000).toFixed(6)} ALGO, available ${(availableWallet / 1_000_000).toFixed(6)} ALGO`
    );
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
