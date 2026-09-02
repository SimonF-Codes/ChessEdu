# Where the project stands

Replaces `integration-plan.md`, which described six unmerged feature branches. All six are
merged, so that plan is spent.

Last reviewed 2026-09-02.

## Built and merged

| | |
|---|---|
| **Scaffold** | Next.js 15 on Vercel, Auth.js v5 with Google, Neon Postgres + pgvector, Drizzle, a Fly.io worker driving Stockfish, Postgres `SKIP LOCKED` as the queue |
| **Ingest** | Chess.com archives, serial and conditional, ownership proved by a nonce on the public profile, re-proved when the username changes hands |
| **Analysis** | Per-ply Stockfish evaluation, classification, accuracy, per-phase breakdown, puzzles derived from the player's own blunders |
| **Analytics** | Trends, breakdowns by opening / colour / time control, time-trouble correlation, the per-phase strength model |
| **Puzzle review** | SM-2 scheduling, theme-weighted session ordering, board UI |
| **Openings** | Repertoire from real games, deviation from mainline theory (CC0 Lichess ECO data) |
| **Coach** | Annotated game walkthrough, grounded in stored engine output |
| **Play** | `stockfish.wasm` in a Web Worker, capped-Elo ladder, opponent picked from the player's own rating |
| **Corpus** | Chunking, embedding, pgvector retrieval, wired into the coach |

`main` is green: 442 tests across 28 files, including the Postgres-backed suites.

## The one thing that matters now

**Nothing is deployed, and no real Chess.com account has ever been synced.**

Everything above is verified against fixtures and a CI database. That is worth something, but it
does not tell you whether the thing works. The first live sync is where malformed PGN, an
unfamiliar variant, a rename or a rate limit will appear, and no amount of green CI predicts it.

### What "live" needs

Each of these needs an account only the owner can create.

1. **Neon Postgres** with `pgvector` → `DATABASE_URL` in Vercel and Fly.
2. **Google OAuth client** — Web application, redirect `https://<domain>/api/auth/callback/google`
   → `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_URL`.
3. **Vercel project** → `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` as repo secrets.
4. **Fly app** `chessedu-worker` → `FLY_API_TOKEN`. Its release command runs the migrations.
5. **`CHESSCOM_CONTACT`** on both — Chess.com blocks requests without a descriptive User-Agent.
6. **`ANTHROPIC_API_KEY`** on the web app, server-side only.

Until then `Deploy web`, `Deploy worker` and `Preview` fail on every push. That is the expected
state rather than a bug; `CI` is the check that means anything right now.

## Still open, roughly in priority order

- **No reference literature has been ingested.** The corpus pipeline works and is empty. Sourcing
  public-domain chess texts and deciding each licence is a real task, not a script.
- **No embedding provider is configured.** Anthropic has no embeddings API, so this needs a second
  vendor — see `EMBEDDING_*` in `.env.example`. Without one the coach runs uncited: supported, but
  not the point of having built a corpus.
- **The Playwright smoke test has never run.** It needs a deployment to run against.
- **Maia/Lc0 for human-like play**, and with it any bot below 1320. See ADR 0002.
- **Lichess as a second ingest source.** The `platform` column exists; nothing else does.
- **Coaching threads are not persisted** — the client carries the history and loses it on reload.
- **The coach's rate-limit counter has nowhere to live.** `429` is specified and never returned.

## Two lessons worth keeping

Both cost real time here, and both are cheap to avoid.

- **A green CI run is not proof when the failure is a race.** The two Postgres-backed suites each
  truncated shared tables, and vitest runs files in parallel, so whether CI passed depended on
  interleaving — it passed on a PR and failed on `main` from the identical tree. The fix was
  structural (a `db` project with `fileParallelism: false`), not a re-run.
- **Documentation describing unbuilt behaviour is worse than none.** `chess-com-linking.md`
  described a re-verification check that did not exist, which would have let a Chess.com rename
  silently attribute a stranger's games to the user. Two more cases turned up in the same audit.
  The document/test/implement cycle in `CONTRIBUTING.md` exists to prevent exactly this, and only
  works if the doc is checked against the code.

## Driving the terminals

For whoever runs the next parallel round:

- **Task text containing newlines gets chopped.** Each newline submits, so a multi-paragraph task
  fires as fragments into a terminal that may still be booting.
- **`cos-coord tell` truncates long messages**, keeping the tail. Three terminals once received
  briefs starting mid-sentence.

Write the brief to a file; send one short line pointing at its path.
