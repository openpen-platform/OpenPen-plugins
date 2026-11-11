#!/usr/bin/env node
// Regenerates plugins.json from plugins/<scope>/<name>/manifest.json.
// Zero dependencies. Exits non-zero (and leaves plugins.json untouched) on any invalid manifest.
//
// Usage: node scripts/build-index.mjs [--root <dir>] [--check]
//   --check  do not write; exit 1 if plugins.json would change.
// Env: BUILD_INDEX_NOW  ISO timestamp used for updatedAt when content changed (for tests).

import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const root = resolve(rootIdx >= 0 ? args[rootIdx + 1] : '.');
const checkOnly = args.includes('--check');

const REQUIRED = [
  'id', 'scope', 'name', 'ownerId', 'ownerLogin', 'ownerType', 'description',
  'minAppVersion', 'repo', 'latestVersion', 'releaseUrl', 'sha256', 'state', 'registeredAt',
];
const STATES = ['active', 'yanked', 'tombstoned'];

const errors = [];
const fail = (msg) => errors.push(msg);

function readJson(path, label = path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`${label}: cannot parse JSON (${e.message})`);
    return null;
  }
}

function validate(m, scope, name, rel) {
  for (const k of REQUIRED) {
    if (m[k] === undefined || m[k] === null || m[k] === '') fail(`${rel}: missing required field "${k}"`);
  }
  if (m.scope !== scope) fail(`${rel}: scope "${m.scope}" does not match directory "${scope}"`);
  if (m.name !== name) fail(`${rel}: name "${m.name}" does not match directory "${name}"`);
  if (m.id !== `@${scope}/${name}`) fail(`${rel}: id "${m.id}" must be "@${scope}/${name}"`);
  if (m.state !== undefined && !STATES.includes(m.state)) fail(`${rel}: invalid state "${m.state}"`);
  if (typeof m.sha256 === 'string' && !/^[0-9a-f]{64}$/.test(m.sha256)) fail(`${rel}: sha256 must be 64 lowercase hex chars`);
  if (typeof m.latestVersion === 'string' && !/^\d+\.\d+\.\d+([-+].+)?$/.test(m.latestVersion)) fail(`${rel}: latestVersion "${m.latestVersion}" is not semver`);
  if (typeof m.registeredAt === 'string' && Number.isNaN(Date.parse(m.registeredAt))) fail(`${rel}: registeredAt is not a date`);
}

// 1. Collect manifests
const pluginsDir = join(root, 'plugins');
const manifests = [];
if (!existsSync(pluginsDir)) fail('plugins/ directory not found');
else {
  for (const scope of readdirSync(pluginsDir).sort()) {
    if (!statSync(join(pluginsDir, scope)).isDirectory()) continue;
    for (const name of readdirSync(join(pluginsDir, scope)).sort()) {
      const dir = join(pluginsDir, scope, name);
      if (!statSync(dir).isDirectory()) continue;
      const rel = `plugins/${scope}/${name}/manifest.json`;
      const file = join(dir, 'manifest.json');
      if (!existsSync(file)) { fail(`${rel}: manifest.json missing`); continue; }
      const m = readJson(file, rel);
      if (!m || typeof m !== 'object' || Array.isArray(m)) { if (m) fail(`${rel}: not a JSON object`); continue; }
      validate(m, scope, name, rel);
      manifests.push(m);
    }
  }
}
const seen = new Set();
for (const m of manifests) {
  if (seen.has(m.id)) fail(`duplicate id ${m.id}`);
  seen.add(m.id);
}

// 2. Existing index (for stable order and unchanged updatedAt)
const indexPath = join(root, 'plugins.json');
let prev = null;
if (existsSync(indexPath)) prev = readJson(indexPath, "plugins.json");

if (errors.length) {
  console.error('build-index: FAILED, plugins.json not modified');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

// 3. Order: entries already in the index keep their position; new ones go after,
//    sorted by registeredAt then id.
const prevOrder = new Map((prev?.plugins ?? []).map((p, i) => [p.id, i]));
manifests.sort((a, b) => {
  const ia = prevOrder.has(a.id), ib = prevOrder.has(b.id);
  if (ia && ib) return prevOrder.get(a.id) - prevOrder.get(b.id);
  if (ia !== ib) return ia ? -1 : 1;
  return Date.parse(a.registeredAt) - Date.parse(b.registeredAt) || a.id.localeCompare(b.id);
});

// 4. updatedAt only moves when the plugin list actually changes.
const unchanged = prev && JSON.stringify(prev.plugins) === JSON.stringify(manifests);
const updatedAt = unchanged
  ? prev.updatedAt
  : (process.env.BUILD_INDEX_NOW ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));

const out = JSON.stringify({ schemaVersion: prev?.schemaVersion ?? 2, updatedAt, plugins: manifests }, null, 2) + '\n';
const current = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;

if (out === current) {
  console.log(`build-index: plugins.json up to date (${manifests.length} plugins)`);
  process.exit(0);
}
if (checkOnly) {
  console.error('build-index: plugins.json is out of date');
  process.exit(1);
}
// Atomic write: temp file then rename.
const tmp = `${indexPath}.tmp`;
writeFileSync(tmp, out);
renameSync(tmp, indexPath);
console.log(`build-index: plugins.json updated (${manifests.length} plugins, updatedAt ${updatedAt})`);
