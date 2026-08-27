# ADR 0001: Next.js on Vercel, a Fly.io worker, and Postgres as the queue

- **Status:** accepted
- **Date:** 2026-08-27

## Context

The idea note left the shape open: "Desktop app vs local web app; engine runs local either
way." The requirement has since firmed up — a **live website**, with Google sign-in and a
linked Chess.com account. That settles the client question and creates a new one: full-history
engine analysis takes minutes of CPU per game and cannot happen inside a web request.

Constraints:

- Analysis of a several-thousand-game history is a long batch job, resumable, one game at a time.
- Interactive use — a hint, a bot move, an eval bar — must be instant and must not queue behind
  the batch.
- This is a personal project. Every piece of infrastructure is one more thing to operate.

## Decision

Three services, two engines, one datastore.

- **Next.js 15 on Vercel** for the site: server components, server actions, and Auth.js v5 with
  Google. Sessions in the database.
- **A long-running Node worker on Fly.io** for ingest and deep analysis, driving a native
  Stockfish binary over UCI. It holds no inbound port and polls for work.
- **Neon Postgres with pgvector** as the only datastore: relational core, RAG corpus, and the
  job queue via `SELECT ... FOR UPDATE SKIP LOCKED`.
- **`stockfish.wasm` in the browser** for anything interactive.

## Alternatives rejected

- **Desktop app (Electron/Tauri).** The game history lives in the cloud, so the app would spend
  its life talking to an API anyway; a website removes install and update entirely, and makes
  the "try it live" requirement trivial. The cost — server CPU for analysis — is the price paid
  by the worker.
- **Redis + BullMQ for the queue.** A second stateful service to run and pay for. At a few
  thousand jobs, `SKIP LOCKED` on a table we already operate is entirely adequate, transactional
  with the data it enqueues, and inspectable with SQL.
- **Analysis in serverless functions.** Vercel functions cap execution well below what a full
  game analysis needs, and cold-starting a Stockfish binary per request wastes most of the work.
- **Browser-only analysis via WASM.** Tempting — zero server cost — but a full-history backfill
  would require the tab to stay open for hours, and results could not be trusted server-side
  since the client could forge them. WASM stays for interactive use only.
- **SQLite/Turso.** No pgvector equivalent for the reference corpus, and the worker plus web app
  want genuine concurrent writers.
- **Supabase instead of Neon + Auth.js.** Would bundle auth and database, but pulls the auth
  model into a vendor and gives less control over session handling. Neon's per-PR database
  branching is worth more to this project.

## Consequences

- Two deploy targets to keep in step. Migrations therefore run in exactly one place — the
  worker's Fly release command — and must stay backward compatible for the length of a rollout.
- Analysis throughput is bounded by one Fly machine. Fine for one user; a real ceiling if this
  ever has several. The queue is the seam where that scales out.
- pgvector doing double duty means the corpus competes with OLTP for the same instance. Revisit
  if the corpus grows past roughly a million chunks.
- Stockfish exists in two forms (native in the worker, WASM in the browser) at possibly
  different versions. Evaluations shown live may differ slightly from stored analysis; the UI
  labels which produced a number.
