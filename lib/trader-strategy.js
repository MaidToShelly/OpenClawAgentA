const { Swap, SwapType } = require('@tinymanorg/tinyman-js-sdk');
const { summarizeQuote, appendTradeLog } = require('../actions/trader-swap');
const { normalizeBalances, saveState, normalizeAsset, PAPER_DUST } = require('./trader-state');
const { updateVirtualWalletBalance } = require('./virtual-wallet');

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

function resolveMinTradeAmount(strategy = {}, assetIn = {}) {
  const symbol = (assetIn.symbol || '').toLowerCase();
  const candidates = [];
  if (symbol) {
    candidates.push(`min_trade_amount_micro_${symbol}`);
  }
  candidates.push('min_trade_amount_micro_asset_in');
  candidates.push('min_trade_amount_micro_algo');
  for (const key of candidates) {
    if (key && Object.prototype.hasOwnProperty.call(strategy, key)) {
      const value = strategy[key];
      if (value === undefined || value === null) continue;
      return BigInt(value);
    }
  }
  throw new Error('min trade amount not configured for asset_in ' + (assetIn.symbol || assetIn.id || 'unknown'));
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
  actions,
  walletHandle
}) {
  state.balances = normalizeBalances(state.balances);
  const slippage = task.strategy.slippage_tolerance_bps;
  const quote = await getSwapQuote({
    direction: 'forward',
    pool,
    task,
    amountMicro,
    slippageBps: slippage
  });
  const assetOutMicro = Number(quote.quoteSummary.assetOutAmount);
  const algoMicro = Number(amountMicro);
  state.balances.asset_out_micro += assetOutMicro;
  state.balances.algo_spent_micro += algoMicro;
  updateVirtualWalletBalance(walletHandle, assetIn, -algoMicro);
  updateVirtualWalletBalance(walletHandle, assetOut, assetOutMicro);
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
  actions,
  walletHandle
}) {
  state.balances = normalizeBalances(state.balances);
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
  const sellMicro = Number(amountMicro);
  const algoOutMicro = Number(quote.quoteSummary.assetOutAmount);
  state.balances.asset_out_micro = Math.max(0, state.balances.asset_out_micro - sellMicro);
  state.balances.algo_realized_micro += algoOutMicro;
  updateVirtualWalletBalance(walletHandle, assetOut, -sellMicro);
  updateVirtualWalletBalance(walletHandle, assetIn, algoOutMicro);
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

module.exports = {
  shouldReenter,
  resolveMinTradeAmount,
  getSwapQuote,
  openPaperPosition,
  closePaperPosition,
};
