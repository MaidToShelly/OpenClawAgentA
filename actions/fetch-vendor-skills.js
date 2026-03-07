#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { parseArgs } = require('../lib/parse-args');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR_DIR = path.join(ROOT, 'vendor', 'algorand-skills');
const DEFAULT_LOCK = path.join(VENDOR_DIR, 'LOCKFILE.json');


async function download(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to download ${url} (${res.status}): ${text}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeTempFile(prefix, buffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filePath = path.join(tmpDir, 'payload.zip');
  fs.writeFileSync(filePath, buffer);
  return { tmpDir, filePath };
}

function verifySha(buffer, expected) {
  if (!expected) return;
  const clean = expected.replace(/^sha256:/i, '').toLowerCase();
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase();
  if (hash !== clean) {
    throw new Error(`SHA256 mismatch (expected ${clean}, got ${hash})`);
  }
}

function extractZip(zipPath, destDir) {
  ensureDir(destDir);
  const cmd = `python3 - <<'PY'\nimport zipfile\nzipfile.ZipFile(r"${zipPath}").extractall(r"${destDir}")\nPY`;
  execSync(cmd, { stdio: 'inherit' });
}

function removeDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function copyDir(src, dest) {
  ensureDir(path.dirname(dest));
  fs.cpSync(src, dest, { recursive: true });
}

async function installReleaseSkill(name, meta, force) {
  const dest = path.join(VENDOR_DIR, name);
  if (fs.existsSync(dest) && !force) {
    console.log(`${name}: already present (use --force to refresh)`);
    return;
  }
  console.log(`${name}: downloading ${meta.asset} (${meta.tag})...`);
  const buffer = await download(meta.download_url);
  verifySha(buffer, meta.sha256);
  const { tmpDir, filePath } = writeTempFile(`${name}-`, buffer);
  try {
    const extractDir = path.join(tmpDir, 'extract');
    extractZip(filePath, extractDir);
    const entries = fs.readdirSync(extractDir);
    let sourceDir;
    if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory()) {
      sourceDir = path.join(extractDir, entries[0]);
    } else {
      sourceDir = extractDir;
    }
    removeDir(dest);
    copyDir(sourceDir, dest);
    console.log(`${name}: installed to ${dest}`);
  } finally {
    removeDir(path.dirname(filePath));
  }
}

async function installRepoSkill(name, meta, force) {
  const dest = path.join(VENDOR_DIR, name);
  if (fs.existsSync(dest) && !force) {
    console.log(`${name}: already present (use --force to refresh)`);
    return;
  }
  const url = `https://codeload.github.com/${meta.repo}/zip/${meta.commit}`;
  console.log(`${name}: downloading ${meta.repo}@${meta.commit}...`);
  const buffer = await download(url);
  const { tmpDir, filePath } = writeTempFile(`${name}-repo-`, buffer);
  try {
    const extractDir = path.join(tmpDir, 'extract');
    extractZip(filePath, extractDir);
    const roots = fs.readdirSync(extractDir);
    if (roots.length === 0) {
      throw new Error('Repo archive missing content');
    }
    const rootDir = path.join(extractDir, roots[0]);
    const source = path.join(rootDir, meta.path);
    if (!fs.existsSync(source)) {
      throw new Error(`Path ${meta.path} not found in repo archive`);
    }
    removeDir(dest);
    copyDir(source, dest);
    console.log(`${name}: installed to ${dest}`);
  } finally {
    removeDir(path.dirname(filePath));
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const lockPath = args.lock || DEFAULT_LOCK;
  const force = Boolean(args.force);
  const targetSkill = args.skill || null;

  if (!fs.existsSync(lockPath)) {
    throw new Error(`Lockfile not found: ${lockPath}`);
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const skills = lock.skills || {};
  ensureDir(VENDOR_DIR);

  const entries = Object.entries(skills).filter(([name]) => !targetSkill || targetSkill === name);
  if (!entries.length) {
    throw new Error('No matching skills found in lockfile.');
  }

  for (const [name, meta] of entries) {
    if (meta.asset) {
      await installReleaseSkill(name, meta, force);
    } else if (meta.commit) {
      await installRepoSkill(name, meta, force);
    } else {
      console.warn(`${name}: unknown lock entry format, skipping.`);
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
