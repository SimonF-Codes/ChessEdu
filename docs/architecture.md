# ChessEdu — Architecture

> Source of truth for how the system is put together. Change this **before** changing code
> (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## 1. What this is

A personal chess trainer built on my own Chess.com history. Ingest the games, analyze them
with a real engine, and wrap the analysis in an education system: coaching, repertoire,
puzzles from my own blunders, reference literature, and bots to play.

Deployed as a **live website** with Google sign-in and a verified Chess.com account link.

## 2. Stack

| Layer           | Choice                                                         | Why                                                                                       |
| --------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Web app         | Next.js 15 (App Router) + React 19 + TypeScript                | One codebase for UI, server actions and API routes; first-class Vercel deploy             |
| Styling         | Tailwind CSS v4                                                | No config file, fast, consistent                                                          |
| Auth            | Auth.js v5 (NextAuth), Google provider, DB sessions            | Standard and audited; DB sessions give server-side revocation                             |
| Database        | Postgres (Neon) + `pgvector`                                   | Relational core _and_ the RAG store in one datastore                                      |
| ORM             | Drizzle                                                        | Typed schema-as-code, real SQL escape hatch, good migrations                              |
| Job queue       | Postgres `SELECT ... FOR UPDATE SKIP LOCKED`                   | Deep analysis is minutes long and cannot run in a serverless request. No Redis to operate |
| Analysis worker | Long-running Node service on Fly.io driving Stockfish over UCI | Needs a persistent process, CPU, and a real filesystem for NNUE weights                   |
| Browser engine  | `stockfish.wasm` in a Web Worker                               | Instant hints and play without burning server CPU                                         |
| Board UI        | `chess.js` + `react-chessboard`                                | De-facto standard pair, well maintained                                                   |
| Coaching LLM    | Anthropic API (`claude-opus-5`), server-side                   | It explains; it never evaluates — see section 6                                           |
| Tests           | Vitest, plus Playwright for one smoke E2E                      | Fast unit/integration loop, thin browser layer                                            |
| CI/CD           | GitHub Actions to Vercel (web) and Fly.io (worker)             | See [ci-cd.md](./ci-cd.md)                                                                |

**Rejected:** a desktop app (the idea note left this open — the website wins because the game
history lives in the cloud anyway and there is nothing to install); Redis/BullMQ (a second
datastore to operate for a queue Postgres already handles at this scale); running Stockfish
inside serverless functions (execution time caps make full-history analysis impossible).

## 3. System shape

```mermaid
flowchart TB
    subgraph browser["Browser"]
        UI["Next.js UI<br/>chess.js + react-chessboard"]
        WASM["stockfish.wasm<br/>(Web Worker)"]
        UI <--> WASM
    end

    subgraph vercel["Vercel — @chessedu/web"]
        RSC["Server Components<br/>+ Server Actions"]
        AUTH["Auth.js v5<br/>Google OAuth"]
        API["Route handlers"]
    end

    subgraph fly["Fly.io — @chessedu/worker"]
        POLL["Job poller<br/>SKIP LOCKED"]
        SF["Stockfish 17<br/>UCI over stdio"]
        ING["Chess.com ingest<br/>serial + ETag"]
        POLL --> SF
        POLL --> ING
    end

    subgraph data["Neon Postgres"]
        CORE[("games, moves,<br/>analysis, puzzles")]
        VEC[("corpus_chunks<br/>pgvector")]
        JOBS[("jobs")]
    end

    GOOG["Google OAuth 2.0"]
    CC["api.chess.com/pub<br/>read-only, no OAuth"]
    LLM["Anthropic API"]

    UI --> RSC
    UI --> API
    RSC --> AUTH
    AUTH <--> GOOG
    RSC --> CORE
    RSC --> JOBS
    API --> LLM
    LLM -.retrieves.-> VEC
    ING <--> CC
    POLL --> CORE
    POLL --> VEC
```

## 4. Repository layout

```
chessedu/
├── apps/
│   ├── web/          Next.js site: UI, auth, server actions, API routes
│   └── worker/       Long-running Node service: ingest + Stockfish analysis
├── packages/
│   ├── db/           Drizzle schema, migrations, client, job queue. The single schema owner.
│   ├── chess/        Pure domain logic: PGN parse, phase split, move classification,
│   │                 accuracy math, link-nonce rules, SM-2 scheduling and the review
│   │                 ordering policy. No I/O, so trivially testable.
│   └── chesscom/     The Chess.com API client. Shared, because the web app reads profiles to
│                     verify a link and the worker reads archives to ingest games.
├── docs/             Architecture, ADRs, runbooks.
└── .github/workflows CI + CD
```

`packages/chess` is deliberately **I/O-free**. Every rule that decides _what counts as a
blunder_, _when the endgame starts_, or _whether a link is verified_ lives there behind a unit
test, not inside a React component or a worker loop.

## 5. Data model

```mermaid
erDiagram
    users ||--o{ chess_accounts : links
    users ||--o{ link_challenges : proves
    users ||--o{ puzzles : practices
    chess_accounts ||--o{ archives : "monthly PGN dumps"
    chess_accounts ||--o{ games : owns
    games ||--o{ moves : "has ply"
    games ||--o| game_analysis : "summarized by"
    games ||--o{ move_analysis : "eval per ply"
    games ||--o{ puzzles : "generated from"
    corpus_docs ||--o{ corpus_chunks : "embedded as"
```

The ownership chain is always `users -> chess_accounts -> games -> ...`. Every query the web
app makes is scoped by `userId` at the top of that chain; there is no row a user can reach
that is not reachable through their own `users.id`.

## 6. The coaching boundary

**The engine evaluates. The LLM explains.** This is a hard architectural rule carried over
from the idea note, and it is enforced structurally rather than by prompt discipline alone:

- Every number a coaching response cites — centipawn loss, best move, accuracy, phase
  strength — is read from `move_analysis` / `game_analysis`, computed by Stockfish, and passed
  to the model as _given facts_ in the prompt.
- The model is never asked "was this a blunder?". It is asked "here is the blunder and the
  engine line; explain the idea the player missed."
- Reference-literature citations come from `corpus_chunks` retrieved via pgvector, so a claim
  about theory is attributable to a real source rather than recalled.

## 7. Analysis pipeline

```mermaid
sequenceDiagram
    actor U as User
    participant W as web (Vercel)
    participant DB as Postgres
    participant K as worker (Fly)
    participant CC as api.chess.com
    participant SF as Stockfish

    U->>W: Link and sync Chess.com account
    W->>DB: enqueue job(kind=ingest)
    K->>DB: claim job (FOR UPDATE SKIP LOCKED)
    K->>CC: GET /pub/player/{u}/games/archives
    loop each month, serially, If-Modified-Since
        K->>CC: GET archive
        CC-->>K: 200 PGN batch, or 304 unchanged
        K->>DB: upsert games + moves
    end
    K->>DB: enqueue job(kind=analyze) per new game
    K->>DB: claim analyze job
    loop each ply
        K->>SF: position ... / go depth N
        SF-->>K: bestmove + cp score
    end
    K->>DB: write move_analysis + game_analysis
    K->>DB: derive puzzles from blunders
    W-->>U: dashboard updates
```

Ingest is **serial and conditional**: Chess.com rate-limits parallel requests and supports
`If-Modified-Since`, so re-syncing an unchanged month costs a single 304. See
[chess-com-linking.md](./chess-com-linking.md).

## 8. Puzzle review

Puzzles are the player's own blunders, replayed. `generatePuzzles` in the analysis handler writes
one row per blunder the player made — the position before the mistake, with the engine's move as
the solution — and review is what reads them back.

```mermaid
flowchart LR
    subgraph db["Postgres"]
        P[("puzzle<br/>due_at, ease, interval_days,<br/>repetitions, lapses, themes")]
    end
    subgraph web["web (Vercel)"]
        Q["lib/review-queue.ts<br/>due pool, scoped by user_id"]
        UI["/review<br/>chess.js + react-chessboard"]
        A["gradeReviewAction<br/>(session-derived user)"]
    end
    subgraph chess["packages/chess — pure"]
        SEL["review.ts<br/>selectReviewSession"]
        SRS["srs.ts<br/>SM-2"]
    end

    P -->|"due only"| Q
    Q --> SEL
    SEL -->|ordered session| UI
    UI -->|outcome| A
    A --> SRS
    SRS -->|next due_at, ease,<br/>interval, lapses| P
```

**The schedule is SM-2**, as pure functions in `packages/chess/src/srs.ts`: a review is graded
0–5, a pass advances `repetitions` and multiplies the interval by the ease, and a fail is a lapse
that resets the interval and drops the ease against a 1.3 floor. Nothing about the schedule lives
in a component or a server action — those only supply the current state and store what comes back.

**The order is not the schedule.** Far more puzzles come due than fit in a session, so which due
puzzles to show is a separate decision, made in `packages/chess/src/review.ts`:

> Among puzzles SM-2 has made due, rank by a blend of **how overdue** the puzzle is relative to its
> own interval and **how often the player fails its theme**, then cap how many puzzles one theme
> may contribute to a session.

The blend is deliberate in both directions: weighting purely by due date targets nothing the player
is actually weak at, while ordering purely by failure rate would starve the themes they have
mastered and defeat the retention SM-2 is there for. The per-theme cap keeps a session from
becoming ten of the same motif, and yields when the backlog genuinely holds nothing else.

The reasoning, the constants, and the five alternatives that lost are in
[ADR 0002](./adr/0002-puzzle-review-ordering.md).

**Authorisation** follows section 9 without exception: the queue query is scoped by `user_id`, and
grading re-derives the user from the session and scopes the update by `user_id` too, so a puzzle id
guessed by a client updates nothing.

## 9. Security posture

- **Sessions** are database-backed, in `httpOnly` + `Secure` + `SameSite=Lax` cookies. No JWT
  in local storage; a session can be revoked server-side.
- **Google OAuth is the only credential path.** No passwords are stored, ever.
- **Authorization is enforced in server code**, never by hiding UI. Every server action
  re-derives `userId` from the session and scopes its query by it.
- **The Chess.com link proves ownership** before any data is attributed to a user. A username
  alone is a public string and proves nothing — see the nonce flow in
  [chess-com-linking.md](./chess-com-linking.md).
- **Secrets** live in Vercel/Fly environment config and `.env.local`. `.env` is gitignored and
  `.env.example` carries only names. The Anthropic key is server-only and never reaches the
  browser.
- **The worker exposes no inbound port.** It polls Postgres; nothing can call it.

## 10. Open questions carried from the idea note

- Lichess as a second ingest source. The `platform` column exists for it; nothing else does.
- Reference-literature licensing. Bootstrap on public-domain classics only.
- Maia/Lc0 bot hosting is heavier than Stockfish — likely a separate Fly machine running a
  CPU Lc0 build with small nets. Not scaffolded yet.
