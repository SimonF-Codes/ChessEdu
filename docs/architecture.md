# ChessEdu — Architecture

> Source of truth for how the system is put together. Change this **before** changing code
> (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## 1. What this is

A personal chess trainer built on my own Chess.com history. Ingest the games, analyze them
with a real engine, and wrap the analysis in an education system: coaching, repertoire,
puzzles from my own blunders, reference literature, and bots to play.

Deployed as a **live website** with Google sign-in and a verified Chess.com account link.

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Web app | Next.js 15 (App Router) + React 19 + TypeScript | One codebase for UI, server actions and API routes; first-class Vercel deploy |
| Styling | Tailwind CSS v4 | No config file, fast, consistent |
| Auth | Auth.js v5 (NextAuth), Google provider, DB sessions | Standard and audited; DB sessions give server-side revocation |
| Database | Postgres (Neon) + `pgvector` | Relational core *and* the RAG store in one datastore |
| ORM | Drizzle | Typed schema-as-code, real SQL escape hatch, good migrations |
| Job queue | Postgres `SELECT ... FOR UPDATE SKIP LOCKED` | Deep analysis is minutes long and cannot run in a serverless request. No Redis to operate |
| Analysis worker | Long-running Node service on Fly.io driving Stockfish over UCI | Needs a persistent process, CPU, and a real filesystem for NNUE weights |
| Browser engine | Stockfish 18 `lite`, **single-threaded** WASM, in a Web Worker | Instant hints and bot play without burning server CPU, and without the COOP/COEP headers a threaded build would need — see [ADR 0002](./adr/0002-browser-engine.md) |
| Board UI | `chess.js` + `react-chessboard` | De-facto standard pair, well maintained |
| Coaching LLM | Anthropic API (`claude-opus-5`), server-side | It explains; it never evaluates — see sections 6 and 7 |
| Tests | Vitest, plus Playwright for one smoke E2E | Fast unit/integration loop, thin browser layer |
| CI/CD | GitHub Actions to Vercel (web) and Fly.io (worker) | See [ci-cd.md](./ci-cd.md) |

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
    API -.retrieves.-> VEC
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
│   │                 accuracy math, link-nonce rules. No I/O, so trivially testable.
│   └── chesscom/     The Chess.com API client. Shared, because the web app reads profiles to
│                     verify a link and the worker reads archives to ingest games.
├── docs/             Architecture, ADRs, runbooks.
└── .github/workflows CI + CD
```

`packages/chess` is deliberately **I/O-free**. Every rule that decides *what counts as a
blunder*, *when the endgame starts*, or *whether a link is verified* lives there behind a unit
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
  to the model as *given facts* in the prompt.
- The model is never asked "was this a blunder?". It is asked "here is the blunder and the
  engine line; explain the idea the player missed."
- Reference-literature citations come from `corpus_chunks` retrieved via pgvector, so a claim
  about theory is attributable to a real source rather than recalled.

## 7. The coaching endpoint

`POST /api/coach` is the only path from the browser to the model. The coaching UI, puzzle review
and the repertoire view all consume it, so its shape is written down here **before** it is
implemented, and is treated as frozen: a change to the request, the event stream, or the fact
payload lands in this section first.

### 7.1 Why a route handler and not a server action

Every other write in this app is a server action (see `app/(app)/link/actions.ts`). Coaching is
not, for two reasons. The response is *streamed* — tokens are rendered as they arrive, and a
server action returns exactly once. And a single response carries three interleaved kinds of
payload: the engine facts, the prose, and the citations. Named SSE events keep them apart without
inventing a framing.

### 7.2 Request

```ts
// POST /api/coach   Content-Type: application/json
interface CoachRequest {
  /** A game the caller owns. Ownership is re-derived server-side; see 7.6. */
  gameId: string;
  /** Focus one move. Omitted, the whole game is in scope. */
  ply?: number;
  /** What the user asked. Omitted, the coach explains the moves in scope unprompted. */
  question?: string;
  /** Prior turns of this coaching thread, carried by the client. Untrusted — see below. */
  history?: CoachTurn[];
}

interface CoachTurn {
  role: 'user' | 'assistant';
  text: string;
}
```

| Field | Rule | On violation |
|---|---|---|
| `gameId` | UUID, and reachable from the session user through `chess_accounts` | `403` / `404`, per 7.6 |
| `ply` | integer in `1..game.moveCount` | `422` |
| `question` | at most `COACH_MAX_QUESTION_CHARS` (500) | `422` |
| `history` | at most `COACH_MAX_HISTORY_TURNS` (8), 4000 chars total, alternating from `user` | oldest turns dropped, then `422` |

**There is no `userId` field, and there never will be one.** The handler calls `requireUser()` and
scopes every query by the result, exactly like the server actions do.

`history` is echoed back to the model as conversation, but it is **not** a source of facts. Every
number in the next answer is re-read from `move_analysis` / `game_analysis` on this request. A
client that edits an assistant turn to claim a different evaluation changes the prose it is
replying to and nothing else. Persisting threads server-side is deferred — see section 15.

### 7.3 Response — an SSE stream

`200` with `Content-Type: text/event-stream`, `Cache-Control: no-store`, and
`X-Accel-Buffering: no` so nothing in front of the app buffers the stream into one lump.

| Event | Payload | When |
|---|---|---|
| `facts` | `CoachFacts` | Exactly once, **before any prose**. |
| `delta` | `{ text: string }` | Repeatedly, as the model streams. |
| `citation` | `CoachCitation` | As each citation arrives, interleaved with `delta`. |
| `done` | `{ stopReason, usage: { inputTokens, outputTokens, cacheReadTokens } }` | Exactly once, last. |
| `error` | `{ code, message }` | Terminal, and only *after* the stream has opened. |

`facts` arriving first is a contract, not an accident: it lets the UI paint the eval bar and the
engine line before the first token, and it lets a test assert that the numbers the prose cites
were handed to the model rather than recalled by it.

Once the response has started there is no status code left to send, so a mid-stream failure is an
`error` event followed by the connection closing. A client must handle a stream that ends after
`facts` with no `done`.

```mermaid
sequenceDiagram
    participant C as Client
    participant R as /api/coach
    participant DB as Postgres
    participant A as Anthropic API
    C->>R: POST { gameId, ply, question }
    R->>R: requireUser()
    R->>DB: game join chess_account where user_id = session
    DB-->>R: game + moves + move_analysis + game_analysis
    alt no game_analysis row
        R-->>C: 409 analysis_pending
    end
    R->>DB: retrieve corpus chunks (pgvector)
    R-->>C: event: facts
    R->>A: messages.stream(system=brief, docs + facts + question)
    loop until done
        A-->>R: text and citation deltas
        R-->>C: event: delta / event: citation
    end
    R-->>C: event: done
```

### 7.4 The facts payload

```ts
interface CoachFacts {
  game: {
    id: string;
    url: string;
    playedAt: string; // ISO 8601
    userColor: 'w' | 'b';
    userResult: 'win' | 'loss' | 'draw';
    timeControl: string;
    eco: string | null;
    userRating: number | null;
    opponentRating: number | null;
  };
  analysis: {
    engine: string; // e.g. "Stockfish 17"
    depth: number;
    accuracy: number | null; // the user's side
    acpl: number | null; // the user's side
    blunderCount: number;
    mistakeCount: number;
    inaccuracyCount: number;
  };
  /** Only the plies in scope, ascending. */
  moves: CoachMoveFact[];
}

interface CoachMoveFact {
  ply: number;
  color: 'w' | 'b';
  san: string;
  uci: string;
  fenBefore: string;
  phase: 'opening' | 'middlegame' | 'endgame';
  evalCp: number | null; // after the move, White's perspective
  mateIn: number | null;
  bestMoveUci: string | null;
  pv: string[];
  centipawnLoss: number;
  winPercentLoss: number;
  classification: 'blunder' | 'mistake' | 'inaccuracy' | 'good';
  isCritical: boolean;
  clockMs: number | null;
}
```

Every field is a column of `moves` / `move_analysis` / `game_analysis`, passed through unmodified.
Nothing here is computed at request time, and nothing here is produced by the model.

**Which plies are in scope:**

| Request | Scope |
|---|---|
| `ply` given | that ply, plus `COACH_CONTEXT_PLIES` (2) either side, clamped to the game |
| `ply` omitted | every `isCritical` move, then the highest `winPercentLoss` moves until `COACH_MAX_MOVES` (12) is reached, ascending by ply |

The whole-game cap exists so that a 200-ply game does not become a 200-move prompt. A user who
wants a move the cap excluded asks for it by `ply`.

### 7.5 Citations

Retrieved corpus chunks are passed as `document` content blocks with `citations: { enabled: true }`,
which makes the API return the exact span it used:

```ts
interface CoachCitation {
  /** Index into the documents sent this turn, and the order they appear in the prose. */
  index: number;
  chunkId: string; // corpus_chunks.id
  docTitle: string;
  author: string | null;
  locator: string | null; // e.g. "ch. 4, p. 91"
  quotedText: string; // the span the model actually cited
}
```

The server maps the API's `document_index` back to the `corpus_chunks` row it sent, so a citation
always resolves to a real row. **The coach cannot cite a source it was not handed** — the retrieval
half of the rule in section 6, enforced by construction rather than by asking nicely.

At most `COACH_MAX_CHUNKS` (6) chunks are retrieved. The corpus is allowed to be empty: the
endpoint answers normally and emits zero `citation` events, so nothing here blocks on the corpus
ingest existing.

### 7.6 Failures before the stream opens

Ordinary HTTP responses, with a JSON body `{ code, message }`.

| Status | `code` | Cause |
|---|---|---|
| `401` | `unauthenticated` | No session. |
| `403` | `forbidden` | The game exists and belongs to someone else. |
| `404` | `game_not_found` | No such game. |
| `409` | `analysis_pending` | The game has no `game_analysis` row yet. Body carries `{ jobState }`. |
| `422` | `invalid_request` | A rule in 7.2 was broken. The body names the field. |
| `429` | `rate_limited` | Over the per-user limit. Carries `Retry-After`. |
| `503` | `coach_unavailable` | The upstream API failed before the first token. |

`403` versus `404` is deliberate. Game ids are unguessable UUIDs, so distinguishing "not yours"
from "not there" leaks nothing and makes a support question answerable.

**`409` is the coaching boundary expressed as a status code.** With no engine analysis there are no
facts, and a coach with no facts would have to improvise the evaluation — precisely what section 6
forbids. So the endpoint refuses, and the UI's job is to say the analysis is still running rather
than to ask the model anyway.

### 7.7 Prompt assembly and caching

The request is rendered in the order the API caches in — `system`, then `messages`:

1. **`system`** — one text block: the frozen coaching brief. Role, the "engine evaluates, model
   explains" rule, how to cite, and the output style. Marked `cache_control: { type: 'ephemeral' }`.
2. **`messages`** — the retrieved chunks as `document` blocks, then `CoachFacts` as JSON, then the
   history, then the question.

| Parameter | Value | Why |
|---|---|---|
| `model` | `claude-opus-5` | |
| `max_tokens` | `4096` | A coaching answer is paragraphs, not a document. |
| transport | `client.messages.stream(...)` | The UI renders tokens as they arrive. |
| `thinking` | `{ type: 'adaptive' }` | Reasoning is never surfaced, so `display` stays at its `omitted` default. |
| `output_config.effort` | default (`high`) | The cost lever. Lower it against measured answer quality, not on a hunch. |
| `output_config.format` | **unset** | Structured outputs and document citations are mutually exclusive, and the response is prose. |

Two things the brief must respect to actually cache. It has to be **byte-stable** — no player name,
no date, no game id, nothing per-request; all of that belongs in `messages`. And it has to clear the
minimum cacheable prefix (512–4096 tokens depending on the model), below which caching silently does
nothing. The test asserts `usage.cache_read_input_tokens > 0` on the second of two identical-prefix
requests, because a silent cache miss is otherwise invisible until the bill arrives.

### 7.8 What this endpoint needs that does not exist yet

- **Retrieval** over `corpus_chunks`. Until it lands the endpoint runs with zero chunks and emits no
  citations; the contract does not change when it arrives.
- **The rate-limit mechanism.** The surface is fixed (`429` + `Retry-After`); where the counter lives
  is open — see section 15.

## 8. Analysis pipeline

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

## 9. The per-phase strength model

One rating hides where a player is actually losing games. The strength model keeps the three
phases apart, because the coaching, the puzzle mix and the practice opponents all want a
different answer for the opening than for the endgame.

**Every number in it is engine output or a pure function of engine output.** No model reads,
writes, ranks or rounds any of it — see the coaching boundary in section 6. The LLM is handed
the finished profile as fact when it explains what to work on.

### Where the numbers come from

```mermaid
flowchart LR
    MA[("move_analysis<br/>one row per ply<br/>phase + winPercentLoss")]
    GA[("game_analysis.phase_breakdown<br/>jsonb, per side, per phase")]
    PROF["StrengthProfile<br/>packages/chess/src/strength.ts"]
    UI["Dashboard"]
    PLAY["chessedu-play<br/>bots + drills"]
    COACH["Coach prompt<br/>(given facts)"]

    MA -->|"worker: summarize()"| GA
    GA -->|"buildStrengthProfile()"| PROF
    PROF --> UI
    PROF --> PLAY
    PROF --> COACH
```

The worker aggregates each analysed game once, into `game_analysis.phase_breakdown`. Readers
never touch `move_analysis` to build a profile: a profile over 500 games is 500 rows, not
40 000 plies.

### The persisted per-game shape

`game_analysis.phase_breakdown` is jsonb holding a `GamePhaseBreakdown`:

```ts
type Phase = 'opening' | 'middlegame' | 'endgame';

interface PhaseSample {
  moves: number;                   // plies this side played in the phase
  accuracy: number | null;         // 0..100, harmonic mean; null when moves === 0
  averageCentipawnLoss: number;    // integer, 0 when moves === 0
  blunders: number;                // moves classified 'blunder'
}

type PhaseBreakdown = Record<Phase, PhaseSample>;      // all three keys always present
interface GamePhaseBreakdown { white: PhaseBreakdown; black: PhaseBreakdown }
```

Both sides are stored, not just the user's: the same game may later be read from the
opponent's side, and re-deriving it would mean re-running the engine.

### The aggregated shape

`buildStrengthProfile(breakdowns)` folds one `PhaseBreakdown` per game — the user's side of
each — into the profile that the rest of the system consumes:

```ts
interface PhaseStrength extends PhaseSample {
  phase: Phase;
  games: number;                   // games that reached this phase at all
  blundersPerHundredMoves: number;
  /** Accuracy points behind this player's own best rated phase. 0 for that phase. */
  deficit: number | null;
  /** False until MIN_MOVES_PER_PHASE plies have accumulated; the numbers are noise below it. */
  rated: boolean;
}

interface StrengthProfile {
  games: number;                   // games folded in
  moves: number;                   // plies across all phases
  phases: Record<Phase, PhaseStrength>;
  focus: Phase | null;             // weakest rated phase; null when nothing is rated yet
  strongest: Phase | null;
}
```

Three rules make this safe to consume:

- **Accuracy recombines exactly.** Per-game accuracy is a harmonic mean, so the mean over
  several games is `Σmoves / Σ(moves / accuracy)` — the same number a single pass over every
  ply would produce, not an average of averages. Centipawn loss is move-weighted and therefore
  carries each game's rounding; treat it as the secondary axis, not the headline.
- **`rated` is the gate.** `MIN_MOVES_PER_PHASE` (150 plies) is the point below which a phase
  is not reported as a strength or a weakness. `focus`, `strongest` and `deficit` only ever
  consider rated phases, and every field is `null`-safe for a player who has just signed up.
- **There is no invented rating.** The strength number *is* accuracy, on the Lichess curve
  already used per move (`packages/chess/src/classify.ts`). Nothing rescales it into a
  fictional Elo.

### Consuming it: practice weights

`practiceWeights(profile)` turns the profile into a distribution over the phases that sums to
1, in proportion to the accuracy each phase is still giving away (`100 - accuracy`). A phase
that is not rated yet is given the mean weight of the rated ones, so a new player still gets
practice everywhere rather than nowhere.

**`chessedu-play` is the intended consumer:** it takes the weights to decide how often a drill
or a bot game starts from an opening, a middlegame or an endgame position, and reads
`phases[phase].accuracy` as the player's level in that phase. Three things keep it in step with
the dashboard:

- Import `phaseBreakdownFor`, `buildStrengthProfile` and `practiceWeights` from
  `@chessedu/chess`; do not re-derive any of them from `game_analysis`. The recombination rule
  above is easy to get subtly wrong, and a second implementation would drift.
- Narrow each game to the side the user played (`phaseBreakdownFor(row.phaseBreakdown, userColor)`)
  before folding. A null means the worker has not analysed that game yet — count it as pending,
  never as a weakness.
- Profile the same window the dashboard uses: the most recent `STRENGTH_WINDOW` (200) games,
  most recent first. Older games describe a player who no longer exists.

An opponent is picked from `phases[focus]`, not from the player's Chess.com rating: the point of
splitting the phases was to stop one number standing in for three.

## 10. Playing against the engine

`/play` is the one place the engine runs client-side rather than on the worker. Nothing about a
casual game is worth a network round trip, and interactive moves must never queue behind the
multi-minute batch analysis on the single Fly machine.

```mermaid
sequenceDiagram
    actor U as User
    participant B as play-board (client)
    participant G as chess.js
    participant E as Stockfish worker

    Note over B,E: on mount: load /engines/…, uci, isready
    B->>E: setoption UCI_LimitStrength / UCI_Elo
    U->>B: drag a piece
    B->>G: move() — legality, and the new FEN
    G-->>B: ok, or rejected (snap back)
    B->>E: position fen … / go movetime 300
    E-->>B: info … / bestmove e2e4
    B->>G: apply the bot's move
    B-->>U: board updates, or game over
```

Three rules hold this together:

- **chess.js is the referee, not the engine.** Legality, check, stalemate, the fifty-move rule
  and threefold repetition are all decided by chess.js on the client. Stockfish is asked for a
  move and nothing else; a bot move is applied through the same `move()` call as a human one,
  so an illegal one would be rejected rather than trusted.
- **Strength is a pure function.** `UCI_Elo` comes from `packages/chess/src/bot.ts`, unit tested,
  clamped to the 1320–3190 range Stockfish accepts. No component decides how strong a bot is.
- **Nothing is persisted.** A play session lives in React state and dies with the tab. There is
  no table, no server action and no job for it, so nothing here can reach a user's real history
  — the ownership chain in §5 is untouched by design. Saving played games would need a schema
  change in `packages/db` and would make them analysable like ingested ones; it is not built.

The bot is Stockfish only. Human-like engines (Maia, Lc0) stay in §15 — different weights,
different runtime, and the reason the Elo floor is 1320 rather than something a beginner would
enjoy.

## 11. Opening repertoire

The repertoire is not a generic opening book. It is **the lines the player actually plays**,
assembled from their own games, with mainline theory laid over the top so the point where they
leave it is visible.

```mermaid
flowchart LR
    G[("games + moves<br/>san, uci, fen_before")] --> TREE["buildRepertoire()<br/>tree per colour"]
    ECO[("Lichess ECO data<br/>CC0, vendored")] --> BOOK["defaultBook()<br/>position-keyed index"]
    BOOK --> TREE
    BOOK --> DEV["findDeviation()<br/>first move off theory"]
    G --> DEV
    MA[("move_analysis<br/>Stockfish")] --> RANK["rankDeviations()<br/>frequency x cost"]
    DEV --> RANK
    TREE --> UI["/openings"]
    RANK --> UI
```

**The tree.** One root per colour, since a repertoire is colour-specific. Each node is a
position reached by a move the player made or faced, carrying how many of their games ran
through it and how those games scored *from their perspective*. Lines are followed to
`OPENING_MAX_PLY`, the same ply cap the phase model uses, so "opening" means one thing across
the app.

**The book.** ECO lines from the Lichess data set, expanded with `chess.js` into an index
keyed by position rather than move order — so a transposition into a named line is recognised
as that line. See [ADR 0003](./adr/0003-opening-theory-source.md) for why this source and not
another. The book answers three questions and no others: *is this position theory*, *what is
it called*, and *what does theory play from here*.

**Deviation detection.** Walk a game's plies while each move is one of the book's known
continuations. The first move that is not is the deviation, and it comes in two kinds:

| Kind | Meaning | Taught? |
|---|---|---|
| `novelty` | The position had known continuations; the player chose something else | Yes — this is the lesson |
| `out-of-book` | Theory simply ends here; there was nothing to leave | No |

Deviations are then grouped by position across the whole history and ranked by
`games x average centipawn loss`, so the habit that costs the most surfaces first — a small
error repeated forty times outranks a disaster played once.

**The punishment comes from the engine.** Nothing in `packages/chess` decides that a deviation
was bad. `rankDeviations()` is handed the `move_analysis` row for the deviating ply and reports
what Stockfish already concluded. The book is a source of names and alternatives; it is not a
second evaluator. This is the coaching boundary of section 6 applied to opening theory.

All of it lives in `packages/chess` (`book.ts`, `repertoire.ts`, `deviation.ts`) behind unit
tests. `apps/web/lib/openings.ts` does the reading; the page at `/openings` only renders.

## 12. Puzzle review

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
puzzles to show is a separate decision, made in `packages/chess/src/session-order.ts`:

> Among puzzles SM-2 has made due, rank by a blend of **how overdue** the puzzle is relative to its
> own interval and **how often the player fails its theme**, then cap how many puzzles one theme
> may contribute to a session.

The blend is deliberate in both directions: weighting purely by due date targets nothing the player
is actually weak at, while ordering purely by failure rate would starve the themes they have
mastered and defeat the retention SM-2 is there for. The per-theme cap keeps a session from
becoming ten of the same motif, and yields when the backlog genuinely holds nothing else.

The reasoning, the constants, and the five alternatives that lost are in
[ADR 0004](./adr/0004-puzzle-review-ordering.md).

**Authorisation** follows section 9 without exception: the queue query is scoped by `user_id`, and
grading re-derives the user from the session and scopes the update by `user_id` too, so a puzzle id
guessed by a client updates nothing.

## 13. The review coach

The dashboard lists games; the review coach is how you *study* one. `/games/{id}/review` walks
a game ply by ply — board, evaluation, and an annotation for **every** move — and adds prose
explanation on the handful of moves that actually decided it.

### Two layers of annotation

```mermaid
flowchart LR
    MA[("move_analysis<br/>game_analysis")] --> RV["buildGameReview()<br/>packages/chess/src/game-review.ts"]
    RV --> DET["Deterministic annotation<br/>every ply"]
    RV --> KM["selectKeyMoments()"]
    KM --> FACT["Given facts<br/>lib/coach/facts.ts"]
    RET["retrieveChunks()<br/>corpus, pgvector"] --> PR
    FACT --> PR["Prompt<br/>lib/coach/prompt.ts"]
    PR --> LLM["Anthropic API"]
    LLM --> PARSE["parseCommentary()<br/>validates plies + citation ids"]
    DET --> UI["Walkthrough UI"]
    PARSE --> UI
```

**Layer one is deterministic and always present.** `buildGameReview` in `packages/chess` turns
the stored moves and `move_analysis` rows into a `GameReview`: per-ply classification, the
evaluation before and after, the engine's best move and principal variation rendered in SAN,
the phase, and a one-line factual annotation ("Blunder. Eval +0.4 to -3.1, 28% of the win
chance. Engine: 21...Rfe8."). It is a pure function of engine output, so the walkthrough is
complete and correct with the LLM switched off, the API key absent, or the model failing.

**Layer two is prose, and only on key moments.** `selectKeyMoments` ranks plies by win
percentage given up, weighting critical swings and the coached player's own moves above the
opponent's, and returns at most six. Those — never the whole game — are what the model is
asked to explain. Anything the model returns for a ply outside that set is discarded.

### The coaching boundary, mechanically

Section 6 states the rule; this is where it is enforced. `momentFacts()` builds a fixed block
of *given facts* per moment straight out of `move_analysis`, and the prompt hands the model
those numbers and asks only for the idea behind them. The model is never sent a position
without its evaluation, and never asked which move was better. `parseCommentary()` then drops
any citation id the model did not receive, so a fabricated source cannot reach the page.

### Corpus retrieval — a provisional interface

Citations come from `corpus_chunks`. The coach does **not** own the corpus, the embeddings, or
the pgvector query: it depends on a single injected function.

```ts
type RetrieveChunks = (query: string, options?: RetrieveOptions) => Promise<CorpusChunk[]>;
```

`apps/web/lib/coach/retrieval.ts` is the only file that knows this shape; everything downstream
consumes the `Citation` it maps chunks to. The default binding is `noCorpus`, which returns
nothing, so the coach ships and runs uncited until the real retriever lands. **The signature in
that file is provisional** — it is a placeholder for the corpus retrieval contract, and when
that contract is settled it is documented here and `retrieval.ts` is adapted to it. Nothing
else in the coach changes.

### Degradation

Commentary is requested from the page by an explicit action, not on render, because it costs a
model call. Every failure mode — no API key, model error, unparseable response, an unanalysed
game — leaves the deterministic walkthrough intact and reports the shortfall inline. Nothing
about the review is cached in Postgres yet; if the cost of re-explaining the same game becomes
real, a `move_commentary` table is the obvious next step.

## 14. Security posture

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

## 15. Open questions

Carried from the idea note:

- Lichess as a second ingest source. The `platform` column exists for it; nothing else does.
- Reference-literature licensing. Bootstrap on public-domain classics only.
- Maia/Lc0 bot hosting is heavier than Stockfish — likely a separate Fly machine running a
  CPU Lc0 build with small nets. Not scaffolded yet. This is also what a sub-1320 bot needs:
  Stockfish's `UCI_Elo` stops there, and weakening it further produces inhuman blunders
  ([ADR 0002](./adr/0002-browser-engine.md)).

Raised by the coaching endpoint (section 7):

- **Coaching threads are not persisted.** The client carries `history`, which is enough to hold a
  conversation and cheap to throw away, but it loses the thread on reload and cannot be mined for
  what a user keeps asking about. The successor is a `coach_threads` / `coach_messages` pair in
  `packages/db`; the request contract then gains a `threadId` and loses nothing else.
- **Where the rate-limit counter lives.** Vercel functions are stateless and there is no Redis, by
  choice (ADR 0001), so the candidates are a Postgres table or the platform's own limiter. Until
  one is picked, `429` is specified but never returned.
