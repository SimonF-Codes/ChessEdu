# ADR 0005: Maia networks in the browser for opponents below Stockfish's floor

- **Status:** accepted
- **Date:** 2026-09-16

## Context

ADR 0002 capped bot strength with Stockfish's `UCI_LimitStrength` / `UCI_Elo`, whose floor is
**1320**, and recorded that anything weaker was Maia's job and out of scope. It assumed sub-floor
players were an edge case.

They are not. The only user's Chess.com blitz median, over 2,111 rated games, is **552**.

### A correction to how that gap was described

It was repeatedly stated in design discussion that "552 against a 1320 floor" made `/play`
unusable. That comparison was **not valid**: it put three different scales side by side.

- **Chess.com** and **Lichess** ratings diverge sharply at the bottom. Chess.com 800 is roughly
  Lichess 1290 — a gap near 490 points, widening further below 800. The two scales converge only
  around 2200. So a Chess.com 552 is approximately **Lichess 1000–1100**.
- **Stockfish's `UCI_Elo`** is a third scale again, and a limited Stockfish plays notably stronger
  than a human of the nominal rating, because its errors are not human errors.

The real problem was therefore never the arithmetic. It is that **a weakened Stockfish is not a
weak human**: it plays a deep, correct move and then hangs a queen, because the only lever is
search quality. That was already the reasoning in ADR 0002, and it stands.

Restated honestly: a Chess.com 552 needs an opponent around **Lichess 1000–1200 that errs the way
a human errs**.

## Decision

Serve sub-floor opponents with **Maia v1 networks, run client-side via ONNX Runtime Web**, in the
Web Worker that already exists for the engine.

- **Maia v1** ships nine networks covering **Lichess 1100–1900**. `maia-1100` sits squarely in the
  band this player needs — not 550 points above them, as the invalid comparison implied.
- Maia weights are Lc0-ecosystem networks, and running those client-side is established practice:
  `play-lc0` performs inference in a Web Worker via ONNX Runtime Web with WebGPU and a WASM
  fallback; A.C.A.S runs Maia weights in-browser through the same runtime.
- This **preserves ADR 0001**. Interactive play stays in the browser; the Fly worker keeps doing
  batch history analysis and nothing else.

Stockfish remains the opponent from 1320 up, and remains the analysis engine everywhere. Maia is
added below it, not substituted for it.

## Alternatives rejected

- **Maia-2 (NeurIPS 2024).** A single skill-aware model spanning **Lichess 600–2600**, which is
  strictly better coverage and would replace the whole nine-network ladder. Rejected *for now*
  only because it ships as PyTorch and needs either a Python service — breaking the
  browser-inference rule in ADR 0001 — or an ONNX export that has to be produced and validated.
  **This is the strongest candidate for a revisit**, and the reason the transport seam below is
  being generalised rather than special-cased to Maia v1.
- **Crippling Stockfish further** (depth 1–2, random top-N selection). Already rejected in ADR
  0002 and rejected again: it produces the inhuman blunder pattern that makes a bot feel broken
  rather than beatable.
- **Server-side Lc0 on Fly.** Works, but puts a network round trip on every bot move and CPU cost
  on every casual game — exactly what ADR 0001 kept out of the interactive path.
- **Leaving `/play` as is.** The feature exists and the only user cannot use it.

## Consequences

- **A second inference runtime in the browser.** ONNX Runtime Web joins `stockfish.wasm`. Both
  are lazy-loaded and only one is needed per game, but the bundle and cache story gets more
  complex, and WebGPU availability now affects experience.
- **The engine seam must generalise.** `apps/web/lib/engine/` is written around "any worker
  speaking UCI". Maia via ONNX does not speak UCI — it returns a move distribution. The interface
  has to become *move provider* rather than *UCI transport*. This is the main piece of work, and
  doing it properly is what keeps Maia-2 cheap to adopt later.
- **Weights must be fetched and cached.** Per-network downloads on first use, versioned like the
  Stockfish WASM fetch in `scripts/fetch-stockfish.mjs`.
- **Two rating scales now appear in the product.** Stockfish rungs are labelled in one scale, Maia
  networks in the Lichess scale, and the user's own rating is Chess.com. The UI must not present
  these as one number. `recommendBotLevel` currently takes a Chess.com rating and compares it
  directly against `UCI_Elo` rungs; that is the same category error as above and needs fixing when
  Maia lands.
- **Maia has no search.** It returns a human-like move, not a best move, and cannot be asked to
  "think longer". `BOT_MOVE_TIME_MS` is meaningless for it.

## Revisit when

Maia-2 has a usable ONNX export, or WebGPU support is broad enough that a larger network is
comfortable client-side. At that point one model replaces the ladder and the scale-labelling
problem largely goes away.

## Sources

- [Maia Chess — Introducing Maia](https://www.maiachess.com/blog/maia-v1)
- [CSSLab/maia-chess](https://github.com/CSSLab/maia-chess)
- [CSSLab/maia2](https://github.com/CSSLab/maia2)
- [Maia-2: A Unified Model for Human-AI Alignment in Chess (NeurIPS 2024)](https://proceedings.neurips.cc/paper_files/paper/2024/hash/250190819ff1dda47cd23cecc0c5a69b-Abstract-Conference.html)
- [play-lc0 — Lc0 networks client-side via ONNX Runtime Web](https://github.com/hunterchen7/play-lc0)
- [Chess Rating Comparison — ChessGoals](https://chessgoals.com/rating-comparison/)
