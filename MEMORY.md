# MEMORY.md

_Long-term notes for Agent → User. Updated 2026-03-06._

## Trading

### Key Asset IDs

| Symbol | ASA ID | Decimals | Network |
|--------|--------|----------|---------|
| ALGO | 0 (native) | 6 | algorand-mainnet |
| USDC | 31566704 | 6 | algorand-mainnet |
| WAD | 3334160924 | 6 | algorand-mainnet |
| ALGO/WAD LP | 3346320836 | — | algorand-mainnet |
| USDC/WAD LP | 3334448440 | — | algorand-mainnet |

### Automation

- Cron: every 5 minutes with flock lock
- Pause flag: `.trader-paused` in workspace root (remove to resume)
- Logs: `logs/trader-manage*.log`
- State files: `portfolio/<task_id>-<mode>-state.json`

## Architecture Decisions

1. **Network config layering:** `config/algorand-networks.json` is base (don't edit). Override in `config/algorand-networks.local.json`. Merged at runtime by `lib/algorand-network.js`.
2. **VOI vs Algorand:** Separate `blockchain` discriminator, not merged config. Shared SDK layer, divergent service layer. Default blockchain = "algorand".
3. **Virtual wallets:** Per-task ledgers track balances for live/paper. `lock_asset_in: true` locks the input asset. If ledger exceeds on-chain balance, trader-manage clamps and warns.
4. **Algod resolution:** `lib/algorand-network.js` resolves URL/token/port. Env overrides supported (e.g. `ALGOD_URL_VOI_MAINNET`). Default node: nodely.dev.
5. **Enabled networks:** algorand-mainnet + voi-mainnet enabled. Testnet/betanet/futurenet disabled via local override.

## MCP Servers

| Server | Used by | Key tools |
|--------|---------|-----------|
| algorand-mcp | trader scripts, mcporter CLI | wallet_*, make_*_txn, send_raw_transaction, api_tinyman_*, api_indexer_* |
| ulu-local | hello-world action | payment_txn, algod_send_raw_transactions, envoi_purchase_txn |
| ulu-mcp | Cursor agent (this context) | ARC200, ARC72, HumbleSwap, SnowballSwap, enVoi, Aramid Bridge |

## Pending (platform-level)

- **Reduce tool count:** 22 tools loaded but only ~6 used. `browser` (2.8K) and `message` (4.2K) are the biggest dead weight. Needs a `tools.disabled` list in `openclaw.json` — not configurable from workspace.
- **Reduce skills injection:** 16 skills (~10K chars) loaded by algorand plugin, most are dev-focused (typescript, python, ARC standards). Only `algorand-interaction` and `troubleshoot-errors` are relevant for trading. Needs per-agent skill filtering in plugin config.

## Lessons Learned

- Workspace has been live on mainnet since 2026-03-04. Always confirm with User before mainnet transactions involving real value.
- `trash` > `rm` — recoverable beats gone forever.
- Must opt into LP token asset before adding liquidity (easy to forget).
- Never re-type or partially copy base64 strings for x402 payment headers. Use exact values from encode/sign steps or signatures break.
- `.trader-paused` silently stops all trading. Easy to forget it exists when debugging why trades aren't firing.
