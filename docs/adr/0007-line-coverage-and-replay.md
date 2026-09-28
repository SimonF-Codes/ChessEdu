---
status: stable
---

# ADR 0007: Line drill — engine-vetted branches for the opponent, and replays that do not grade

- **Status:** accepted. Amends [ADR 0006](./0006-opening-line-drill.md): replaces its answer to
  question 2 (which Black replies), reopens question 3 (what a revealed move does), and adds
  replay, which it did not have.
- **Date:** 2026-09-28

## Context

Two gaps showed up comparing the drill against ChessReps, which has about 19 Ponziani lines to our 7.

**No immediate second pass.** A line ended, SM-2 rescheduled it, and there was no way to run it
again while the mistake was fresh. That second pass is the core of repetition training.

**The ECO name filter decided which branches exist.** ADR 0006 branched Black on every ECO
continuation at its first two decisions. ECO names five replies to `3.c3` — `Be7`, `Nf6`,
`Nge7`, `d5`, `f5` — and has no line at all for `3...a6`, `3...d6`, `3...Bc5` or `3...g6`. In the
player's own four Ponziani games Black played **`3...a6`**, a move the drill could not prepare
them for. A name in a book is evidence that someone once catalogued a move, not that anyone plays
it or that it is sound. Deeper in, the same filter collapsed every Black decision the book had no
name for into Stockfish's single move.

What was available to replace it:

- **Stockfish, MultiPV.** Every legal reply can be scored against the best. This measures
  _soundness_, not _likelihood_.
- **The player's own games** (`game` / `move`). At the time of writing the application database
  holds none — it has not been re-synced since a test run against it deleted the synced games — and
  even synced, four Ponziani games are far too few to rank anything at move four.
- **The Lichess opening explorer** (likelihood at a rating band). Not integrated; ADR 0003 lists it
  as a revisit trigger.

Measured at depth 20, from Black's side, after `3.c3` (centipawns):

| `d5` | `Nf6` | `f5` | `Nge7` | `d6` | `a6` | `h6` | `a5` | `g6` | `Be7` | `Bc5` |
| ---: | ----: | ---: | -----: | ---: | ---: | ---: | ---: | ---: | ----: | ----: |
|  +14 |    +7 |  −26 |    −38 |  −50 |  −53 |  −62 |  −63 |  −64 |   −65 |   −88 |

The position is quiet: ten replies sit within a pawn of the best. Soundness alone does not
narrow it enough, so a cap has to.

## Decision

### Black's branches: within a margin of the engine's best, capped per decision

At each of the opponent's decisions after the root, `generateLines` asks the engine for its
`maxReplies` best replies (MultiPV) and keeps those within `marginCp` of the best, best first. The
best reply always qualifies. Past the last rule, Black plays the engine's single best move.
`selectReplies` in `packages/chess/src/lines.ts` is the rule; it is pure and unit tested.

For the Ponziani (`PONZIANI_BRANCHING`):

| Black's decision | Example                  | Keep at most | Within of the best |
| ---------------- | ------------------------ | -----------: | -----------------: |
| 1st, at `3.c3`   | `3...d5`, `3...a6`       |            6 |    100 cp (a pawn) |
| 2nd              | `3...d5 4.Qa4` → `4...?` |            3 |              50 cp |
| 3rd and later    | —                        |            1 |    (engine's best) |

Why these numbers:

- **Six at the first decision.** This is the decision that defines what game the learner is in,
  so it is the one worth covering widely. Ranked by the engine, the top six are the four ECO
  replies that are sound (`d5`, `Nf6`, `f5`, `Nge7`) plus `d6` and `a6` — including the one reply
  the player has actually faced. The seventh would be `3...h6`, which is a tempo spent on nothing;
  `3...Be7` (the old Romanishin line) is tenth, 79 cp behind.
- **A pawn at the first decision, half a pawn after.** At move three the position is quiet and a
  pawn is the difference between "sound" and "fine for a 550 opponent". By move four the lines
  are concrete, and a reply half a pawn worse is already one the engine would punish — worth
  meeting when it comes, not worth a line of its own.
- **Three at the second decision, then one.** Five Black decisions with three replies each would
  be 243 lines. The cap is what stops that, and it shrinks with depth for the same reason ADR 0006
  gave: the further in, the less likely the opponent is still in the tree at all. The third
  decision would add lines that differ only in the learner's very last move.

**What this produces for the Ponziani: 15 lines.** Six first replies, then at the second decision
3 (`3...d5 4.Qa4` → `Bd7`, `f6`, `Qd6`), 3 (`3...Nf6 4.d4` → `Nxe4`, `exd4`, `d5`), 2
(`3...f5 4.exf5` → `Qf6`, `e4`), 1 (`3...Nge7 4.Bc4` → `d5` — nothing else within 50 cp), 3
(`3...d6 4.d4`) and 3 (`3...a6 4.d4`). The bound is 6 × 3 = 18; a real engine gives 15 because
some positions have fewer than three sound replies. ChessReps' ~19 is a sanity check, not a
target: the gap is `3...Be7` and some named deep sidelines, which this rule deliberately leaves
out, and White alternatives such as the Spanish, Neumann and Vukovic variations, which are
different _White_ choices and absent by design.

**White's side is unchanged.** The learner's move at every node is still the engine's single best
— a repertoire has one answer to each position.

**ECO names, it does not choose.** `nameLine` gives a line the name of the deepest named position
it passes through, then the opponent's branch choices made after that position: `Ponziani Opening ·
3...a6, 4...d6`. Two lines that leave the book at the same place are still told apart.

Each ply records where it came from: `branch` for one of several vetted replies at a node, `engine`
for the engine's single choice. Lines generated before this ADR carry `book`; nothing produces it
now.

### Duplicate prefixes: the learner plays every line from move one

All 15 lines share `1.e4 e5 2.Nf3 Nc6 3.c3`, and many share more. The learner still drills each
from move one. Those first three White moves take a few seconds once known, they are the cue that
puts the learner in the right game — nobody meets `4.d4` in a game without having played `3.c3`
first — and a drill that starts mid-line would be practising a position the learner never reaches
cold. What it costs is a few seconds per line, and because every move is recorded separately, a
shared move that is always clean cannot hide the one that is not.

### Replay: a new attempt, graded only if the line was due

After a line — and mid-line, once a move has gone wrong — the learner can **try this line again**
at once. A replay is a new attempt: new `line_attempt` rows under a new `attempt_id`. Nothing is
overwritten; "failed at 4.Qa4 three times running" includes the runs just made.

Only the attempt that meets a line which is **due** (or never tried) is graded
(`isGradedAttempt`). Grading it moves the due date at least a day out — even a lapse is back
_tomorrow_ — so every replay after it in the same sitting finds the line not yet due and is
**practice**: recorded, per move, with `graded = false`, and never shown to SM-2. The decision is
made under the `line_review` row lock, from the stored due date, so the client cannot choose it.

Why the first attempt and not the best or the last:

- **The grade must be measured, not chosen.** If a replay could re-grade, a `hard` becomes an
  `easy` by retrying until it is easy, and the schedule would say the line is known when what is
  known is the last thirty seconds. SM-2's intervals assume the grade is a sample of recall after
  the interval; only the first attempt is that sample.
- **"Due" is already the definition of a session.** It needs no session table, no time window, no
  clock on the client: the line was due, or it was not.
- **A practice run's outcome is still reported** — the learner sees "Practice — Clean", and why it
  did not count — because hiding it would make replaying feel pointless.

"Start again" mid-line records the current attempt with the rest of its moves `abandoned` — it is
what happened — and starts a new one. If that was the graded attempt, the line lapses.

### A revealed move is played by the learner, not for them (reopens ADR 0006, question 3)

ADR 0006 chose between ending the line at the first slip and playing the right move for the
learner and carrying on, and rightly rejected ending it. There was a third option, which ChessReps
uses: after the second wrong move, or _Show me_, the right move is played on the board, named,
**taken back**, and marked with an arrow, and the line does not move on until the learner plays it
themselves.

It keeps everything question 3 protected — the line is always completed and every learner move
gets its `line_attempt` row — and adds what it lost: the learner's own hands make the move. At 550,
that motor memory is most of what a drill is for; arriving at move six having merely been _told_
moves four and five teaches much less.

Nothing about the record changes. The move is still `revealed`, graded `again`; its time is to
the reveal, and its wrong moves are the ones tried before it. Moves tried after the reveal are
rejected with the answer repeated and are not recorded — finding a move you have just been shown
is copying, not recall. This lives entirely in the drill component; `PlyResult`,
`MAX_WRONG_MOVES_PER_PLY`, `normaliseAttempt` and `lineOutcome` are unchanged.

## Alternatives rejected

- **Keep ECO for branching, add unnamed replies by hand.** It fixes `3...a6` and nothing else;
  the next missing reply is found the same way, by the player losing to it.
- **Every legal reply within a margin, no cap.** Ten replies at move three, and the tree
  multiplies from there. The cap is what makes the number of lines a decision rather than an
  accident of how quiet the position is.
- **Weight by the player's own games.** The right signal eventually, but the database holds none
  of their games today and four Ponziani games could not rank move four. Kept as the first thing
  to add: a reply the player has faced should qualify even outside the margin.
- **Grade the best attempt of a session, or the last.** Both let retrying choose the grade.
- **Grade every attempt.** Five clean replays in a row would push the interval out by months after
  one sitting.
- **Overwrite the previous attempt on replay.** Destroys exactly the record — repeated misses on
  one move — the per-ply table exists for.
- **Start later lines at the branch point.** Shorter, but it drills positions the learner never
  reaches cold, and the shared moves are cheap once known.

## Consequences

- **The opponent is sound, not typical.** A reply within a pawn of the best is one a strong
  player would consider; a 550 opponent's natural-looking `3...Bc5` is out. Maia (ADR 0005) or the Lichess
  explorer is how "likely" gets in; the player's own replies are the cheaper first step once games
  are synced.
- **Generation costs MultiPV.** 58 engine positions at depth 20, about 35 s single-threaded.
- **The engine's scores reach the walk but are not stored.** `rankMoves` returns `scoreCp` and
  `mateIn` for every move it ranks, so keeping an evaluation on each ply — which explaining a move
  later needs — is a change to what `generateLines` copies into `LinePly`, not to the engine seam.
  Not done here.
- **Two old lines retire**: `3...Be7` (Romanishin) and `3...d5 4.Qa4 Nf6` (Leonhardt). Their
  `line_review` and `line_attempt` rows stay, pointing at retired lines, as `retired_at` intends.
  The five others keep their keys, and with them their history.
- **Practice is visible in the data.** `line_attempt.graded` is the flag; the history panel says
  how many recent runs were practice.
- **Revisit** when the player's games are synced (add faced replies), when a likelihood source
  exists, or if the learner reports lines they never meet.
