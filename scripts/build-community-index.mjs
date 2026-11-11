#!/usr/bin/env node
// Scans public GitHub repositories tagged with the `openpen-plugin` topic and writes
// community/plugins.json. This is a separate list from the official plugins.json,
// which this script only reads (to reject ids that collide with official plugins) and never writes.
//
// Zero dependencies. Exits non-zero and leaves community/plugins.json untouched when the
// scan as a whole cannot be trusted (API error, rate limit, invalid blocklist).
//
// Usage: node scripts/build-community-index.mjs [--root <dir>] [--api-base <url>] [--check]
//   --root      repository root (default: .)
//   --api-base  GitHub REST API base (default: https://api.github.com)
//   --check     do not write; exit 1 if community/plugins.json would change.
// Env: GITHUB_TOKEN              optional, raises the API rate limit (never sent to asset downloads)
//      COMMUNITY_INDEX_NOW       ISO timestamp used for updatedAt/indexedAt (for tests)
//      COMMUNITY_INDEX_MAX_DOWNLOAD_BYTES / COMMUNITY_INDEX_MAX_SECONDS
//                                whole-scan budget (defaults 500 MiB, 1200 s); once it is used up the scan stops
//                                downloading, leaves the remaining repos as they were and prints a warning

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const TOPIC = 'openpen-plugin';
const MAX_ZIP_BYTES = 10 * 1024 * 1024; // official packages are around 12 KB
const MAX_PLUGIN_JSON_BYTES = 1024 * 1024;
const SEARCH_PAGE_SIZE = 100;
const SEARCH_MAX_PAGES = 10; // GitHub search returns at most 1000 results
// Strict semver 2.0.0 (no leading zeros in numeric parts, no empty identifiers).
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const DOWNLOAD_HOPS_MAX = 5;
// Hosts a release download may be redirected to when talking to the real GitHub.
const GITHUB_CDN_HOSTS = ['objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
const MATCH_KINDS = ['id', 'repo', 'owner', 'ownerId'];
// Whole-scan budget: a scan that needs more than this fails instead of running for hours.
const DEFAULT_MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_SECONDS = 20 * 60;
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // locale-independent ordering
const REQUIRED_PLUGIN_JSON = ['id', 'name', 'version', 'description', 'minAppVersion'];

// ---------- helpers ----------

export function parseSemver(v) {
  const m = typeof v === 'string' ? SEMVER.exec(v) : null;
  return m ? { nums: [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])], pre: m[4] ?? null } : null;
}

const cmpBig = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// <0, 0, >0. A prerelease sorts below the same release. Returns null if either side is not semver.
export function compareSemver(a, b) {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return cmpBig(pa.nums[i], pb.nums[i]);
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const xa = pa.pre.split('.'), xb = pb.pre.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^[0-9]+$/.test(xa[i]), nb = /^[0-9]+$/.test(xb[i]);
    if (na && nb) { if (BigInt(xa[i]) !== BigInt(xb[i])) return cmpBig(BigInt(xa[i]), BigInt(xb[i])); }
    else if (na !== nb) return na ? -1 : 1; // numeric identifiers sort below alphanumeric ones
    else if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Reads one entry from a zip held in memory. Supports stored (0) and deflate (8); no zip64.
export function readZipEntry(buf, wanted, maxBytes = MAX_PLUGIN_JSON_BYTES) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      // A second end-of-central-directory record makes the package read differently in different tools.
      if (eocd >= 0) throw new Error('zip has more than one end-of-central-directory record');
      eocd = i;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (end of central directory not found)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let found = null;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // Names that resolve to the wanted one only after normalising (case, "./", "../", leading or trailing
    // slashes, backslashes) are ambiguous (other unzip tools may pick them), so the whole package is refused.
    const normalized = posix.normalize(name.replace(/\\/g, '/')).replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
    if (normalized === wanted.toLowerCase() && name !== wanted) throw new Error(`zip has an ambiguous entry name "${name}"`);
    if (name === wanted) {
      if (found !== null) throw new Error(`zip contains more than one ${wanted}`);
      if (size > maxBytes) throw new Error(`${wanted} is larger than ${maxBytes} bytes`);
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt zip local header');
      const localNameLen = buf.readUInt16LE(local + 26);
      if (buf.toString('utf8', local + 30, local + 30 + localNameLen) !== name) throw new Error('corrupt zip: local header name differs from central directory');
      const start = local + 30 + localNameLen + buf.readUInt16LE(local + 28);
      if (start + compSize > buf.length) throw new Error('corrupt zip: entry runs past end of file');
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) found = Buffer.from(raw);
      else if (method === 8) found = inflateRawSync(raw, { maxOutputLength: maxBytes });
      else throw new Error(`unsupported zip compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return found;
}

// ---------- blocklist ----------

export function loadBlocklist(path) {
  if (!existsSync(path)) return [];
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`blocklist: cannot parse JSON (${e.message})`); }
  if (!data || !Array.isArray(data.entries)) throw new Error('blocklist: "entries" array is required');
  return data.entries.map((e, i) => {
    if (!e || !MATCH_KINDS.includes(e.match)) throw new Error(`blocklist: entries[${i}].match must be one of ${MATCH_KINDS.join(', ')}`);
    const value = typeof e.value === 'number' ? String(e.value) : e.value;
    if (typeof value !== 'string' || !value) throw new Error(`blocklist: entries[${i}].value is required`);
    if (e.match === 'ownerId' && !/^[0-9]+$/.test(value)) throw new Error(`blocklist: entries[${i}].value must be a numeric GitHub account id for match "ownerId"`);
    if (typeof e.reason !== 'string' || !e.reason) throw new Error(`blocklist: entries[${i}].reason is required`);
    return { match: e.match, value: value.toLowerCase() };
  });
}

// owner and repo match by name; ownerId matches the numeric GitHub account id, so it still applies after
// the account changes its login.
export function isBlocked(blocklist, { id, repoFullName, ownerLogin, ownerId }) {
  const owner = ownerLogin?.toLowerCase();
  const repo = repoFullName?.toLowerCase();
  const pid = id?.toLowerCase();
  const oid = ownerId === undefined || ownerId === null ? undefined : String(ownerId);
  return blocklist.some((b) =>
    (b.match === 'owner' && b.value === owner) ||
    (b.match === 'repo' && b.value === repo) ||
    (b.match === 'ownerId' && oid !== undefined && b.value === oid) ||
    (b.match === 'id' && pid !== undefined && b.value === pid));
}

// ---------- GitHub (or mock) API ----------

class ApiError extends Error {} // the scan as a whole cannot be trusted: fail and leave the list untouched
class BudgetError extends Error {} // the whole-scan download budget is used up: stop downloading, keep the rest as is
class PermanentError extends Error {} // a download problem that retrying will not fix

async function apiGet(apiBase, path, token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'openpen-community-index' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${apiBase}${path}`, { headers, signal: AbortSignal.timeout(30000) });
  return res;
}

async function searchRepos(apiBase, token) {
  const items = [];
  let total;
  for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
    const res = await apiGet(apiBase, `/search/repositories?q=topic:${TOPIC}&per_page=${SEARCH_PAGE_SIZE}&page=${page}`, token);
    if (!res.ok) { await cancelBody(res); throw new ApiError(`search failed: HTTP ${res.status}`); }
    const body = await res.json();
    if (!body || !Array.isArray(body.items)) throw new ApiError('search failed: response has no items array');
    // An incomplete or truncated result would make every missing repo look like it lost its topic and
    // remove it from the list, so the scan fails instead.
    if (body.incomplete_results === true) throw new ApiError('search failed: GitHub reported incomplete_results');
    if (!Number.isInteger(body.total_count)) throw new ApiError('search failed: response has no total_count');
    if (body.total_count > SEARCH_PAGE_SIZE * SEARCH_MAX_PAGES) {
      throw new ApiError(`search matches ${body.total_count} repositories, more than the ${SEARCH_PAGE_SIZE * SEARCH_MAX_PAGES} the API returns`);
    }
    total = body.total_count;
    items.push(...body.items);
    if (body.items.length < SEARCH_PAGE_SIZE) break;
  }
  // Pages can shift between requests and repeat a repo while another one is missed, so the comparison with
  // total_count is made on distinct repositories.
  const distinct = new Map(items.map((r) => [r.html_url.toLowerCase(), r]));
  if (distinct.size < total) throw new ApiError(`search failed: received ${distinct.size} of ${total} results`);
  return [...distinct.values()];
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

// The API base is either the real GitHub API or a loopback mock; anything else is refused.
export function assertApiBase(apiBase) {
  let api;
  try { api = new URL(apiBase); } catch { throw new Error(`--api-base is not a URL: ${apiBase}`); }
  if (api.hostname === 'api.github.com' && api.protocol === 'https:') return;
  if (LOOPBACK_HOSTS.includes(api.hostname) && (api.protocol === 'http:' || api.protocol === 'https:')) return;
  throw new Error('--api-base must be https://api.github.com or a loopback address');
}

// The package URL comes from the release's asset list. Against the real API it must be that repo's own
// release download path on github.com; against a loopback mock it must be on the mock's host.
export function isAllowedAssetUrl(url, apiBase, fullName) {
  let u, api;
  try { u = new URL(url); api = new URL(apiBase); } catch { return false; }
  if (api.hostname === 'api.github.com') {
    return u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password && !u.port &&
      u.pathname.toLowerCase().startsWith(`/${fullName.toLowerCase()}/releases/download/`);
  }
  return u.host === api.host;
}

// Every redirect hop is checked again: GitHub's own CDN hosts for the real API, the mock's host otherwise.
export function isAllowedRedirectUrl(url, apiBase) {
  let u, api;
  try { u = new URL(url); api = new URL(apiBase); } catch { return false; }
  if (api.hostname === 'api.github.com') {
    return u.protocol === 'https:' && GITHUB_CDN_HOSTS.includes(u.hostname) && !u.username && !u.password && !u.port;
  }
  return u.host === api.host;
}

async function cancelBody(res) {
  try { await res.body?.cancel(); } catch { /* the connection is already gone */ }
}

async function download(url, apiBase, budget) {
  const tooBig = () => new PermanentError(`package is larger than ${MAX_ZIP_BYTES} bytes`);
  let current = url;
  let res;
  for (let hop = 0; ; hop++) {
    res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(60000) });
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    await cancelBody(res);
    const location = res.headers.get('location');
    if (!location || hop >= DOWNLOAD_HOPS_MAX) throw new PermanentError('download redirected too many times or without a location');
    const next = new URL(location, current).toString();
    if (!isAllowedRedirectUrl(next, apiBase)) throw new PermanentError(`download redirected to a host that is not allowed: ${next}`);
    current = next;
  }
  if (!res.ok) { await cancelBody(res); throw new Error(`download failed: HTTP ${res.status}`); }
  if (Number(res.headers.get('content-length')) > MAX_ZIP_BYTES) { await cancelBody(res); throw tooBig(); }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    budget.bytes += chunk.length;
    if (budget.bytes > budget.maxBytes) { await cancelBody(res); throw new BudgetError(`more than ${budget.maxBytes} bytes downloaded in this scan`); }
    if (total > MAX_ZIP_BYTES) { await cancelBody(res); throw tooBig(); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 429, or 403 with an exhausted quota or a Retry-After header (secondary rate limit): the scan as a whole
// cannot be trusted, so it fails instead of silently keeping stale entries.
const isRateLimited = (res) => res.status === 429 ||
  (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')));

// ---------- per-repo evaluation ----------
// Returns { kind: 'keep' | 'entry' | 'skip', ... }.
//   entry: a (new or updated) index entry
//   keep:  nothing to change, keep whatever is already indexed for this repo
//   skip:  could not index; keep the previous entry (if any) and log why

async function evaluateRepo({ apiBase, token, repo, previous: previousByUrl, previousById, listedUrls, officialIds, blocklist, budget, now, log }) {
  let previous = previousByUrl;
  const full = repo.full_name;
  // transient: the repo may well be fine and could not be checked right now (server error, network)
  const skip = (why, transient = false) => { log(`skip ${full}: ${why}`); return { kind: 'skip', transient }; };

  const res = await apiGet(apiBase, `/repos/${full}/releases/latest`, token);
  if (res.status === 404) { await cancelBody(res); return skip('no published release'); }
  if (isRateLimited(res)) { await cancelBody(res); throw new ApiError(`rate limited on ${full}: HTTP ${res.status}`); }
  if (!res.ok) { await cancelBody(res); return skip(`release lookup failed: HTTP ${res.status}`, res.status >= 500); }
  const rel = await res.json();
  if (rel.draft || rel.prerelease) return skip('latest release is a draft or prerelease');
  const asset = (rel.assets ?? []).find((a) => typeof a.name === 'string' && a.name.toLowerCase().endsWith('.zip'));
  if (!asset || !asset.browser_download_url) return skip('latest release has no .zip asset');

  // Cheap pre-check from the tag, so an unchanged or older release is not downloaded.
  const tagVersion = String(rel.tag_name ?? '').replace(/^v/, '');
  if (previous && compareSemver(tagVersion, previous.latestVersion) !== null && compareSemver(tagVersion, previous.latestVersion) <= 0) {
    log(`keep ${full}: release ${tagVersion} is not newer than indexed ${previous.latestVersion}`);
    return { kind: 'keep' };
  }

  if (!isAllowedAssetUrl(asset.browser_download_url, apiBase, full)) return skip(`asset URL is not allowed: ${asset.browser_download_url}`);
  let buf;
  try {
    buf = await download(asset.browser_download_url, apiBase, budget);
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    return skip(e.message, !(e instanceof PermanentError));
  }
  let manifest;
  try {
    const raw = readZipEntry(buf, 'plugin.json');
    if (!raw) return skip('package has no plugin.json at the zip root');
    manifest = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return skip(e.message);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return skip('plugin.json is not an object');
  for (const k of REQUIRED_PLUGIN_JSON) {
    if (typeof manifest[k] !== 'string' || !manifest[k]) return skip(`plugin.json is missing "${k}"`);
  }
  if (!parseSemver(manifest.version)) return skip(`plugin.json version "${manifest.version}" is not semver`);

  const ownerLogin = repo.owner.login;
  const m = /^@([^/]+)\/([^/]+)$/.exec(manifest.id);
  if (!m) return skip(`plugin.json id "${manifest.id}" is not @scope/name`);
  const [, scope, name] = m;
  if (scope.toLowerCase() !== ownerLogin.toLowerCase()) return skip(`id scope "${scope}" does not match repo owner "${ownerLogin}"`);
  const id = `@${scope.toLowerCase()}/${name}`;
  if (id !== manifest.id) return skip(`plugin.json id "${manifest.id}" must be lowercase scope "${id}"`);
  if (scope.toLowerCase() === 'openpen' || officialIds.has(id)) return skip(`id ${id} belongs to the official catalog`);
  if (isBlocked(blocklist, { id, repoFullName: full, ownerLogin, ownerId: repo.owner.id })) return skip(`id ${id} is blocklisted`);

  // Whose version history does this id continue?
  // - The entry this repo URL already owns counts only if it is for the same id; a repo that switches
  //   to an id it did not own gets no history from its old entry.
  // - An entry for the same id under another repo URL counts only if that repo has disappeared from the
  //   scan (renamed or moved). If that repo is still listed, the two repos are fighting over one id and
  //   the one already indexed keeps it, whatever the order the search returns them in.
  // - A different owner id for the same id is never a rename (the login was re-registered by someone
  //   else): refuse it instead of handing the id over.
  if (previous && previous.id !== id) previous = undefined;
  const indexed = previousById.get(id);
  if (indexed) {
    if (indexed.ownerId !== repo.owner.id) return skip(`id ${id} is already indexed for a different owner`);
    const sameRepo = indexed.repo.toLowerCase() === repo.html_url.toLowerCase();
    if (!sameRepo && listedUrls.has(indexed.repo.toLowerCase())) return skip(`id ${id} is already indexed for ${indexed.repo}, which is still listed`);
    previous = indexed;
  }

  // The version in the package is authoritative (the tag is only a hint).
  if (previous) {
    const c = compareSemver(manifest.version, previous.latestVersion);
    if (c === null || c <= 0) { // null: the indexed version is not semver, so nothing may replace it
      log(`keep ${full}: package version ${manifest.version} is not newer than indexed ${previous.latestVersion}`);
      return { kind: 'keep', entry: previous }; // unchanged as a whole: repo, releaseUrl and sha256 stay together
    }
  }

  return {
    kind: 'entry',
    entry: {
      id,
      scope: scope.toLowerCase(),
      name,
      ownerId: repo.owner.id,
      ownerLogin,
      ownerType: repo.owner.type,
      description: manifest.description,
      minAppVersion: manifest.minAppVersion,
      repo: repo.html_url,
      latestVersion: manifest.version,
      releaseUrl: asset.browser_download_url,
      sha256: sha256(buf), // computed here from the downloaded bytes; never taken from the author
      state: 'active',
      tier: 'community',
      reviewed: false,
      indexedAt: previous?.indexedAt ?? now,
      releasedAt: rel.published_at ?? now,
    },
  };
}

// ---------- main scan ----------

// Re-checks an entry that is about to be written, whether it is new or carried over from the last scan:
// official ids may have been added since, the owner may have changed its login, the blocklist may have grown.
// ctx.ownerLogin / ctx.repoFullName / ctx.ownerId override what the entry itself says (current values).
export function checkEntry(entry, { officialIds, blocklist, ownerLogin, repoFullName, ownerId }) {
  if (ownerId !== undefined && entry.ownerId !== ownerId) return `owner id changed from ${entry.ownerId} to ${ownerId}`;
  if (ownerLogin !== undefined && entry.scope !== ownerLogin.toLowerCase()) return `scope "${entry.scope}" no longer matches owner "${ownerLogin}"`;
  if (entry.scope === 'openpen' || officialIds.has(entry.id)) return `id ${entry.id} belongs to the official catalog`;
  const fromUrl = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(entry.repo ?? '');
  if (isBlocked(blocklist, {
    id: entry.id,
    repoFullName: repoFullName ?? fromUrl?.[1],
    ownerLogin: ownerLogin ?? entry.ownerLogin,
    ownerId: ownerId ?? entry.ownerId,
  })) return `${entry.id} is blocklisted`;
  return null;
}

export async function scan({ root, apiBase, token, now, log = console.log, maxDownloadBytes = DEFAULT_MAX_DOWNLOAD_BYTES, maxSeconds = DEFAULT_MAX_SECONDS }) {
  assertApiBase(apiBase);
  for (const [name, v] of [['maxDownloadBytes', maxDownloadBytes], ['maxSeconds', maxSeconds]]) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
  }
  // The clock starts here, so the search requests count too.
  const budget = { bytes: 0, maxBytes: maxDownloadBytes, deadline: Date.now() + maxSeconds * 1000, exhausted: false };
  const warnings = [];
  const blocklist = loadBlocklist(join(root, 'community', 'blocklist.json'));
  const officialPath = join(root, 'plugins.json');
  const officialIds = new Set(
    existsSync(officialPath) ? (JSON.parse(readFileSync(officialPath, 'utf8')).plugins ?? []).map((p) => p.id) : []);

  const indexPath = join(root, 'community', 'plugins.json');
  let prev = null;
  if (existsSync(indexPath)) {
    try { prev = JSON.parse(readFileSync(indexPath, 'utf8')); }
    catch (e) { throw new Error(`community/plugins.json: cannot parse JSON (${e.message})`); }
  }
  const previousByRepo = new Map((prev?.plugins ?? []).map((p) => [p.repo.toLowerCase(), p]));
  const previousById = new Map((prev?.plugins ?? []).map((p) => [p.id, p]));

  const found = (await searchRepos(apiBase, token)).filter((r) => {
    if (r.private) { log(`skip ${r.full_name}: private`); return false; }
    if (r.fork) { log(`skip ${r.full_name}: fork`); return false; }
    if (r.archived) { log(`skip ${r.full_name}: archived`); return false; }
    return true;
  });
  const listedUrls = new Set(found.map((r) => r.html_url.toLowerCase()));
  const unresolvedOwners = new Map(); // owner id -> current login, for owners with a repo that could not be checked right now
  let unscanned = 0;

  // Repos that are already indexed go first, then by name, so the outcome does not depend on search order.
  found.sort((a, b) => (previousByRepo.has(b.html_url.toLowerCase()) - previousByRepo.has(a.html_url.toLowerCase())) || byString(a.full_name, b.full_name));
  const result = new Map(); // repo html_url (lowercase) -> entry
  const idOwner = new Map(); // id -> repo url, to refuse two repos claiming the same id
  for (const repo of found) {
    const key = repo.html_url.toLowerCase();
    // An entry for the same URL but another owner id means the repo was deleted and re-created by
    // someone else who now holds the login; the old entry does not carry over.
    const byUrl = previousByRepo.get(key);
    const previous = byUrl && byUrl.ownerId === repo.owner.id ? byUrl : undefined;
    // Blocklist on owner/repo/ownerId is checked before any network call for the repo.
    if (isBlocked(blocklist, { repoFullName: repo.full_name, ownerLogin: repo.owner.login, ownerId: repo.owner.id })) {
      log(`skip ${repo.full_name}: blocklisted`);
      continue; // dropped from the list, also when it was indexed before
    }
    let out;
    if (budget.exhausted || Date.now() >= budget.deadline) {
      // Budget used up: stop downloading, leave this repo as it was.
      budget.exhausted = true;
      unscanned++;
      out = { kind: 'skip', transient: true };
    } else {
      try {
        out = await evaluateRepo({ apiBase, token, repo, previous, previousById, listedUrls, officialIds, blocklist, budget, now, log });
      } catch (e) {
        if (e instanceof BudgetError) {
          budget.exhausted = true;
          unscanned++;
          log(`skip ${repo.full_name}: ${e.message}`);
          out = { kind: 'skip', transient: true };
        } else if (e instanceof ApiError) {
          throw e;
        } else {
          out = { kind: 'skip', transient: false };
          log(`skip ${repo.full_name}: ${e.message}`);
        }
      }
    }
    // Whatever is about to be written is checked again against the current official ids, owner login and blocklist.
    let kept = out.kind === 'entry' || (out.kind === 'keep' && out.entry) ? out.entry : previous;
    const problem = kept && checkEntry(kept, { officialIds, blocklist, ownerLogin: repo.owner.login, repoFullName: repo.full_name, ownerId: repo.owner.id });
    if (problem) {
      log(`drop ${repo.full_name}: ${problem}`);
      kept = undefined;
    }
    if (!kept) {
      // Only a repo that has no entry of its own and could merely not be checked makes the owner "unresolved";
      // a repo whose entry was just dropped for a reason does not.
      if (!problem && out.kind === 'skip' && out.transient) unresolvedOwners.set(repo.owner.id, repo.owner.login);
      continue;
    }
    const claimed = idOwner.get(kept.id);
    if (claimed && claimed !== key) { log(`skip ${repo.full_name}: id ${kept.id} already claimed by ${claimed}`); continue; }
    idOwner.set(kept.id, key);
    result.set(key, kept);
  }

  // An indexed plugin whose repo has vanished from the search is normally dropped. If another repo of the
  // same owner could not be checked right now, it may be that same plugin under a new name: keep the old
  // entry for this scan instead of losing its version history.
  const idsInResult = new Set([...result.values()].map((e) => e.id));
  for (const p of prev?.plugins ?? []) {
    if (idsInResult.has(p.id) || listedUrls.has(p.repo.toLowerCase()) || !unresolvedOwners.has(p.ownerId)) continue;
    if (checkEntry(p, { officialIds, blocklist, ownerLogin: unresolvedOwners.get(p.ownerId) })) continue; // e.g. the owner renamed its login
    log(`keep ${p.id}: its repo is no longer listed, but another repo of the same owner could not be checked`);
    result.set(`orphan:${p.id}`, p);
  }

  if (budget.exhausted) warnings.push(`scan budget exhausted (${budget.maxBytes} bytes, ${maxSeconds} seconds): ${unscanned} repositories were not checked and keep their previous state`);

  const plugins = [...result.values()].sort((a, b) => byString(a.id, b.id));
  const unchanged = prev && JSON.stringify(prev.plugins) === JSON.stringify(plugins);
  const updatedAt = unchanged ? prev.updatedAt : now;
  const out = JSON.stringify({ schemaVersion: 1, tier: 'community', updatedAt, plugins }, null, 2) + '\n';
  const current = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
  return { out, current, indexPath, count: plugins.length, updatedAt, warnings };
}

// ---------- CLI ----------

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const root = resolve(opt('--root', '.'));
  const apiBase = opt('--api-base', 'https://api.github.com').replace(/\/+$/, '');
  const checkOnly = args.includes('--check');
  const now = process.env.COMMUNITY_INDEX_NOW ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  let r;
  try {
    const limits = {};
    if (process.env.COMMUNITY_INDEX_MAX_DOWNLOAD_BYTES) limits.maxDownloadBytes = Number(process.env.COMMUNITY_INDEX_MAX_DOWNLOAD_BYTES);
    if (process.env.COMMUNITY_INDEX_MAX_SECONDS) limits.maxSeconds = Number(process.env.COMMUNITY_INDEX_MAX_SECONDS);
    r = await scan({ root, apiBase, token: process.env.GITHUB_TOKEN, now, ...limits });
  } catch (e) {
    console.error(`build-community-index: FAILED, community/plugins.json not modified (${e.message})`);
    process.exitCode = 1;
    return;
  }
  for (const w of r.warnings) console.warn(`build-community-index: WARNING ${w}`);
  if (r.out === r.current) {
    console.log(`build-community-index: community/plugins.json up to date (${r.count} plugins)`);
    return;
  }
  if (checkOnly) {
    console.error('build-community-index: community/plugins.json is out of date');
    process.exitCode = 1;
    return;
  }
  mkdirSync(dirname(r.indexPath), { recursive: true });
  const tmp = `${r.indexPath}.tmp`;
  writeFileSync(tmp, r.out);
  renameSync(tmp, r.indexPath);
  console.log(`build-community-index: community/plugins.json updated (${r.count} plugins, updatedAt ${r.updatedAt})`);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
