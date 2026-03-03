#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const failures = [];

function readJson(relPath) {
  const abs = path.join(root, relPath);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function requireField(obj, keyPath, label) {
  const parts = keyPath.split('.');
  let cur = obj;
  for (const p of parts) {
    cur = cur && cur[p];
  }
  if (typeof cur !== 'string' || cur.trim().length === 0) {
    failures.push(`${label} missing: ${keyPath}`);
  }
}

function assertFile(relPath) {
  const abs = path.join(root, relPath);
  if (!fs.existsSync(abs)) failures.push(`required file missing: ${relPath}`);
}

function checkMetadata() {
  const pkg = readJson('package.json');
  const plugin = readJson('openclaw.plugin.json');

  requireField(pkg, 'name', 'package metadata');
  requireField(pkg, 'version', 'package metadata');
  requireField(pkg, 'description', 'package metadata');
  requireField(pkg, 'license', 'package metadata');
  requireField(pkg, 'author', 'package metadata');
  requireField(pkg, 'repository.type', 'package metadata');
  requireField(pkg, 'repository.url', 'package metadata');
  requireField(pkg, 'homepage', 'package metadata');
  requireField(pkg, 'bugs.url', 'package metadata');

  requireField(plugin, 'id', 'plugin metadata');
  requireField(plugin, 'name', 'plugin metadata');
  requireField(plugin, 'description', 'plugin metadata');
  requireField(plugin, 'version', 'plugin metadata');
}

function checkDocsBundle() {
  const requiredDocs = [
    'README.md',
    'docs/setup.md',
    'docs/runtime-protocol-v1.md',
    'docs/skill-pair-manifest-schema-v1.md',
    'docs/skill-pair-publish-executor-v1.md',
    'docs/documentation-status-v1.md',
  ];
  for (const f of requiredDocs) assertFile(f);
}

function checkNoSecretLiterals() {
  const targets = [
    'README.md',
    'docs',
    'src',
    'scripts',
    'openclaw.plugin.json',
    'package.json',
  ];

  try {
    const cmd = `git ls-files ${targets.join(' ')}`;
    const files = execSync(cmd, { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const re = /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----|AIza[0-9A-Za-z\-_]{30,})\b/g;
    for (const rel of files) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      if (re.test(text)) {
        failures.push(`possible secret literal found in ${rel}`);
      }
      re.lastIndex = 0;
    }
  } catch (err) {
    failures.push(`secret scan failed: ${String(err)}`);
  }
}

function checkPackContents() {
  try {
    const out = execSync('npm pack --dry-run --json --loglevel=error', {
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_cache: '/tmp/npm-cache-release-gate',
        npm_config_logs_dir: '/tmp/npm-logs-release-gate',
      },
    });
    const parsed = JSON.parse(out);
    const files = new Set((parsed?.[0]?.files || []).map((f) => f.path));
    const mustInclude = ['dist/index.js', 'openclaw.plugin.json', 'README.md'];
    for (const f of mustInclude) {
      if (!files.has(f)) failures.push(`npm pack missing required artifact: ${f}`);
    }
  } catch (err) {
    failures.push(`npm pack dry-run check failed: ${String(err)}`);
  }
}

checkMetadata();
checkDocsBundle();
checkNoSecretLiterals();
checkPackContents();

if (failures.length > 0) {
  console.error('release-gate: FAILED');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log('release-gate: PASS');
