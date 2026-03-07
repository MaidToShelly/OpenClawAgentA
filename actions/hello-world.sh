#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="$ROOT_DIR/secrets/algorand-account.json"
NETWORK="${HELLO_WORLD_NETWORK:-mainnet}"
RECIPIENT="${HELLO_WORLD_RECIPIENT:-G3MSA75OZEJTCCENOJDLDJK7UD7E2K5DNC7FVHCNOV7E3I4DTXTOWDUIFQ}"
MCP_SERVER="${HELLO_WORLD_MCP:-ulu-local}"
PAYMENT_TOOL="${HELLO_WORLD_TOOL:-payment_txn}"
BROADCAST_TOOL="${HELLO_WORLD_BROADCAST_TOOL:-algod_send_raw_transactions}"
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

ARGS_JSON=$(NETWORK="$NETWORK" NOTE_TEXT="$NOTE_TEXT" SENDER="$SENDER" RECIPIENT="$RECIPIENT" AMOUNT_MICRO="0" PAYMENT_TOOL="$PAYMENT_TOOL" node <<'NODE'
const payload = {
  network: process.env.NETWORK,
  note: process.env.NOTE_TEXT
};

if (process.env.PAYMENT_TOOL === 'payment_txn') {
  payload.sender = process.env.SENDER;
  payload.receiver = process.env.RECIPIENT;
  payload.amount = process.env.AMOUNT_MICRO;
} else {
  payload.from = process.env.SENDER;
  payload.to = process.env.RECIPIENT;
  payload.amount = Number(process.env.AMOUNT_MICRO);
}

process.stdout.write(JSON.stringify(payload));
NODE
)

echo "[hello-world] Building unsigned transaction via $MCP_SERVER.$PAYMENT_TOOL..."
mcporter call "$MCP_SERVER"."$PAYMENT_TOOL" --args "$ARGS_JSON" > "$UNSIGNED_FILE"

echo "[hello-world] Signing locally with scripts/sign_algorand_tx.js..."
node "$ROOT_DIR/scripts/sign_algorand_tx.js" "$UNSIGNED_FILE" "$SECRETS_FILE" > "$SIGNED_FILE"

read -r TXID <<<"$(node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync('$SIGNED_FILE','utf8'));if(Array.isArray(data.txIDs)){process.stdout.write(data.txIDs[0]);}else{process.stdout.write(data.txID);} ")"
SEND_ARGS=$(node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync('$SIGNED_FILE','utf8'));const blobs=data.blob?[data.blob]:data.blobs;const network=process.argv[1];process.stdout.write(JSON.stringify({signedTxns:blobs,network}));" "$NETWORK")

echo "[hello-world] Broadcasting via $MCP_SERVER.$BROADCAST_TOOL (txID: $TXID)..."
mcporter call "$MCP_SERVER"."$BROADCAST_TOOL" --args "$SEND_ARGS"

echo "[hello-world] Done. TxID: $TXID"
