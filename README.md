# ChessEdu

A personal chess trainer built on my own Chess.com game history: pull the games,
analyze them with an engine, and wrap the analysis in a real education system —
direct coaching, reference literature, and bots to play against.

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

## Status

Empty scaffold. Stack undecided.
