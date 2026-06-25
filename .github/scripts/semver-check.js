#!/usr/bin/env node
// Decides whether the current package version should be released.
//
// Uses full semver precedence — including prerelease ordering — as defined by
// https://semver.org/#spec-item-11, so it stays correct even when versions use
// prerelease suffixes (e.g. 1.2.0-beta.1) where a plain `sort -V` is unreliable.
//
// Usage:   git tag --list 'v*' | node semver-check.js <currentVersion>
// Output:  prints "true" or "false" to stdout (the release decision);
//          human-readable reasoning is written to stderr (shows up in CI logs).
//
// No external dependencies — runs on a bare Node install with no `npm install`.

import { readFileSync } from 'fs';

const current = process.argv[2];
if (!current) {
  console.error('Usage: semver-check.js <currentVersion> (existing tags on stdin)');
  process.exit(2);
}

// major.minor.patch, optional -prerelease, optional +build (build is ignored).
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(value) {
  const m = SEMVER_RE.exec(value.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

// Compare two prerelease identifier lists per semver §11.4.
// An empty list (no prerelease) has HIGHER precedence than a non-empty one.
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);

    if (aNum && bNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (aNum !== bNum) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return aNum ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1; // ASCII lexical order
    }
  }
  // All shared identifiers equal: the longer set has higher precedence.
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function compare(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

const cur = parse(current);
if (!cur) {
  console.error(`Current version "${current}" is not valid semver.`);
  process.exit(2);
}

const tags = readFileSync(0, 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

let highest = null;
let highestRaw = null;
let exactExists = false;

for (const tag of tags) {
  const parsed = parse(tag.replace(/^v/, ''));
  if (!parsed) continue; // ignore tags that aren't semver releases
  if (compare(parsed, cur) === 0) exactExists = true;
  if (!highest || compare(parsed, highest) > 0) {
    highest = parsed;
    highestRaw = tag.replace(/^v/, '');
  }
}

function decide() {
  if (!highest) {
    console.error('No existing release tags found — releasing.');
    return true;
  }
  if (exactExists) {
    console.error(`Tag for ${current} already exists — version was not bumped. Skipping.`);
    return false;
  }
  if (compare(cur, highest) > 0) {
    console.error(`Version ${current} is higher than latest released ${highestRaw} — releasing.`);
    return true;
  }
  console.error(`Version ${current} is not higher than latest released ${highestRaw} — skipping.`);
  return false;
}

process.stdout.write(decide() ? 'true' : 'false');
