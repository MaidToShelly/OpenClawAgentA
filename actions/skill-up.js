#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parseArgs } = require('../lib/parse-args');

const ROOT = path.join(__dirname, '..');
const DOWNLOAD_DIR = path.join(ROOT, 'skills-packages');


async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error (${res.status}): ${text}`);
  }
  return res.json();
}

async function getRelease(repo, tag) {
  const base = `https://api.github.com/repos/${repo}/releases`;
  if (tag) {
    return fetchJson(`${base}/tags/${tag}`);
  }
  return fetchJson(`${base}/latest`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function listAssets(repo) {
  const release = await getRelease(repo);
  console.log(`Latest release: ${release.name || release.tag_name}`);
  console.log(`Tag: ${release.tag_name}`);
  console.log('Packaged skills:');
  release.assets.forEach((asset) => {
    const sizeKB = (asset.size / 1024).toFixed(1);
    console.log(`- ${asset.name} (${sizeKB} KB) → ${asset.browser_download_url}`);
  });
}

async function downloadAsset(asset, destPath) {
  const res = await fetch(asset.browser_download_url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Download failed (${res.status}): ${text}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

async function installAsset(repo, assetName, tag) {
  const release = await getRelease(repo, tag);
  const asset = release.assets.find((item) => item.name === assetName);
  if (!asset) {
    throw new Error(`Asset "${assetName}" not found in release ${release.tag_name}.`);
  }

  ensureDir(DOWNLOAD_DIR);
  const zipPath = path.join(DOWNLOAD_DIR, asset.name);
  const destDir = path.join(DOWNLOAD_DIR, asset.name.replace(/\.zip$/i, ''));

  console.log(`Downloading ${asset.name} from ${release.tag_name}...`);
  await downloadAsset(asset, zipPath);

  if (fs.existsSync(destDir)) {
    console.log(`Removing existing directory ${destDir}`);
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  ensureDir(destDir);

  console.log(`Extracting to ${destDir}...`);
  const extractCmd = `python3 - <<'PY'\nimport zipfile\nzipfile.ZipFile(r"${zipPath}").extractall(r"${destDir}")\nPY`;
  execSync(extractCmd, { stdio: 'inherit' });

  console.log('Done.');
  console.log(`Zip: ${zipPath}`);
  console.log(`Extracted contents: ${destDir}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const repo = args.repo || 'algorand-devrel/algorand-agent-skills';

  if (args.list) {
    await listAssets(repo);
    return;
  }

  if (args.install) {
    await installAsset(repo, args.install, args.tag);
    return;
  }

  console.log('Usage:');
  console.log('  --list                 List packaged skills');
  console.log('  --install <asset.zip>  Download and extract a packaged skill');
  console.log('  --tag <tag>            Optional release tag (default latest)');
  console.log('  --repo <owner/repo>    Override repository (default algorand-devrel/algorand-agent-skills)');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
