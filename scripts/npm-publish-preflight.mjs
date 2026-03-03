#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const failures = [];
const warnings = [];

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), "utf8"));
}

function ensure(condition, message) {
  if (!condition) failures.push(message);
}

function warn(condition, message) {
  if (!condition) warnings.push(message);
}

function run(cmd) {
  return execSync(cmd, {
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: "/tmp/npm-cache-npm-preflight",
      npm_config_logs_dir: "/tmp/npm-logs-npm-preflight",
    },
  }).trim();
}

function checkMetadata() {
  const pkg = readJson("package.json");
  const plugin = readJson("openclaw.plugin.json");

  ensure(typeof pkg.name === "string" && pkg.name.startsWith("@"), "package name must be scoped for npm publish");
  ensure(
    typeof pkg.name === "string" && /openclaw-plugin-ansible/.test(pkg.name),
    "package name should include openclaw-plugin-ansible",
  );
  ensure(typeof pkg.version === "string" && pkg.version.length > 0, "package version missing");
  ensure(plugin.version === pkg.version, "openclaw.plugin.json version must match package.json version");
  ensure(pkg.publishConfig?.access === "public", "publishConfig.access should be 'public'");
  ensure(pkg.private !== true, "package must not be private for npm publish");
}

function checkNpmNameCollision() {
  const pkg = readJson("package.json");
  try {
    const out = run(`npm view ${pkg.name} name version --json`);
    if (out) {
      warnings.push(`package name '${pkg.name}' already exists on npm; publish will require owner access`);
    }
  } catch (err) {
    const text = String(err?.stdout || err?.stderr || err || "");
    if (/E404|Not Found/i.test(text)) return;
    warnings.push(`npm name check inconclusive: ${text.slice(0, 240)}`);
  }
}

function checkPack() {
  try {
    const out = run("npm pack --dry-run --json --loglevel=error");
    const parsed = JSON.parse(out);
    const files = new Set((parsed?.[0]?.files || []).map((f) => f.path));
    ensure(files.has("dist/index.js"), "npm pack artifact missing dist/index.js");
    ensure(files.has("openclaw.plugin.json"), "npm pack artifact missing openclaw.plugin.json");
    ensure(files.has("README.md"), "npm pack artifact missing README.md");
  } catch (err) {
    failures.push(`npm pack dry-run failed: ${String(err?.stderr || err?.message || err).slice(0, 320)}`);
  }
}

function checkAuthHint() {
  try {
    const who = run("npm whoami");
    warn(Boolean(who), "npm whoami did not return a username");
  } catch (err) {
    warnings.push("npm whoami failed (not logged in or token expired). Run `npm login` before publish.");
  }
}

checkMetadata();
checkNpmNameCollision();
checkPack();
checkAuthHint();

if (warnings.length > 0) {
  console.warn("npm-preflight: WARN");
  for (const w of warnings) console.warn(`- ${w}`);
}

if (failures.length > 0) {
  console.error("npm-preflight: FAILED");
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log("npm-preflight: PASS");
