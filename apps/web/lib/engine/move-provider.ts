import type { BotLevel } from '@chessedu/chess/browser';

/**
 * What `/play` needs from an opponent, and deliberately nothing more.
 *
 * This file used to be a transport: "any worker speaking UCI", which held for exactly as long
 * as Stockfish was the only engine. ADR 0005 adds Maia v1 through ONNX Runtime Web below
 * Stockfish's 1320 floor, and Maia does not speak UCI — it returns a distribution over legal
 * moves, has no search that could be given longer, and changes strength by loading a different
 * network rather than by setting an option. So the seam is a *move provider*: a position goes
 * in, a move comes out, and how is nobody else's business.
 *
 * See §10.1 of docs/architecture.md, and docs/adr/0005-human-like-bots.md for why.
 */

/** Anything that goes wrong on the far side of the seam, whatever runtime is over there. */
export class MoveProviderError extends Error {}

export interface MoveProvider {
  /** Which opponent this is. Stable, for logs and diagnostics; never shown to a player. */
  readonly id: string;

  /**
   * Load whatever has to be loaded — WebAssembly, weights, a session — and resolve once a move
   * can actually be asked for. Separate from construction because it is megabytes and the page
   * renders a status while it happens.
   */
  init(): Promise<void>;

  /**
   * Start a fresh game at a given strength.
   *
   * The whole rung is passed rather than a number, because strength is provider-defined.
   * `BotLevel.elo` is a `UCI_Elo` — a Stockfish scale that means nothing to a network trained
   * on Lichess games. Stockfish reads it and sets `UCI_LimitStrength`/`UCI_Elo`; a Maia
   * provider would read the rung's identity and load the matching weights. Neither mapping
   * belongs in this type.
   */
  newGame(level: BotLevel): Promise<void>;

  /**
   * The move this opponent plays in this position, in UCI long algebraic (`e2e4`, `e7e8q`), or
   * null when there is none to play.
   *
   * UCI *notation* survives the generalisation while the UCI *protocol* does not: it is how
   * chess.js is handed a move on the other side of the board, and any engine worth wrapping can
   * produce one.
   *
   * There is no time budget in this signature on purpose. `BOT_MOVE_TIME_MS` is a Stockfish
   * knob — one forward pass through a network cannot be asked to think longer — so it lives
   * with the provider that honours it.
   */
  chooseMove(fen: string): Promise<string | null>;

  /** Let go of the worker, the session, the weights. Safe to call twice. */
  dispose(): void;
}

export interface MoveProviderOptions {
  /**
   * Every diagnostic line the provider emits, for the `?engineLog=1` switch. What a line says
   * is the provider's business: Stockfish mirrors its UCI traffic, another runtime would not.
   */
  onLog?: (line: string) => void;
  /** The provider failed outside any call the caller is awaiting — a worker that never loaded. */
  onError?: (error: Error) => void;
}

/**
 * How a provider is built. Constructing one must not do the loading — that is `init` — so this
 * can be called synchronously during a render effect and fail loudly if the runtime is missing.
 */
export type MoveProviderFactory = (options?: MoveProviderOptions) => MoveProvider;
