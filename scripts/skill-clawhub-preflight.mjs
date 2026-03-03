#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const argDir = process.argv.find((a) => a.startsWith("--skill-dir="));
const skillDir = path.resolve(argDir ? argDir.slice("--skill-dir=".length) : "/Users/jaredlikes/code/openclaw-skill-ansible");
const failures = [];
const warnings = [];

function exists(rel) {
  return fs.existsSync(path.join(skillDir, rel));
}

function read(rel) {
  return fs.readFileSync(path.join(skillDir, rel), "utf8");
}

function hasLine(text, re) {
  return re.test(text);
}

function checkFiles() {
  for (const rel of ["SKILL.md", "README.md", "metadata.yaml"]) {
    if (!exists(rel)) failures.push(`missing required file: ${rel}`);
  }
}

function checkMetadata() {
  if (!exists("metadata.yaml")) return;
  const m = read("metadata.yaml");
  const required = [
    [/^name:\s*\S+/m, "metadata.name"],
    [/^owner:\s*\S+/m, "metadata.owner"],
    [/^contact:\s*\S+/m, "metadata.contact"],
    [/^risk_level:\s*\S+/m, "metadata.risk_level"],
  ];
  for (const [re, label] of required) {
    if (!hasLine(m, re)) failures.push(`missing required metadata field: ${label}`);
  }
  const recommended = [
    [/^version:\s*\S+/m, "metadata.version"],
    [/^license:\s*\S+/m, "metadata.license"],
    [/^repository:\s*\S+/m, "metadata.repository"],
    [/^description:\s*\S+/m, "metadata.description"],
  ];
  for (const [re, label] of recommended) {
    if (!hasLine(m, re)) warnings.push(`recommended metadata field missing: ${label}`);
  }
}

function checkSkillBody() {
  if (!exists("SKILL.md")) return;
  const s = read("SKILL.md");
  if (s.trim().length < 120) warnings.push("SKILL.md is very short; consider adding usage contract and examples");
}

function checkSecrets() {
  const re = /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----)\b/;
  const files = ["SKILL.md", "README.md", "metadata.yaml"];
  for (const rel of files) {
    if (!exists(rel)) continue;
    const text = read(rel);
    if (re.test(text)) failures.push(`possible secret literal detected in ${rel}`);
  }
}

checkFiles();
checkMetadata();
checkSkillBody();
checkSecrets();

console.log(`skill-preflight target: ${skillDir}`);
if (warnings.length > 0) {
  console.warn("skill-preflight: WARN");
  for (const w of warnings) console.warn(`- ${w}`);
}
if (failures.length > 0) {
  console.error("skill-preflight: FAILED");
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log("skill-preflight: PASS");
