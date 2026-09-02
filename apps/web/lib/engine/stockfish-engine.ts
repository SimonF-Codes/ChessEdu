import {
  type EngineInfo,
  type Evaluation,
  type UciOption,
  parseBestMove,
  parseInfoLine,
  setOptionCommand,
  sideToMove,
  toWhitePerspective,
} from '@chessedu/chess/browser';

/**
 * Stockfish in the tab, spoken to over UCI.
 *
 * The protocol parsing is shared with the worker (`packages/chess/src/uci.ts`); what is
 * different here is the plumbing — a Web Worker rather than a child process — and that is all
 * this file is. The transport is injected so the state machine can be tested without a
 * Worker, a DOM, or 7 MB of WebAssembly.
 *
 * Single-threaded by construction: `Threads` is never set, because the build that would honour
 * it needs cross-origin isolation. See docs/adr/0002-browser-engine.md.
 */

export interface EngineTransport {
  send(command: string): void;
  /** Listen to one line of engine output. Returns the unsubscribe. */
  subscribe(listener: (line: string) => void): () => void;
  terminate(): void;
}

export interface SearchResult {
  /** The move the engine chose, in UCI (`e2e4`, `e7e8q`). Null when there is nothing to play. */
  bestMoveUci: string | null;
  /** Evaluation of the searched position, from White's perspective — as everywhere else. */
  evaluation: Evaluation;
  depth: number;
  pv: string[];
}

/** How long to wait past the requested search time before giving up on the engine. */
const SEARCH_GRACE_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;

export class EngineError extends Error {}

export class StockfishEngine {
  private disposed = false;

  /**
   * One command sequence at a time. UCI is a single conversation — a second `go` while the
   * first is running gets one `bestmove` for the two of them — so callers are queued rather
   * than allowed to interleave.
   */
  private turn: Promise<unknown> = Promise.resolve();

  constructor(private readonly transport: EngineTransport) {}

  /** Handshake. Resolves once the engine has answered `uciok` and is ready for commands. */
  init(): Promise<void> {
    return this.enqueue(async () => {
      this.send('uci');
      await this.waitFor((line) => line === 'uciok', HANDSHAKE_TIMEOUT_MS);
      await this.isReady();
    });
  }

  /**
   * Start a fresh game at a given strength.
   *
   * `ucinewgame` clears the hash so the previous game cannot colour this one, and the options
   * are re-sent because a level change is the usual reason to be here.
   */
  newGame(options: readonly UciOption[] = []): Promise<void> {
    return this.enqueue(async () => {
      this.send('ucinewgame');
      for (const option of options) this.send(setOptionCommand(option));
      await this.isReady();
    });
  }

  /** Search a position and return the move to play. */
  search(fen: string, moveTimeMs: number): Promise<SearchResult> {
    return this.enqueue(async () => {
      this.send(`position fen ${fen}`);

      let best: EngineInfo | null = null;
      const bestMoveUci = await new Promise<string | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new EngineError(`the engine did not answer within ${moveTimeMs}ms`));
        }, moveTimeMs + SEARCH_GRACE_MS);

        const unsubscribe = this.transport.subscribe((line) => {
          const info = parseInfoLine(line);
          // Later lines are deeper; keep the last complete one.
          if (info && (!best || info.depth >= best.depth)) best = info;

          if (line.startsWith('bestmove')) {
            cleanup();
            resolve(parseBestMove(line));
          }
        });

        const cleanup = () => {
          clearTimeout(timer);
          unsubscribe();
        };

        this.send(`go movetime ${moveTimeMs}`);
      });

      const info: EngineInfo = best ?? { depth: 0, scoreCp: 0, mateIn: null, pv: [] };
      return {
        bestMoveUci,
        evaluation: toWhitePerspective(info, sideToMove(fen)),
        depth: info.depth,
        pv: info.pv,
      };
    });
  }

  /**
   * Abandon the engine. Safe to call twice, and safe to call mid-search: a queued caller sees
   * an EngineError rather than hanging on a worker that is no longer there.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transport.terminate();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.turn.then(() => {
      if (this.disposed) throw new EngineError('the engine has been disposed');
      return work();
    });
    // The caller gets the rejection; the queue swallows it, so one failed command does not
    // strand every command behind it.
    this.turn = result.catch(() => undefined);
    return result;
  }

  private async isReady(): Promise<void> {
    this.send('isready');
    await this.waitFor((line) => line === 'readyok', HANDSHAKE_TIMEOUT_MS);
  }

  private waitFor(predicate: (line: string) => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new EngineError('timed out waiting for the engine'));
      }, timeoutMs);

      const unsubscribe = this.transport.subscribe((line) => {
        if (!predicate(line)) return;
        cleanup();
        resolve();
      });

      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
      };
    });
  }

  private send(command: string): void {
    if (this.disposed) throw new EngineError('the engine has been disposed');
    this.transport.send(command);
  }
}
