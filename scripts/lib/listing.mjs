// Marketplace listing fields (icon, screenshots, descriptionLocalized) taken from a plugin's plugin.json.
// Shared by the community scanner, the PR validator and the manifest sync tool. Zero dependencies.
//
// Everything here treats plugin.json as untrusted data: a field that breaks a rule is reported and left
// out, never repaired. Image paths become raw.githubusercontent.com URLs pinned to the release tag.
// Rule source: hq specs/plugin-spec.md, "Marketplace listing fields".

export const LISTING_FIELDS = ['descriptionLocalized', 'icon', 'screenshots'];
export const LOCALES = ['zh-Hant', 'zh-Hans'];
export const RAW_HOST = 'raw.githubusercontent.com';
const MAX_SCREENSHOTS = 5;
const MAX_ALT = 200;
const MAX_LOCALIZED = 80;
// alt is English plain text: every letter must be a Latin letter, and there must be at least one.
const NON_LATIN_LETTER_RE = /(?![\p{Script=Latin}])\p{L}/u;
const LATIN_LETTER_RE = /\p{Script=Latin}/u;
// C0/C1 control characters and the bidirectional overrides/isolates and marks.
const UNSAFE_TEXT_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const IMAGE_EXT = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.gif': 'gif' };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const length = (s) => [...s].length; // code points, so a Chinese character counts 1

function textProblem(v, max) {
  if (typeof v !== 'string') return 'must be a string';
  if (length(v) < 1 || length(v) > max) return `must be 1-${max} characters`;
  if (UNSAFE_TEXT_RE.test(v)) return 'contains control or bidirectional-override characters';
  return null;
}

function altProblem(v) {
  const why = textProblem(v, MAX_ALT);
  if (why) return why;
  if (NON_LATIN_LETTER_RE.test(v) || !LATIN_LETTER_RE.test(v)) return 'must be English text';
  return null;
}

// A relative path inside the repo. Backslashes are refused because some tools read them as separators,
// which would turn "..\x" into a parent-directory path.
export function pathProblem(p) {
  if (typeof p !== 'string' || !p) return 'must be a non-empty string';
  if (UNSAFE_TEXT_RE.test(p)) return 'contains control characters';
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//')) return 'must be a path inside the repository, not a URL';
  if (p.startsWith('/') || p.startsWith('\\')) return 'must be a relative path, not an absolute one';
  if (p.split(/[\\/]/).some((s) => s === '..')) return 'must not contain ".."';
  if (p.includes('\\')) return 'must use "/" between segments';
  if (!repoPath(p)) return 'must name a file';
  return null;
}

// The path as it is inside the repo: "." and empty segments removed ("./a//b.png" -> "a/b.png").
function repoPath(p) {
  return p.split('/').filter((s) => s && s !== '.').join('/');
}

// The image format a path promises through its extension: 'png' | 'jpeg' | 'gif' | null.
export function extFormat(p) {
  const m = /\.[A-Za-z]+$/.exec(p);
  return m ? IMAGE_EXT[m[0].toLowerCase()] ?? null : null;
}

// Each path segment is percent-encoded, so "?", "#" or spaces in a file name stay part of the path.
export function rawUrl(owner, repo, tag, path) {
  const file = repoPath(path).split('/').map(encodeURIComponent).join('/');
  return `https://${RAW_HOST}/${owner}/${repo}/${encodeURIComponent(tag)}/${file}`;
}

// Returns { listing, problems }.
//   listing:  only the fields that pass every rule, image paths turned into tag-pinned URLs
//   problems: one readable line per field that was left out, naming the field
// source: { owner, repo, tag } of the release the package came from.
export function extractListing(pj, source) {
  const listing = {};
  const problems = [];
  const bad = (field, why) => problems.push(`${field}${why.startsWith('[') ? '' : ' '}${why}`);
  const url = (p) => rawUrl(source.owner, source.repo, source.tag, p);

  if (pj?.descriptionLocalized !== undefined) {
    const d = pj.descriptionLocalized;
    if (!isObject(d)) bad('descriptionLocalized', 'must be an object');
    else {
      const out = {};
      for (const k of LOCALES) { // other keys are dropped without a report (spec: only these two are read)
        if (d[k] === undefined) continue;
        const why = textProblem(d[k], MAX_LOCALIZED);
        if (why) bad(`descriptionLocalized.${k}`, why);
        else out[k] = d[k];
      }
      if (Object.keys(out).length) listing.descriptionLocalized = out;
    }
  }

  if (pj?.icon !== undefined) {
    const why = pathProblem(pj.icon) ?? (extFormat(pj.icon) === 'png' ? null : 'must be a .png file');
    if (why) bad('icon', why);
    else listing.icon = url(pj.icon);
  }

  if (pj?.screenshots !== undefined) {
    const s = pj.screenshots;
    // One bad item drops the whole list, so the cover (item 1) is never silently replaced by item 2.
    let why = null;
    if (!Array.isArray(s)) why = 'must be an array';
    else if (s.length < 1 || s.length > MAX_SCREENSHOTS) why = `must have 1-${MAX_SCREENSHOTS} items`;
    else {
      for (const [i, item] of s.entries()) {
        const at = `[${i}]`;
        if (!isObject(item)) { why = `${at} must be an object`; break; }
        const extra = Object.keys(item).filter((k) => k !== 'src' && k !== 'alt');
        if (extra.length) { why = `${at} may only have src and alt (found ${extra.join(', ')})`; break; }
        const p = pathProblem(item.src);
        if (p) { why = `${at}.src ${p}`; break; }
        const fmt = extFormat(item.src);
        if (!fmt) { why = `${at}.src must be a .png, .jpg, .jpeg or .gif file`; break; }
        if (i === 0 && fmt === 'gif') { why = `${at}.src is the cover and must be a still .png, .jpg or .jpeg`; break; }
        const a = altProblem(item.alt);
        if (a) { why = `${at}.alt ${a}`; break; }
      }
    }
    if (why) bad('screenshots', why);
    else listing.screenshots = s.map((x) => ({ src: url(x.src), alt: x.alt }));
  }
  return { listing, problems };
}

// What an official (@openpen/*) plugin must carry, after extractListing. Each line names the field.
export function missingOfficial(listing) {
  const out = [];
  if (!listing.icon) out.push('icon is missing');
  if (!listing.screenshots) out.push('screenshots is missing');
  for (const k of LOCALES) if (!listing.descriptionLocalized?.[k]) out.push(`descriptionLocalized.${k} is missing`);
  return out;
}

// Key-order-independent JSON, for comparing a manifest's listing fields with the expected ones.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
}

// ---------- image headers ----------

// Reads the format, pixel size and (for PNG) animation from the file's own bytes; the extension is not trusted.
// Returns { format: 'png'|'jpeg'|'gif'|null, width, height, animated }.
export function inspectImage(buf) {
  const none = { format: null, width: 0, height: 0, animated: false };
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buf.toString('latin1', 12, 16) !== 'IHDR') return none;
    let animated = false;
    for (let p = 8; p + 8 <= buf.length;) {
      const len = buf.readUInt32BE(p);
      const type = buf.toString('latin1', p + 4, p + 8);
      if (type === 'acTL') { animated = true; break; } // APNG: an animation control chunk before the image data
      if (type === 'IDAT' || type === 'IEND') break;
      p += 12 + len;
    }
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), animated };
  }
  if (buf.length >= 10 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) {
    return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), animated: false };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    for (let p = 2; p + 9 <= buf.length;) {
      if (buf[p] !== 0xff) return none;
      const marker = buf[p + 1];
      if (marker === 0xff) { p++; continue; } // fill byte
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
      const len = buf.readUInt16BE(p + 2);
      // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { format: 'jpeg', width: buf.readUInt16BE(p + 7), height: buf.readUInt16BE(p + 5), animated: false };
      }
      if (marker === 0xda || len < 2) return none; // image data before any frame header
      p += 2 + len;
    }
    return none;
  }
  return none;
}
