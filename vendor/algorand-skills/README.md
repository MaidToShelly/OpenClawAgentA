# Algorand Skill Vendor Cache

This directory is populated on demand by `./actions/fetch-vendor-skills.js` using `LOCKFILE.json`.

- `LOCKFILE.json` pins the upstream repo, tag/asset, and checksum for each skill.
- Real skill directories (algorand-ecosystem, call-smart-contracts, etc.) are **generated** and git-ignored.

Run:

```bash
./actions/fetch-vendor-skills.js
```

to download/extract the locked versions locally.
