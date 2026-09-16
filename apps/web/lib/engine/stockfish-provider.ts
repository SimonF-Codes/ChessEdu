import { BOT_MOVE_TIME_MS, type BotLevel, strengthOptions } from '@chessedu/chess/browser';

import type { MoveProvider, MoveProviderOptions } from './move-provider';
import { type EngineTransport, StockfishEngine } from './stockfish-engine';
import { createWorkerTransport } from './worker-transport';

/**
 * Stockfish as a move provider.
 *
 * This is where UCI stops. Below it: `strengthOptions` turning a rung into options, the protocol
 * state machine in stockfish-engine.ts, a Web Worker in worker-transport.ts. Above it nothing
 * knows the opponent speaks a protocol at all — see §10.1 of docs/architecture.md.
 *
 * The two Stockfish-shaped facts that the seam refuses to carry both live here, and nowhere
 * else: that a rung's `elo` is a `UCI_Elo`, and that a move is the result of a timed search.
 */

export interface StockfishProviderOptions extends MoveProviderOptions {
  /**
   * Injected in tests, where there is no Worker and no 7 MB of WebAssembly. Production leaves
   * it alone and gets the real one.
   */
  createTransport?: (options: MoveProviderOptions) => EngineTransport;
}

const workerTransport = (options: MoveProviderOptions): EngineTransport =>
  createWorkerTransport({ onLine: options.onLog, onError: options.onError });

export function createStockfishProvider(options: StockfishProviderOptions = {}): MoveProvider {
  const engine = new StockfishEngine((options.createTransport ?? workerTransport)(options));

  return {
    id: 'stockfish',

    init: () => engine.init(),

    /**
     * A rung becomes a strength cap here and stays one. `UCI_Elo`'s floor of 1320 is Stockfish's
     * own, which is why ADR 0005 needed a second provider rather than a lower number.
     */
    newGame: (level: BotLevel) => engine.newGame(strengthOptions(level.elo)),

    /**
     * `BOT_MOVE_TIME_MS` is applied here because this is the only provider for which it means
     * anything. At a capped Elo it is a responsiveness knob, not a strength one.
     */
    async chooseMove(fen: string) {
      const { bestMoveUci } = await engine.search(fen, BOT_MOVE_TIME_MS);
      return bestMoveUci;
    },

    dispose: () => engine.dispose(),
  };
}
