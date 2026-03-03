#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function mustContain(text, needle, label) {
  if (!text.includes(needle)) failures.push(`${label} missing required marker: ${needle}`);
}

function checkRuntimeProvenanceHooks() {
  const tools = read('src/tools.ts');
  mustContain(tools, 'G2_PROVENANCE', 'runtime gate pipeline');
  mustContain(tools, 'manifest.provenance.manifestChecksum', 'runtime provenance checksum handling');
  mustContain(tools, 'manifestSignature', 'runtime provenance signature handling');
  mustContain(
    tools,
    'provenance.manifestChecksum does not match canonicalized manifest payload',
    'runtime canonical checksum validation',
  );
}

function checkSchemaContract() {
  const schema = read('docs/skill-pair-manifest-schema-v1.md');
  mustContain(schema, '"provenance"', 'manifest schema');
  mustContain(schema, '"manifestChecksum"', 'manifest schema');
  mustContain(schema, '"manifestSignature"', 'manifest schema');
  mustContain(schema, '"publishedByAgentId"', 'manifest schema');
  mustContain(schema, '"publishedAt"', 'manifest schema');
}

function checkDocGateSpec() {
  const gates = read('docs/skill-pair-publish-executor-v1.md');
  mustContain(gates, 'G2_PROVENANCE', 'publish gate spec');
  mustContain(gates, 'verify checksum + signature', 'publish gate spec');
}

function checkChecklistAlignment() {
  const checklist = read('docs/ansible-completion-checklist-v1.md');
  mustContain(checklist, 'Signature verification trust path + key store integration', 'MVP-3 checklist');
  mustContain(checklist, 'Signed provenance checks in CI', 'MVP-3 checklist');
}

checkRuntimeProvenanceHooks();
checkSchemaContract();
checkDocGateSpec();
checkChecklistAlignment();

if (failures.length > 0) {
  console.error('provenance-gate: FAILED');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log('provenance-gate: PASS');
