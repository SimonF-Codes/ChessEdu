# Integration plan

Six feature branches are complete and pushed. None is merged. This is the order to land them
and the collisions to resolve on the way.

Written 2026-09-02, after the first parallel build round.

## Where things stand

| Branch | Commit | State |
|---|---|---|
| `wt/main-1` | `a4ba315` | Corpus **design only** — retrieval interface documented, `packages/corpus` not written |
| `wt/main-2` | `d035fd8` | Analytics + per-phase strength model — complete |
| `wt/main-3` | `95fa0ad` | Puzzle review, SM-2, session ordering — complete |
| `wt/main-4` | `27226f2` | Coaching walkthrough — complete, corpus retrieval stubbed |
| `wt/main-5` | `c3cd33a` | Opening repertoire — complete |
| `wt/main-7` | `4194923` | Browser play vs Stockfish — complete, verified in Chrome |

`main` is at `71279f3`. Every branch is one commit behind it (the MIT license), so each needs a
rebase or merge from `main` before it lands.

`wt/main-6` is an abandoned empty worktree from a terminal that died. Prune it.

## The three collisions

These are real and already on disk. Resolve them **in the branches, before merging** — doing it
inside a merge conflict is far worse.

### 1. `packages/chess/src/review.ts` exists twice, with different contents

- `wt/main-3` — 6.9KB, review-session *ordering policy*
- `wt/main-4` — 14.2KB, annotated *game walkthrough*

Unrelated purposes, same path. Neither branch knows about the other.

**Fix:** rename on the branch before merge.
- `wt/main-3`: `review.ts` → `session-order.ts` (and `review.test.ts` to match)
- `wt/main-4`: `review.ts` → `game-review.ts` (and its test)

Update `packages/chess/src/index.ts` and the `./review` subpath export in
`packages/chess/package.json` accordingly.

### 2. Three different ADR 0002s

- `wt/main-3`: `0002-puzzle-review-ordering.md`
- `wt/main-5`: `0002-opening-theory-source.md`
- `wt/main-7`: `0002-browser-engine.md`

**Fix:** renumber in merge order — 0002 browser engine, 0003 opening theory source, 0004 puzzle
review ordering. Update any cross-references.

### 3. `docs/architecture.md` edited by four branches

`wt/main-1`, `wt/main-3`, `wt/main-4` and `wt/main-7` all changed it, and `wt/main-4`
**renumbered sections 8/9/10**. That shifts the section references in `CONTRIBUTING.md` and in
several branch commit messages, which point at "section 6, the coaching boundary".

**Fix:** one person takes this file across all four merges rather than resolving it four times.
Re-check every "section N" reference in the repo afterwards.

### Lesser overlaps

Expected, mechanical, low risk — but all need a human eye at merge time:

- `apps/web/app/(app)/layout.tsx` — nav links from `wt/main-3`, `wt/main-5`, `wt/main-7`
- `packages/chess/src/index.ts` — new exports from `wt/main-3`, `wt/main-4`, `wt/main-5`, `wt/main-7`
- `packages/chess/package.json` — subpath exports from `wt/main-4`, `wt/main-5`, `wt/main-7`
- `apps/web/app/(app)/dashboard/page.tsx` — `wt/main-2` and `wt/main-4`
- `apps/web/tsconfig.json` — `wt/main-4` and `wt/main-7`
- `README.md` — `wt/main-2` and `wt/main-7`
- `apps/web/auth.ts`, `apps/worker/src/index.ts` — touched by several

## Merge order

Dependency-driven, not arbitrary. Each step: rebase on `main`, open a PR, let CI go green, merge.

1. **`wt/main-2` (analytics)** — first, because `wt/main-7` consumes the per-phase strength
   model and is currently stubbed against it. Landing this lets play swap to the real thing.
2. **`wt/main-1` (corpus design)** — small, mostly documentation. Landing the interface early
   settles the contract `wt/main-4` is stubbed against.
3. **`wt/main-7` (play)** — rename its ADR to 0002. Swap the strength-model stub for the real
   import from step 1.
4. **`wt/main-5` (openings)** — renumber its ADR to 0003.
5. **`wt/main-3` (puzzles)** — rename `review.ts` → `session-order.ts`, renumber ADR to 0004.
6. **`wt/main-4` (coach)** — last, because it carries the `architecture.md` renumbering and the
   other `review.ts`. Rename to `game-review.ts`. Swap `apps/web/lib/coach/retrieval.ts` from
   the stub to the real retrieval once `packages/corpus` exists.

After every merge: `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build`.
CI does this too, but a local check is faster than a round trip.

## Then: finish what is half-built

- **`packages/corpus` implementation.** `wt/main-1` designed the retrieval interface and stopped.
  The ingest, chunker, embedding and retrieval are still to write. Until they exist, coaching
  cites nothing and `apps/web/lib/coach/retrieval.ts` stays a stub.
- **Swap both stubs** — coach → real retrieval, play → real strength model.

## Then: make it actually live

None of this is deployed. The pipeline exists and CI is green, but the deploy jobs have never
succeeded because nothing is configured.

1. **A Neon Postgres** with `pgvector`, and `DATABASE_URL` set in Vercel and Fly.
2. **A Google OAuth client** — Web application, redirect URI
   `https://<domain>/api/auth/callback/google`. Set `AUTH_SECRET`, `AUTH_GOOGLE_ID`,
   `AUTH_GOOGLE_SECRET`, `AUTH_URL`.
3. **GitHub secrets** — `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `FLY_API_TOKEN`.
   See `docs/ci-cd.md`.
4. **`CHESSCOM_CONTACT`** on both — Chess.com blocks requests without a descriptive User-Agent.
5. **`ANTHROPIC_API_KEY`** on the web app, server-side only.
6. **Create the Fly app** `chessedu-worker` and confirm the release command runs migrations.

Only after this does "link my account and see my games" work end to end. That is the first
real test of the whole thing, and nothing before it proves much.

## Known risks

- **Nothing has run against a real Chess.com account.** Ingest is tested against fixtures only.
  The first real sync will find something — malformed PGN, a variant, a rename, a rate limit.
- **Analysis throughput is one Fly machine.** Fine for one player; the queue is the seam if that
  changes.
- **`stockfish.wasm` and the native Stockfish may differ in version**, so a live evaluation can
  disagree with stored analysis. The UI should say which produced a number.

## A note for whoever drives the next round

Two things went wrong in the first round, both avoidable:

- **Task text with newlines gets chopped** — each newline submits, so a multi-paragraph task
  fires as fragments into a terminal that may still be booting.
- **`cos-coord tell` truncates long messages**, keeping the tail. Three terminals received
  briefs starting mid-sentence.

Write the brief to a file, then send one short line pointing at its path.
