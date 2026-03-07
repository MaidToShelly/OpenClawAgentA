const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'portfolio');
const TRADES_PATH = path.join(STATE_DIR, 'trades.json');
const DEFAULT_STATE_PATH = path.join(STATE_DIR, 'trader-state.json');
const TASKS_DIR = path.join(ROOT, 'roles', 'trader', 'tasks');
const DEFAULT_TASK_ID = 'tinyman-algo-wad';
const POSITION_DUST = 1_000n;
const PAPER_DUST = 1_000n;

function normalizeBalances(balances = {}) {
  return {
    asset_out_micro: Number(balances.asset_out_micro || 0),
    algo_spent_micro: Number(balances.algo_spent_micro || 0),
    algo_realized_micro: Number(balances.algo_realized_micro || 0)
  };
}

function rebuildBalancesFromTrades(taskId, executionMode) {
  if (!fs.existsSync(TRADES_PATH)) return normalizeBalances();
  const trades = JSON.parse(fs.readFileSync(TRADES_PATH, 'utf8')).trades || [];
  const balances = { asset_out_micro: 0, algo_spent_micro: 0, algo_realized_micro: 0 };
  trades.forEach((trade) => {
    if (trade.task_id !== taskId) return;
    const isPaperTrade = Boolean(trade.paper);
    if (executionMode === 'paper' && !isPaperTrade) return;
    if (executionMode === 'live' && isPaperTrade) return;
    const inputAsset = trade.input?.asset_id;
    const outputAsset = trade.output?.asset_id;
    const inputAmount = Number(trade.input?.amount_micro || 0);
    const outputAmount = Number(trade.output?.amount_micro || 0);
    if (inputAsset === 0) {
      balances.algo_spent_micro += inputAmount;
      balances.asset_out_micro += outputAmount;
    } else if (outputAsset === 0) {
      balances.asset_out_micro = Math.max(0, balances.asset_out_micro - inputAmount);
      balances.algo_realized_micro += outputAmount;
    }
  });
  return normalizeBalances(balances);
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
      last_mark_price: null,
      balances: normalizeBalances(),
      balances_bootstrapped: false
    };
  }
  const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  data.task_id = data.task_id || taskId;
  data.execution_mode = executionMode;
  data.position = data.position || { open: false };
  if (data.paper && !data.balances) {
    data.balances = {
      asset_out_micro: data.paper.asset_out_micro || 0,
      algo_spent_micro: data.paper.algo_spent_micro || 0,
      algo_realized_micro: data.paper.algo_realized_micro || 0
    };
    delete data.paper;
  }
  data.balances = normalizeBalances(data.balances);
  if (!data.balances_bootstrapped) {
    const rebuilt = rebuildBalancesFromTrades(taskId, executionMode);
    if (
      rebuilt.asset_out_micro !== 0 ||
      rebuilt.algo_spent_micro !== 0 ||
      rebuilt.algo_realized_micro !== 0
    ) {
      data.balances = rebuilt;
      data.balances_bootstrapped = true;
    }
  }
  return data;
}

function saveState(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function extractHoldings({ info, assetInId, assetOutId }) {
  const algoTotal = BigInt(info.amount);
  const minBalance = BigInt(info['min-balance'] || 0);
  const algoSpendable = algoTotal > minBalance ? algoTotal - minBalance : 0n;
  const findAssetAmount = (assetId) => {
    if (assetId === undefined || assetId === null) return 0n;
    if (Number(assetId) === 0) {
      return algoSpendable;
    }
    return BigInt(
      ((info.assets || []).find((a) => Number((a['asset-id'] ?? a['assetId'])) === Number(assetId))?.amount) || 0
    );
  };
  const assetOutMicro = findAssetAmount(assetOutId);
  const assetInMicro = findAssetAmount(assetInId);
  return {
    algoTotal,
    algoSpendable,
    assetInMicro,
    assetOutMicro
  };
}

function extractPaperHoldings(state) {
  const balances = normalizeBalances(state.balances);
  const netAlgo = BigInt(balances.algo_realized_micro - balances.algo_spent_micro);
  return {
    algoTotal: netAlgo,
    algoSpendable: 0n,
    assetInMicro: netAlgo,
    assetOutMicro: BigInt(balances.asset_out_micro)
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

function loadTask(taskId) {
  const taskPath = path.join(TASKS_DIR, `${taskId}.json`);
  if (!fs.existsSync(taskPath)) {
    throw new Error(`Task config not found at ${taskPath}`);
  }
  return JSON.parse(fs.readFileSync(taskPath, 'utf8'));
}

function normalizeAsset(def) {
  return {
    id: Number(def.id),
    symbol: def.symbol || String(def.id),
    decimals: typeof def.decimals === 'number' ? def.decimals : 6
  };
}

module.exports = {
  normalizeBalances,
  rebuildBalancesFromTrades,
  resolveStatePath,
  loadState,
  saveState,
  extractHoldings,
  extractPaperHoldings,
  bootstrapEntry,
  loadTask,
  normalizeAsset,
  POSITION_DUST,
  PAPER_DUST,
  DEFAULT_TASK_ID,
  STATE_DIR,
  TRADES_PATH,
};
