#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="$ROOT_DIR/secrets/algorand-account.json"
NETWORK="${HELLO_WORLD_NETWORK:-mainnet}"
RECIPIENT="${HELLO_WORLD_RECIPIENT:-G3MSA75OZEJTCCENOJDLDJK7UD7E2K5DNC7FVHCNOV7E3I4DTXTOWDUIFQ}"
DEFAULT_NOTE="Hello Shelly"

if [[ -n "${HELLO_WORLD_NOTE:-}" ]]; then
  NOTE_TEXT="$HELLO_WORLD_NOTE"
elif [[ -n "${HELLO_WORLD_NAME:-}" ]]; then
  NOTE_TEXT="Hello ${HELLO_WORLD_NAME}"
else
  NOTE_TEXT="$DEFAULT_NOTE"
fi

if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "Secrets file not found at $SECRETS_FILE" >&2
  exit 1
fi

SENDER=$(node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync('$SECRETS_FILE','utf8'));if(!data.address){throw new Error('Missing address in secrets file');}process.stdout.write(data.address);")

UNSIGNED_FILE=$(mktemp)
SIGNED_FILE=$(mktemp)
trap 'rm -f "$UNSIGNED_FILE" "$SIGNED_FILE"' EXIT

echo "[hello-world] Building unsigned transaction via algorand-mcp.make_payment_txn..."
mcporter call algorand-mcp.make_payment_txn \
  from:"$SENDER" \
  to:"$RECIPIENT" \
  amount:0 \
  note:"$NOTE_TEXT" \
  network:"$NETWORK" \
  > "$UNSIGNED_FILE"

echo "[hello-world] Signing locally with scripts/sign_algorand_tx.js..."
node "$ROOT_DIR/scripts/sign_algorand_tx.js" "$UNSIGNED_FILE" "$SECRETS_FILE" > "$SIGNED_FILE"

read -r TXID <<<"$(node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync('$SIGNED_FILE','utf8'));process.stdout.write(data.txID);")"
SEND_ARGS=$(node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync('$SIGNED_FILE','utf8'));const network=process.argv[1];process.stdout.write(JSON.stringify({signedTxns:[data.blob],network}));" "$NETWORK")

echo "[hello-world] Broadcasting via algorand-mcp.send_raw_transaction (txID: $TXID)..."
mcporter call algorand-mcp.send_raw_transaction --args "$SEND_ARGS"

echo "[hello-world] Done. TxID: $TXID"
