---
status: stable
---

# ADR 0008: A tutor that is computed, not generated — and a Learn mode to read it in

- **Status:** accepted. Builds on [ADR 0007](./0007-line-coverage-and-replay.md), whose
  consequence "the engine's scores reach the walk but are not stored" this resolves.
- **Date:** 2026-09-29

## Context

Two requests arrived together: an explanatory bot **that makes no model call**, and a way to
**play through an opening** without being graded on it. They are one feature. A tutor needs a
surface to speak on, and walking a line with nothing said about it is just an animation.

The drill (ADR 0006, 0007) is graded from the first move. A line never seen before is presented
as a memory test the learner is certain to fail, and failing it is what schedules it. At 550 the
lesson is rarely the move itself — it is _why_ `3.c3` was played so that `4.d4` could follow.

What was on hand:

- **The engine already computed every number an explanation needs, and threw them away.**
  `rankMoves(fen, count)` returns a score for each of the top _n_ moves; `generateLines` used the
  scores to pick and filter moves and stored only the move.
- **§6's rule assumed a model.** "The engine evaluates. The LLM explains." The review coach
  (§13) is built on that. The tutor is asked for without the second half.
- **The Ponziani root is five plies of fixed theory** that the generator never searches. Whatever
  explains a move has nothing to say about `1.e4 e5 2.Nf3 Nc6 3.c3` from engine output alone —
  and those are the moves a beginner needs explained most.

## Decision

### Explanations are computed at request time from stored facts and authored plans

Three layers, and only the middle one is new code of any size:

| Layer            | Answers          | Source                                              | Where                                   |
| ---------------- | ---------------- | --------------------------------------------------- | --------------------------------------- |
| Authored library | _why this line_  | hand-written prose, reviewed in a PR                | `packages/chess/src/tutor/library.ts`   |
| Motif detectors  | _why this move_  | the position (chess.js) and the stored engine facts | `packages/chess/src/tutor/detectors.ts` |
| Learn mode       | where it is read | —                                                   | `/lines/learn/[id]`                     |

A **motif** is a pure function of a `MoveContext` — the position before the move, the move, the
ply's stored engine facts, and the line's remaining plies — that either fires with a short clause
and a weight, or returns `null`. `explainMove` runs every detector, keeps the three heaviest, and
renders them. There is no network, no model, no randomness: the same ply always gets the same
explanation, and every detector is unit tested on known positions.

### The rule that replaces "the LLM explains", for the tutor

1. **Any number in an explanation comes from stored engine output.** A centipawn gap, an
   evaluation, "the next best is 180 cp worse" — read from the ply, never from a template, never
   from authored prose, never estimated.
2. **Authored prose describes plans and ideas only.** Qualitative claims a person can check against
   the board — "prepares `d4`", "pins the knight" — and no evaluations. The library has no digits
   in it beyond move numbers, and a test holds it to that.
3. **A detector that cannot substantiate its claim does not fire.** An engine detector on a ply
   with no stored facts returns `null`; it does not assume a default score.

The review coach's model call is unaffected. §6 now states both halves: what the engine owns, and
the two ways explanation is allowed to happen on top of it.

### Store the engine facts on every searched ply

`LinePly` gains `facts: PlyFacts | null`:

| Field               | Meaning                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `scoreCp`, `mateIn` | the evaluation after the move, **from White's perspective** like every other stored evaluation |
| `pv`                | the engine's continuation _after_ the move, in UCI, **at most `PLY_PV_LIMIT` (6) plies**       |
| `gapCp`             | the move's score minus the best _other_ move's at the same node, from the mover's side         |

`gapCp` is the one that must be captured during the search: the runner-up's score exists only in
that MultiPV result. It separates "the only move" (large positive) from "one of several" (near
zero); on a `branch` reply below the engine's first choice it is negative — how far behind the
best it sits. It is `null` when the node had no second move to compare, or when either score is a
mate, because a mate score is not a distance in centipawns.

To have a runner-up at all, the generator now asks for **at least two** moves at every searched
node, including White's. White still plays the single best; the second is only measured.

The five root plies carry `facts: null` — never searched — and so do lines stored before this ADR.
Every consumer treats `null` as "no engine opinion", not as zero.

**Why six plies of `pv`.** The engine detector that uses it ("prepares `d4`") looks at the mover's
next two moves, which are `pv[1]` and `pv[3]`; six plies is that window with room to spare. At six
UCI moves a ply adds about 100 bytes of JSON, roughly 17 KB across the Ponziani's 15 lines × 11
plies. A full PV would be three to five times that for no detector that reads it.

**No SQL migration.** `plies` is already `jsonb`; the change is to the TypeScript type both
`packages/chess` and `packages/db` give it. `drizzle-kit generate` reports no schema change, and
adding an unused column to satisfy the word "migration" would be worse than none.

### Learn mode: a walk that writes nothing

`/lines/learn/[id]` steps forward and back through a line — board and move list in sync — with an
explanation panel: the line's authored idea, the current ply's authored note if it has one, what
kind of move it is (the opening's definition, the engine's single best, or one of _n_ replies the
engine rated close to its best), and its rendered motifs.

It **writes nothing** — no `line_attempt`, no `line_review`, no SM-2. The page is a server
component that reads, and a client component with no server action. Learning is not measurement,
and a learn pass counted as an attempt would pollute the history that answers "how often do I fail
here". The drill is unchanged beside it; the lines page lists every line with _Learn_ and _Drill_,
and offers _Learn it first_ on a line the learner has never attempted.

### The knowledge boundary is a code path

The tutor answers a fixed set of questions: _what is this line about_, _why this move_, and _what
about this other move?_ — the last by playing a move on the Learn board. The answer to that comes
from `askAboutMove(tree, fen, uci)` over every stored line in the family:

- the move is the one this line plays: explain it;
- the move is one another stored line plays from this position: say so, name that line, and offer
  to switch to it;
- otherwise: **"I have not analysed that move."** Exactly that, with nothing else. No evaluation,
  no guess at why it might be weaker.

A no-model bot has a real edge to its knowledge, and it must be visible. One that says "I don't
know" in the same words every time can be trusted; one that improvises cannot be told apart from
one that knows, which at 550 is worse than silence.

### The authored library is a draft, pending review

`library.ts` holds one paragraph for the Ponziani's idea, one or two sentences for each of the
five root plies, and a sentence for each first Black reply and a few second ones. It is keyed by
family and by the SAN moves after the root, so a reviewer reads `['d5', 'Qa4', 'Bd7']`, not a
UCI key. It is **marked at the top as pending review by a stronger player**: none of the authors
is one, and a subtly wrong opening explanation is worse than none. A line or ply with no entry
shows the motifs alone; the missing entry is a tested path, not an error.

## Alternatives rejected

- **Generate the prose once with a model and store it.** No request-time model call, so it looks
  like it meets the request. But the text goes stale silently when the engine, depth or branch set
  changes, it cannot be checked against the board it describes, and the model is still the one
  deciding what is true about a position — §6's violation, moved to build time.
- **Re-analyse at request time.** Slow, and it puts an engine in the web request path for facts
  the generator already had.
- **Derive `gapCp` later.** The runner-up's score is gone once the search returns; recomputing it is
  another engine run per ply.
- **Record learn passes as ungraded attempts.** `line_attempt.graded = false` already exists for
  practice. But practice is a real attempt at recall; a learn pass is reading. Counting it would
  make "missed 5.d4 three times running" include times the answer was on screen.
- **A free-text question box.** It implies understanding the tutor does not have. A fixed question
  set makes the boundary visible instead of hiding it behind plausible prose.
- **Engine motifs only, no authored prose, until reviewed.** The design's own recommendation for
  question 1. It ships nothing correct for the first five moves of every line, which is where a
  beginner needs it; the draft ships with a review warning instead, and a wrong sentence costs one
  line of diff to fix.
- **Search the root plies too.** It would give `3.c3` an evaluation, and the engine would say what
  ADR 0006 already records: it would not play `3.c3`. "The only good move" is the wrong thing to
  teach about a move chosen by definition; its explanation is a plan, which is the library's job.

## Consequences

- **Explanations change when lines are regenerated**, because the facts they read do. That is the
  point: they cannot drift from the position.
- **Asking for two moves at White's nodes can change a White move** where the engine's MultiPV-2
  search disagrees with its MultiPV-1 search at the same depth. A changed move is a new key; the
  old line is retired and its history kept, as ADR 0006 intends.
- **Old rows have no facts** until the generator runs again; the tutor says less about them rather
  than anything false.
- **Detectors are heuristics, not an engine.** "Attacks the knight" is true of the board; it does
  not claim the attack matters. The engine detectors are the ones that say something is _good_,
  and they only restate stored scores.
- **The library is Ponziani-only.** A second opening is a new family entry. A line in a family with
  no entry still gets its motifs.
- **Revisit** if a detector is found to fire on positions where its clause is misleading — the fix
  is a narrower detector and a test for that position, not a softer sentence — or when a second
  opening arrives and the library's shape has to hold two.
