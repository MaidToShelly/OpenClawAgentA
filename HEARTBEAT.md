# Heartbeat Tasks

## Algorand watch digests (every heartbeat)
Run the consolidated watcher (reads `address-book/watchlist.json`, which is git-ignored). Only surface the output if the script prints a digest; otherwise reply `HEARTBEAT_OK`.

```
./actions/run-watchlist.js
```

(Adjust the local watch list in `address-book/watchlist.json` whenever you want to add/remove contacts or change intervals.)
