const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'algorand-networks.json');
const CONFIG_LOCAL_PATH = path.join(ROOT, 'config', 'algorand-networks.local.json');
const DEFAULT_ALGOD_URL = 'https://mainnet-api.4160.nodely.dev';
const DEFAULT_ALGOD_PORT = '';

let cachedConfig = null;

function mergeNetworkConfigs(baseConfig = {}, overrideConfig = {}) {
  const merged = { ...baseConfig };
  for (const [id, overrideEntry] of Object.entries(overrideConfig || {})) {
    const baseEntry = baseConfig[id] || {};
    merged[id] = mergeNetworkEntry(baseEntry, overrideEntry);
  }
  return merged;
}

function mergeNetworkEntry(baseEntry = {}, overrideEntry = {}) {
  return {
    ...baseEntry,
    ...overrideEntry,
    algod: {
      ...(baseEntry.algod || {}),
      ...(overrideEntry.algod || {})
    },
    indexer: {
      ...(baseEntry.indexer || {}),
      ...(overrideEntry.indexer || {})
    }
  };
}

function loadAlgorandNetworkConfig() {
  if (cachedConfig) return cachedConfig;
  let baseConfig = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      baseConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.warn('Failed to parse algorand network config:', err.message);
    }
  }
  let localConfig = {};
  if (fs.existsSync(CONFIG_LOCAL_PATH)) {
    try {
      localConfig = JSON.parse(fs.readFileSync(CONFIG_LOCAL_PATH, 'utf8'));
    } catch (err) {
      console.warn('Failed to parse algorand network local override:', err.message);
    }
  }
  cachedConfig = mergeNetworkConfigs(baseConfig, localConfig);
  return cachedConfig;
}

function normalize(value) {
  return String(value || '').toLowerCase();
}

function getNetworkEntry(identifier) {
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

function isEntryEnabled(entry) {
  if (entry.enabled !== undefined) {
    return Boolean(entry.enabled);
  }
  return normalize(entry.chain) === 'algorand';
}

function requireEnabledNetwork(identifier, contextLabel) {
  const entry = getNetworkEntry(identifier);
  if (!entry) {
    throw new Error(`Network "${identifier}" is not defined in config/algorand-networks.json${contextLabel ? ` (${contextLabel})` : ''}`);
  }
  if (!isEntryEnabled(entry.entry)) {
    throw new Error(`Network "${entry.id}" is disabled in config/algorand-networks.json`);
  }
  return entry;
}

function resolveWalletNamespace(task) {
  if (!task) return 'algorand-unknown';
  if (task.virtual_wallet_network) {
    const match = requireEnabledNetwork(task.virtual_wallet_network, 'virtual_wallet_network');
    return match.entry.wallet_namespace || match.id;
  }
  const match = requireEnabledNetwork(task.network, 'task.network');
  return match.entry.wallet_namespace || match.id;
}

function resolveAlgodNetworkConfig(task) {
  if (!task || !task.network) {
    throw new Error('Task is missing a "network" value.');
  }
  const match = requireEnabledNetwork(task.network, 'task.network');
  return { id: match.id, ...match.entry };
}

function sanitizeEnvKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function envOverride(baseKey, networkId) {
  const scopedKey = networkId ? `${baseKey}_${sanitizeEnvKey(networkId)}` : null;
  if (scopedKey && process.env[scopedKey] !== undefined) {
    return process.env[scopedKey];
  }
  if (process.env[baseKey] !== undefined) {
    return process.env[baseKey];
  }
  return undefined;
}

function resolveAlgodSettings(task) {
  const entry = resolveAlgodNetworkConfig(task);
  const networkId = entry?.id;
  const algod = entry?.algod || {};
  const url = envOverride('ALGOD_URL', networkId) || algod.url || DEFAULT_ALGOD_URL;
  const token = envOverride('ALGOD_TOKEN', networkId) ?? algod.token ?? '';
  const port = envOverride('ALGOD_PORT', networkId) ?? algod.port ?? DEFAULT_ALGOD_PORT;
  const headers = { ...(algod.headers || {}) };
  return { url, token, port, headers };
}

module.exports = {
  loadAlgorandNetworkConfig,
  resolveWalletNamespace,
  resolveAlgodNetworkConfig,
  resolveAlgodSettings
};
