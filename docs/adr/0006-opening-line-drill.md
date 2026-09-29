---
status: stable
---

# ADR 0006: Opening line drill — ECO branches for the opponent, Stockfish for the learner

- **Status:** accepted; the Black branching rule (the table row below and question 2) is
  superseded, and question 3 reopened, by [ADR 0007](./0007-line-coverage-and-replay.md), which
  also adds replay.
- **Date:** 2026-09-28

## Context

The repertoire view (architecture §11) shows the lines a player _has_ played and where they left
theory. It cannot teach a line they have never played: it is built from their games, and a
550-rated player's games contain three replies to the Ponziani and very little past move five.

A line drill is the other half — repeat a sequence, move by move, until it is automatic, and be
told _where_ it keeps breaking. It needs three things the project does not have yet: a set of
drillable lines, a per-user schedule for them, and a per-move record of each attempt.

Constraints:

- **The coaching boundary** (§6). Something has to decide what White plays at every node. That
  is an evaluation, so it is Stockfish's job. An LLM-authored repertoire would be the model
  evaluating, and nothing downstream could check it.
- **The ECO data names lines; it does not recommend moves.** ADR 0003's book knows sixteen
  Ponziani entries, mostly five or six plies. It says a Black reply _has a name_, and stops
  exactly where a repertoire starts.
- **`srs.ts` stays unchanged.** SM-2 and the four `ReviewOutcome`s are reused as they are.
- **A line is not a position.** The puzzle table is one FEN and one solution per row.

## Decision

### Lines are generated, not authored

> **Amended by ADR 0007.** Black no longer branches on ECO continuations: it branches on the
> replies Stockfish rates within a margin of its best, capped per decision, and the book only
> names lines. The engine seam is now `rankMoves(fen, count)` (MultiPV). The rest of this section
> stands.

`generateLines` in `packages/chess/src/lines.ts` walks a tree from a fixed root and emits every
leaf as a line:

| Node                                                                                 | Who moves | Where the move comes from                                    |
| ------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------ |
| inside the root (`1.e4 e5 2.Nf3 Nc6 3.c3`)                                           | either    | the opening's own definition                                 |
| learner to move                                                                      | White     | **Stockfish's best move**, one per node                      |
| opponent to move, one of its first `LINE_BRANCH_DECISIONS` decisions, book has moves | Black     | **every ECO continuation** — this is where the tree branches |
| opponent to move, otherwise                                                          | Black     | Stockfish's best move, one per node                          |

The engine is injected as `chooseMove(fen) => Promise<uci | null>`, so the walk is pure and unit
tested with a scripted engine. The root moves are the _definition_ of the Ponziani, not a claim
that `3.c3` is best — Stockfish would not play it, and nobody drills the Ponziani to learn
`3.Bb5`.

The script that drives it with a real engine is `apps/worker/src/lines/generate.ts`, reusing the
worker's `Engine` (UCI over stdio) at a fixed depth, one thread, hash cleared per position, so the
same engine binary produces the same lines on every run.

### Four questions, answered

**1. Line depth: 11 plies** (`LINE_DEPTH_PLIES`). Ten plies is where memorisation stops paying and
understanding has to take over; rounded up by one so that **a line always ends on the learner's
move**. A line that ends on the opponent's reply leaves the learner nothing to recall at the end
of it — the last thing they see would be a move they did not have to find. Six White moves,
three of them past the root.

> **Superseded by ADR 0007.** The ECO filter missed `3...a6`, the one reply the player had actually
> faced. The text below is kept as the record of what was decided and why it was replaced.

**2. Which Black replies: every named ECO reply at Black's first two decisions after `3.c3`,
Stockfish's reply after that** (`LINE_BRANCH_DECISIONS = 2`). The first reply to `3.c3` is the
point of the opening — `3...d5`, `3...Nf6`, `3...f5`, `3...Be7`, `3...Nge7` are each a different
game, and all five are named. The second decision is where the book's own sub-variations live
(`3...d5 4.Qa4` has three named answers). Past that the tree would multiply for lines a 550
opponent has already left, so Black plays the engine's move — the most testing continuation,
which is what a line should prepare for. This sits between "every ECO branch" and "the three the
player has met": broader than their history, because the drill exists to cover what they have
not seen, and narrower than the book, because depth-first coverage of named sidelines is not
what a 550 player needs. What it cannot do is rank replies by how often they are _played_; that
needs the Lichess explorer, which is ADR 0003's revisit trigger.

> **Reopened by ADR 0007.** The choice here was framed as "end the line" or "play the move for
> them and continue". A third option keeps what this answer protects — the line is always
> completed and every ply recorded — and adds what it lost: the revealed move is played, taken
> back, and the learner plays it with their own hands before the line continues.

**3. A wrong move is corrected, and the line continues.** First wrong move: "not that one", try
again. Second wrong move, or "Show me": the correct move is played on the board, named in text,
and the line carries on. Ending the line at the first slip would throw away everything after it —
the learner would drill move four forever and never see move six, and the per-move record would
be empty exactly where it is most wanted.

**4. Drilled lines do not feed `/openings`.** That view is a record of games actually played, and
its counts and scores mean "this happened over the board". A drilled line happened in a trainer,
against a scripted opponent, with retries. Mixing them would inflate the frequency of every line
the player drills and credit them with results they never played for. The relationship runs the
other way: the drill is what you do about a hole the repertoire shows you. Today that is only a
link from the drill's "nothing due" state to `/openings`; the repertoire does not yet link back.

### Separate tables, one schedule

- **`opening_line`** — a shared catalogue, not user-owned: `family`, `eco`, `name`, the plies as
  jsonb (`san`, `uci`, `fenBefore`, and where each came from), the learner's colour, the engine
  and depth that chose its moves, and `retired_at` for lines a later run no longer produces.
  Keyed by the learner's colour plus the move sequence, so re-running the generator is an upsert.
- **`line_review`** — per user per line, the SM-2 columns exactly as `puzzle` has them, so
  `gradeReview` is called on it with no adapter. Created on the first attempt.
- **`line_attempt`** — one row **per learner ply per attempt**: `first_try`, `second_try`,
  `revealed` or `abandoned`, the wrong moves tried, and the time to the right one. "Clean for
  three moves, `5.d4` missed three times running" is a query over these rows; there is no summary
  column to drift from them.

### Grading is derived

`lineOutcome` in `packages/chess/src/lines.ts`:

| Attempt                                          | Outcome |
| ------------------------------------------------ | ------- |
| any ply revealed or abandoned                    | `again` |
| any ply needed a second try                      | `hard`  |
| every ply first try, each under `QUICK_SOLVE_MS` | `easy`  |
| every ply first try                              | `good`  |

There is no self-rating button. The board already knows.

## Alternatives rejected

- **A `kind` column on `puzzle`.** A line is an ordered move list with a per-move record; a
  puzzle is a position. Every puzzle row would carry a nullable move list and every puzzle query
  would grow a `kind` filter, for no shared behaviour beyond the five SM-2 columns — which are
  cheap to repeat and are all `srs.ts` needs.
- **The model writes the repertoire.** Unverifiable, and it is the model evaluating (§6).
- **Hand-authored lines.** Honest, but a person is then the evaluator, the lines cannot be
  regenerated when the engine improves, and it does not scale past one opening.
- **Stockfish for Black too, everywhere.** One line per opening — it would never show the learner
  `3...Nf6`, the reply they are most likely to meet.
- **Branching on every book move at every depth.** Covers named sidelines to their end and
  produces lines a beginner will never reach, at the cost of drilling time.
- **A worker job instead of a script.** Lines are shared content, generated once per opening and
  again when the engine or the book changes — not per user, not on a trigger, not on a schedule.
  A job would need a new `job_kind` value, an enqueuer with nothing to enqueue it, and would share
  the single Fly machine's CPU with game analysis for work nobody is waiting on. A script run by
  hand against the target database is the honest shape. If lines ever become per-user (a
  repertoire built from _your_ replies), that is when it becomes a job.
- **Self-rated recall ("I knew it" / "I didn't").** The board observes first try, retry and reveal
  directly; asking the learner as well can only add noise.
- **Ending the line on the first wrong move.** See question 3.

## Consequences

- **Transpositions are ignored.** A line is its move sequence. `1.e4 e5 2.Nf3 Nc6 3.c3` reached by
  another order is a different key and would be a different line; the drill never meets one,
  because it always plays from move one. The book is position-keyed (ADR 0003), so nothing
  prevents keying lines by position later.
- **Black's out-of-book moves are the engine's best, not what a 550 opponent plays.** The learner
  is drilled against the most testing reply, not the most likely one. Maia (ADR 0005) is the
  natural source for "likely"; it is browser-side and not built.
- **A closed tab records nothing.** The attempt is written once, at the end of the line or when the
  learner stops. Walking away mid-line leaves the schedule untouched and the line still due.
- **Engine version is part of a line's identity only through its moves.** A new binary that picks
  different moves produces new keys; the old lines are marked retired rather than deleted, so their
  history survives.
- **The coach is not wired in.** The drill says what the right move was; it does not yet ask the
  coach to explain it. When it does, the engine facts it hands over must come from the generator
  run (evaluation and principal variation per learner ply), which are not stored today.
- Ponziani only, White only. A second opening is a new `LineSpec` and a script run; a Black
  repertoire is the same walk with the colours swapped and the branching rule mirrored.
