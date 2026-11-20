// Run: node --test scripts/test/
// Regression tests for the listing field rules in scripts/lib/listing.mjs (pure functions, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractListing } from '../lib/listing.mjs';

const SRC = { owner: 'alice', repo: 'notes', tag: 'v1.0.0' };
const RAW = 'https://raw.githubusercontent.com/alice/notes/v1.0.0';

test('regression: valid relative paths are kept: "./" segments, long paths and other characters in file names', () => {
  const long = `${'a'.repeat(120)}/${'b'.repeat(120)}.png`;
  const { listing, problems } = extractListing({
    icon: './.github/marketplace/icon.png',
    screenshots: [{ src: long, alt: 'A cover.' }, { src: 'shots/step #2 (dark).gif', alt: 'Step two.' }],
  }, SRC);
  assert.deepEqual(problems, []);
  assert.equal(listing.icon, `${RAW}/.github/marketplace/icon.png`);
  assert.equal(listing.screenshots[0].src, `${RAW}/${long}`);
  assert.equal(listing.screenshots[1].src, `${RAW}/shots/step%20%232%20(dark).gif`);
});

test('regression: alt must be English text', () => {
  const shots = (alt) => ({ screenshots: [{ src: 'a.png', alt }] });
  for (const alt of ['中文說明', 'Arrow 箭頭', '1234 ...']) {
    const { listing, problems } = extractListing(shots(alt), SRC);
    assert.equal(listing.screenshots, undefined, alt);
    assert.match(problems[0], /^screenshots\[0\]\.alt must be English text$/, alt);
  }
  assert.ok(extractListing(shots('The café menu opens — “Save” is clicked.'), SRC).listing.screenshots);
});
