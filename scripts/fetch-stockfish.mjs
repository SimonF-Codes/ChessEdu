#!/usr/bin/env node

/**
 * Fetch the browser Stockfish build into apps/web/public/engines/.
 *
 * Engine binaries are fetched, never committed — the same rule .gitignore applies to the
 * worker's native Stockfish and its NNUE weights. This runs from `predev` and `prebuild`, and
 * is a no-op once the files are on disk and hashing clean.
 *
 * The build is deliberately the SINGLE-THREADED one: the threaded build needs SharedArrayBuffer,
 * which needs COOP/COEP, which breaks Google sign-in and every remote image. See
 * docs/adr/0002-browser-engine.md.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pinned. Bumping this means re-recording both hashes — see docs/browser-engine.md. */
const ENGINE_VERSION = '18.0.8';

/**
 * `lite` is the small NNUE net, embedded in the .wasm so there is no separate weights file.
 * `single` is the no-SharedArrayBuffer build. Switching either half changes the header story.
 */
const ENGINE_FILE = 'stockfish-18-lite-single';

/**
 * SHA-256 of each file as published in the stockfish@18.0.8 npm tarball. The CDN is a
 * convenience; these hashes are what actually decides whether the bytes are trusted, because
 * this code runs in the user's tab.
 */
const FILES = [
  {
    name: `${ENGINE_FILE}.js`,
    sha256: '5243fd9b276cab7dfe3ad1d43ab9ead73568fac76468c614242977a210c4a391',
  },
  {
    name: `${ENGINE_FILE}.wasm`,
    sha256: 'a8fbc05ec6920b56d7485826dcb02c5ffd2826bcbf751cf973046f237a9096f1',
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const destination = join(here, '..', 'apps', 'web', 'public', 'engines');

/** jsDelivr refuses this package (it is over their 150 MB size limit); unpkg serves it. */
const urlFor = (name) => `https://unpkg.com/stockfish@${ENGINE_VERSION}/bin/${name}`;

const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function alreadyGood(path, expected) {
  try {
    return digest(await readFile(path)) === expected;
  } catch {
    return false;
  }
}

async function fetchOne({ name, sha256 }) {
  const path = join(destination, name);

  if (await alreadyGood(path, sha256)) {
    console.log(`[engine] ${name} is present and verified`);
    return;
  }

  const url = urlFor(name);
  console.log(`[engine] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  const actual = digest(body);
  if (actual !== sha256) {
    // Do not leave unverified bytes where Next would happily serve them.
    await rm(path, { force: true });
    throw new Error(
      `checksum mismatch for ${name}\n  expected ${sha256}\n  actual   ${actual}\n` +
        'If you just bumped ENGINE_VERSION, check the new hash against the npm tarball before ' +
        'trusting it — see docs/browser-engine.md.',
    );
  }

  await writeFile(path, body);
  const size =
    body.length < 1e6
      ? `${Math.round(body.length / 1e3)} KB`
      : `${(body.length / 1e6).toFixed(1)} MB`;
  console.log(`[engine] wrote ${name} (${size})`);
}

async function main() {
  await mkdir(destination, { recursive: true });
  // Serial: two requests, and a clear log beats a fast one.
  for (const file of FILES) await fetchOne(file);
}

main().catch((error) => {
  console.error(`[engine] ${error.message}`);
  process.exit(1);
});
