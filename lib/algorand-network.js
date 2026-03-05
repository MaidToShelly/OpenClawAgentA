const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'algorand-networks.json');

let cachedConfig = null;

function loadAlgorandNetworkConfig() {
  if (cachedConfig) return cachedConfig;
  if (!fs.existsSync(CONFIG_PATH)) {
    cachedConfig = {};
    return cachedConfig;
  }
  try {
    cachedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.warn('Failed to parse algorand network config:', err.message);
    cachedConfig = {};
  }
  return cachedConfig;
}

function normalize(value) {
  return String(value || '').toLowerCase();
}

function findNetworkEntry(identifier) {
  if (!identifier) return null;
  const config = loadAlgorandNetworkConfig();
  const target = normalize(identifier);
  for (const [id, entry] of Object.entries(config)) {
    if (normalize(id) === target) {
      return { id, entry };
    }
    const aliases = (entry.aliases || []).map(normalize);
    if (aliases.includes(target)) {
      return { id, entry };
    }
  }
  return null;
}

function resolveWalletNamespace(task) {
  if (!task) return 'algorand-unknown';
  if (task.virtual_wallet_network) {
    const match = findNetworkEntry(task.virtual_wallet_network);
    return match ? (match.entry.wallet_namespace || match.id) : task.virtual_wallet_network;
  }
  const match = findNetworkEntry(task.network);
  if (match) {
    return match.entry.wallet_namespace || match.id;
  }
  return `algorand-${task.network || 'unknown'}`;
}

function resolveAlgodNetworkConfig(task) {
  if (!task) return null;
  const match = findNetworkEntry(task.network) || findNetworkEntry(task.virtual_wallet_network);
  if (!match) return null;
  return { id: match.id, ...match.entry };
}

module.exports = {
  loadAlgorandNetworkConfig,
  resolveWalletNamespace,
  resolveAlgodNetworkConfig
};
