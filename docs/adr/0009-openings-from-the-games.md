---
status: stable
---

# ADR 0009: Which openings to drill — points lost in the player's own games

- **Status:** accepted. Amends [ADR 0007](./0007-line-coverage-and-replay.md): the opponent's
  replies are now taken from the player's own games where there are enough of them, with the
  engine as a veto. Retires the "Ponziani only, White only" consequence of
  [ADR 0006](./0006-opening-line-drill.md).
- **Date:** 2026-10-14

## Context

The drill trained one opening, named in a constant: `PONZIANI` in `packages/chess/src/lines.ts`.
It was the right pilot — chosen deliberately as a tester — but with 4,464 games now synced it
accounts for **4** of them, and appears in neither side's top fourteen. Nothing connected what
the trainer teaches to what the player actually plays, though that history is the premise of the
project.

What is available:

- **`game`** — complete. Every game carries `user_color`, `user_result`, and `eco_url`, Chess.com's
  own name for the opening as a URL slug (`…/openings/Scandinavian-Defense-2.e5`).
- **`move`** — complete. Every ply of every game: SAN, UCI and the position before it.
- **`move_analysis`** — still draining when this was written. **Not used.**

Frequency was the obvious ranking and the wrong one. The most frequent openings include the player's two
best — White against the French (147 games, 56.5%) and the Nimzowitsch (114, 63.6%). A drill
ranked by frequency would spend most of its repetitions where there is nothing to win.

## Decision

### Rank by points lost

For each opening family, on each side:

```
points_lost = games × (0.5 − score)        score: win 1, draw ½, loss 0
```

It is the number of points the opening costs against an even result. It combines how often the
opening is met with how badly it goes, so 318 games at 46.5% (11.0) and 55 games at 29.1% (11.5)
rank together, which neither number does alone. Half-point results make it a multiple of a half,
so ties are exact and happen: they are broken by **more games first** — the same cost measured on
more evidence — then by side and family name, so the order never depends on the database's.

`familyStandings` and `chooseOpenings` in `packages/chess/src/opening-choice.ts` are the rule.
They are pure and take aggregated rows, so the rule is unit tested without a database.

### A family is Chess.com's name, cut after "Defense" or "Gambit"

`openingFamily` strips the move suffix from the `eco_url` slug (`-2.e5`, `-3...d6-4.c3`) and cuts
the name after its first `Defense` or `Gambit`:

| `eco_url` slug                                      | Family                                      |
| --------------------------------------------------- | ------------------------------------------- |
| `Scandinavian-Defense-Mieses-Kotrc-Variation-3.Nc3` | `Scandinavian-Defense`                      |
| `Queens-Gambit-Declined-Chigorin-Defense-3.e3`      | `Queens-Gambit`                             |
| `Englund-Gambit-2.dxe5`                             | `Englund-Gambit`                            |
| `Kings-Pawn-Opening-Kings-Knight-Variation-2...Nc6` | `Kings-Pawn-Opening-Kings-Knight-Variation` |
| `Italian-Game-3...d6-4.O-O`                         | `Italian-Game`                              |

A defence or a gambit is one decision, and its sub-variations are where that decision goes; an
"Opening", "Game" or "Variation" name is often a catch-all (`Kings-Pawn-Opening` covers everything
after 1.e4 e5 that has no better name), and cutting it short would merge unrelated games. Games
with no `eco_url` are left out.

### At least 40 games

A family with fewer than **40** games in it, on that side, is not ranked. Below that the score is
noise — four Ponziani games at 25% say nothing — and a confidence interval would be more machinery
than a ranking of a dozen families needs.

### Strengths are left alone

A family with `points_lost <= 0` is **never** chosen, however often it is played. The French and
the Nimzowitsch score above 50%; drilling them spends repetitions where there is nothing to win.
They still appear in the standings the generator prints, below the line.

### Three families at a time

`chooseOpenings` takes a count, and the generator's `--families` defaults to **3**. Six families at
about 15 lines each is about 90 new lines to meet at once, which is a worse product than three
done well. Raising it is a flag, not a code change.

### What the rule chose, on 2026-10-14

From 4,464 games:

| #   | Side  | Family                                       | Games | Score | Points lost |
| --- | ----- | -------------------------------------------- | ----: | ----: | ----------: |
| 1   | Black | Englund Gambit                               |    55 | 29.1% |        11.5 |
| 2   | Black | Scandinavian Defense                         |   318 | 46.5% |        11.0 |
| 3   | Black | Queen's Gambit                               |    68 | 38.2% |         8.0 |
| 4   | Black | Center Game                                  |    45 | 32.2% |         8.0 |
| 5   | White | Sicilian Defense                             |    79 | 41.1% |         7.0 |
| 6   | White | King's Pawn Opening, King's Knight Variation |   126 | 44.8% |         6.5 |
| 7   | Black | King's Pawn Opening                          |   147 | 45.9% |         6.0 |

Generated: the first three. The design note this ADR follows listed a "Centre Game" row of 62
games at 41.1%; that grouping also cut `Game`, which would merge `Italian-Game` into one 151-game
family where the same note had it at 77. No single slug rule reproduces both rows. This one
reproduces the note's other nine, and the Center Game it keeps is the 45 games of `Center-Game`
itself, tied with the Queen's Gambit at 8.0 and placed after it on games.

**The Englund is generated, not endorsed.** 1.d4 e5 is the worst return in the history, and
whether to drill it or play something else against 1.d4 is a preference this data cannot decide.
The lines exist so that the decision can be made after seeing them; the drill presents them like
any other family.

### What it generated, on 2026-10-14

Stockfish at depth 20, one thread, hash cleared per position. Nothing was retired.

| Family                  | Root           | Lines | The opponent's first decision                                                                                                                  |
| ----------------------- | -------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Englund Gambit, Black   | `1.d4 e5`      |     4 | `2.dxe5` (36 games) and `2.e3` (7) from the games; `2.d5` (5) vetoed by the engine; nothing else within a pawn of `2.dxe5`, so nothing filled. |
| Scandinavian, Black     | `1.e4 d5`      |    15 | All six from the games: `2.exd5` 110, `2.e5` 85, `2.Nc3` 52, `2.Qf3` 22, `2.d3` 19, `2.f3` 18.                                                 |
| Queen's Gambit, Black   | `1.d4 d5 2.c4` |    18 | Engine margin only. The learner's `2...e6` is the engine's, and few of the player's games reach it — they mostly played `2...dxc4`.            |
| Ponziani, White (pilot) | unchanged      |    15 | ADR 0007's rule, unchanged; same 15 keys as before.                                                                                            |

The Englund's four lines are what the rule gives when the engine rates one reply far above the rest
and the player has met few others; that is a fact about the opening, not a gap in the generator.

### A family becomes a `LineSpec`; the shape does not change

`familySpec` derives every field from the history:

- **`rootSan`** — follow the family's most common move sequence, and stop at the first move that
  **identifies** the family: at least 80% of the player's games on that side which reach it are
  in the family (`d4 e5` is the Englund; `d4 d5` is not yet the Queen's Gambit, `d4 d5 c4` is).
  The root never goes past where half the family's games still agree, and if no move identifies
  the family it stops there. A root that went deeper would fix a move the opponent does not
  always play, and drop every line where they played something else.
- **`learnerColor`** — the side the player had, from `user_color`.
- **`depthPlies`** — 11 for White, 12 for Black (`lineDepthFor`): ADR 0006's rule that a line
  ends on the learner's move, mirrored.
- **`family`** — the slug and the side (`englund-gambit-black`), so `saveGeneratedLines` retires
  within it exactly as it does for the Ponziani.
- **`eco`, `name`** — the most common ECO code among the family's games, and the slug made
  readable. Both are fallbacks: `nameLine` still names each line from the book.

### The opponent's replies: what was played against the player, vetted by the engine

ADR 0007 picked the opponent's replies by engine margin alone, because there was nothing better:
the database held none of the player's games. Now it holds them. At each opponent decision:

1. **Replies the player has faced** at that position — at least `FACED_MIN_GAMES` (5) times in their games
   on that side, any family, transpositions included — come first, most frequent first.
2. **The engine vetoes** any of them more than `FACED_VETO_CP` (150 cp) worse than its own best
   reply. A popular reply that simply loses is not theory, and drilling it as a line would teach
   the learner to expect a gift. A reply the engine's MultiPV did not reach is scored with a
   restricted search (`searchmoves`), so the veto is applied to every faced reply, not only to
   those that happen to rank near the top.
3. **The cap is the branch rule's** (`maxReplies`, unchanged), and slots the measured replies do
   not fill are filled by ADR 0007's margin rule — the drill still prepares for what the player has not
   met.
4. **Past the branching rules**, the opponent plays the most-faced reply that survives the veto,
   or the engine's best when there is none.

After `1.e4 d5` (Black's main defence) White's second move was `exd5` 104 times, `e5` 82, `Nc3` 54,
`Qf3` 22 and `d3` 20 — the shape the drill now covers. Branching uses the Ponziani's numbers
(`FAMILY_BRANCHING`: 6 within a pawn at the first decision, 3 within half a pawn at the second);
the engine margins only matter where the games are silent.

A reply chosen this way is stored with `source: 'games'`, so a line can still be audited, and the
tutor says where it came from.

### The Ponziani stays

It is the pilot, it works, and retiring it would discard real review history. It is still the
`PONZIANI` spec, generated with the measured families on every run, and it keeps **ADR 0007's
branching, without measured replies**.

That is a choice, not an accident of the data. The "4 games" is the count under one Chess.com name;
34 of the player's White games reach the position after `3.c3`, and Black replied `3...Nf6` 23
times, `3...Bc5` 5, `3...d5` 3, `3...a6` 2. Under the measured rule `3...Bc5` would take a slot
and `3...a6` would lose one: 13 lines instead of 15, and the two `3...a6` lines retired — the
only two besides the Caro Gambit that the player has reviewed. Whether to switch the Ponziani to
measured replies is left to the player; it is a one-line change in the generator.

### The drill shows every family

`/lines` takes a `family`, lists the families that have live lines, and opens the one with a line
due (else the first). It names them neutrally — the slug, readable, and the side.

## Alternatives rejected

- **Rank by frequency.** Puts the French and the Nimzowitsch, the two best, at the top.
- **Rank by score.** A 40-game family at 30% would outrank a 318-game family at 46.5% that costs
  more points in total.
- **No floor, or a confidence interval.** No floor ranks four-game noise; an interval is more
  machinery than needed to keep it out.
- **Family by ECO code** (`game.eco`). B01 lumps the Scandinavian with unrelated 1.e4 d5 sidelines
  and splits nothing the player would recognise; Chess.com's name is what the player sees after every game.
- **Cut every family at its first named word.** Merges unrelated games under catch-all names:
  `Kings-Pawn-Opening` then holds 257 Black games with no common plan.
- **The root as the moves every game shares.** One transposition (`1.Nf3 d5 2.d4`) and the Queen's
  Gambit's root is empty.
- **The root as the moves most games share.** Fixes the Englund's root at `1.d4 e5 2.dxe5 f6`,
  dropping the 35% of games where White did not play `2.dxe5`.
- **Measured frequency only, no engine.** A popular blunder becomes a line, and the drill teaches
  the learner to expect it.
- **Engine margin only (ADR 0007, unchanged).** Ignores that `2.e5` against the Scandinavian came
  up 82 times; the margin rule ranks by soundness, which is not what the player meets.
- **Lines per user.** The catalogue stays shared, as ADR 0006 has it. It is now built from one
  account's games, chosen by `--account` (or the only verified account); if a second player's
  history ever needs its own repertoire, that is when lines become per-user and generation a job.
- **Retire a family's lines when it drops out of the top three.** A family that improves out of
  the ranking has been fixed by drilling it; pulling its lines would stop the schedule that fixed
  it. A family is retired line by line, when it is regenerated, as before.

## Consequences

- **Black repertoires exist.** The drill and Learn mode already honoured `learnerColor`; nothing
  in them changed.
- **Generation is longer.** Three families plus the Ponziani are several minutes of single-threaded
  depth-20 search; the script logs progress per family.
- **The ranking moves as games are played.** Each run re-reads the history, so a family can enter
  or leave the top three. Lines already generated are left as they are when that happens.
- **Measured replies are counted across families.** A position reached by transposition counts
  the same as one reached in order — the replies met there are the replies met.
- **The engine still decides the learner's moves.** What the player chooses in these
  openings is not used; a repertoire is one sound answer per position, not the player's habits.
- **Revisit** when `move_analysis` is complete (a family could be ranked by where the points were
  actually lost, not only by result), when a second player is synced, or if Simon decides the
  Englund question.
