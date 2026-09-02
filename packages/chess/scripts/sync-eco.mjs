#!/usr/bin/env node
/**
 * Regenerate src/eco/data.ts from lichess-org/chess-openings.
 *
 * The data set is CC0, which is the whole reason it was picked — see
 * docs/adr/0002-opening-theory-source.md. It is vendored rather than fetched at runtime so
 * that packages/chess stays I/O-free and the unit tests stay deterministic and offline.
 *
 *   node scripts/sync-eco.mjs [commit-sha]
 *
 * With no argument it re-fetches the pin below, which verifies the checked-in file still
 * matches upstream. Pass a commit to move the pin — deliberately, never automatically.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The upstream commit this data was taken from. */
const PINNED_COMMIT = '4b8622759e7ae6f93f011cc6c83a3823401ab45e';

const VOLUMES = ['a', 'b', 'c', 'd', 'e'];
const REPO = 'lichess-org/chess-openings';

const BACKTICK = String.fromCharCode(96);
const BACKSLASH = String.fromCharCode(92);

const commit = process.argv[2] ?? PINNED_COMMIT;
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'eco', 'data.ts');

/** Body rows only: every volume file repeats the "eco / name / pgn" header. */
async function fetchVolume(volume) {
  const url = `https://raw.githubusercontent.com/${REPO}/${commit}/${volume}.tsv`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  const text = await response.text();
  return text
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim().length > 0);
}

const rows = [];
for (const volume of VOLUMES) {
  rows.push(...(await fetchVolume(volume)));
}
rows.sort();

// Embedding the rows in a template literal is only safe because the data set is plain move
// text and opening names. Fail loudly rather than emit a file that will not parse.
for (const row of rows) {
  if (row.includes(BACKTICK) || row.includes(BACKSLASH) || row.includes('${')) {
    throw new Error(`row would break the template literal: ${row}`);
  }
}

const header = [
  '/**',
  ` * ECO opening lines from ${REPO}, pinned at ${commit}.`,
  ' *',
  ' * GENERATED FILE — do not edit. Run "npm run sync:eco" to refresh.',
  ' *',
  ' * Licence: CC0 1.0 Universal (public domain dedication). Upstream describes the data set',
  ' * as a collection of facts and releases the curation under CC0, which is why this source',
  ' * was chosen over the alternatives — see docs/adr/0002-opening-theory-source.md.',
  ' *',
  ` * One line per named opening, tab separated as eco / name / pgn. ${rows.length} lines,`,
  ' * parsed by parseEcoTsv in ../book.ts.',
  ' */',
].join('\n');

const file = `${header}\nexport const ECO_TSV = ${BACKTICK}${rows.join('\n')}${BACKTICK};\n`;

await writeFile(target, file, 'utf8');
console.log(`wrote ${target} (${rows.length} lines, commit ${commit})`);
