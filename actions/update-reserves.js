#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const algosdk = require('algosdk');
const {
  loadAlgorandNetworkConfig,
  resolveAlgodSettings
} = require('../lib/algorand-network');

const ROOT = path.join(__dirname, '..');
const SECRETS_PATH = path.join(ROOT, 'secrets', 'algorand-account.json');
const VIRTUAL_WALLET_DIR = path.join(ROOT, 'portfolio', 'virtual-wallets');
const TASKS_DIR = path.join(ROOT, 'roles', 'trader', 'tasks');

async function main() {
  const args = parseArgs(process.argv);
  const networksConfig = loadAlgorandNetworkConfig();
  const targetNetworks = resolveTargets(args.networks, networksConfig);
  if (!targetNetworks.length) {
    console.log('No networks selected.');
    return;
  }

  const taskModes = loadTaskModes();
  const secrets = loadJson(SECRETS_PATH, 'Algorand secrets');
  if (!secrets.mnemonic) {
    throw new Error('Mnemonic missing in secrets/algorand-account.json');
  }
  const account = algosdk.mnemonicToSecretKey(secrets.mnemonic);

  for (const networkKey of targetNetworks) {
    const entry = networksConfig[networkKey];
    if (!entry) continue;
    try {
      await updateReserveForNetwork({ networkKey, entry, account, taskModes });
    } catch (err) {
      console.warn(`Reserve update failed for ${networkKey}: ${err.message}`);
    }
  }
}

async function updateReserveForNetwork({ networkKey, entry, account, taskModes }) {
  const algodSettings = resolveAlgodSettings({ network: networkKey });
  const algodClient = new algosdk.Algodv2(
    algodSettings.token || '',
    algodSettings.url,
    algodSettings.port || '',
    algodSettings.headers || {}
  );

  let accountInfo;
  try {
    accountInfo = await algodClient.accountInformation(account.addr).do();
  } catch (err) {
    // Treat missing accounts as zero balance
    if (err.status === 404 || /account .* does not exist/i.test(err.message)) {
      accountInfo = { amount: 0 };
    } else {
      throw err;
    }
  }

  const actualMicro = BigInt(accountInfo.amount || 0);
  const allocatedMicro = sumAllocatedMicro(networkKey, taskModes);
  let reserveMicro = actualMicro - allocatedMicro;
  if (reserveMicro < 0n) {
    console.warn(`Reserve underflow on ${networkKey} (allocated ${allocatedMicro} > actual ${actualMicro}). Clamping to 0.`);
    reserveMicro = 0n;
  }

  await writeReserveWallet({ networkKey, entry, reserveMicro });
  console.log(`Updated reserve-${networkKey}: ${Number(reserveMicro) / 1_000_000} ${nativeSymbol(entry)}`);
}

function sumAllocatedMicro(networkKey, taskModes) {
  if (!fs.existsSync(VIRTUAL_WALLET_DIR)) return 0n;
  const files = fs.readdirSync(VIRTUAL_WALLET_DIR).filter((f) => f.endsWith('.json'));
  let total = 0n;
  for (const file of files) {
    if (file.startsWith('reserve-')) continue;
    const wallet = loadJson(path.join(VIRTUAL_WALLET_DIR, file));
    const walletId = wallet?.id || file.replace(/\.json$/, '');
    const mode = taskModes[walletId];
    if (mode && mode !== 'live') continue; // skip paper/sim wallets
    const networkSlice = wallet?.networks?.[networkKey];
    if (!networkSlice) continue;
    const amountMicro = networkSlice.assets?.['0']?.amount_micro;
    if (amountMicro === undefined) continue;
    total += BigInt(amountMicro);
  }
  return total;
}

async function writeReserveWallet({ networkKey, entry, reserveMicro }) {
  if (!fs.existsSync(VIRTUAL_WALLET_DIR)) {
    fs.mkdirSync(VIRTUAL_WALLET_DIR, { recursive: true });
  }
  const reservePath = path.join(VIRTUAL_WALLET_DIR, `reserve-${networkKey}.json`);
  let existing = {};
  if (fs.existsSync(reservePath)) {
    existing = loadJson(reservePath);
  }
  const isoNow = new Date().toISOString();
  const payload = {
    id: existing.id || `reserve-${networkKey}`,
    created_at: existing.created_at || isoNow,
    updated_at: isoNow,
    networks: {
      ...(existing.networks || {}),
      [networkKey]: {
        assets: {
          '0': {
            symbol: nativeSymbol(entry),
            decimals: 6,
            amount_micro: Number(reserveMicro)
          }
        },
        initial_assets: {
          '0': Number(reserveMicro)
        }
      }
    }
  };
  fs.writeFileSync(reservePath, JSON.stringify(payload, null, 2));
}

function nativeSymbol(entry) {
  if (entry.native_symbol) return entry.native_symbol;
  const chain = (entry.chain || '').toLowerCase();
  if (chain === 'voi') return 'VOI';
  return 'ALGO';
}

function resolveTargets(flagValue, config) {
  if (!flagValue) return Object.keys(config);
  return flagValue
    .split(',')
    .map((s) => s.trim())
    .filter((key) => key && config[key]);
}

function parseArgs(argv) {
  const args = { networks: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--network' || arg === '--networks') && argv[i + 1]) {
      args.networks = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function loadTaskModes() {
  const modes = {};
  if (!fs.existsSync(TASKS_DIR)) return modes;
  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const task = loadJson(path.join(TASKS_DIR, file));
      if (task?.id) {
        modes[task.id] = (task.execution_mode || 'live').toLowerCase();
      }
    } catch {
      // ignore malformed task file
    }
  }
  return modes;
}

function loadJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (label) {
      throw new Error(`${label} (${filePath}) could not be read: ${err.message}`);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
