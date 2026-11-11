// Run: node --test scripts/test/
// Everything runs against a local mock of the GitHub REST API and locally built zip packages.
// No request ever leaves the machine. Temp directories are created under os.tmpdir() and left in place.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

import { checkEntry, isAllowedAssetUrl, isAllowedRedirectUrl, assertApiBase, parseSemver, compareSemver, readZipEntry } from '../build-community-index.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.COMMUNITY_INDEX_SCRIPT ?? resolve(HERE, '..', 'build-community-index.mjs');
const REPO_ROOT = resolve(HERE, '..', '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---- minimal zip writer (test helper) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(files, { deflate = false } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  const list = Array.isArray(files) ? files : Object.entries(files);
  for (const [name, content] of list) {
    const data = Buffer.from(content);
    const comp = deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp); centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(list.length, 8); end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---- mock GitHub ----
let server, base;
let repos = new Map(); // full_name -> { meta, release | null (404), zip, status }
let downloads = [];
let searchStatus = 200;
let searchIncomplete = false;
let searchTotal = null;
let searchDuplicate = false;

function pluginJson(owner, name, version, extra = {}) {
  return JSON.stringify({ id: `@${owner.toLowerCase()}/${name}`, name, version, author: owner, description: `${name} plugin`, minAppVersion: '1.0.0', renderer: 'dist/renderer.js', ...extra });
}
const ownerIdFor = (login) => 1000 + [...login].reduce((n, c) => n + c.charCodeAt(0), 0);
function addRepo(owner, name, version, { zipFiles, meta = {}, release = {}, deflate = false, pj = {} } = {}) {
  const full = `${owner}/${name}`;
  const zip = makeZip(zipFiles ?? { 'plugin.json': pluginJson(owner, name, version, pj), 'dist/renderer.js': `// ${full} ${version}` }, { deflate });
  repos.set(full, {
    meta: { full_name: full, html_url: `https://github.com/${full}`, private: false, fork: false, archived: false, owner: { login: owner, id: ownerIdFor(owner), type: 'User' }, ...meta },
    release: release === null ? null : { tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-11-01T00:00:00Z', assets: [{ name: `${name}-${version}.zip`, browser_download_url: `${base}/dl/${full}/${version}.zip` }], ...release },
    zip, version,
  });
  return zip;
}

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, base);
    if (u.pathname === '/search/repositories') {
      if (searchStatus !== 200) { res.writeHead(searchStatus).end('{}'); return; }
      const page = Number(u.searchParams.get('page') ?? 1), per = Number(u.searchParams.get('per_page') ?? 30);
      const all = [...repos.values()].filter((r) => r.inTopic !== false).map((r) => r.meta);
      const payload = { total_count: searchTotal ?? all.length, incomplete_results: searchIncomplete, items: all.slice((page - 1) * per, page * per) };
      if (searchTotal === 'missing') delete payload.total_count;
      if (searchDuplicate && payload.items.length) payload.items.push(payload.items[0]);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
      return;
    }
    let m = /^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(u.pathname);
    if (m) {
      const r = repos.get(m[1]);
      if (r?.releaseStatus) { res.writeHead(r.releaseStatus, r.releaseHeaders ?? {}).end('{}'); return; }
      if (!r || r.release === null) { res.writeHead(404).end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r.release));
      return;
    }
    m = /^\/chunked\/([^/]+\/[^/]+)\/(.+)\.zip$/.exec(u.pathname);
    if (m) {
      const r = repos.get(m[1]);
      downloads.push(`${m[1]}@${m[2]}`);
      res.writeHead(200, { 'content-type': 'application/zip' }); // no content-length: chunked transfer
      for (let i = 0; i < r.zip.length; i += 65536) res.write(r.zip.subarray(i, i + 65536));
      res.end();
      return;
    }
    m = /^\/redir\/([^/]+\/[^/]+)\/(.+)\.zip$/.exec(u.pathname);
    if (m) { res.writeHead(302, { location: `/dl/${m[1]}/${m[2]}.zip` }).end(); return; }
    if (u.pathname.startsWith('/redir-out/')) { res.writeHead(302, { location: 'http://127.0.0.2:1/x.zip' }).end(); return; }
    m = /^\/dl\/([^/]+\/[^/]+)\/(.+)\.zip$/.exec(u.pathname);
    if (m) {
      const r = repos.get(m[1]);
      downloads.push(`${m[1]}@${m[2]}`);
      if (!r) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'application/zip' }).end(r.zip);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function newRoot({ blocklist } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'community-index-'));
  copyFileSync(join(REPO_ROOT, 'plugins.json'), join(root, 'plugins.json')); // the real official index, read-only input
  mkdirSync(join(root, 'community'));
  if (blocklist) writeFileSync(join(root, 'community', 'blocklist.json'), JSON.stringify(blocklist));
  return root;
}
async function scanOnce(root, { now = '2026-11-12T00:00:00Z', env = {} } = {}) {
  downloads = [];
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, '--root', root, '--api-base', base], { env: { ...process.env, COMMUNITY_INDEX_NOW: now, ...env } });
    return { code: 0, stdout, stderr };
  } catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
}
const readIndex = (root) => JSON.parse(readFileSync(join(root, 'community', 'plugins.json'), 'utf8'));
const ids = (root) => readIndex(root).plugins.map((p) => p.id);
const reset = () => { repos = new Map(); downloads = []; searchStatus = 200; searchIncomplete = false; searchTotal = null; searchDuplicate = false; };

// ---- acceptance #1 ----
test('#1 a tagged public repo with a release package is listed after a scan', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  const root = newRoot();
  const r = await scanOnce(root);
  assert.equal(r.code, 0, r.stderr);
  const idx = readIndex(root);
  assert.equal(idx.tier, 'community');
  assert.equal(idx.schemaVersion, 1);
  assert.equal(idx.plugins.length, 1);
  const e = idx.plugins[0];
  assert.equal(e.id, '@alice/ruler');
  assert.equal(e.scope, 'alice');
  assert.equal(e.latestVersion, '1.0.0');
  assert.equal(e.repo, 'https://github.com/alice/ruler');
  assert.equal(e.releaseUrl, `${base}/dl/alice/ruler/1.0.0.zip`);
  assert.equal(e.state, 'active');
  assert.equal(e.reviewed, false);
  assert.equal(e.tier, 'community');
});

test('#1 a repo that is not in the topic search result is not listed', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  repos.get('alice/ruler').inTopic = false;
  const root = newRoot();
  assert.equal((await scanOnce(root)).code, 0);
  assert.deepEqual(ids(root), []);
});

test('#1 deflate-compressed packages are readable', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0', { deflate: true });
  const root = newRoot();
  assert.equal((await scanOnce(root)).code, 0);
  assert.deepEqual(ids(root), ['@alice/ruler']);
});

// ---- acceptance #2 ----
test('#2 the official index is byte-identical before and after a scan, and no official id is overwritten', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  addRepo('openpen-platform', 'arrow', '9.9.9', { pj: { id: '@openpen/arrow' } }); // tries to impersonate an official id
  addRepo('openpen', 'evil', '1.0.0');
  const root = newRoot();
  const before = readFileSync(join(root, 'plugins.json'));
  const realBefore = readFileSync(join(REPO_ROOT, 'plugins.json'));
  assert.equal((await scanOnce(root)).code, 0);
  assert.ok(readFileSync(join(root, 'plugins.json')).equals(before), 'plugins.json copy changed');
  assert.ok(readFileSync(join(REPO_ROOT, 'plugins.json')).equals(realBefore), 'real plugins.json changed');
  assert.deepEqual(ids(root), ['@alice/ruler']);
});

// ---- acceptance #3 ----
test('#3 the sha256 is computed from the downloaded package, not taken from the author', async () => {
  reset();
  const zip = addRepo('alice', 'ruler', '1.0.0', { pj: { sha256: 'a'.repeat(64) }, release: { body: `sha256: ${'b'.repeat(64)}` } });
  repos.get('alice/ruler').release.assets[0].digest = `sha256:${'c'.repeat(64)}`;
  const root = newRoot();
  assert.equal((await scanOnce(root)).code, 0);
  assert.equal(readIndex(root).plugins[0].sha256, sha(zip));
});

// ---- acceptance #4 ----
test('#4 blocklisted by owner, repo or id are not listed', async () => {
  reset();
  addRepo('mallory', 'a', '1.0.0');
  addRepo('bob', 'blocked-repo', '1.0.0');
  addRepo('carol', 'x', '1.0.0');
  addRepo('dave', 'ok', '1.0.0');
  const root = newRoot({ blocklist: { schemaVersion: 1, entries: [
    { match: 'owner', value: 'Mallory', reason: 't' },
    { match: 'repo', value: 'bob/blocked-repo', reason: 't' },
    { match: 'id', value: '@carol/x', reason: 't' },
  ] } });
  assert.equal((await scanOnce(root)).code, 0);
  assert.deepEqual(ids(root), ['@dave/ok']);
});

test('#4 blocklisting an already indexed plugin removes it on the next scan', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  addRepo('dave', 'ok', '1.0.0');
  const root = newRoot();
  await scanOnce(root);
  assert.deepEqual(ids(root), ['@alice/ruler', '@dave/ok']);
  writeFileSync(join(root, 'community', 'blocklist.json'), JSON.stringify({ schemaVersion: 1, entries: [{ match: 'id', value: '@alice/ruler', reason: 't' }] }));
  await scanOnce(root);
  assert.deepEqual(ids(root), ['@dave/ok']);
});

test('#4 an older or equal version does not replace the indexed one and is not downloaded again', async () => {
  reset();
  addRepo('alice', 'ruler', '1.2.0');
  const root = newRoot();
  await scanOnce(root);
  const first = readFileSync(join(root, 'community', 'plugins.json'), 'utf8');

  addRepo('alice', 'ruler', '1.0.0'); // author publishes an older release as "latest"
  const r1 = await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(r1.code, 0);
  assert.equal(readFileSync(join(root, 'community', 'plugins.json'), 'utf8'), first);
  assert.deepEqual(downloads, [], 'older release must not be downloaded');

  addRepo('alice', 'ruler', '1.2.0'); // same version again
  await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(readFileSync(join(root, 'community', 'plugins.json'), 'utf8'), first);
  assert.deepEqual(downloads, []);
});

test('#4 a lying tag cannot downgrade: tag says newer, package says older', async () => {
  reset();
  addRepo('alice', 'ruler', '1.2.0');
  const root = newRoot();
  await scanOnce(root);
  const first = readFileSync(join(root, 'community', 'plugins.json'), 'utf8');
  addRepo('alice', 'ruler', '0.5.0', { release: { tag_name: 'v9.0.0' } });
  await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(readFileSync(join(root, 'community', 'plugins.json'), 'utf8'), first);
});

test('#4 a newer version updates the entry, recomputes the hash and keeps indexedAt', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  const root = newRoot();
  await scanOnce(root, { now: '2026-11-12T00:00:00Z' });
  const zip2 = addRepo('alice', 'ruler', '1.1.0');
  await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  const idx = readIndex(root);
  assert.equal(idx.plugins[0].latestVersion, '1.1.0');
  assert.equal(idx.plugins[0].sha256, sha(zip2));
  assert.equal(idx.plugins[0].indexedAt, '2026-11-12T00:00:00Z');
  assert.equal(idx.updatedAt, '2026-11-13T00:00:00Z');
});

test('an unchanged scan does not rewrite the file or move updatedAt', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  const root = newRoot();
  await scanOnce(root, { now: '2026-11-12T00:00:00Z' });
  const first = readFileSync(join(root, 'community', 'plugins.json'), 'utf8');
  const r = await scanOnce(root, { now: '2026-11-20T00:00:00Z' });
  assert.match(r.stdout, /up to date/);
  assert.equal(readFileSync(join(root, 'community', 'plugins.json'), 'utf8'), first);
});

// ---- exclusion rules ----
test('forks, archived, private repos and unusable releases are not listed', async () => {
  reset();
  addRepo('f1', 'forked', '1.0.0', { meta: { fork: true } });
  addRepo('f2', 'old', '1.0.0', { meta: { archived: true } });
  addRepo('f3', 'priv', '1.0.0', { meta: { private: true } });
  addRepo('f4', 'norel', '1.0.0', { release: null });
  addRepo('f5', 'draft', '1.0.0', { release: { draft: true } });
  addRepo('f6', 'pre', '1.0.0', { release: { prerelease: true } });
  addRepo('f7', 'nozip', '1.0.0', { release: { assets: [{ name: 'notes.txt', browser_download_url: `${base}/dl/f7/nozip/1.0.0.zip` }] } });
  addRepo('f8', 'nomanifest', '1.0.0', { zipFiles: { 'dist/renderer.js': 'x' } });
  addRepo('f9', 'badscope', '1.0.0', { pj: { id: '@someoneelse/badscope' } });
  addRepo('g1', 'nover', '1.0.0', { pj: { version: 'latest' } });
  addRepo('g2', 'garbage', '1.0.0', { zipFiles: { 'plugin.json': '{not json' } });
  addRepo('good', 'one', '1.0.0');
  const root = newRoot();
  const r = await scanOnce(root);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(root), ['@good/one']);
});

test('one broken repo does not stop the others, and a transient failure keeps the old entry', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  const root = newRoot();
  await scanOnce(root);
  repos.get('alice/ruler').release = null; // release disappears (404)
  addRepo('dave', 'ok', '1.0.0');
  await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.deepEqual(ids(root), ['@alice/ruler', '@dave/ok']);
});

test('a repo that loses the topic is dropped from the list', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  const root = newRoot();
  await scanOnce(root);
  repos.get('alice/ruler').inTopic = false;
  await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.deepEqual(ids(root), []);
});

test('search results beyond one page are all collected', async () => {
  reset();
  for (let i = 0; i < 120; i++) addRepo(`user${i}`, 'p', '1.0.0');
  const root = newRoot();
  assert.equal((await scanOnce(root)).code, 0);
  assert.equal(ids(root).length, 120);
});

// ---- failure behaviour ----
test('a failing search exits non-zero and leaves the list untouched', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  const root = newRoot();
  await scanOnce(root);
  const first = readFileSync(join(root, 'community', 'plugins.json'), 'utf8');
  searchStatus = 403;
  const r = await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /FAILED/);
  assert.equal(readFileSync(join(root, 'community', 'plugins.json'), 'utf8'), first);
});

test('an invalid blocklist file fails the scan instead of being ignored', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  const root = newRoot({ blocklist: { schemaVersion: 1, entries: [{ match: 'nonsense', value: 'x', reason: 'y' }] } });
  const r = await scanOnce(root);
  assert.equal(r.code, 1);
  assert.equal(existsSync(join(root, 'community', 'plugins.json')), false);
});

// ---- review follow-ups ----
test('prerelease versions compare by semver precedence (rc.10 is newer than rc.2)', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0-rc.2');
  const root = newRoot();
  await scanOnce(root);
  addRepo('alice', 'ruler', '1.0.0-rc.10');
  await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(readIndex(root).plugins[0].latestVersion, '1.0.0-rc.10');
});

test('a package with two plugin.json entries is rejected', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0', { zipFiles: [['plugin.json', pluginJson('alice', 'ruler', '1.0.0')], ['plugin.json', pluginJson('alice', 'other', '1.0.0')]] });
  addRepo('good', 'one', '1.0.0');
  const root = newRoot();
  assert.equal((await scanOnce(root)).code, 0);
  assert.deepEqual(ids(root), ['@good/one']);
});

test('a package URL outside the allowed hosts is skipped without being fetched', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0', { release: { assets: [{ name: 'r.zip', browser_download_url: 'http://127.0.0.2:1/r.zip' }] } });
  addRepo('good', 'one', '1.0.0');
  const root = newRoot();
  const r = await scanOnce(root);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(root), ['@good/one']);
  assert.match(r.stdout, /asset URL is not allowed/);
});

test('a 403 on one repo (not a rate limit) skips that repo only; a rate-limit 403 fails the scan', async () => {
  reset();
  addRepo('blocked', 'dmca', '1.0.0');
  repos.get('blocked/dmca').releaseStatus = 403;
  addRepo('good', 'one', '1.0.0');
  const root = newRoot();
  const r1 = await scanOnce(root);
  assert.equal(r1.code, 0, r1.stderr);
  assert.deepEqual(ids(root), ['@good/one']);

  const first = readFileSync(join(root, 'community', 'plugins.json'), 'utf8');
  repos.get('blocked/dmca').releaseHeaders = { 'x-ratelimit-remaining': '0' };
  const r2 = await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(r2.code, 1);
  assert.equal(readFileSync(join(root, 'community', 'plugins.json'), 'utf8'), first);
});

test('two repos claiming the same id: the one already indexed keeps it', async () => {
  reset();
  addRepo('alice', 'zzz-first', '1.0.0', { pj: { id: '@alice/shared' } });
  const root = newRoot();
  await scanOnce(root);
  addRepo('alice', 'aaa-second', '1.0.0', { pj: { id: '@alice/shared' } }); // sorts before zzz-first alphabetically
  await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  const idx = readIndex(root);
  assert.equal(idx.plugins.length, 1);
  assert.equal(idx.plugins[0].repo, 'https://github.com/alice/zzz-first');
});

// ---- round 2 follow-ups ----
test('asset and redirect URL rules for the real GitHub API', () => {
  const api = 'https://api.github.com';
  const ok = 'https://github.com/alice/ruler/releases/download/v1.0.0/ruler-1.0.0.zip';
  assert.equal(isAllowedAssetUrl(ok, api, 'alice/ruler'), true);
  assert.equal(isAllowedAssetUrl(ok.replace('github.com/alice', 'GitHub.com/Alice'), api, 'alice/ruler'), true);
  for (const bad of [
    'https://github.com/bob/other/releases/download/v1/x.zip', // another repo's release
    'https://github.com/alice/ruler/raw/main/x.zip', // not a release download
    'https://raw.githubusercontent.com/alice/ruler/main/x.zip',
    'https://objects.githubusercontent.com/alice/ruler/releases/download/x.zip',
    'https://github.com@evil.example/alice/ruler/releases/download/x.zip',
    'https://evil.example/alice/ruler/releases/download/x.zip',
    'https://evil-github.com/alice/ruler/releases/download/x.zip',
    'https://github.com.evil.example/alice/ruler/releases/download/x.zip',
    'https://github.com:8443/alice/ruler/releases/download/x.zip',
    'http://github.com/alice/ruler/releases/download/x.zip',
    'not a url',
  ]) assert.equal(isAllowedAssetUrl(bad, api, 'alice/ruler'), false, bad);

  assert.equal(isAllowedRedirectUrl('https://objects.githubusercontent.com/x', api), true);
  assert.equal(isAllowedRedirectUrl('https://release-assets.githubusercontent.com/x', api), true);
  for (const bad of [
    'https://raw.githubusercontent.com/x',
    'https://gist.githubusercontent.com/x',
    'https://github.com/x',
    'https://evil-objects.githubusercontent.com.evil.example/x',
    'https://objects.githubusercontent.com@evil.example/x',
    'http://objects.githubusercontent.com/x',
  ]) assert.equal(isAllowedRedirectUrl(bad, api), false, bad);
});

test('the api base must be api.github.com or a loopback address', async () => {
  assert.doesNotThrow(() => assertApiBase('https://api.github.com'));
  assert.doesNotThrow(() => assertApiBase('http://127.0.0.1:8080'));
  assert.doesNotThrow(() => assertApiBase('http://localhost:8080'));
  for (const bad of ['http://api.github.com', 'https://example.com', 'http://192.168.1.5:80', 'ftp://127.0.0.1', 'nope']) {
    assert.throws(() => assertApiBase(bad), undefined, bad);
  }
  const root = newRoot();
  const out = await run(process.execPath, [SCRIPT, '--root', root, '--api-base', 'https://example.com']).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stderr: e.stderr }));
  assert.equal(out.code, 1);
  assert.match(out.stderr, /--api-base must be/);
});

test('a redirect inside the allowed host is followed; a redirect to another host is refused', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0', { release: { assets: [{ name: 'r.zip', browser_download_url: base + '/redir/alice/ruler/1.0.0.zip' }] } });
  addRepo('mallory', 'sneaky', '1.0.0', { release: { assets: [{ name: 'r.zip', browser_download_url: base + '/redir-out/mallory/sneaky.zip' }] } });
  const root = newRoot();
  const r = await scanOnce(root);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(root), ['@alice/ruler']);
  assert.match(r.stdout, /redirected to a host that is not allowed/);
});

test('a 403 with Retry-After (secondary rate limit) fails the scan and keeps the list', async () => {
  reset();
  addRepo('good', 'one', '1.0.0');
  const root = newRoot();
  await scanOnce(root);
  const first = readFileSync(join(root, 'community', 'plugins.json'), 'utf8');
  addRepo('slow', 'down', '1.0.0');
  repos.get('slow/down').releaseStatus = 403;
  repos.get('slow/down').releaseHeaders = { 'retry-after': '60' };
  const r = await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(r.code, 1);
  assert.equal(readFileSync(join(root, 'community', 'plugins.json'), 'utf8'), first);
});

test('semver parsing is strict and long numeric identifiers compare exactly', () => {
  for (const bad of ['01.0.0', '1.00.0', '1.0.0-01', '1.0.0-a..b', '1.0.0-', '1.0', 'v1.0.0', '1.0.0-rc.01']) assert.equal(parseSemver(bad), null, bad);
  assert.ok(parseSemver('1.0.0-rc.1+build.5'));
  assert.ok(compareSemver('1.0.0-9007199254740993', '1.0.0-9007199254740992') > 0);
  assert.ok(compareSemver('9007199254740993.0.0', '9007199254740992.0.0') > 0);
  assert.ok(compareSemver('1.0.0-rc.10', '1.0.0-rc.2') > 0);
  assert.ok(compareSemver('1.0.0-alpha', '1.0.0-1') > 0); // alphanumeric above numeric
  assert.ok(compareSemver('1.0.0', '1.0.0-rc.1') > 0);
  assert.equal(compareSemver('1.0.0', 'banana'), null);
});

test('a non-semver indexed version is never replaced (no downgrade through bad data)', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  const root = newRoot();
  await scanOnce(root);
  const idx = readIndex(root);
  idx.plugins[0].latestVersion = 'banana';
  writeFileSync(join(root, 'community', 'plugins.json'), JSON.stringify(idx, null, 2) + '\n');
  addRepo('alice', 'ruler', '9.0.0');
  await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(readIndex(root).plugins[0].latestVersion, 'banana');
});

test('zip: ambiguous entry names, mismatched local header and bad offsets are refused', async () => {
  const good = JSON.stringify({ id: '@a/b' });
  for (const variant of ['Plugin.json', './plugin.json', 'plugin.json/', 'PLUGIN.JSON']) {
    const zip = makeZip([['plugin.json', good], [variant, good]]);
    assert.throws(() => readZipEntry(zip, 'plugin.json'), /ambiguous/, variant);
  }
  const zip = makeZip({ 'plugin.json': good });
  const tampered = Buffer.from(zip);
  tampered.write('plugin.jsoX', 30); // local header name no longer matches the central directory
  assert.throws(() => readZipEntry(tampered, 'plugin.json'), /local header name differs/);

  const badDir = Buffer.from(zip);
  badDir.writeUInt32LE(zip.length + 1000, zip.length - 22 + 16); // central directory offset beyond the file
  assert.throws(() => readZipEntry(badDir, 'plugin.json'), /corrupt/);

  const cd = zip.length - 22 - 46 - 'plugin.json'.length;
  const lying = Buffer.from(zip);
  lying.writeUInt32LE(100000, cd + 20); // compressed size claims more than the file holds
  assert.throws(() => readZipEntry(lying, 'plugin.json'), /past end of file/);

  // end to end: a repo whose package has two ambiguous manifests is not listed
  reset();
  addRepo('alice', 'ruler', '1.0.0', { zipFiles: [['plugin.json', pluginJson('alice', 'ruler', '1.0.0')], ['Plugin.json', pluginJson('alice', 'ruler', '2.0.0')]] });
  const root = newRoot();
  assert.equal((await scanOnce(root)).code, 0);
  assert.deepEqual(ids(root), []);
});

test('a renamed repo keeps its version history: an older release does not replace, a newer one updates', async () => {
  reset();
  addRepo('alice', 'old-name', '1.2.0', { pj: { id: '@alice/ruler' } });
  const root = newRoot();
  await scanOnce(root, { now: '2026-11-12T00:00:00Z' });
  const original = readIndex(root).plugins[0];

  // the author renames the repo and publishes an older version as latest
  repos.get('alice/old-name').inTopic = false;
  addRepo('alice', 'new-name', '1.0.0', { pj: { id: '@alice/ruler' } });
  await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  let idx = readIndex(root);
  assert.equal(idx.plugins.length, 1);
  assert.equal(idx.plugins[0].latestVersion, '1.2.0');
  assert.equal(idx.plugins[0].sha256, original.sha256);
  assert.equal(idx.plugins[0].repo, 'https://github.com/alice/old-name');
  assert.equal(idx.plugins[0].releaseUrl, original.releaseUrl);

  // a newer version under the new name updates it and keeps the original indexedAt
  addRepo('alice', 'new-name', '1.3.0', { pj: { id: '@alice/ruler' } });
  await scanOnce(root, { now: '2026-11-14T00:00:00Z' });
  idx = readIndex(root);
  assert.equal(idx.plugins.length, 1);
  assert.equal(idx.plugins[0].latestVersion, '1.3.0');
  assert.equal(idx.plugins[0].indexedAt, '2026-11-12T00:00:00Z');
});

test('the same id under a different owner id (login re-registered by someone else) is not handed over', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  const root = newRoot();
  await scanOnce(root);

  // same login and repo URL, but a different account behind it, publishing a higher version
  addRepo('alice', 'ruler', '9.0.0', { meta: { owner: { login: 'alice', id: 424242, type: 'User' } } });
  const r = await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(root), [], 'old entry must not carry over to a different owner id');

  // same login, new repo name, different owner id, while the old entry is still indexed under another URL
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  const root2 = newRoot();
  await scanOnce(root2);
  repos.get('alice/ruler').inTopic = false;
  addRepo('alice', 'ruler2', '9.0.0', { pj: { id: '@alice/ruler' }, meta: { owner: { login: 'alice', id: 424242, type: 'User' } } });
  const r2 = await scanOnce(root2, { now: '2026-11-13T00:00:00Z' });
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /different owner/);
  assert.deepEqual(ids(root2), []);
});

// ---- round 3 follow-ups ----
test('identity: a repo that switches to another repo\'s id gets no history and cannot take the id, in either order', async () => {
  for (const [xName, yName] of [['zz-x', 'aa-y'], ['aa-x', 'zz-y']]) {
    reset();
    addRepo('alice', xName, '3.0.0', { pj: { id: '@alice/x' } });
    addRepo('alice', yName, '1.0.0', { pj: { id: '@alice/y' } });
    const root = newRoot();
    await scanOnce(root, { now: '2026-11-12T00:00:00Z' });
    assert.deepEqual(ids(root), ['@alice/x', '@alice/y']);
    const x1 = readIndex(root).plugins.find((p) => p.id === '@alice/x');
    const y1 = readIndex(root).plugins.find((p) => p.id === '@alice/y');

    addRepo('alice', yName, '2.0.0', { pj: { id: '@alice/x' } }); // Y now claims X's id with a lower version than X's 3.0.0
    const r = await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /still listed/);
    const idx = readIndex(root);
    const x2 = idx.plugins.find((p) => p.id === '@alice/x');
    assert.equal(x2.latestVersion, '3.0.0', 'X must not be downgraded (' + xName + ')');
    assert.equal(x2.repo, x1.repo, 'X must keep its own repo');
    assert.equal(x2.sha256, x1.sha256);
    assert.equal(x2.indexedAt, x1.indexedAt);
    assert.deepEqual(idx.plugins.find((p) => p.id === '@alice/y'), y1, 'Y keeps the entry it already had');
  }
});

test('identity: a renamed repo keeps its entry whole (repo, releaseUrl, sha256 stay together)', async () => {
  reset();
  addRepo('alice', 'old-name', '1.2.0', { pj: { id: '@alice/ruler' } });
  const root = newRoot();
  await scanOnce(root);
  const original = readIndex(root).plugins[0];
  repos.get('alice/old-name').inTopic = false;
  addRepo('alice', 'new-name', '1.0.0', { pj: { id: '@alice/ruler' } });
  await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.deepEqual(readIndex(root).plugins, [original]);
  await scanOnce(root, { now: '2026-11-14T00:00:00Z' }); // stays stable on the next scan
  assert.deepEqual(readIndex(root).plugins, [original]);
});

test('search: incomplete_results or more matches than the API can return fails the scan and keeps the list', async () => {
  reset();
  addRepo('good', 'one', '1.0.0');
  const root = newRoot();
  await scanOnce(root);
  const first = readFileSync(join(root, 'community', 'plugins.json'), 'utf8');

  searchIncomplete = true;
  const r1 = await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(r1.code, 1);
  assert.match(r1.stderr, /incomplete_results/);
  assert.equal(readFileSync(join(root, 'community', 'plugins.json'), 'utf8'), first);

  searchIncomplete = false;
  searchTotal = 1001;
  const r2 = await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /more than the 1000/);
  assert.equal(readFileSync(join(root, 'community', 'plugins.json'), 'utf8'), first);
});

test('budget: once used up, downloading stops, the rest keep their state and the list is still written (exit 0, warning)', async () => {
  reset();
  addRepo('good', 'one', '1.0.0');
  const root = newRoot();
  await scanOnce(root);
  const before = readIndex(root);
  addRepo('good', 'one', '1.1.0'); // an update that would be picked up with budget
  addRepo('big', 'one', '1.0.0');
  addRepo('big', 'two', '1.0.0');

  // byte budget far below one package: the first download trips it, nothing is added or changed
  const r1 = await scanOnce(root, { now: '2026-11-13T00:00:00Z', env: { COMMUNITY_INDEX_MAX_DOWNLOAD_BYTES: '10' } });
  assert.equal(r1.code, 0, r1.stderr);
  assert.match(r1.stderr, /WARNING scan budget exhausted/);
  assert.deepEqual(readIndex(root).plugins, before.plugins);

  // time budget of zero: nothing is downloaded at all
  const r2 = await scanOnce(root, { now: '2026-11-13T00:00:00Z', env: { COMMUNITY_INDEX_MAX_SECONDS: '0' } });
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stderr, /WARNING scan budget exhausted/);
  assert.deepEqual(downloads, []);
  assert.deepEqual(readIndex(root).plugins, before.plugins);

  // blocklist changes still take effect while the budget is exhausted
  writeFileSync(join(root, 'community', 'blocklist.json'), JSON.stringify({ schemaVersion: 1, entries: [{ match: 'owner', value: 'good', reason: 't' }] }));
  const r3 = await scanOnce(root, { now: '2026-11-13T00:00:00Z', env: { COMMUNITY_INDEX_MAX_SECONDS: '0' } });
  assert.equal(r3.code, 0, r3.stderr);
  assert.deepEqual(ids(root), []);
  writeFileSync(join(root, 'community', 'blocklist.json'), JSON.stringify({ schemaVersion: 1, entries: [] }));

  // default budget is enough for everything
  const r4 = await scanOnce(root, { now: '2026-11-14T00:00:00Z' });
  assert.equal(r4.code, 0, r4.stderr);
  assert.doesNotMatch(r4.stderr, /WARNING/);
  assert.deepEqual(ids(root), ['@big/one', '@big/two', '@good/one']);
});

test('budget: a non-numeric or negative limit fails the scan instead of switching the budget off', async () => {
  reset();
  addRepo('good', 'one', '1.0.0');
  const root = newRoot();
  for (const env of [{ COMMUNITY_INDEX_MAX_SECONDS: 'abc' }, { COMMUNITY_INDEX_MAX_DOWNLOAD_BYTES: '-5' }, { COMMUNITY_INDEX_MAX_DOWNLOAD_BYTES: 'NaN' }]) {
    const r = await scanOnce(root, { env });
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.match(r.stderr, /must be a non-negative number/);
  }
  assert.equal(existsSync(join(root, 'community', 'plugins.json')), false);
});

test('packages over 10 MiB are refused, with or without a content-length header', async () => {
  reset();
  const big = Buffer.alloc(11 * 1024 * 1024, 7);
  addRepo('huge', 'one', '1.0.0', { zipFiles: { 'plugin.json': pluginJson('huge', 'one', '1.0.0'), 'dist/big.bin': big } });
  addRepo('huge', 'two', '1.0.0', { zipFiles: { 'plugin.json': pluginJson('huge', 'two', '1.0.0'), 'dist/big.bin': big }, release: { assets: [{ name: 'r.zip', browser_download_url: base + '/chunked/huge/two/1.0.0.zip' }] } });
  addRepo('good', 'one', '1.0.0');
  const root = newRoot();
  const r = await scanOnce(root);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(root), ['@good/one']);
  assert.equal((r.stdout.match(/larger than 10485760 bytes/g) ?? []).length, 2);
});

test('search: a missing total_count, or fewer results than total_count, fails the scan and keeps the list', async () => {
  reset();
  addRepo('good', 'one', '1.0.0');
  const root = newRoot();
  await scanOnce(root);
  const first = readFileSync(join(root, 'community', 'plugins.json'), 'utf8');

  searchTotal = 'missing';
  const r1 = await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(r1.code, 1);
  assert.match(r1.stderr, /no total_count/);
  assert.equal(readFileSync(join(root, 'community', 'plugins.json'), 'utf8'), first);

  searchTotal = 5; // claims 5 matches but returns 1
  const r2 = await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /received 1 of 5/);
  assert.equal(readFileSync(join(root, 'community', 'plugins.json'), 'utf8'), first);
});

test('search: a repo repeated across pages is evaluated once', async () => {
  reset();
  addRepo('good', 'one', '1.0.0');
  searchDuplicate = true;
  const root = newRoot();
  const r = await scanOnce(root);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(root), ['@good/one']);
  assert.deepEqual(downloads, ['good/one@1.0.0']);
});

test('identity: a renamed plugin survives a transient failure of its new repo and keeps its version history', async () => {
  reset();
  addRepo('alice', 'old-name', '1.2.0', { pj: { id: '@alice/ruler' } });
  const root = newRoot();
  await scanOnce(root, { now: '2026-11-12T00:00:00Z' });
  const original = readIndex(root).plugins[0];

  // renamed; the new repo's release lookup fails with a server error this time
  repos.get('alice/old-name').inTopic = false;
  addRepo('alice', 'new-name', '1.0.0', { pj: { id: '@alice/ruler' } });
  repos.get('alice/new-name').releaseStatus = 503;
  const r1 = await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(r1.code, 0, r1.stderr);
  assert.deepEqual(readIndex(root).plugins, [original]);

  // the next scan succeeds with an older release: still not a downgrade
  repos.get('alice/new-name').releaseStatus = undefined;
  await scanOnce(root, { now: '2026-11-14T00:00:00Z' });
  assert.deepEqual(readIndex(root).plugins, [original]);
});

test('identity: a plugin whose repo is gone is still dropped when the owner has no repo that merely failed to load', async () => {
  reset();
  addRepo('alice', 'old-name', '1.2.0', { pj: { id: '@alice/ruler' } });
  addRepo('bob', 'other', '1.0.0');
  const root = newRoot();
  await scanOnce(root);
  repos.get('alice/old-name').inTopic = false;
  addRepo('alice', 'norelease', '1.0.0', { release: null }); // a permanent state, not a transient failure
  await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.deepEqual(ids(root), ['@bob/other']);
});

test('final check: an id that became official, or a scope that no longer matches the owner, is removed from the list', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  addRepo('good', 'one', '1.0.0');
  const root = newRoot();
  await scanOnce(root);
  assert.deepEqual(ids(root), ['@alice/ruler', '@good/one']);

  // the official catalog gains the same id (tag not newer, so the kept path is taken)
  const officialPath = join(root, 'plugins.json');
  const official = JSON.parse(readFileSync(officialPath, 'utf8'));
  official.plugins.push({ id: '@alice/ruler' });
  writeFileSync(officialPath, JSON.stringify(official));
  const r = await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(root), ['@good/one']);
  assert.match(r.stdout, /belongs to the official catalog/);

  const entry = { id: '@alice/ruler', scope: 'alice', repo: 'https://github.com/alice/ruler', ownerId: 1, ownerLogin: 'alice' };
  const ctx = { officialIds: new Set(), blocklist: [] };
  assert.equal(checkEntry(entry, ctx), null);
  assert.match(checkEntry(entry, { ...ctx, ownerLogin: 'alice2' }), /no longer matches owner/);
  assert.match(checkEntry(entry, { ...ctx, officialIds: new Set(['@alice/ruler']) }), /official/);
  assert.match(checkEntry({ ...entry, scope: 'openpen' }, ctx), /official/);
  assert.match(checkEntry(entry, { ...ctx, blocklist: [{ match: 'repo', value: 'alice/ruler' }] }), /blocklisted/);
});

test('blocklist: ownerId blocks an account even after it renamed its login, and removes earlier entries', async () => {
  reset();
  addRepo('mallory', 'tool', '1.0.0');
  addRepo('good', 'one', '1.0.0');
  const root = newRoot();
  await scanOnce(root);
  assert.deepEqual(ids(root), ['@good/one', '@mallory/tool']);

  const malloryId = ownerIdFor('mallory');
  writeFileSync(join(root, 'community', 'blocklist.json'), JSON.stringify({ schemaVersion: 1, entries: [{ match: 'ownerId', value: malloryId, reason: 't' }] }));
  await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.deepEqual(ids(root), ['@good/one']);

  // the account renames itself (same numeric id, new login, new repo name) and publishes again
  reset();
  addRepo('good', 'one', '1.0.0');
  addRepo('mallory2', 'tool2', '1.0.0', { meta: { owner: { login: 'mallory2', id: malloryId, type: 'User' } } });
  writeFileSync(join(root, 'community', 'blocklist.json'), JSON.stringify({ schemaVersion: 1, entries: [{ match: 'ownerId', value: String(malloryId), reason: 't' }] })); // string form
  await scanOnce(root, { now: '2026-11-14T00:00:00Z' });
  assert.deepEqual(ids(root), ['@good/one']);

  writeFileSync(join(root, 'community', 'blocklist.json'), JSON.stringify({ schemaVersion: 1, entries: [{ match: 'ownerId', value: 'mallory', reason: 't' }] }));
  const bad = await scanOnce(root, { now: '2026-11-15T00:00:00Z' });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /numeric GitHub account id/);
});

test('zip: names that resolve to plugin.json after normalising, and a second end record, are refused', () => {
  const good = JSON.stringify({ id: '@a/b' });
  for (const variant of ['/plugin.json', 'dist/../plugin.json', 'a/../plugin.json', '.\\plugin.json']) {
    assert.throws(() => readZipEntry(makeZip([['plugin.json', good], [variant, good]]), 'plugin.json'), /ambiguous/, variant);
  }
  assert.doesNotThrow(() => readZipEntry(makeZip([['plugin.json', good], ['dist/plugin.json', 'x']]), 'plugin.json')); // a nested file is not ambiguous

  const zip = makeZip({ 'plugin.json': good });
  const withHiddenEnd = Buffer.from(zip);
  withHiddenEnd.writeUInt16LE(22, zip.length - 22 + 20); // comment length: room for a second record
  const fakeEnd = Buffer.alloc(22);
  fakeEnd.writeUInt32LE(0x06054b50, 0);
  assert.throws(() => readZipEntry(Buffer.concat([withHiddenEnd, fakeEnd]), 'plugin.json'), /more than one end-of-central-directory/);
});

test('ordering does not depend on the locale', async () => {
  reset();
  addRepo('u', 'alpha', '1.0.0');
  addRepo('u', 'Zeta', '1.0.0');
  const root = newRoot();
  await scanOnce(root);
  assert.deepEqual(ids(root), ['@u/Zeta', '@u/alpha']); // plain code-unit order: upper case before lower case
});

// ---- round 5 follow-ups ----
test('identity: a carried-over entry is dropped when the owner has renamed its login', async () => {
  reset();
  addRepo('alice', 'ruler', '1.0.0');
  const root = newRoot();
  await scanOnce(root);
  assert.deepEqual(ids(root), ['@alice/ruler']);

  // same account (same numeric id) now called alice2; its only repo fails to load this time
  repos.get('alice/ruler').inTopic = false;
  addRepo('alice2', 'other', '1.0.0', { meta: { owner: { login: 'alice2', id: ownerIdFor('alice'), type: 'User' } } });
  repos.get('alice2/other').releaseStatus = 503;
  const r = await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(root), [], 'scope "alice" must not be carried over for login "alice2"');
});

test('identity: a repo whose own entry was just dropped does not make older entries of its owner carry over', async () => {
  reset();
  addRepo('alice', 'foo-repo', '1.0.0', { pj: { id: '@alice/foo' } });
  addRepo('alice', 'old-name', '1.0.0', { pj: { id: '@alice/bar' } });
  const root = newRoot();
  await scanOnce(root);
  assert.deepEqual(ids(root), ['@alice/bar', '@alice/foo']);

  repos.get('alice/old-name').inTopic = false; // its repo is gone
  const officialPath = join(root, 'plugins.json');
  const official = JSON.parse(readFileSync(officialPath, 'utf8'));
  official.plugins.push({ id: '@alice/foo' }); // foo became official, and its repo fails to load right now
  writeFileSync(officialPath, JSON.stringify(official));
  repos.get('alice/foo-repo').releaseStatus = 503;
  const r = await scanOnce(root, { now: '2026-11-13T00:00:00Z' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(root), []);
});

test('search: a repo repeated on one page while another is missed does not pass the total_count check', async () => {
  reset();
  addRepo('good', 'one', '1.0.0');
  searchDuplicate = true; // the result repeats good/one ...
  searchTotal = 2; // ... but GitHub says there are two matches
  const root = newRoot();
  const r = await scanOnce(root);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /received 1 of 2/);
});

test('checkEntry refuses an entry whose owner id changed', () => {
  const entry = { id: '@alice/ruler', scope: 'alice', repo: 'https://github.com/alice/ruler', ownerId: 1, ownerLogin: 'alice' };
  const ctx = { officialIds: new Set(), blocklist: [] };
  assert.equal(checkEntry(entry, { ...ctx, ownerId: 1 }), null);
  assert.match(checkEntry(entry, { ...ctx, ownerId: 2 }), /owner id changed/);
});
