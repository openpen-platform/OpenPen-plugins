// Run: node --test scripts/test/
// Everything is local: a fake GitHub API on 127.0.0.1 and disposable git repositories under os.tmpdir().
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  parseSemver, compareSemver, levenshtein, code, makeContext, validatePr, formatComment, postComment,
  MARKER,
} from '../validate-pr.mjs';
import { extractListing } from '../lib/listing.mjs';
import { makeZip, png, jpeg, gif, svg } from '../test-helpers/fixtures.mjs';

const run = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'validate-pr.mjs');
const SYNC_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'sync-listing.mjs');
const ORG_ID = 281348594;

// --- fake GitHub ---

const pluginJson = (extra = {}) => JSON.stringify({ id: '@alice/notes', name: 'Notes', version: '1.0.0', description: 'd', minAppVersion: '1.0.0', renderer: 'dist/renderer.js', ...extra });
// Listing fields as an official plugin writes them in plugin.json, and the image files on its tag.
const OFFICIAL_LISTING = {
  descriptionLocalized: { 'zh-Hant': '畫直線箭頭。', 'zh-Hans': '画直线箭头。' },
  icon: '.github/marketplace/icon.png',
  screenshots: [
    { src: '.github/marketplace/cover.png', alt: 'An arrow points at a button.' },
    { src: '.github/readme-demo.gif', alt: 'Arrows are dragged onto a page.' },
  ],
};
const OFFICIAL_FILES = () => ({
  '.github/marketplace/icon.png': png(256, 256),
  '.github/marketplace/cover.png': png(960, 675),
  '.github/readme-demo.gif': gif(960, 675),
});
const zips = {
  good: makeZip({ 'plugin.json': pluginJson(), 'dist/renderer.js': '// good' }),
  other: makeZip({ 'plugin.json': pluginJson(), 'dist/renderer.js': '// other' }),
  official: makeZip({ 'plugin.json': pluginJson({ id: '@openpen/arrow', ...OFFICIAL_LISTING }), 'dist/renderer.js': '// arrow' }),
};
const sha = (b) => createHash('sha256').update(b).digest('hex');

let server;
let base; // http://127.0.0.1:port
const fake = {};
function resetFake() {
  fake.latest = '1.5.0';
  fake.repoOwners = { 'alice/notes': 111, 'alice/other': 111, 'openpen-platform/openpen-arrow': ORG_ID, 'eve/fake': 999 };
  fake.tags = new Set(['alice/notes@v1.0.0', 'alice/notes@v1.1.0', 'alice/other@v1.0.0', 'openpen-platform/openpen-arrow@v1.1.0', 'openpen-platform/openpen-freehand@v1.0.0', 'bob/zeta@v1.0.0', 'alice/tooling@v1.0.0']);
  fake.publicMembers = new Set(['maintainer']);
  fake.privateMembers = new Set(['maintainer', 'quiet-maintainer']);
  fake.fail = new Set(); // path prefixes that answer 500
  fake.comments = [];
  fake.nextCommentId = 1;
  fake.seenAuth = [];
  fake.downloadAuth = [];
  fake.zips = {}; // extra packages served at /dl/<name>.zip
  fake.raw = OFFICIAL_FILES(); // repo files served at /raw/<owner>/<repo>/<tag>/<path>, whatever the tag
  fake.rawSeen = [];
  fake.rawStatus = {}; // repo file path -> HTTP status to answer instead of the file
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const send = (status, body) => {
      res.statusCode = status;
      if (body === undefined) return res.end();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const readBody = (cb) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => cb(d ? JSON.parse(d) : {})); };
    if ([...fake.fail].some((f) => p.startsWith(f))) return send(500, { message: 'boom' });
    let m;
    if ((m = /^\/raw\/[^/]+\/[^/]+\/[^/]+\/(.+)$/.exec(p))) {
      fake.rawSeen.push(p);
      if (fake.rawStatus[m[1]]) return send(fake.rawStatus[m[1]]);
      const f = fake.raw[m[1]];
      if (!f) return send(404);
      res.setHeader('content-length', f.length);
      return res.end(f);
    }
    if (p.startsWith('/dl/')) {
      fake.downloadAuth.push(req.headers.authorization ?? null);
      if (p === '/dl/good.zip') { res.setHeader('content-length', zips.good.length); return res.end(zips.good); }
      if (p === '/dl/other.zip') return res.end(zips.other);
      if ((m = /^\/dl\/(.+)\.zip$/.exec(p)) && zips[m[1]]) return res.end(zips[m[1]]);
      if (m && fake.zips[m[1]]) return res.end(fake.zips[m[1]]);
      if (p === '/dl/redirect.zip') { res.statusCode = 302; res.setHeader('location', 'https://evil.example.com/x.zip'); return res.end(); }
      return send(404, { message: 'nope' });
    }
    fake.seenAuth.push({ path: p, auth: req.headers.authorization ?? null });
    if (p === '/orgs/openpen-platform') return send(200, { id: ORG_ID });
    if ((m = /^\/orgs\/openpen-platform\/members\/(.+)$/.exec(p))) {
      if (req.headers.authorization !== 'Bearer org-secret') return send(302);
      return send(fake.privateMembers.has(decodeURIComponent(m[1])) ? 204 : 404);
    }
    if ((m = /^\/orgs\/openpen-platform\/public_members\/(.+)$/.exec(p))) {
      return send(fake.publicMembers.has(decodeURIComponent(m[1])) ? 204 : 404);
    }
    if (p === '/repos/openpen-platform/openpen/releases/latest') return send(200, { tag_name: `v${fake.latest}` });
    if (p === '/repos/openpen-platform/openpen/contents/src/core/modules') {
      return send(200, [{ type: 'dir', name: 'freehand' }, { type: 'dir', name: 'line' }, { type: 'file', name: 'registry.ts' }]);
    }
    if ((m = /^\/repos\/openpen-platform\/openpen\/contents\/src\/core\/modules\/(\w+)\/index\.ts$/.exec(p))) {
      const q = m[1] === 'line' ? '"' : "'";
      const text = `export default {\n  id: ${q}@openpen/${m[1]}${q},\n  contributes: { tools: [{\n      id: '@openpen/inner',\n  }] },\n}\n`;
      return send(200, { content: Buffer.from(text).toString('base64') });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/releases\/tags\/(.+)$/.exec(p))) {
      return send(fake.tags.has(`${m[1]}/${m[2]}@${decodeURIComponent(m[3])}`) ? 200 : 404, { message: 'x' });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(p))) {
      if (req.method === 'GET') return send(200, fake.comments);
      return readBody((b) => { const c = { id: fake.nextCommentId++, body: b.body, user: { login: 'github-actions[bot]' } }; fake.comments.push(c); send(201, c); });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)$/.exec(p)) && req.method === 'PATCH') {
      return readBody((b) => { const c = fake.comments.find((x) => x.id === Number(m[3])); c.body = b.body; send(200, c); });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(p))) {
      const id = fake.repoOwners[`${m[1]}/${m[2]}`];
      return id === undefined ? send(404, {}) : send(200, { owner: { id } });
    }
    return send(404, { message: `unhandled ${p}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// --- disposable git repositories ---

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const made = [];
const g = (cwd, ...a) => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8' });

function manifest(over = {}) {
  const v = over.latestVersion ?? '1.0.0';
  const name = over.name ?? 'notes';
  const scope = over.scope ?? 'alice';
  return {
    id: `@${scope}/${name}`, scope, name, ownerId: 111, ownerLogin: 'alice', ownerType: 'User',
    description: 'd', minAppVersion: '1.0.0', repo: 'https://github.com/alice/notes', latestVersion: v,
    releaseUrl: `${base}/dl/good.zip`, sha256: sha(zips.good), state: 'active', ...over,
  };
}
const mpath = (m) => `plugins/${m.scope}/${m.name}/manifest.json`;
const officialListing = (v, pj = OFFICIAL_LISTING) => extractListing(pj, { owner: 'openpen-platform', repo: 'openpen-arrow', tag: `v${v}` }).listing;
const OFFICIAL = (over = {}) => manifest({
  scope: 'openpen', name: 'arrow', ownerId: ORG_ID, ownerLogin: 'openpen-platform', ownerType: 'Organization',
  repo: 'https://github.com/openpen-platform/openpen-arrow', latestVersion: '1.0.0',
  releaseUrl: `${base}/dl/official.zip`, sha256: sha(zips.official),
  ...officialListing(over.latestVersion ?? '1.0.0'), ...over,
});

// baseFiles/headFiles: { path: object|string|null(delete) }
function makeRepo(baseFiles, headFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-pr-test-'));
  made.push(dir);
  g(dir, 'init', '-q', '-b', 'main');
  const write = (files) => {
    for (const [p, v] of Object.entries(files)) {
      const full = join(dir, p);
      if (v === null) { rmSync(full); continue; }
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    }
  };
  write({ 'README.md': 'x', ...baseFiles });
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'base');
  g(dir, 'switch', '-q', '-c', 'pr');
  write(headFiles);
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'pr');
  g(dir, 'switch', '-q', 'main');
  return dir;
}
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const ctxFor = (extra = {}) => makeContext({ apiBase: base, token: '', orgToken: '', allowLocalDownload: true, rawBase: `${base}/raw`, ...extra });
const validate = (repo, author, extra) => validatePr({ repo, base: 'main', head: 'pr', author, ctx: ctxFor(extra) });
const byId = (section, id) => section.checks.filter((c) => c.id === id);
const statusOf = (section, label) => section.checks.find((c) => c.label.startsWith(label))?.status;

// registration scenario: a base catalog with alice/other (+ optionally more), PR adds `m`.
function registration(m, baseExtra = {}) {
  const other = manifest({ name: 'other' });
  return makeRepo({ [mpath(other)]: other, ...baseExtra }, { [mpath(m)]: m });
}
function update(oldM, newM) {
  return makeRepo({ [mpath(oldM)]: oldM }, { [mpath(newM)]: newM });
}

// --- pure helpers ---

test('semver: parse and compare, prerelease sorts below release', () => {
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver('01.2.3'), null);
  assert.equal(compareSemver('1.2.3', '1.10.0'), -1);
  assert.equal(compareSemver('2.0.0', '2.0.0'), 0);
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0-rc.2', '1.0.0-rc.10'), -1);
});

test('levenshtein distance', () => {
  assert.equal(levenshtein('notes', 'notes'), 0);
  assert.equal(levenshtein('notes', 'note'), 1);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'ab'), 2);
});

test('code(): neutralises backticks and newlines', () => {
  assert.equal(code('a`b\nc'), '`a b c`');
});

// --- registration ---

test('registration: a valid third-party registration passes every condition', async () => {
  resetFake();
  const r = await validate(registration(manifest({ name: 'tooling' })), 'alice');
  assert.equal(r.passed, true, JSON.stringify(r, null, 1));
  const s = r.sections[0];
  assert.equal(s.kind, 'registration');
  assert.equal(s.checks.filter((c) => c.status === 'pass').length, 9); // schema + 7 spec conditions + listing match
  assert.equal(s.checks.some((c) => c.status === 'fail'), false);
});

test('registration: scope not equal to the PR author fails condition 1', async () => {
  resetFake();
  const r = await validate(registration(manifest({ name: 'tooling' })), 'mallory');
  assert.equal(r.passed, false);
  assert.equal(statusOf(r.sections[0], '1.'), 'fail');
});

test('registration: scope comparison ignores case', async () => {
  resetFake();
  const r = await validate(registration(manifest({ name: 'tooling' })), 'ALICE');
  assert.equal(statusOf(r.sections[0], '1.'), 'pass');
});

test('registration: an id that is already active fails condition 2 (existing under another path)', async () => {
  resetFake();
  const dup = manifest({ name: 'tooling' });
  const moved = { ...dup, __note: 'same id at another path' };
  const repo = makeRepo({ 'plugins/alice/legacy/manifest.json': moved }, { [mpath(dup)]: dup });
  const r = await validate(repo, 'alice');
  assert.equal(statusOf(r.sections[0], '2.'), 'fail');
});

test('registration: a tombstoned id fails condition 2, a yanked id does not', async () => {
  resetFake();
  const m = manifest({ name: 'tooling' });
  const t = await validate(makeRepo({ 'plugins/alice/legacy/manifest.json': { ...m, state: 'tombstoned' } }, { [mpath(m)]: m }), 'alice');
  assert.equal(statusOf(t.sections[0], '2.'), 'fail');
  const y = await validate(makeRepo({ 'plugins/alice/legacy/manifest.json': { ...m, state: 'yanked' } }, { [mpath(m)]: m }), 'alice');
  assert.equal(statusOf(y.sections[0], '2.'), 'pass');
});

test('registration: a name within 2 edits of a same-scope name fails condition 3; other scopes are free', async () => {
  resetFake();
  const near = await validate(registration(manifest({ name: 'othet' })), 'alice'); // distance 1 from "other"
  assert.equal(statusOf(near.sections[0], '3.'), 'fail');
  assert.match(near.sections[0].checks.find((c) => c.label.startsWith('3.')).message, /other/);
  const far = await validate(registration(manifest({ name: 'zeta' })), 'alice');
  assert.equal(statusOf(far.sections[0], '3.'), 'pass');
  const crossScope = manifest({ scope: 'bob', name: 'other', ownerId: 222, ownerLogin: 'bob', repo: 'https://github.com/bob/zeta' });
  const cross = await validate(registration(crossScope), 'bob');
  assert.equal(statusOf(cross.sections[0], '3.'), 'pass');
});

test('registration: an id that breaks the pattern fails condition 4', async () => {
  resetFake();
  const bad = manifest({ name: 'Bad_Name' });
  const r = await validate(registration(bad), 'alice');
  assert.equal(statusOf(r.sections[0], '4.'), 'fail');
});

test('registration: minAppVersion must be semver and not above the latest stable', async () => {
  resetFake();
  const high = await validate(registration(manifest({ name: 'tooling', minAppVersion: '9.0.0' })), 'alice');
  assert.equal(statusOf(high.sections[0], '5.'), 'fail');
  assert.match(high.sections[0].checks.find((c) => c.label.startsWith('5.')).message, /latest stable/);
  const junk = await validate(registration(manifest({ name: 'tooling', minAppVersion: 'abc' })), 'alice');
  assert.equal(statusOf(junk.sections[0], '5.'), 'fail');
  const equal = await validate(registration(manifest({ name: 'tooling', minAppVersion: '1.5.0' })), 'alice');
  assert.equal(statusOf(equal.sections[0], '5.'), 'pass');
});

test('registration: sha256 mismatch, missing release tag, unreachable url all fail condition 6', async () => {
  resetFake();
  const badSha = await validate(registration(manifest({ name: 'tooling', sha256: sha(zips.other) })), 'alice');
  assert.equal(statusOf(badSha.sections[0], '6.'), 'fail');
  assert.match(badSha.sections[0].checks.find((c) => c.label.startsWith('6.')).message, /sha256 mismatch/);

  const noTag = await validate(registration(manifest({ name: 'tooling', latestVersion: '1.2.0' })), 'alice');
  assert.match(noTag.sections[0].checks.find((c) => c.label.startsWith('6.')).message, /release tag `v1.2.0` not found/);

  const gone = await validate(registration(manifest({ name: 'tooling', releaseUrl: `${base}/dl/missing.zip` })), 'alice');
  assert.match(gone.sections[0].checks.find((c) => c.label.startsWith('6.')).message, /HTTP 404/);
});

test('registration: release download refuses hosts outside the GitHub allow-list and never sends credentials', async () => {
  resetFake();
  await assert.rejects(ctxFor({ token: 'gh-secret' }).download('https://example.com/a.zip'), /host not allowed/);
  await assert.rejects(ctxFor().download('http://github.com/a.zip'), /host not allowed/);
  const redirect = await validate(registration(manifest({ name: 'tooling', releaseUrl: `${base}/dl/redirect.zip` })), 'alice', { token: 'gh-secret' });
  assert.match(redirect.sections[0].checks.find((c) => c.label.startsWith('6.')).message, /host not allowed/);
  assert.deepEqual(fake.downloadAuth.filter((a) => a !== null), []);
});

test('registration: without allowLocalDownload a 127.0.0.1 releaseUrl fails the repo-prefix rule', async () => {
  resetFake();
  const r = await validatePr({ repo: registration(manifest({ name: 'tooling' })), base: 'main', head: 'pr', author: 'alice', ctx: makeContext({ apiBase: base, token: '', orgToken: '' }) });
  assert.match(r.sections[0].checks.find((c) => c.label.startsWith('6.')).message, /releaseUrl must start with/);
});

test('releaseUrl must be the declared repo release for that version (another repo or version is refused)', async () => {
  resetFake();
  const mk = (releaseUrl) => update(manifest(), manifest({ latestVersion: '1.1.0', releaseUrl }));
  const strict = { allowLocalDownload: false };
  const other = await validate(mk('https://github.com/eve/fake/releases/download/v1.1.0/alice-notes-1.1.0.zip'), 'eve', strict);
  assert.equal(statusOf(other.sections[0], '2.'), 'fail');
  assert.match(other.sections[0].checks.find((c) => c.label.startsWith('2.')).message, /releaseUrl must start with `https:\/\/github.com\/alice\/notes\/releases\/download\/v1.1.0\/`/);
  const wrongVersion = await validate(mk('https://github.com/alice/notes/releases/download/v9.9.9/alice-notes-1.1.0.zip'), 'alice', strict);
  assert.equal(statusOf(wrongVersion.sections[0], '2.'), 'fail');
  const dotRepo = await validate(update(manifest(), manifest({ latestVersion: '1.1.0', repo: 'https://github.com/alice/..' })), 'alice', strict);
  assert.equal(statusOf(dotRepo.sections[0], '3.'), 'fail');
});

test('registration: an official-scope id equal to a built-in id fails condition 7', async () => {
  resetFake();
  const m = { ...OFFICIAL(), id: '@openpen/freehand', name: 'freehand', repo: 'https://github.com/openpen-platform/openpen-freehand' };
  fake.repoOwners['openpen-platform/openpen-freehand'] = ORG_ID;
  const r = await validate(registration(m), 'maintainer');
  assert.equal(statusOf(r.sections[0], '7.'), 'fail');
  assert.equal(statusOf(r.sections[0], '1.'), 'pass');
});

test('registration: built-in ids are read from module sources: nested ids ignored, double quotes accepted', async () => {
  resetFake();
  const nested = { ...OFFICIAL(), id: '@openpen/inner', name: 'inner' };
  assert.equal(statusOf((await validate(registration(nested), 'maintainer')).sections[0], '7.'), 'pass'); // only a nested 6-space id
  const dq = { ...OFFICIAL(), id: '@openpen/line', name: 'line' };
  assert.equal(statusOf((await validate(registration(dq), 'maintainer')).sections[0], '7.'), 'fail'); // declared with double quotes
});

test('registration: @core/* is rejected for everyone', async () => {
  resetFake();
  const r = await validate(registration(manifest({ scope: 'core', name: 'x' })), 'core');
  assert.equal(statusOf(r.sections[0], '1.'), 'fail');
  assert.match(r.sections[0].checks.find((c) => c.label.startsWith('1.')).message, /@core/);
});

test('registration: @openpen/* needs a current org member and the org identity fields', async () => {
  resetFake();
  const okM = { ...OFFICIAL(), name: 'brush', id: '@openpen/brush', repo: 'https://github.com/openpen-platform/openpen-arrow' };
  const member = await validate(registration(okM), 'maintainer');
  assert.equal(statusOf(member.sections[0], '1.'), 'pass');
  const outsider = await validate(registration(okM), 'alice');
  assert.equal(statusOf(outsider.sections[0], '1.'), 'fail');
  const wrongId = await validate(registration({ ...okM, ownerId: 5, ownerType: 'User', ownerLogin: 'x' }), 'maintainer');
  const msg = wrongId.sections[0].checks.find((c) => c.label.startsWith('1.')).message;
  assert.match(msg, /ownerId must be the organization id/);
  assert.match(msg, /ownerType must be Organization/);
  assert.match(msg, /ownerLogin must be openpen-platform/);
});

test('registration: advisory notes never fail the PR', async () => {
  resetFake();
  const m = manifest({ name: 'tooling', registeredAt: '2026-01-01T00:00:00Z', ownerId: 424242 });
  const r = await validate(registration(m), 'alice');
  assert.equal(r.passed, true);
  assert.equal(r.sections[0].checks.filter((c) => c.status === 'warn').length, 2);
});

// --- update ---

test('update: a valid version bump passes every condition', async () => {
  resetFake();
  const r = await validate(update(manifest(), manifest({ latestVersion: '1.1.0' })), 'alice');
  assert.equal(r.passed, true, JSON.stringify(r, null, 1));
  assert.equal(r.sections[0].kind, 'update');
  assert.equal(r.sections[0].checks.some((c) => c.status === 'fail'), false);
});

test('update: a downgrade fails condition 5; the same version passes', async () => {
  resetFake();
  const down = await validate(update(manifest({ latestVersion: '1.1.0' }), manifest({ latestVersion: '1.0.0' })), 'alice');
  assert.equal(statusOf(down.sections[0], '5.'), 'fail');
  assert.equal(down.passed, false);
  const same = await validate(update(manifest(), manifest({ description: 'reworded' })), 'alice');
  assert.equal(statusOf(same.sections[0], '5.'), 'pass');
});

test('update: a prerelease below the current release is a downgrade', async () => {
  resetFake();
  const r = await validate(update(manifest({ latestVersion: '1.1.0' }), manifest({ latestVersion: '1.1.0-rc.1' })), 'alice');
  assert.equal(statusOf(r.sections[0], '5.'), 'fail');
});

test('update: sha256 mismatch fails condition 2', async () => {
  resetFake();
  const r = await validate(update(manifest(), manifest({ latestVersion: '1.1.0', sha256: sha(zips.other) })), 'alice');
  assert.equal(statusOf(r.sections[0], '2.'), 'fail');
});

test('update: repo owned by another account fails condition 3', async () => {
  resetFake();
  const r = await validate(update(manifest(), manifest({ latestVersion: '1.1.0', repo: 'https://github.com/eve/fake' })), 'alice');
  assert.equal(statusOf(r.sections[0], '3.'), 'fail');
});

test('update: changing ownerId or id fields fails the schema condition', async () => {
  resetFake();
  const r = await validate(update(manifest(), manifest({ latestVersion: '1.1.0', ownerId: 999 })), 'alice');
  assert.equal(statusOf(r.sections[0], 'manifest schema'), 'fail');
  assert.match(r.sections[0].checks[0].message, /ownerId must not change/);
});

test('update: minAppVersion above the latest stable fails condition 4', async () => {
  resetFake();
  const r = await validate(update(manifest(), manifest({ latestVersion: '1.1.0', minAppVersion: '3.0.0' })), 'alice');
  assert.equal(statusOf(r.sections[0], '4.'), 'fail');
});

test('update: @openpen/* requires a current org member; ownerId equality is not enough', async () => {
  resetFake();
  const oldM = OFFICIAL();
  const newM = OFFICIAL({ latestVersion: '1.1.0' });
  const outsider = await validate(update(oldM, newM), 'alice');
  assert.equal(statusOf(outsider.sections[0], '6.'), 'fail');
  assert.equal(statusOf(outsider.sections[0], '3.'), 'pass'); // ownerId matches, still not authorised
  const member = await validate(update(oldM, newM), 'maintainer');
  assert.equal(statusOf(member.sections[0], '6.'), 'pass');
  assert.equal(member.passed, true, JSON.stringify(member, null, 1));
});

test('update: @openpen/* must keep the organization identity (ownerType, ownerLogin)', async () => {
  resetFake();
  const r = await validate(update(OFFICIAL(), { ...OFFICIAL(), latestVersion: '1.1.0', ownerType: 'User', ownerLogin: 'x' }), 'maintainer');
  assert.equal(statusOf(r.sections[0], '6.'), 'fail');
  assert.match(r.sections[0].checks.find((c) => c.label.startsWith('6.')).message, /ownerType must be Organization.*ownerLogin must be openpen-platform/);
});

test('update: org membership uses ORG_READ_TOKEN when given and sends it only to the API', async () => {
  resetFake();
  const oldM = OFFICIAL();
  const newM = { ...OFFICIAL(), latestVersion: '1.1.0' };
  const priv = await validate(update(oldM, newM), 'quiet-maintainer', { orgToken: 'org-secret' });
  assert.equal(statusOf(priv.sections[0], '6.'), 'pass');
  const noToken = await validate(update(oldM, newM), 'quiet-maintainer');
  assert.equal(statusOf(noToken.sections[0], '6.'), 'fail');
  assert.match(noToken.sections[0].checks.find((c) => c.label.startsWith('6.')).message, /ORG_READ_TOKEN/);
  const badToken = await validate(update(oldM, newM), 'maintainer', { orgToken: 'wrong' });
  assert.equal(statusOf(badToken.sections[0], '6.'), 'fail');
  assert.match(badToken.sections[0].checks.find((c) => c.label.startsWith('6.')).message, /HTTP 302/); // cannot verify, fail closed
});

test('update: a non-openpen scope does not need org membership', async () => {
  resetFake();
  const r = await validate(update(manifest(), manifest({ latestVersion: '1.1.0' })), 'someone-else');
  assert.equal(statusOf(r.sections[0], '6.'), 'pass');
});

test('update: a tombstoned entry accepts no update', async () => {
  resetFake();
  const r = await validate(update(manifest({ state: 'tombstoned' }), manifest({ latestVersion: '1.1.0' })), 'alice');
  assert.equal(r.passed, false);
  assert.equal(byId(r.sections[0], 'state')[0].status, 'fail');
});

test('update: author-set tombstone and un-yank are flagged for a maintainer', async () => {
  resetFake();
  const t = await validate(update(manifest(), manifest({ latestVersion: '1.1.0', state: 'tombstoned' })), 'alice');
  assert.equal(byId(t.sections[0], 'state-tombstone')[0].status, 'warn');
  const y = await validate(update(manifest({ state: 'yanked' }), manifest({ latestVersion: '1.1.0' })), 'alice');
  assert.equal(byId(y.sections[0], 'state-unyank')[0].status, 'warn');
});

test('update: same version with a changed package is a warning, not a failure', async () => {
  resetFake();
  const r = await validate(update(manifest({ sha256: sha(zips.other) }), manifest()), 'alice');
  assert.equal(r.passed, true);
  assert.equal(byId(r.sections[0], 'same-version')[0].status, 'warn');
});

// --- fail closed, other PR shapes ---

test('an API error makes the dependent condition fail instead of passing', async () => {
  resetFake();
  fake.fail.add('/repos/openpen-platform/openpen/releases/latest');
  const r = await validate(registration(manifest({ name: 'tooling' })), 'alice');
  assert.equal(statusOf(r.sections[0], '5.'), 'fail');
  assert.match(r.sections[0].checks.find((c) => c.label.startsWith('5.')).message, /could not verify/);
  assert.equal(r.passed, false);
});

test('a PR can carry several manifests, each reported separately', async () => {
  resetFake();
  const a = manifest({ name: 'tooling' });
  const b = manifest({ scope: 'bob', name: 'zeta', ownerId: 222, ownerLogin: 'bob', repo: 'https://github.com/bob/zeta' });
  fake.repoOwners['bob/zeta'] = 222;
  const repo = makeRepo({}, { [mpath(a)]: a, [mpath(b)]: b });
  const r = await validate(repo, 'alice');
  assert.equal(r.sections.length, 2);
  assert.equal(r.sections.find((s) => s.path === mpath(a)).checks.some((c) => c.status === 'fail'), false);
  assert.equal(statusOf(r.sections.find((s) => s.path === mpath(b)), '1.'), 'fail');
  assert.equal(r.passed, false);
});

test('unparseable manifest fails the schema condition', async () => {
  resetFake();
  const repo = makeRepo({}, { 'plugins/alice/tooling/manifest.json': '{not json' });
  const r = await validate(repo, 'alice');
  assert.equal(r.passed, false);
  assert.match(r.sections[0].checks[0].message, /cannot read manifest/);
});

test('deleting a manifest is flagged for a maintainer, not failed', async () => {
  resetFake();
  const m = manifest();
  const repo = makeRepo({ [mpath(m)]: m }, { [mpath(m)]: null });
  const r = await validate(repo, 'alice');
  assert.equal(r.sections[0].kind, 'deletion');
  assert.equal(r.passed, true);
});

test('deleting a tombstoned manifest fails: the id must stay unregistrable', async () => {
  resetFake();
  const m = manifest({ state: 'tombstoned' });
  const r = await validate(makeRepo({ [mpath(m)]: m }, { [mpath(m)]: null }), 'alice');
  assert.equal(r.passed, false);
  assert.equal(byId(r.sections[0], 'deleted')[0].status, 'fail');
});

test('a PR without catalog manifests is not reported as validated', async () => {
  resetFake();
  const repo = makeRepo({}, { 'docs.md': 'x' });
  const r = await validate(repo, 'alice');
  assert.equal(r.validated, 0);
  assert.ok(r.global.some((c) => c.id === 'other-files'));
  assert.ok(r.global.some((c) => c.id === 'nothing'));
  assert.match(formatComment(r), /nothing was validated/);
  assert.doesNotMatch(formatComment(r), /all conditions passed/);
});

test('files under plugins/ outside the manifest layout fail', async () => {
  resetFake();
  const repo = makeRepo({}, { 'plugins/alice/x/y/manifest.json': manifest({ name: 'x' }), 'plugins/alice/x/extra.txt': 'z' });
  const r = await validate(repo, 'alice');
  assert.equal(r.passed, false);
  assert.match(r.global.find((c) => c.id === 'stray-files').message, /extra\.txt/);
});

test('an unreadable base manifest fails closed instead of being skipped', async () => {
  resetFake();
  const m = manifest({ name: 'tooling' });
  const repo = makeRepo({ 'plugins/alice/legacy/manifest.json': '{broken' }, { [mpath(m)]: m });
  const r = await validate(repo, 'alice');
  assert.equal(r.passed, false);
  assert.match(r.global.find((c) => c.id === 'base-unreadable').message, /legacy/);
});

test('index edits fail only when --forbid-index-edit is on', async () => {
  resetFake();
  const m = manifest({ name: 'tooling' });
  const repo = makeRepo({ 'plugins.json': '{"plugins":[]}' }, { [mpath(m)]: m, 'plugins.json': '{"plugins":[1]}' });
  const off = await validate(repo, 'alice');
  assert.equal(off.passed, true);
  const on = await validate(repo, 'alice', { forbidIndexEdit: true });
  assert.equal(on.passed, false);
  assert.equal(on.global.find((c) => c.id === 'index-edit').status, 'fail');
});

test('the PR head is only read, never checked out', async () => {
  resetFake();
  const repo = registration(manifest({ name: 'tooling' }));
  await validate(repo, 'alice');
  assert.equal(existsSync(join(repo, 'plugins/alice/tooling/manifest.json')), false);
  assert.equal(g(repo, 'branch', '--show-current').trim(), 'main');
});

// --- comment text and posting ---

test('comment: lists every condition, marks failures, keeps PR text inert', async () => {
  resetFake();
  const m = manifest({ name: 'tooling', description: 'x', id: '@alice/tooling', minAppVersion: '@everyone|9.0.0' });
  const r = await validate(registration(m), 'alice');
  const text = formatComment(r);
  assert.ok(text.startsWith(MARKER));
  assert.match(text, /some conditions failed/);
  assert.match(text, /❌ \| 5\. minAppVersion/);
  assert.match(text, /`@everyone\|9\.0\.0`|`@everyone/); // inside a code span
  assert.ok(!/(^|[^`])@everyone/.test(text.replace(/`[^`]*`/g, '')), 'mention must only appear inside code spans');
  assert.match(text, /only reports\. It does not merge or close/);
  assert.equal((text.match(/^\| (✅|❌|⚠️) \|/gm) ?? []).length, r.sections[0].checks.length);
});

test('comment: PR-controlled text in every message path cannot mention or link', async () => {
  resetFake();
  const evil = '@some-team [click](https://evil.example) <b>x</b>';
  const urlCase = await validate(registration(manifest({ name: 'tooling', releaseUrl: evil })), 'alice');
  const jsonCase = await validate(makeRepo({}, { 'plugins/alice/bad/manifest.json': `{"id": "${evil}` }), 'alice');
  const idCase = await validate(registration(manifest({ name: 'tooling', repo: evil })), 'alice');
  for (const r of [urlCase, jsonCase, idCase]) {
    const text = formatComment(r);
    const outside = text.replace(/`[^`]*`/g, '');
    assert.ok(!/@(?!\u200b)[a-z]/i.test(outside.replace(MARKER, '')), `mention outside code: ${outside}`);
    assert.ok(!/(^|[^\\])\[click\]/.test(outside));
    assert.ok(!/<b>/.test(outside));
  }
});

test('comment: all-pass wording', async () => {
  resetFake();
  const r = await validate(registration(manifest({ name: 'tooling' })), 'alice');
  assert.match(formatComment(r), /all conditions passed/);
});

test('postComment: creates once, then updates the same comment; ignores a spoofed marker', async () => {
  resetFake();
  fake.comments.push({ id: 900, body: `${MARKER} fake`, user: { login: 'mallory' } });
  fake.nextCommentId = 1000;
  const ctx = ctxFor();
  assert.equal(await postComment(ctx, { prRepo: 'o/r', prNumber: 7, body: `${MARKER}\nfirst` }), 'created');
  assert.equal(await postComment(ctx, { prRepo: 'o/r', prNumber: 7, body: `${MARKER}\nsecond` }), 'updated');
  const bot = fake.comments.filter((c) => c.user.login === 'github-actions[bot]');
  assert.equal(bot.length, 1);
  assert.match(bot[0].body, /second/);
  assert.match(fake.comments.find((c) => c.id === 900).body, /fake/);
});

// --- CLI end to end ---

async function cli(repo, args) {
  try {
    const r = await run(process.execPath, [SCRIPT, '--repo', repo, '--base', 'main', '--head', 'pr', '--api-base', base, '--allow-local-download', ...args], { env: { ...process.env, GITHUB_TOKEN: '', ORG_READ_TOKEN: '' } });
    return { code: 0, ...r };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

test('cli: exit 0, writes comment and result files, posts the comment', async () => {
  resetFake();
  const out = mkdtempSync(join(tmpdir(), 'catalog-pr-out-'));
  made.push(out);
  const repo = registration(manifest({ name: 'tooling' }));
  const r = await cli(repo, ['--pr-author', 'alice', '--comment-file', join(out, 'c.md'), '--result-file', join(out, 'r.json'), '--post-comment', '--pr-repo', 'o/r', '--pr-number', '3']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(readFileSync(join(out, 'c.md'), 'utf8'), /all conditions passed/);
  assert.equal(JSON.parse(readFileSync(join(out, 'r.json'), 'utf8')).passed, true);
  assert.equal(fake.comments.length, 1);
});

test('cli: exit 1 when a condition fails, comment still posted', async () => {
  resetFake();
  const repo = registration(manifest({ name: 'tooling' }));
  const r = await cli(repo, ['--pr-author', 'mallory', '--post-comment', '--pr-repo', 'o/r', '--pr-number', '3']);
  assert.equal(r.code, 1);
  assert.match(fake.comments[0].body, /some conditions failed/);
});

test('cli: exit 2 on tool errors (bad ref, missing option, comment API down)', async () => {
  resetFake();
  const repo = registration(manifest({ name: 'tooling' }));
  const bad = await run(process.execPath, [SCRIPT, '--repo', repo, '--base', 'nope', '--head', 'pr', '--pr-author', 'a']).catch((e) => e);
  assert.equal(bad.code, 2);
  const missing = await run(process.execPath, [SCRIPT, '--repo', repo]).catch((e) => e);
  assert.equal(missing.code, 2);
  fake.fail.add('/repos/o/r/issues');
  const down = await cli(repo, ['--pr-author', 'alice', '--post-comment', '--pr-repo', 'o/r', '--pr-number', '3']);
  assert.equal(down.code, 2);
  assert.match(down.stderr, /could not post comment/);
});

test('cli: a tool error overwrites a stale comment so an old pass is not left standing', async () => {
  resetFake();
  const repo = registration(manifest({ name: 'tooling' }));
  fake.comments.push({ id: 50, body: `${MARKER}\n## Catalog PR validation: ✅ all conditions passed`, user: { login: 'github-actions[bot]' } });
  const r = await run(process.execPath, [SCRIPT, '--repo', repo, '--base', 'nope', '--head', 'pr', '--api-base', base, '--pr-author', 'alice', '--post-comment', '--pr-repo', 'o/r', '--pr-number', '3'], { env: { ...process.env, GITHUB_TOKEN: '', ORG_READ_TOKEN: '' } }).catch((e) => e);
  assert.equal(r.code, 2);
  assert.match(fake.comments.find((c) => c.id === 50).body, /could not run/);
});

// --- marketplace listing fields (icon, screenshots, descriptionLocalized) ---

// A release package whose plugin.json carries `extra`, served at /dl/<name>.zip.
function pkg(name, extra) {
  const z = makeZip({ 'plugin.json': pluginJson(extra), 'dist/renderer.js': `// ${name}` });
  fake.zips[name] = z;
  return { releaseUrl: `${base}/dl/${name}.zip`, sha256: sha(z) };
}
const NOTES_LISTING = {
  descriptionLocalized: { 'zh-Hant': '筆記', 'zh-Hans': '笔记' },
  icon: 'img/icon.png',
  screenshots: [{ src: 'img/a.png', alt: 'Notes are open on a page.' }],
};
const notesListing = (pj) => extractListing(pj, { owner: 'alice', repo: 'notes', tag: 'v1.1.0' }).listing;
const withoutListing = (m) => { const c = { ...m }; for (const k of ['icon', 'screenshots', 'descriptionLocalized']) delete c[k]; return c; };

test('listing #2: an update whose listing fields equal the release plugin.json, pinned to the tag, passes', async () => {
  resetFake();
  const rel = pkg('notes-listed', NOTES_LISTING);
  const fields = notesListing(NOTES_LISTING);
  assert.equal(fields.icon, 'https://raw.githubusercontent.com/alice/notes/v1.1.0/img/icon.png');
  const r = await validate(update(manifest(), manifest({ latestVersion: '1.1.0', ...rel, ...fields })), 'alice');
  assert.equal(r.passed, true, JSON.stringify(r, null, 1));
  assert.equal(byId(r.sections[0], 'listing-match')[0].status, 'pass');
});

test('listing #2: a listing field that differs from the release plugin.json fails and is named', async () => {
  resetFake();
  const rel = pkg('notes-listed', NOTES_LISTING);
  const fields = notesListing(NOTES_LISTING);
  const otherTag = await validate(update(manifest(), manifest({ latestVersion: '1.1.0', ...rel, ...fields, icon: fields.icon.replace('v1.1.0', 'main') })), 'alice');
  const c = byId(otherTag.sections[0], 'listing-match')[0];
  assert.equal(otherTag.passed, false);
  assert.equal(c.status, 'fail');
  assert.match(c.message, /^icon differs/);
  assert.doesNotMatch(c.message, /screenshots|descriptionLocalized/);
  // An official update that leaves the fields out of the manifest is inconsistent too.
  const official = await validate(update(OFFICIAL(), withoutListing(OFFICIAL({ latestVersion: '1.1.0' }))), 'maintainer');
  const o = byId(official.sections[0], 'listing-match')[0];
  assert.equal(o.status, 'fail');
  assert.match(o.message, /icon is in plugin\.json but missing from the manifest/);
});

test('listing #3: an official plugin with a complete listing passes; every image is read from its release tag', async () => {
  resetFake();
  const r = await validate(update(OFFICIAL(), OFFICIAL({ latestVersion: '1.1.0' })), 'maintainer');
  assert.equal(r.passed, true, JSON.stringify(r, null, 1));
  assert.equal(byId(r.sections[0], 'official-listing')[0].status, 'pass');
  assert.deepEqual(fake.rawSeen.sort(), [
    '/raw/openpen-platform/openpen-arrow/v1.1.0/.github/marketplace/cover.png',
    '/raw/openpen-platform/openpen-arrow/v1.1.0/.github/marketplace/icon.png',
    '/raw/openpen-platform/openpen-arrow/v1.1.0/.github/readme-demo.gif',
  ]);
  // A JPEG cover is accepted as well.
  resetFake();
  const pj = { ...OFFICIAL_LISTING, screenshots: [{ src: 'shots/cover.jpg', alt: 'A still frame.' }, OFFICIAL_LISTING.screenshots[1]] };
  fake.raw['shots/cover.jpg'] = jpeg(1920, 1350);
  const m = { ...withoutListing(OFFICIAL({ latestVersion: '1.1.0', ...pkg('arrow-jpeg', { id: '@openpen/arrow', ...pj }) })), ...officialListing('1.1.0', pj) };
  const j = await validate(update(OFFICIAL(), m), 'maintainer');
  assert.equal(j.passed, true, JSON.stringify(j, null, 1));
});

test('listing #3: an official plugin missing an item, or with a malformed one, is failed and the item is named', async () => {
  const L = OFFICIAL_LISTING;
  const big = (b, n) => Buffer.concat([b, Buffer.alloc(n)]);
  const cases = [
    ['no icon', { ...L, icon: undefined }, {}, /^icon is missing$/],
    ['no screenshots', { ...L, screenshots: undefined }, {}, /^screenshots is missing$/],
    ['no zh-Hans', { ...L, descriptionLocalized: { 'zh-Hant': '箭頭' } }, {}, /^descriptionLocalized\.zh-Hans is missing$/],
    ['no zh-Hant', { ...L, descriptionLocalized: { 'zh-Hans': '箭头' } }, {}, /^descriptionLocalized\.zh-Hant is missing$/],
    ['parent directory', { ...L, icon: '../icon.png' }, {}, /icon must not contain "\.\."/],
    ['absolute path', { ...L, screenshots: [{ src: '/etc/cover.png', alt: 'x' }] }, {}, /screenshots\[0\]\.src must be a relative path/],
    ['external URL', { ...L, icon: 'https://evil.example.com/i.png' }, {}, /icon must be a path inside the repository/],
    ['not on the tag', L, { '.github/marketplace/icon.png': null }, /icon is not on tag `v1\.1\.0` \(HTTP 404\)/],
    ['icon size', L, { '.github/marketplace/icon.png': png(128, 128) }, /icon must be 256×256 pixels \(found 128×128\)/],
    ['icon bytes', L, { '.github/marketplace/icon.png': png(256, 256, { pad: 256 * 1024 }) }, /icon is larger than 262144 bytes/],
    ['SVG named .png', L, { '.github/marketplace/cover.png': svg() }, /screenshots\[0\] is not a PNG file/],
    ['animated cover', L, { '.github/marketplace/cover.png': png(960, 675, { animated: true }) }, /screenshots\[0\] is animated/],
    ['narrow', L, { '.github/marketplace/cover.png': png(800, 562) }, /screenshots\[0\] must be at least 960 pixels wide \(found 800\)/],
    ['aspect ratio', L, { '.github/readme-demo.gif': gif(960, 540) }, /screenshots\[1\] aspect ratio differs from screenshots\[0\] by more than 1%/],
    ['screenshot bytes', L, { '.github/readme-demo.gif': big(gif(960, 675), 5 * 1024 * 1024) }, /screenshots\[1\] is larger than 5242880 bytes/],
  ];
  for (const [name, pj, files, re] of cases) {
    resetFake();
    for (const [p, b] of Object.entries(files)) { if (b === null) delete fake.raw[p]; else fake.raw[p] = b; }
    const rel = pkg('arrow-case', { id: '@openpen/arrow', ...pj });
    const m = { ...withoutListing(OFFICIAL({ latestVersion: '1.1.0', ...rel })), ...officialListing('1.1.0', pj) };
    const r = await validate(update(OFFICIAL(), m), 'maintainer');
    assert.equal(byId(r.sections[0], 'listing-match')[0].status, 'pass', `${name}: ${JSON.stringify(r.sections[0].checks)}`);
    const c = byId(r.sections[0], 'official-listing')[0];
    assert.equal(c?.status, 'fail', name);
    assert.match(c.message, re, name);
    assert.equal(r.passed, false, name);
  }
});

test('listing #4: a third-party PR is not failed for missing or malformed listing fields', async () => {
  resetFake();
  // plugin.json has a bad icon and a good description: only the description belongs in the manifest.
  const pj = { ...NOTES_LISTING, icon: '../x.png', screenshots: [{ src: 'https://evil.example.com/a.png', alt: 'x' }] };
  const rel = pkg('notes-bad', pj);
  const fields = notesListing(pj);
  assert.deepEqual(Object.keys(fields), ['descriptionLocalized']);
  const dropped = await validate(update(manifest(), manifest({ latestVersion: '1.1.0', ...rel, ...fields })), 'alice');
  assert.equal(dropped.passed, true, JSON.stringify(dropped, null, 1));
  assert.equal(byId(dropped.sections[0], 'official-listing').length, 0);
  // No listing fields anywhere: passes without a note.
  const none = await validate(update(manifest(), manifest({ latestVersion: '1.1.0' })), 'alice');
  assert.equal(byId(none.sections[0], 'listing-match')[0].status, 'pass');
  // plugin.json has valid fields that the manifest leaves out (an older CLI): a note, not a failure.
  const relOk = pkg('notes-listed', NOTES_LISTING);
  const missing = await validate(update(manifest(), manifest({ latestVersion: '1.1.0', ...relOk })), 'alice');
  assert.equal(missing.passed, true);
  assert.equal(byId(missing.sections[0], 'listing-match')[0].status, 'warn');
  assert.equal(fake.rawSeen.length, 0); // third-party images are not fetched
});

test('sync-listing #1: writes the listing fields from the release plugin.json into the manifest', async () => {
  resetFake();
  const dir = mkdtempSync(join(tmpdir(), 'catalog-sync-'));
  made.push(dir);
  const file = join(dir, 'manifest.json');
  const stale = { ...withoutListing(OFFICIAL({ latestVersion: '1.1.0' })), icon: 'https://example.com/old.png' };
  writeFileSync(file, JSON.stringify(stale, null, 2) + '\n');
  await run(process.execPath, [SYNC_SCRIPT, '--allow-local-download', file]);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after, { ...withoutListing(stale), ...officialListing('1.1.0') });
  assert.deepEqual(Object.keys(after).slice(0, 10), ['id', 'scope', 'name', 'ownerId', 'ownerLogin', 'ownerType', 'description', 'descriptionLocalized', 'icon', 'screenshots']);
  // The written manifest passes the consistency check.
  const r = await validate(update(OFFICIAL(), after), 'maintainer');
  assert.equal(r.passed, true, JSON.stringify(r, null, 1));
  // A package that does not match sha256 is refused and the manifest is left alone.
  const bad = { ...stale, sha256: '0'.repeat(64) };
  writeFileSync(file, JSON.stringify(bad, null, 2) + '\n');
  const e = await run(process.execPath, [SYNC_SCRIPT, '--allow-local-download', file]).catch((x) => x);
  assert.equal(e.code, 1);
  assert.match(e.stderr, /sha256/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), bad);
});

test('regression: an official image that cannot be fetched (403, 429, 5xx) fails as a fetch failure, not as missing from the tag', async () => {
  for (const status of [403, 429, 503]) {
    resetFake();
    fake.rawStatus['.github/marketplace/icon.png'] = status;
    const r = await validate(update(OFFICIAL(), OFFICIAL({ latestVersion: '1.1.0' })), 'maintainer');
    const c = byId(r.sections[0], 'official-listing')[0];
    assert.equal(c.status, 'fail', String(status));
    assert.match(c.message, new RegExp(`^icon could not be fetched from tag \\S+ \\(HTTP ${status}\\); re-run the check later$`), String(status));
    assert.doesNotMatch(c.message, /is not on tag/, String(status));
  }
});
