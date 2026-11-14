#!/usr/bin/env node
// Validates a registration or update PR against the catalog acceptance conditions and
// writes a per-condition report. It only reports: it never merges and never closes a PR.
// Zero dependencies. PR content is read as data with `git show`; nothing from the PR is executed.
//
// Usage:
//   node scripts/validate-pr.mjs --repo <dir> --base <ref> --head <ref> --pr-author <login>
//     [--api-base <url>] [--comment-file <path>] [--result-file <path>]
//     [--post-comment --pr-repo <owner/name> --pr-number <n>] [--latest-stable <semver>]
//     [--forbid-index-edit] [--allow-local-download]
//   --repo      checkout holding the base branch history; the PR head only needs to be fetched, not checked out
//   --forbid-index-edit  fail when the PR touches plugins.json or community/plugins.json
//               (enable once the index is generated automatically)
//   --allow-local-download  tests only: allow http://127.0.0.1 release downloads
// Env: GITHUB_TOKEN     optional, used for GitHub API calls (never sent to release downloads)
//      ORG_READ_TOKEN   optional, token able to read openpen-platform org members; without it only
//                       public membership is visible
// Exit: 0 all conditions pass (warnings allowed) / 1 at least one condition fails / 2 tool error
//
// Rule sources: plugin-spec 4.2 manifest fields, 4.4 acceptance conditions, 4.5 official scope.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER = '<!-- catalog-pr-validation -->';
export const OFFICIAL_ORG = 'openpen-platform';
export const OFFICIAL_SCOPE = 'openpen';
const OPENPEN_REPO = 'openpen-platform/openpen';
const PLUGIN_ID_RE = /^@([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9][a-z0-9-]{0,38})$/;
const PART_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const MANIFEST_PATH_RE = /^plugins\/([^/]+)\/([^/]+)\/manifest\.json$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const STATES = ['active', 'yanked', 'tombstoned'];
const OWNER_TYPES = ['User', 'Organization'];
// Required fields of a submitted manifest (plugin-spec 4.2). registeredAt is filled by the catalog, not the author.
const REQUIRED = ['id', 'scope', 'name', 'ownerId', 'ownerLogin', 'ownerType', 'description',
  'minAppVersion', 'repo', 'latestVersion', 'releaseUrl', 'sha256', 'state'];
const IMMUTABLE = ['id', 'scope', 'name', 'ownerId'];
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const DOWNLOAD_HOPS_MAX = 5;
const DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
const INDEX_FILES = ['plugins.json', 'community/plugins.json'];

// --- small helpers ---

export function parseSemver(v) {
  const m = typeof v === 'string' ? SEMVER_RE.exec(v) : null;
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

// Values from a PR are shown inside a code span so they can neither format nor @-mention anyone.
export function code(v) {
  const s = String(v ?? '').replace(/[`\r\n]+/g, ' ').slice(0, 200);
  return `\`${s}\``;
}

const pass = (id, label, message) => ({ id, label, status: 'pass', message });
const fail = (id, label, message) => ({ id, label, status: 'fail', message });
const warn = (id, label, message) => ({ id, label, status: 'warn', message });

// --- network ---

export function makeContext(opts = {}) {
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? '';
  const orgToken = opts.orgToken ?? process.env.ORG_READ_TOKEN ?? '';
  const allowLocal = !!opts.allowLocalDownload;

  async function api(path, { auth = token, method = 'GET', body } = {}) {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'openpen-catalog-pr-validation' };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      redirect: 'manual',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    let json = null;
    try { json = await res.json(); } catch { /* 204 or non-JSON */ }
    return { status: res.status, json };
  }

  // Release download: https only, host allow-list at every redirect hop, size cap, no credentials.
  async function download(url) {
    let current = url;
    for (let hop = 0; hop <= DOWNLOAD_HOPS_MAX; hop++) {
      let u;
      try { u = new URL(current); } catch { throw new Error(`not a URL: ${code(current)}`); }
      const local = allowLocal && u.protocol === 'http:' && u.hostname === '127.0.0.1';
      if (!local && (u.protocol !== 'https:' || !DOWNLOAD_HOSTS.includes(u.hostname))) {
        throw new Error(`host not allowed for release download: ${code(`${u.protocol}//${u.hostname}`)}`);
      }
      const res = await fetch(u, {
        redirect: 'manual',
        headers: { 'User-Agent': 'openpen-catalog-pr-validation' },
        signal: AbortSignal.timeout(60000),
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`redirect without location (HTTP ${res.status})`);
        current = new URL(loc, u).toString();
        continue;
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_ZIP_BYTES) throw new Error(`file larger than ${MAX_ZIP_BYTES} bytes`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_ZIP_BYTES) throw new Error(`file larger than ${MAX_ZIP_BYTES} bytes`);
      return buf;
    }
    throw new Error('too many redirects');
  }

  const cache = new Map();
  const once = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };

  return {
    api,
    download,
    orgToken,
    latestStable: opts.latestStable ?? null,
    forbidIndexEdit: !!opts.forbidIndexEdit,
    allowLocalDownload: allowLocal,
    // Cached lookups, each resolves to a value or throws with a readable reason.
    orgId: () => once('orgId', async () => {
      const r = await api(`/orgs/${OFFICIAL_ORG}`);
      if (r.status !== 200 || typeof r.json?.id !== 'number') throw new Error(`org lookup returned HTTP ${r.status}`);
      return r.json.id;
    }),
    latestStableVersion: () => once('latest', async () => {
      if (opts.latestStable) return opts.latestStable;
      const r = await api(`/repos/${OPENPEN_REPO}/releases/latest`);
      const v = String(r.json?.tag_name ?? '').replace(/^v/, '');
      if (r.status !== 200 || !parseSemver(v)) throw new Error(`latest stable release lookup returned HTTP ${r.status}`);
      return v;
    }),
    builtInIds: () => once('builtin', () => fetchBuiltInIds(api)),
  };
}

// Built-in ids live in each module's `id: '@scope/name'` line under src/core/modules/<dir>/index.ts.
export async function fetchBuiltInIds(api) {
  const dir = await api(`/repos/${OPENPEN_REPO}/contents/src/core/modules`);
  if (dir.status !== 200 || !Array.isArray(dir.json)) throw new Error(`module directory listing returned HTTP ${dir.status}`);
  const ids = new Set();
  for (const e of dir.json.filter((x) => x.type === 'dir')) {
    const f = await api(`/repos/${OPENPEN_REPO}/contents/src/core/modules/${e.name}/index.ts`);
    if (f.status !== 200 || typeof f.json?.content !== 'string') throw new Error(`module ${e.name} source returned HTTP ${f.status}`);
    const text = Buffer.from(f.json.content, 'base64').toString('utf8');
    for (const m of text.matchAll(/^ {2}id: ['"](@[^'"]+)['"]/gm)) ids.add(m[1]);
  }
  if (ids.size === 0) throw new Error('no built-in module id found');
  return ids;
}

function parseRepoUrl(repo) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(repo ?? ''));
  return m && !/^\.+$/.test(m[1]) && !/^\.+$/.test(m[2]) ? { owner: m[1], name: m[2] } : null;
}

// Wraps a lookup that can fail so an unverifiable condition fails closed with a reason.
async function guarded(id, label, fn) {
  try {
    return await fn();
  } catch (e) {
    return fail(id, label, `could not verify: ${e.message}`);
  }
}

// --- individual checks ---

export function checkSchema(manifest, dirScope, dirName, existing) {
  const label = 'manifest schema is valid';
  const problems = [];
  for (const k of REQUIRED) {
    if (manifest[k] === undefined || manifest[k] === null || manifest[k] === '') problems.push(`missing ${k}`);
  }
  if (typeof manifest.ownerId !== 'number') problems.push('ownerId must be a number');
  if (manifest.scope !== dirScope) problems.push(`scope ${code(manifest.scope)} differs from directory ${code(dirScope)}`);
  if (manifest.name !== dirName) problems.push(`name ${code(manifest.name)} differs from directory ${code(dirName)}`);
  if (manifest.id !== `@${dirScope}/${dirName}`) problems.push(`id must be ${code(`@${dirScope}/${dirName}`)}`);
  if (manifest.state !== undefined && !STATES.includes(manifest.state)) problems.push(`state ${code(manifest.state)} is not one of ${STATES.join('/')}`);
  if (manifest.ownerType !== undefined && !OWNER_TYPES.includes(manifest.ownerType)) problems.push('ownerType must be User or Organization');
  if (typeof manifest.sha256 === 'string' && !/^[0-9a-f]{64}$/.test(manifest.sha256)) problems.push('sha256 must be 64 lowercase hex characters');
  if (typeof manifest.latestVersion === 'string' && !parseSemver(manifest.latestVersion)) problems.push('latestVersion is not semver');
  if (existing) {
    for (const k of IMMUTABLE) {
      if (manifest[k] !== existing[k]) problems.push(`${k} must not change (${code(existing[k])} -> ${code(manifest[k])})`);
    }
  }
  return problems.length ? fail('schema', label, problems.join('; ')) : pass('schema', label);
}

async function checkRelease(manifest, ctx, label, requireTag) {
  const id = 'release';
  const problems = [];
  const repo = parseRepoUrl(manifest.repo);
  if (typeof manifest.releaseUrl !== 'string' || !manifest.releaseUrl) {
    return fail(id, label, 'releaseUrl is missing');
  }
  // The package must come from the declared repo's own release for this version (plugin-spec 2.3 and 4.4).
  // Local test downloads are exempt because they cannot live under github.com.
  const local = ctx.allowLocalDownload && /^http:\/\/127\.0\.0\.1[:/]/.test(manifest.releaseUrl);
  if (!local) {
    if (!repo) return fail(id, label, 'repo is not a github.com repository URL, releaseUrl cannot be tied to it');
    const prefix = `https://github.com/${repo.owner}/${repo.name}/releases/download/v${manifest.latestVersion}/`;
    if (!manifest.releaseUrl.toLowerCase().startsWith(prefix.toLowerCase())) {
      return fail(id, label, `releaseUrl must start with ${code(prefix)}`);
    }
  }
  let buf;
  try {
    buf = await ctx.download(manifest.releaseUrl);
  } catch (e) {
    return fail(id, label, `release download failed: ${e.message}`);
  }
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== manifest.sha256) problems.push(`sha256 mismatch: manifest ${code(manifest.sha256)}, download ${code(actual)}`);
  if (requireTag) {
    if (!repo) {
      problems.push('repo is not a github.com repository URL, release tag cannot be checked');
    } else {
      const tag = `v${manifest.latestVersion}`;
      try {
        const r = await ctx.api(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/releases/tags/${encodeURIComponent(tag)}`);
        if (r.status !== 200) problems.push(`release tag ${code(tag)} not found (HTTP ${r.status})`);
      } catch (e) {
        problems.push(`release tag lookup failed: ${e.message}`);
      }
    }
  }
  return problems.length ? fail(id, label, problems.join('; ')) : pass(id, label);
}

async function checkMinApp(manifest, ctx, label) {
  const id = 'min-app-version';
  if (!parseSemver(manifest.minAppVersion)) return fail(id, label, `minAppVersion ${code(manifest.minAppVersion)} is not valid semver`);
  return guarded(id, label, async () => {
    const latest = await ctx.latestStableVersion();
    return compareSemver(manifest.minAppVersion, latest) <= 0
      ? pass(id, label)
      : fail(id, label, `minAppVersion ${code(manifest.minAppVersion)} is higher than the latest stable OpenPen ${code(latest)}`);
  });
}

async function checkOrgMember(login, ctx, id, label) {
  return guarded(id, label, async () => {
    const enc = encodeURIComponent(login);
    if (ctx.orgToken) {
      const r = await ctx.api(`/orgs/${OFFICIAL_ORG}/members/${enc}`, { auth: ctx.orgToken });
      if (r.status === 204) return pass(id, label);
      if (r.status === 404) return fail(id, label, `${code(login)} is not a member of ${OFFICIAL_ORG}`);
      throw new Error(`membership lookup returned HTTP ${r.status}`);
    }
    const r = await ctx.api(`/orgs/${OFFICIAL_ORG}/public_members/${enc}`);
    if (r.status === 204) return pass(id, label);
    if (r.status === 404) {
      return fail(id, label, `${code(login)} is not a public member of ${OFFICIAL_ORG}; private membership can only be verified with ORG_READ_TOKEN`);
    }
    throw new Error(`membership lookup returned HTTP ${r.status}`);
  });
}

// plugin-spec 4.5: @openpen/* entries carry the organization identity.
async function orgIdentityProblems(manifest, ctx) {
  const id = await ctx.orgId();
  const bad = [];
  if (manifest.ownerId !== id) bad.push(`ownerId must be the organization id ${code(id)}`);
  if (manifest.ownerType !== 'Organization') bad.push('ownerType must be Organization');
  if (manifest.ownerLogin !== OFFICIAL_ORG) bad.push(`ownerLogin must be ${OFFICIAL_ORG}`);
  return bad;
}

// Registration conditions: plugin-spec 4.4 items 1-7 in order, plus advisory notes.
export async function checkRegistration({ manifest, dirScope, dirName, author, baseManifests, ctx }) {
  const out = [];
  out.push(checkSchema(manifest, dirScope, dirName, null));

  const L1 = `1. scope equals the submitter's GitHub login, or the official scope rule holds`;
  if (dirScope === 'core') {
    out.push(fail('scope', L1, '@core/* must not be registered by anyone'));
  } else if (dirScope === OFFICIAL_SCOPE) {
    const member = await checkOrgMember(author, ctx, 'scope', L1);
    const problems = member.status === 'fail' ? [member.message] : [];
    try {
      problems.push(...await orgIdentityProblems(manifest, ctx));
    } catch (e) {
      problems.push(`could not verify: ${e.message}`);
    }
    out.push(problems.length ? fail('scope', L1, problems.join('; ')) : pass('scope', L1, `${code(author)} is a ${OFFICIAL_ORG} member`));
  } else if (String(author).toLowerCase() === dirScope.toLowerCase()) {
    out.push(pass('scope', L1));
  } else {
    out.push(fail('scope', L1, `scope ${code(dirScope)} differs from the PR author ${code(author)}`));
  }

  const L2 = '2. id is not already an active or tombstoned entry';
  const taken = baseManifests.filter((m) => m.id === manifest.id && ['active', 'tombstoned'].includes(m.state));
  out.push(taken.length ? fail('id-free', L2, `${code(manifest.id)} is already ${taken[0].state}`) : pass('id-free', L2));

  const L3 = '3. name is more than 2 edits away from other names in the same scope';
  const near = baseManifests
    .filter((m) => m.scope === dirScope && m.id !== manifest.id)
    .map((m) => ({ name: m.name, d: levenshtein(String(manifest.name), String(m.name)) }))
    .filter((x) => x.d <= 2);
  out.push(near.length
    ? fail('name-distance', L3, `too similar to ${near.map((x) => `${code(x.name)} (distance ${x.d})`).join(', ')}`)
    : pass('name-distance', L3));

  const L4 = '4. scope and name match the plugin id pattern';
  out.push(PLUGIN_ID_RE.test(String(manifest.id)) && PART_RE.test(dirScope) && PART_RE.test(dirName)
    ? pass('id-pattern', L4)
    : fail('id-pattern', L4, `id ${code(manifest.id)}, scope ${code(dirScope)}, name ${code(dirName)} do not match ${PLUGIN_ID_RE}`));

  out.push(await checkMinApp(manifest, ctx, '5. minAppVersion is valid semver and not above the latest stable OpenPen'));
  out.push(await checkRelease(manifest, ctx, '6. releaseUrl is reachable, sha256 matches, release tag v<latestVersion> exists', true));

  const L7 = '7. id is not a built-in module id';
  out.push(await guarded('built-in', L7, async () => {
    const ids = await ctx.builtInIds();
    return ids.has(manifest.id) ? fail('built-in', L7, `${code(manifest.id)} is a built-in module id`) : pass('built-in', L7);
  }));

  // Advisory (not a plugin-spec acceptance condition): never fails the PR.
  if (manifest.registeredAt !== undefined) {
    out.push(warn('registered-at', 'note: registeredAt is filled by the catalog on first merge', 'the author should not set it; a maintainer decides whether to keep it'));
  }
  const repo = parseRepoUrl(manifest.repo);
  if (repo) {
    try {
      const r = await ctx.api(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`);
      if (r.status === 200 && r.json?.owner?.id !== manifest.ownerId) {
        out.push(warn('owner-id', 'note: ownerId matches the owner of repo', `repo owner id is ${code(r.json?.owner?.id)}, manifest says ${code(manifest.ownerId)}`));
      }
    } catch { /* advisory only */ }
  }
  return out;
}

// Update conditions: plugin-spec 4.4 items 1-6 in order, plus state notes.
export async function checkUpdate({ manifest, dirScope, dirName, author, existing, ctx }) {
  const out = [];
  out.push(checkSchema(manifest, dirScope, dirName, existing));
  out.push(await checkRelease(manifest, ctx, '2. releaseUrl download matches sha256', false));

  const L3 = '3. repo owner id equals the registered ownerId';
  const repo = parseRepoUrl(manifest.repo);
  if (!repo) {
    out.push(fail('repo-owner', L3, `repo ${code(manifest.repo)} is not a github.com repository URL`));
  } else {
    out.push(await guarded('repo-owner', L3, async () => {
      const r = await ctx.api(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`);
      if (r.status !== 200) throw new Error(`repo lookup returned HTTP ${r.status}`);
      return r.json?.owner?.id === existing.ownerId
        ? pass('repo-owner', L3)
        : fail('repo-owner', L3, `repo owner id is ${code(r.json?.owner?.id)}, registered ownerId is ${code(existing.ownerId)}`);
    }));
  }

  out.push(await checkMinApp(manifest, ctx, '4. minAppVersion is valid semver and not above the latest stable OpenPen'));

  const L5 = '5. latestVersion is not lower than the current entry';
  if (!parseSemver(manifest.latestVersion) || !parseSemver(existing.latestVersion)) {
    out.push(fail('no-downgrade', L5, `cannot compare ${code(manifest.latestVersion)} with ${code(existing.latestVersion)}`));
  } else {
    out.push(compareSemver(manifest.latestVersion, existing.latestVersion) >= 0
      ? pass('no-downgrade', L5)
      : fail('no-downgrade', L5, `${code(manifest.latestVersion)} is lower than the current ${code(existing.latestVersion)}`));
  }

  const L6 = '6. for scope openpen, the submitter is a current openpen-platform member';
  if (dirScope === OFFICIAL_SCOPE) {
    const member = await checkOrgMember(author, ctx, 'org-member', L6);
    let identity = [];
    try { identity = await orgIdentityProblems(manifest, ctx); } catch (e) { identity = [`could not verify: ${e.message}`]; }
    const problems = [...(member.status === 'fail' ? [member.message] : []), ...identity];
    out.push(problems.length ? fail('org-member', L6, problems.join('; ')) : pass('org-member', L6));
  } else {
    out.push(pass('org-member', L6, 'not applicable: scope is not openpen'));
  }

  if (existing.state === 'tombstoned') {
    out.push(fail('state', 'note: tombstoned entries accept no update', 'this id is tombstoned'));
  }
  if (manifest.state === 'tombstoned' && existing.state !== 'tombstoned') {
    out.push(warn('state-tombstone', 'note: state set to tombstoned', 'tombstoning is done by catalog maintainers; a maintainer should confirm'));
  }
  if (existing.state === 'yanked' && manifest.state === 'active') {
    out.push(warn('state-unyank', 'note: yanked entry set back to active', 'a yanked entry only accepts security fixes; a maintainer should confirm'));
  }
  if (manifest.latestVersion === existing.latestVersion && manifest.sha256 !== existing.sha256) {
    out.push(warn('same-version', 'note: same version with a different sha256', 'the package changed without a version bump'));
  }
  return out;
}

// --- git reading ---

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function readJsonAt(repo, ref, path) {
  const size = Number(git(repo, ['cat-file', '-s', `${ref}:${path}`]));
  if (size > MAX_MANIFEST_BYTES) throw new Error(`${path} is larger than ${MAX_MANIFEST_BYTES} bytes`);
  return JSON.parse(git(repo, ['show', `${ref}:${path}`]));
}

// Returns { manifests, unreadable }; an unreadable base manifest makes uniqueness checks untrustworthy.
export function readBaseManifests(repo, base) {
  const manifests = [];
  const unreadable = [];
  const files = git(repo, ['ls-tree', '-r', '-z', '--name-only', base, '--', 'plugins/']).split('\0').filter((p) => MANIFEST_PATH_RE.test(p));
  for (const p of files) {
    try { manifests.push({ ...readJsonAt(repo, base, p), __path: p }); } catch { unreadable.push(p); }
  }
  return { manifests, unreadable };
}

export function readChanges(repo, base, head) {
  const raw = git(repo, ['diff', '--name-status', '-z', '--no-renames', `${base}...${head}`]);
  const parts = raw.split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i], path: parts[i + 1] });
  return changes;
}

// --- orchestration ---

export async function validatePr({ repo, base, head, author, ctx }) {
  const changes = readChanges(repo, base, head);
  const { manifests: baseManifests, unreadable } = readBaseManifests(repo, base);
  const sections = [];
  const global = [];

  if (unreadable.length && changes.some((c) => MANIFEST_PATH_RE.test(c.path))) {
    global.push(fail('base-unreadable', 'existing catalog manifests are readable', `cannot read ${unreadable.map(code).join(', ')}; uniqueness and update conditions cannot be trusted`));
  }
  const others = changes.filter((c) => !MANIFEST_PATH_RE.test(c.path));
  const indexTouched = others.filter((c) => INDEX_FILES.includes(c.path));
  if (ctx.forbidIndexEdit && indexTouched.length) {
    global.push(fail('index-edit', 'PR does not edit the generated index', `${indexTouched.map((c) => code(c.path)).join(', ')} is generated by the catalog and must not be edited by hand`));
  }
  const stray = others.filter((c) => c.path.startsWith('plugins/'));
  if (stray.length) {
    global.push(fail('stray-files', 'plugins/ holds only plugins/<scope>/<name>/manifest.json', `unexpected: ${stray.map((c) => code(c.path)).join(', ')}`));
  }
  const unchecked = others.filter((c) => !c.path.startsWith('plugins/') && !(ctx.forbidIndexEdit && INDEX_FILES.includes(c.path)));
  if (unchecked.length) {
    global.push(warn('other-files', 'note: files outside plugins/<scope>/<name>/manifest.json', `not checked by this bot: ${unchecked.map((c) => code(c.path)).join(', ')}`));
  }

  for (const c of changes.filter((x) => MANIFEST_PATH_RE.test(x.path))) {
    const [, dirScope, dirName] = MANIFEST_PATH_RE.exec(c.path);
    const existing = baseManifests.find((m) => m.__path === c.path) ?? null;
    if (c.status === 'D') {
      const gone = existing?.state === 'tombstoned'
        ? fail('deleted', 'manifest deleted', 'a tombstoned id must stay in the catalog so it cannot be registered again')
        : warn('deleted', 'manifest deleted', 'removing an entry is not an update; a maintainer decides (see the yank and tombstone flow)');
      sections.push({ path: c.path, kind: 'deletion', checks: [gone] });
      continue;
    }
    let manifest;
    try {
      manifest = readJsonAt(repo, head, c.path);
      if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest is not a JSON object');
    } catch (e) {
      sections.push({ path: c.path, kind: existing ? 'update' : 'registration', checks: [fail('schema', 'manifest schema is valid', `cannot read manifest: ${code(e.message)}`)] });
      continue;
    }
    const kind = existing ? 'update' : 'registration';
    const checks = existing
      ? await checkUpdate({ manifest, dirScope, dirName, author, existing, ctx })
      : await checkRegistration({ manifest, dirScope, dirName, author, baseManifests, ctx });
    sections.push({ path: c.path, kind, checks });
  }

  if (!sections.length) {
    global.push(warn('nothing', 'no catalog manifest changed', 'no acceptance condition was checked'));
  }
  const all = [...global, ...sections.flatMap((s) => s.checks)];
  return { passed: !all.some((c) => c.status === 'fail'), validated: sections.length, global, sections };
}

const ICON = { pass: '✅', fail: '❌', warn: '⚠️' };

// PR text must not ping anyone or render links/HTML: outside code spans, break @ [ < and pipes.
export function neutralize(text) {
  return String(text ?? '').replace(/\r?\n/g, ' ').split(/(`[^`]*`)/).map((part, i) => (i % 2
    ? part.replace(/\|/g, '\\|')
    : part.replace(/@/g, '@\u200b').replace(/\[/g, '\\[').replace(/</g, '&lt;').replace(/\|/g, '\\|'))).join('');
}

export function formatComment(result) {
  const head = result.validated === 0 ? '⚠️ nothing was validated'
    : result.passed ? '✅ all conditions passed' : '❌ some conditions failed';
  const lines = [MARKER, `## Catalog PR validation: ${head}`, ''];
  const table = (checks) => {
    lines.push('| | Condition | Result |', '| --- | --- | --- |');
    for (const c of checks) {
      lines.push(`| ${ICON[c.status]} | ${neutralize(c.label)} | ${neutralize(c.message)} |`);
    }
    lines.push('');
  };
  if (result.global.length) table(result.global);
  for (const s of result.sections) {
    lines.push(`### ${s.kind}: ${code(s.path)}`, '');
    table(s.checks);
  }
  lines.push('This bot only reports. It does not merge or close the PR; a maintainer decides whether to merge.');
  return lines.join('\n') + '\n';
}

export async function postComment(ctx, { prRepo, prNumber, body, botLogin = 'github-actions[bot]' }) {
  let existingId = null;
  for (let page = 1; page <= 10 && existingId === null; page++) {
    const r = await ctx.api(`/repos/${prRepo}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`listing comments returned HTTP ${r.status}`);
    const hit = r.json.find((c) => c.user?.login === botLogin && typeof c.body === 'string' && c.body.includes(MARKER));
    if (hit) existingId = hit.id;
    if (r.json.length < 100) break;
  }
  const r = existingId === null
    ? await ctx.api(`/repos/${prRepo}/issues/${prNumber}/comments`, { method: 'POST', body: { body } })
    : await ctx.api(`/repos/${prRepo}/issues/comments/${existingId}`, { method: 'PATCH', body: { body } });
  if (r.status !== 200 && r.status !== 201) throw new Error(`writing comment returned HTTP ${r.status}`);
  return existingId === null ? 'created' : 'updated';
}

// --- CLI ---

async function main() {
  const argv = process.argv.slice(2);
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const has = (f) => argv.includes(f);
  for (const f of ['--repo', '--base', '--head', '--pr-author']) {
    if (!get(f)) { console.error(`missing ${f}`); return 2; }
  }
  if (has('--post-comment') && (!get('--pr-repo') || !get('--pr-number'))) {
    console.error('--post-comment needs --pr-repo and --pr-number');
    return 2;
  }
  const ctx = makeContext({
    apiBase: get('--api-base'),
    latestStable: get('--latest-stable'),
    forbidIndexEdit: has('--forbid-index-edit'),
    allowLocalDownload: has('--allow-local-download'),
  });
  let result;
  try {
    result = await validatePr({ repo: resolve(get('--repo')), base: get('--base'), head: get('--head'), author: get('--pr-author'), ctx });
  } catch (e) {
    console.error(`validate-pr: tool error: ${e.message}`);
    if (has('--post-comment') && get('--pr-repo') && get('--pr-number')) {
      const text = `${MARKER}\n## Catalog PR validation: ⚠️ the validation could not run\n\nNo condition was checked for the latest commit; earlier results on this PR are out of date. A maintainer should re-run the check.\n`;
      try { await postComment(ctx, { prRepo: get('--pr-repo'), prNumber: get('--pr-number'), body: text }); } catch { /* nothing more to do */ }
    }
    return 2;
  }
  const body = formatComment(result);
  if (get('--comment-file')) writeFileSync(get('--comment-file'), body);
  if (get('--result-file')) writeFileSync(get('--result-file'), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(body);
  if (has('--post-comment')) {
    try {
      const how = await postComment(ctx, { prRepo: get('--pr-repo'), prNumber: get('--pr-number'), body });
      console.error(`validate-pr: comment ${how}`);
    } catch (e) {
      console.error(`validate-pr: could not post comment: ${e.message}`);
      return 2;
    }
  }
  return result.passed ? 0 : 1;
}

// Set exitCode instead of calling process.exit so open fetch sockets close cleanly.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
