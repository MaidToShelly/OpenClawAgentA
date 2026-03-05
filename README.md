# Workspace Overview (OpenClaw)

This OpenClaw workspace bundles a turnkey Algorand trading agent (currently pointed at Tinyman) plus the scaffolding needed to run it live or in simulation. The same layout can host other strategies—swap the task JSONs and cron commands and you’re off to the races.

## High-level features

- **Agent-friendly layout:** `actions/` holds the runnable scripts, `roles/trader/tasks/` defines strategies, and `portfolio/` captures state/logs so the assistant can reason about performance.
- **Live + paper modes:** Each task declares `execution_mode` (`live` hits the chain, `paper` simulates fills and records them as `paper: true`).
- **Self-contained automation:** Cron entries run the manager every five minutes, with flock locks, per-task logs, and a pause flag (`.trader-paused`).
- **Traceable history:** All fills (real or hypothetical) land in `portfolio/trades.json`; state snapshots live under `portfolio/*.json` for dashboards or downstream analytics.

## Requirements

1. **OpenClaw Gateway** (already hosting this workspace). Cron, file I/O, and pause flagging assume the OpenClaw agent has shell access here.
2. **Node.js 18+** (`npm install` installs `algosdk` and `@tinymanorg/tinyman-js-sdk`).
3. **Algorand account funding** – the manager expects `secrets/algorand-account.json` with `{ "mnemonic": "your 25-word phrase" }` and enough ALGO to pay swap fees.

## Getting started

1. **Create & fund a wallet** (agent task):
   - Generate a mnemonic with `algokey`, `goal account new`, or any Algorand wallet CLI.
   - Fund it via faucet/testnet or an exchange transfer, then drop the phrase into `secrets/algorand-account.json`.
2. **Install dependencies:** `npm install`
3. **Run once manually:**
   ```bash
   node actions/trader-manage.js --verbose
   ```
   Add `--task <id>` to target a specific config (e.g., `tinyman-algo-wad-paper`).
4. **(Optional) Schedule cron:** copy the sample entries below into `crontab -e` to fire every five minutes.

## Sample commands

```bash
# Live task heartbeat
node actions/trader-manage.js --verbose

# Paper clone
node actions/trader-manage.js --task tinyman-algo-wad-paper --verbose

# Force actions
node actions/trader-manage.js --force-close
node actions/trader-manage.js --task tinyman-algo-wad-paper --force-open

# Dry run / ignore pause flag
node actions/trader-manage.js --dry-run --verbose
node actions/trader-manage.js --ignore-pause --verbose
```

## Cron template

```
*/5 * * * * cd /home/shelly/.../workspace && \
  /usr/bin/flock -n /tmp/trader-manage.lock \
  /usr/bin/node actions/trader-manage.js --verbose \
  >> /home/shelly/.../workspace/logs/trader-manage.log 2>&1

*/5 * * * * cd /home/shelly/.../workspace && \
  /usr/bin/flock -n /tmp/trader-manage-paper.lock \
  /usr/bin/node actions/trader-manage.js --task tinyman-algo-wad-paper --verbose \
  >> /home/shelly/.../workspace/logs/trader-manage-paper.log 2>&1
```

(Use `.trader-paused` or comment out a line to pause.)

## Files to know

- `actions/trader-swap.js` – swap helper (also exports `appendTradeLog`).
- `actions/trader-manage.js` – strategy loop (live & paper aware).
- `roles/trader/tasks/*.json` – task configs; add/edit here to change behaviour.
- `portfolio/positions.json`, `portfolio/trader-state.json`, `portfolio/<task>-paper-state.json` – dashboard inputs.
- `portfolio/trades.json` – global trade log.
- `logs/trader-manage*.log` – cron output for debugging.

Need more detail (architecture diagram, troubleshooting, etc.)? Ask the agent to extend this doc as the workspace evolves. 