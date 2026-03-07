const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', 'portfolio');
const VIRTUAL_WALLET_DIR = path.join(STATE_DIR, 'virtual-wallets');

function loadVirtualWallet(walletId, networkKey, assetIn, assetOut) {
  if (!fs.existsSync(VIRTUAL_WALLET_DIR)) {
    fs.mkdirSync(VIRTUAL_WALLET_DIR, { recursive: true });
  }
  const walletPath = path.join(VIRTUAL_WALLET_DIR, `${walletId}.json`);
  if (!fs.existsSync(walletPath)) {
    const wallet = {
      id: walletId,
      created_at: new Date().toISOString(),
      networks: {
        [networkKey]: {
          assets: {},
          initial_assets: {}
        }
      }
    };
    fs.writeFileSync(walletPath, JSON.stringify(wallet, null, 2));
  }
  const wallet = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  if (!wallet.networks) {
    wallet.networks = {
      [networkKey]: {
        assets: wallet.assets || {},
        initial_assets: wallet.initial_assets || {}
      }
    };
    delete wallet.assets;
    delete wallet.initial_assets;
  }
  wallet.networks[networkKey] = wallet.networks[networkKey] || { assets: {}, initial_assets: {} };
  fs.writeFileSync(walletPath, JSON.stringify(wallet, null, 2));
  return { path: walletPath, wallet, networkKey };
}

function getWalletNetwork(walletHandle) {
  if (!walletHandle) return null;
  return walletHandle.wallet.networks[walletHandle.networkKey];
}

function updateVirtualWalletBalance(walletHandle, asset, deltaMicro) {
  if (!walletHandle) return;
  const network = getWalletNetwork(walletHandle);
  if (!network) return;
  const key = String(asset.id);
  const entry = network.assets[key] || { symbol: asset.symbol, decimals: asset.decimals, amount_micro: 0 };
  entry.symbol = entry.symbol || asset.symbol;
  entry.decimals = entry.decimals || asset.decimals;
  entry.amount_micro = Number(entry.amount_micro || 0) + deltaMicro;
  network.assets[key] = entry;
  fs.writeFileSync(walletHandle.path, JSON.stringify(walletHandle.wallet, null, 2));
}

function syncVirtualWallet(walletHandle, assetIn, assetOut, balances) {
  if (!walletHandle) return;
  const network = getWalletNetwork(walletHandle);
  if (!network) return;
  network.initial_assets = network.initial_assets || {};
  const ensureEntry = (asset) => {
    const key = String(asset.id);
    network.assets[key] = network.assets[key] || { symbol: asset.symbol, decimals: asset.decimals, amount_micro: 0 };
    network.initial_assets[key] =
      network.initial_assets[key] !== undefined ? network.initial_assets[key] : network.assets[key].amount_micro || 0;
    return key;
  };
  const keyIn = ensureEntry(assetIn);
  const keyOut = ensureEntry(assetOut);
  const lockAssetIn = Boolean(walletHandle.wallet && walletHandle.wallet.lock_asset_in);
  if (!lockAssetIn) {
    const assetInInitial = Number(network.initial_assets[keyIn] || 0);
    const netDeployed = balances.algo_spent_micro - balances.algo_realized_micro;
    network.assets[keyIn].amount_micro = Math.max(0, assetInInitial - netDeployed);
  }
  const outInitial = Number(network.initial_assets[keyOut] || 0);
  network.assets[keyOut].amount_micro = Math.max(0, outInitial + balances.asset_out_micro);
  fs.writeFileSync(walletHandle.path, JSON.stringify(walletHandle.wallet, null, 2));
}

function formatWalletSummary(walletHandle, assetIn, assetOut) {
  const network = getWalletNetwork(walletHandle);
  if (!network) return 'n/a';
  const algoEntry = network.assets[String(assetIn.id)] || { amount_micro: 0 };
  const outEntry = network.assets[String(assetOut.id)] || { amount_micro: 0 };
  const format = (micro) => (micro / 1_000_000).toFixed(6);
  return `${assetIn.symbol || assetIn.id} ${format(algoEntry.amount_micro)} / ${assetOut.symbol || assetOut.id} ${format(outEntry.amount_micro)}`;
}

module.exports = {
  loadVirtualWallet,
  getWalletNetwork,
  updateVirtualWalletBalance,
  syncVirtualWallet,
  formatWalletSummary,
};
