# Third-party notices

ChessEdu is MIT licensed — see [LICENSE](LICENSE). It builds on the work below, which keeps its
own licensing. This file records what is used, under what terms, and how each component reaches a
user.

> This is an attribution record, not legal advice.

## Stockfish — GPL-3.0-or-later

Stockfish is the only copyleft component, and it is used in two places. Neither links it into
ChessEdu's own code.

### In the browser

[`stockfish.js`](https://github.com/nmrugg/stockfish.js) — the WebAssembly port by Nathan Rugg of
[Stockfish](https://github.com/official-stockfish/Stockfish) by the Stockfish developers.

- **Pinned at `stockfish@18.0.8`**, the `stockfish-18-lite-single` build (single-threaded; see
  [ADR 0002](docs/adr/0002-browser-engine.md) for why the threaded build is not used).
- **Fetched at build time, never committed.** `scripts/fetch-stockfish.mjs` downloads it from
  unpkg and verifies each file against a pinned SHA-256 before writing it. `apps/web/public/engines/`
  is gitignored.
- **Served to the browser as a standalone asset** from `/engines/`, unmodified, and executed in a
  Web Worker. ChessEdu speaks to it over UCI; no Stockfish code is compiled into the application
  bundle.
- **The licence is served with it**, at `/engines/Copying.txt`, fetched and hash-pinned by the same
  script.
- Corresponding source: <https://github.com/nmrugg/stockfish.js> at the `18.0.8` tag, and upstream
  <https://github.com/official-stockfish/Stockfish>.

### In the worker

`apps/worker` drives a **native Stockfish binary that ChessEdu neither ships nor distributes**. The
operator installs it and points `STOCKFISH_PATH` at it; the worker launches it as a separate
process and communicates over UCI on stdin/stdout. NNUE weights (`*.nnue`) are likewise gitignored
and never redistributed.

## ECO opening data — CC0-1.0

Opening names and lines in `packages/chess/src/eco/data.ts` are derived from
[lichess-org/chess-openings](https://github.com/lichess-org/chess-openings), pinned at commit
`4b8622759e7ae6f93f011cc6c83a3823401ab45e`, released into the public domain under
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).

CC0 requires no attribution. It is credited here and in the file header because the curation is
real work, and because [ADR 0003](docs/adr/0003-opening-theory-source.md) chose this source over
the alternatives specifically for its licence.

## Runtime dependencies

Direct dependencies, with the licence each declares:

| Package | Licence |
| --- | --- |
| `next`, `react`, `react-dom` | MIT |
| `react-chessboard` | MIT |
| `chess.js` | BSD-2-Clause |
| `drizzle-orm` | Apache-2.0 |
| `@auth/drizzle-adapter`, `next-auth` | ISC |
| `postgres` | Unlicense |
| `@anthropic-ai/sdk` | MIT |
| `@ai-sdk/anthropic` | Apache-2.0 |
| `tsx` | MIT |

Full transitive licence text ships in `node_modules`; `npm ls --omit=dev` lists the resolved tree.

## Data services

- **Chess.com Published-Data API** — game history and profiles, used under
  [Chess.com's published-data terms](https://www.chess.com/news/view/published-data-api). ChessEdu
  sends a contact address in its `User-Agent` on every request, configured as `CHESSCOM_CONTACT`,
  as that API asks.
- **Chess.com account linking** does not use OAuth, which Chess.com does not offer publicly.
  Ownership is proved by a single-use nonce the user places in their own public profile — see
  [`docs/architecture.md`](docs/architecture.md).

## Original content

Opening prose, coaching text and documentation in this repository are original work by the
ChessEdu authors, covered by the repository's MIT licence. None of it is transcribed from an
opening book, annotation database or commercial course.

Any evaluation quoted in the application is generated from this project's own Stockfish analysis;
no third-party evaluation database is used.
