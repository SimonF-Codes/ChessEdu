# ADR 0003: The Lichess ECO data set as the source of mainline theory

- **Status:** accepted
- **Date:** 2026-08-27

## Context

The opening repertoire is built from the player's own games — that part needs no external
data. But the feature that teaches something is **deviation detection**: showing where the
player's line leaves mainline theory, and what it costs. That needs a second opinion about
what "theory" *is*, and the games themselves cannot provide it. A book built from a player's
own moves can only say what they play, never whether it is sound.

Constraints, in the order they bind:

- **Licensing.** This is a public website. Whatever we ship has to be redistributable, and it
  must not drag a share-alike obligation into the rest of the codebase.
- **`packages/chess` is I/O-free** (CONTRIBUTING.md). Tree construction and deviation
  detection are pure logic behind unit tests, so their theory source has to be available
  synchronously and offline, and produce identical results on every run.
- **The coaching boundary holds** (architecture.md §6). A theory source may supply *names* and
  *continuations*. It may not supply evaluations — those come from Stockfish, always.
- One person's project. A source that needs a scraper, a cleaning pass and a maintenance
  schedule costs more than it returns.

## Decision

Use **[lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)** — the ECO
data set that backs the Lichess opening explorer — **vendored into the repo** at a pinned
commit.

- It is **CC0 1.0**: an explicit public-domain dedication over a data set that upstream
  describes as a collection of facts. No attribution obligation, no share-alike, no ambiguity.
- 3,810 named lines across ECO volumes A–E, as `eco`, `name`, and a PGN line.
- Vendored as a generated module, `packages/chess/src/eco/data.ts`, refreshed by
  `npm run sync:eco --workspace @chessedu/chess`. The pinned commit is recorded in that
  file's header and in `packages/chess/scripts/sync-eco.mjs`.
- `packages/chess/src/book.ts` expands those lines into a **position-keyed** index, so the
  book answers "is this position theory, what is it called, and what does theory play here" —
  the three questions deviation detection asks. Keying by position rather than move order
  means transpositions are recognised for free.

The book supplies names and continuations. **Every number attached to a deviation is still
read from `move_analysis`**, computed by Stockfish. The book never says a move is bad; it says
a move is not in it, and the engine says what that cost.

## Alternatives rejected

- **Chess.com's `eco` / `eco_url`, already stored on every game.** Free and already ingested,
  but it is one label for a whole game, not a per-position tree: it cannot answer "what does
  theory play *here*", which is the entire question. It also gives no continuations, so there
  is nothing to compare a move against. Separately, the Chess.com terms cover reading the
  public API, not redistributing a derived opening database. It stays what it is today — a
  cheap label on the dashboard.
- **The Lichess opening explorer API** (`explorer.lichess.ovh`, masters and Lichess
  databases). By far the richest option: real move frequencies and results over millions of
  master games, which would make "mainline theory" mean *what strong players actually play*
  rather than *what happens to have a name*. Rejected as the foundation because it is a
  network call in the middle of what CONTRIBUTING.md requires to be pure logic — unavailable
  offline, unavailable in unit tests, rate limited to roughly a request a second and
  explicitly not intended for bulk use, and non-deterministic as the database grows. Worth
  revisiting as an *enrichment layer* on top of the vendored book, cached in Postgres; see
  Consequences.
- **SCID's `scid.eco`, and the Encyclopaedia of Chess Openings itself.** `scid.eco` ships as
  part of a GPL program, so building it into a hosted service pulls a licence question into
  the data path for no gain over a CC0 alternative. The ECO volumes themselves are a
  copyrighted publication of Šahovski Informator; the *codes* are facts, the book is not.
- **Polyglot `.bin` books (Cerebellum, `Human.bin`, Perfect20xx and friends).** Good at
  answering "what move", useless at answering "why": they carry weights, not names or ECO
  codes, so there is nothing to show a player. Provenance is usually undocumented — "free to
  download" is not a licence — and several are generated from engine self-play, which makes
  them a model of engine preference rather than of theory.
- **Wikibooks *Chess Opening Theory*.** The only candidate with real prose explanation, but it
  is CC BY-SA 3.0. Share-alike reaching into a structural index that the whole app depends on
  is a much larger commitment than it looks, and it would need a scraper and a cleaning pass
  per page. Rejected as the *structural* source. It remains a reasonable candidate for
  `corpus_docs`, where a licence is recorded per document and the share-alike scope is a
  quoted chunk rather than our code.
- **Deriving a book from the player's own games.** Circular, as above: it can rank what they
  play and never tell them it is wrong.

## Consequences

- **About 390 KB of vendored data** in the repo, and in the server bundle. The repertoire view
  is a server component and the worker is a long-running process, so no part of this reaches
  the browser; if an interactive client-side book is ever wanted, it needs a trimmed export.
- **"Theory" means "reaches a named ECO position",** which is a narrower claim than "is a good
  move". Named lines run out somewhere between ply 6 and ply 20, so deviation detection
  distinguishes a *novelty* — the position had known continuations and the player played
  something else — from *out of book*, where theory simply ended. Only the former is taught.
- **The book cannot rank its own continuations.** It knows `4...Nf6` and `4...Nc6` are both
  theory; it has no idea which is better or more common. That gap is exactly what the Lichess
  explorer would fill, and is the trigger to revisit this ADR.
- **Transpositions are handled**, because the index is keyed by position. This depends on both
  sides producing FENs with `chess.js` — the book expands lines with it, and `moves.fen_before`
  was written by it in `normalizeGame`. A second FEN producer would have to normalise to the
  same position key.
- **Refreshing the pinned commit can rename lines.** Names are display-only and nothing is
  stored keyed by a name, so a refresh is a doc-and-diff exercise, not a migration.
- Building the index replays every line with `chess.js`. Lines are walked in sorted order so a
  shared prefix is replayed once rather than once per line, which brings the whole data set to
  roughly 600 ms — paid once per process, memoised behind `defaultBook()`, and paid again by
  every cold serverless instance. If that ever matters, the index is what to precompute.
