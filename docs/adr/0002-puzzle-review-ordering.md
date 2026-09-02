# ADR 0002: Puzzle review ordering — theme failure rate blended with overdue urgency

- **Status:** accepted
- **Date:** 2026-08-27

## Context

Puzzles are generated from the player's own blunders (`generatePuzzles` in
`apps/worker/src/handlers/analyze.ts`), and the `puzzle` table carries SM-2 columns — `due_at`,
`interval_days`, `ease`, `repetitions`, `lapses` — plus `themes` and `phase`.

SM-2 answers _when a puzzle becomes eligible again_. It does not answer _which of the eligible
puzzles to show_, and for this product that second question matters more:

- A full-history analysis produces puzzles in bulk, so on any given day far more puzzles are due
  than fit in a session. Something has to choose.
- Pure `ORDER BY due_at` resolves that choice by generation order, which is chronological by game
  — effectively arbitrary with respect to what the player is actually bad at.
- Puzzles arrive in runs from the same game and the same phase, so due order also _clusters_: a
  session ordered by `due_at` alone is frequently ten endgame puzzles in a row.

The point of this product is practice built from the player's own mistakes. Ordering should
reflect that.

## Decision

SM-2 continues to own the schedule. Ordering is applied **among the puzzles SM-2 has already made
due**, never as a replacement for it, so nothing escapes the review cycle.

Each due puzzle is scored:

```
score = (1 - THEME_BLEND) * urgency + THEME_BLEND * themeFailureRate      THEME_BLEND = 0.4
```

- **`urgency`** — how overdue the puzzle is _relative to its own interval_, saturating:
  `overdue / (overdue + 1)` where `overdue = daysOverdue / max(intervalDays, 1)`. Relative rather
  than absolute, because a day late on a one-day interval is a real lapse risk while a day late on
  a ninety-day interval is noise. Saturating, so a badly neglected backlog does not let one ancient
  puzzle outrank everything for the rest of time.
- **`themeFailureRate`** — the smoothed share of reviews in that theme that ended in a lapse,
  aggregated across the user's puzzles carrying the theme. A puzzle takes the **maximum** rate over
  its own themes: it inherits the priority of the weakest thing it tests.
- **Smoothing** is a Beta prior (`THEME_PRIOR_WEIGHT` pseudo-reviews at `THEME_PRIOR_RATE`), so a
  theme with one unlucky review does not outrank a theme with a hundred genuinely bad ones.
- **Blend, do not replace.** At `THEME_BLEND = 0.4` weakness reorders the queue but cannot starve
  it: a sufficiently overdue puzzle in a theme the player is good at still surfaces, which is the
  whole point of keeping SM-2 underneath.

A **per-theme cap** then limits any one theme to `ceil(sessionSize * MAX_THEME_SHARE)` puzzles
(`MAX_THEME_SHARE = 0.5`), applied greedily down the scored list, so a session is not all one
motif. The cap **yields when nothing else is available**: if honouring it would return a short
session, the skipped puzzles are appended in score order. A player whose whole backlog is one theme
should get a full session, not a truncated one — the cap exists to diversify where diversity
exists, not to withhold practice.

`attempts` for the failure rate is taken as `repetitions + lapses`. SM-2 resets `repetitions` on a
lapse, so this undercounts reviews for a puzzle that has lapsed more than once, which biases its
theme's rate _upward_. That bias points at repeatedly-forgotten themes, which is the direction this
policy wants anyway; a dedicated review-log table would be exact, and is not worth a second write
path yet.

Both the SM-2 rules and the ordering policy are pure functions in `packages/chess`
(`srs.ts`, `review.ts`), unit tested there. The database layer only supplies the candidate pool.

## Alternatives rejected

- **Pure `ORDER BY due_at LIMIT n`.** The obvious option, and the one the index already serves. It
  loses because with a bulk-generated backlog it is chronological-by-game order — it targets
  nothing, and clusters one motif per session.
- **Replace due-date order with failure rate entirely.** Starves retention: a puzzle in a theme the
  player has mastered would never come back up, which is precisely the failure mode spaced
  repetition exists to prevent. Weakness targeting is a re-ordering, not a filter.
- **Multiplying the two signals (`urgency * themeFailureRate`).** A puzzle that is due but not yet
  _overdue_ has `urgency = 0` and would score zero no matter how weak its theme — new puzzles from
  a fresh analysis would sink to the bottom of every session.
- **Fixed per-theme quotas (a rota: two openings, two middlegames, two endgames).** Rigid. A theme
  with nothing due wastes its slot, and the quota has to be redesigned every time the theme
  vocabulary grows beyond the phase names.
- **A materialised `theme_stats` table.** A second write path to keep consistent with the puzzle
  rows for a number that is a cheap aggregate over the candidate pool already being read.
- **Ordering in SQL.** The score needs theme aggregates over the whole pool before any row can be
  ranked, which is a window-function query that would then have to be re-derived every time the
  policy changed, in the one place the project has deliberately kept logic out of.

## Consequences

- Selection is application code over a bounded pool: at most `REVIEW_POOL_SIZE` due puzzles read in
  `due_at` order (served by `puzzle_due_idx`), scored in memory. At personal scale — thousands of
  puzzles, tens due-and-selected per session — this is trivial. It would need revisiting if the
  pool routinely exceeded a few thousand rows per user.
- The policy is testable without a database, and changing a weight is a one-line change behind a
  unit test rather than a query rewrite.
- Theme quality now matters. Today `themes` is `[phase]`, so the policy resolves to "practise the
  phase you forget most" — useful, but coarse. Richer tactical themes (fork, pin, back-rank) on
  puzzle generation would sharpen this policy without changing it.
