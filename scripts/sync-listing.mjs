#!/usr/bin/env node
// Writes the marketplace listing fields (icon, screenshots, descriptionLocalized) of a catalog manifest
// from the plugin.json inside its release package, so an update PR carries exactly what the release says.
// Run it after setting latestVersion, releaseUrl and sha256 for the new version.
//
// The package is downloaded from releaseUrl (GitHub release hosts only) and must match sha256. Fields that
// break the listing rules are left out and reported; image paths become raw.githubusercontent.com URLs
// pinned to tag v<latestVersion>. Nothing else in the manifest changes. Zero dependencies.
//
// Usage: node scripts/sync-listing.mjs [--allow-local-download] <plugins/<scope>/<name>/manifest.json>...
//   --allow-local-download  tests only: allow http://127.0.0.1 release downloads
// Exit: 0 all manifests written / 1 a manifest could not be synced (left untouched)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntry } from './build-community-index.mjs';
import { makeContext } from './validate-pr.mjs';
import { LISTING_FIELDS, extractListing } from './lib/listing.mjs';

// Returns the manifest with its listing fields replaced, placed right after description.
export function withListing(manifest, listing) {
  const out = {};
  const put = () => { for (const f of LISTING_FIELDS) if (listing[f] !== undefined) out[f] = listing[f]; };
  let placed = false;
  for (const [k, v] of Object.entries(manifest)) {
    if (LISTING_FIELDS.includes(k)) continue;
    out[k] = v;
    if (k === 'description') { put(); placed = true; }
  }
  if (!placed) put();
  return out;
}

async function syncOne(file, ctx) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const repo = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(manifest.repo ?? ''));
  if (!repo) throw new Error(`repo ${JSON.stringify(manifest.repo)} is not a github.com repository URL`);
  if (typeof manifest.releaseUrl !== 'string' || !manifest.releaseUrl) throw new Error('releaseUrl is missing');
  const buf = await ctx.download(manifest.releaseUrl);
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== manifest.sha256) throw new Error(`sha256 mismatch: manifest ${manifest.sha256}, download ${actual}`);
  const raw = readZipEntry(buf, 'plugin.json');
  if (!raw) throw new Error('the release package has no plugin.json at the zip root');
  const pj = JSON.parse(raw.toString('utf8'));
  const { listing, problems } = extractListing(pj, { owner: repo[1], repo: repo[2], tag: `v${manifest.latestVersion}` });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(withListing(manifest, listing), null, 2) + '\n');
  renameSync(tmp, file);
  return { fields: Object.keys(listing), problems };
}

async function main() {
  const argv = process.argv.slice(2);
  const files = argv.filter((a) => !a.startsWith('--'));
  if (!files.length) { console.error('usage: node scripts/sync-listing.mjs [--allow-local-download] <manifest.json>...'); return 1; }
  const ctx = makeContext({ allowLocalDownload: argv.includes('--allow-local-download') });
  let code = 0;
  for (const f of files) {
    try {
      const r = await syncOne(resolve(f), ctx);
      console.log(`sync-listing: ${f}: ${r.fields.length ? r.fields.join(', ') : 'no listing fields'}`);
      for (const p of r.problems) console.warn(`sync-listing: ${f}: left out: ${p}`);
    } catch (e) {
      console.error(`sync-listing: ${f}: not changed (${e.message})`);
      code = 1;
    }
  }
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
