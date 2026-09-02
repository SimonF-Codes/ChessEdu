import { Chess } from 'chess.js';

import { ECO_TSV } from './eco/data';
import { extractSanMoves } from './pgn';

/**
 * Mainline opening theory: what a position is called, and what theory plays from it.
 *
 * The source is the CC0 ECO data set vendored in ./eco/data.ts — see
 * docs/adr/0002-opening-theory-source.md for why that one and not another. The book supplies
 * names and continuations and nothing else. It never says a move is bad; it says a move is not
 * in it, and Stockfish says what that cost. That is the coaching boundary applied to openings.
 */

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** One named line, straight from the data set. */
export interface EcoEntry {
  eco: string;
  name: string;
  /** The line as PGN movetext, e.g. `1. e4 c5 2. d4`. */
  pgn: string;
}

/** A theory move available from a book position. */
export interface BookMove {
  uci: string;
  san: string;
  /** The shortest named line this move leads into. */
  eco: string;
  name: string;
}

/** What the book knows about one position. */
export interface BookPosition {
  key: string;
  /** Plies from the start along the shortest book line that reaches this position. */
  ply: number;
  /** Set only where a named line ends exactly here; null for a position merely passed through. */
  eco: string | null;
  name: string | null;
  moves: readonly BookMove[];
}

export interface OpeningBook {
  get(fen: string): BookPosition | undefined;
  has(fen: string): boolean;
  /** Number of distinct positions indexed. */
  readonly size: number;
}

/**
 * Position identity for book lookup: a FEN without the halfmove and fullmove counters, so the
 * same position matches whenever and however it arises. This is what makes transpositions
 * work.
 *
 * It assumes both sides of a comparison produce FENs the same way. They do — the book expands
 * lines with `chess.js`, and `moves.fen_before` was written by `chess.js` in `normalizeGame`.
 * A second FEN producer would have to normalise its en passant field to match.
 */
export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

/** Read the vendored data set. Blank lines and the repeated header row are skipped. */
export function parseEcoTsv(tsv: string): EcoEntry[] {
  const entries: EcoEntry[] = [];
  for (const line of tsv.split('\n')) {
    const row = line.trim();
    if (row.length === 0 || row.startsWith('eco\t')) continue;
    const [eco, name, pgn] = row.split('\t');
    if (eco === undefined || name === undefined || pgn === undefined) continue;
    entries.push({ eco, name, pgn });
  }
  return entries;
}

/** Order two lines so that a prefix sorts before what extends it. */
function compareLines(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const order = a[index]!.localeCompare(b[index]!);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

interface MutableEdge extends BookMove {
  /** Length of the line this edge was learned from; the shortest one wins the name. */
  via: number;
}

interface MutablePosition {
  key: string;
  ply: number;
  eco: string | null;
  name: string | null;
  /** Length of the line that supplied the name, so a shorter one can replace it. */
  via: number;
  moves: Map<string, MutableEdge>;
}

/**
 * Expand named lines into a position-keyed index.
 *
 * Every position along every line is indexed, not only the ones a line ends on: deviation
 * detection has to answer "what does theory play here" at each ply, not just at the leaves.
 * Where two entries reach the same position, the shorter line supplies the name — the upstream
 * convention is that each name has a unique shortest line.
 */
export function buildBook(entries: Iterable<EcoEntry>): OpeningBook {
  const positions = new Map<string, MutablePosition>();
  const board = new Chess();
  const rootKey = positionKey(START_FEN);

  const ensure = (key: string, ply: number): MutablePosition => {
    const existing = positions.get(key);
    if (existing) {
      if (ply < existing.ply) existing.ply = ply;
      return existing;
    }
    const created: MutablePosition = {
      key,
      ply,
      eco: null,
      name: null,
      via: Number.POSITIVE_INFINITY,
      moves: new Map(),
    };
    positions.set(key, created);
    return created;
  };

  ensure(rootKey, 0);

  // Lines are walked in sorted order so consecutive entries share a prefix, and the board is
  // rewound to that prefix rather than reset. Replaying is by far the expensive part, and the
  // data set has thousands of lines through `1. e4 e5`. Every entry still visits every one of
  // its own plies below, from the cache — sorting changes the cost, never the result.
  const lines = [...entries]
    .map((entry) => ({ entry, san: extractSanMoves(entry.pgn) }))
    .filter((line) => line.san.length > 0)
    .sort((a, b) => compareLines(a.san, b.san));

  /** The line currently on the board, with the key and UCI of each ply already replayed. */
  const played: string[] = [];
  const keys: string[] = [rootKey];
  const ucis: string[] = [];
  const sans: string[] = [];

  for (const { entry, san } of lines) {
    let shared = 0;
    while (shared < played.length && shared < san.length && played[shared] === san[shared]) {
      shared += 1;
    }
    while (played.length > shared) {
      board.undo();
      played.pop();
    }

    for (let index = shared; index < san.length; index += 1) {
      const move = board.move(san[index]!);
      ucis[index] = `${move.from}${move.to}${move.promotion ?? ''}`;
      sans[index] = move.san;
      keys[index + 1] = positionKey(board.fen());
      played.push(san[index]!);
    }

    for (let index = 0; index < san.length; index += 1) {
      const from = ensure(keys[index]!, index);
      const uci = ucis[index]!;
      const known = from.moves.get(uci);
      if (!known || san.length < known.via) {
        from.moves.set(uci, {
          uci,
          san: sans[index]!,
          eco: entry.eco,
          name: entry.name,
          via: san.length,
        });
      }
    }

    const leaf = ensure(keys[san.length]!, san.length);
    if (san.length < leaf.via) {
      leaf.eco = entry.eco;
      leaf.name = entry.name;
      leaf.via = san.length;
    }
  }

  const frozen = new Map<string, BookPosition>();
  for (const [key, position] of positions) {
    const moves = [...position.moves.values()]
      .sort((a, b) => a.eco.localeCompare(b.eco) || a.name.localeCompare(b.name))
      .map(({ uci, san, eco, name }) => ({ uci, san, eco, name }));
    frozen.set(key, { key, ply: position.ply, eco: position.eco, name: position.name, moves });
  }

  return {
    get: (fen) => frozen.get(positionKey(fen)),
    has: (fen) => frozen.has(positionKey(fen)),
    size: frozen.size,
  };
}

let memoized: OpeningBook | undefined;

/**
 * The book over the whole vendored data set.
 *
 * Building it replays every line, which costs a few hundred milliseconds, so it is built once
 * per process and shared. Callers that want a different book — a test, or a repertoire scoped
 * to one ECO volume — pass their own to `buildBook`.
 */
export function defaultBook(): OpeningBook {
  memoized ??= buildBook(parseEcoTsv(ECO_TSV));
  return memoized;
}
