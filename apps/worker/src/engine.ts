import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import {
  type EngineInfo,
  type Evaluation,
  parseBestMove,
  parseInfoLine,
  sideToMove,
  toWhitePerspective,
} from '@chessedu/chess';

/**
 * A Stockfish process spoken to over UCI.
 *
 * One process is reused for a whole game: starting the engine and letting it fill its hash
 * table is most of the cost, and throwing that away per position would multiply analysis time.
 */

export interface EngineOptions {
  binaryPath: string;
  threads?: number;
  hashMb?: number;
  /** Milliseconds allowed per position before the search is stopped. */
  moveTimeMs?: number;
  depth?: number;
}

export interface PositionAnalysis {
  /** Evaluation of the position, from White's perspective. */
  evaluation: Evaluation;
  bestMoveUci: string | null;
  pv: string[];
  depth: number;
}

export class Engine {
  private process: ChildProcessWithoutNullStreams | null = null;
  private lines: ((line: string) => void)[] = [];

  constructor(private readonly options: EngineOptions) {}

  async start(): Promise<void> {
    const child = spawn(this.options.binaryPath, [], { stdio: 'pipe' });
    this.process = child;

    createInterface({ input: child.stdout }).on('line', (line) => {
      for (const listener of this.lines) listener(line);
    });

    child.on('exit', (code) => {
      this.process = null;
      if (code !== 0 && code !== null) {
        console.error(`[engine] stockfish exited with code ${code}`);
      }
    });

    this.send('uci');
    await this.waitFor((line) => line === 'uciok');

    this.send(`setoption name Threads value ${this.options.threads ?? 1}`);
    this.send(`setoption name Hash value ${this.options.hashMb ?? 256}`);
    await this.isReady();
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    this.send('quit');
    const child = this.process;
    this.process = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Clear the hash between games so one game cannot colour the next. */
  async newGame(): Promise<void> {
    this.send('ucinewgame');
    await this.isReady();
  }

  /**
   * Analyse a position. The returned evaluation is from White's perspective, whoever is to
   * move — see toWhitePerspective.
   */
  async analyse(fen: string): Promise<PositionAnalysis> {
    this.send(`position fen ${fen}`);

    let best: EngineInfo | null = null;
    const bestMove = await new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          cleanup();
          reject(new Error(`engine timed out on ${fen}`));
        },
        (this.options.moveTimeMs ?? 1000) * 5 + 10_000,
      );

      const listener = (line: string) => {
        const info = parseInfoLine(line);
        // Later lines are deeper; keep the last complete one.
        if (info && (!best || info.depth >= best.depth)) best = info;

        if (line.startsWith('bestmove')) {
          cleanup();
          resolve(parseBestMove(line));
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.lines = this.lines.filter((l) => l !== listener);
      };

      this.lines.push(listener);
      this.send(this.goCommand());
    });

    const info: EngineInfo = best ?? { depth: 0, scoreCp: 0, mateIn: null, pv: [] };
    return {
      evaluation: toWhitePerspective(info, sideToMove(fen)),
      bestMoveUci: bestMove,
      pv: info.pv,
      depth: info.depth,
    };
  }

  private goCommand(): string {
    if (this.options.depth) return `go depth ${this.options.depth}`;
    return `go movetime ${this.options.moveTimeMs ?? 1000}`;
  }

  private async isReady(): Promise<void> {
    this.send('isready');
    await this.waitFor((line) => line === 'readyok');
  }

  private waitFor(predicate: (line: string) => boolean, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for the engine'));
      }, timeoutMs);

      const listener = (line: string) => {
        if (!predicate(line)) return;
        cleanup();
        resolve();
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.lines = this.lines.filter((l) => l !== listener);
      };

      this.lines.push(listener);
    });
  }

  private send(command: string): void {
    if (!this.process) throw new Error('engine is not running');
    this.process.stdin.write(`${command}\n`);
  }
}
