# ChessEdu

A personal chess trainer built on my own Chess.com game history: pull the games,
analyze them with an engine, and wrap the analysis in a real education system —
direct coaching, reference literature, and bots to play against.

Runs as a live website: Google sign-in, and a Chess.com account linked by proving you own it.

Idea note: `Simon-Brain/Personal/Code/Chess Trainer.md`

## Planned pieces

- **Ingest** — Chess.com public API archives → local PGN store, incremental sync.
- **Analytics** — local Stockfish per-game analysis; blunder classification, accuracy
  trends, breakdowns by opening / color / time control; per-phase and per-theme
  strength model rather than a single rating number.
- **Education** — coaching grounded in my own positions, openings, annotated game
  history, technique lessons, and puzzles generated from my actual mistakes, with an
  embedded reference-literature corpus so coaching cites real sources.
- **Play** — Stockfish at capped ELO plus human-like engines (Lc0, Maia) tuned just
  above my current level per phase.

## Stack

Next.js 15 on Vercel · Auth.js v5 with Google · Neon Postgres with pgvector · Drizzle ·
a Fly.io worker driving Stockfish over UCI · `stockfish.wasm` in the browser for anything
interactive · Anthropic for coaching that explains but never evaluates.

The reasoning, including what was rejected, is in [ADR 0001](docs/adr/0001-stack.md).

## Getting started

```bash
cp .env.example .env.local          # fill in AUTH_* and DATABASE_URL
npm install
npm run db:migrate
npm run dev                         # http://localhost:3000
npm run dev:worker                  # ingest + analysis, in another terminal
```

You need a Postgres with `pgvector`. Quickest local option:

```bash
docker run -d -p 5432:5432 \
  -e POSTGRES_USER=chessedu -e POSTGRES_PASSWORD=chessedu -e POSTGRES_DB=chessedu \
  pgvector/pgvector:pg17
```

Google OAuth: create a Web application client in the Google Cloud console with the redirect URI
`http://localhost:3000/api/auth/callback/google`, then put the id and secret in `.env.local`.

The worker also needs a Stockfish binary; point `STOCKFISH_PATH` at it.

## Layout

| Path | What |
|---|---|
| `apps/web` | The site: UI, auth, server actions, API routes |
| `apps/worker` | Long-running service: Chess.com ingest and Stockfish analysis |
| `packages/db` | Drizzle schema, migrations, client, job queue. The single schema owner |
| `packages/chess` | Pure domain logic — classification, phases, accuracy, PGN, link rules |
| `packages/chesscom` | Chess.com API client: serial, conditional, rate-limit aware |
| `docs/` | Architecture, ADRs, runbooks |

## Docs

- [Architecture](docs/architecture.md) — system shape, data model, security posture, diagrams
- [ADR 0001](docs/adr/0001-stack.md) — why this stack, and what lost
- [Linking a Chess.com account](docs/chess-com-linking.md) — why a nonce, and how ingest behaves
- [CI/CD](docs/ci-cd.md) — pipeline, environments, migration policy
- [CONTRIBUTING](CONTRIBUTING.md) — the document, then test, then implement cycle

## Status

Scaffold, and it builds and runs. In place: Google sign-in, verified Chess.com account linking,
the ingest and analysis pipeline, the job queue, the schema, and CI/CD.

Not built yet: the coaching UI, the repertoire view, puzzle review, the reference-corpus
ingest, and the bots. The schema and the queue have a place for each.
