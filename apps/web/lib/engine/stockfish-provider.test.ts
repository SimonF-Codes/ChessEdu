import { describe, expect, it } from 'vitest';

import { BOT_LEVELS, BOT_MOVE_TIME_MS, MIN_BOT_ELO } from '@chessedu/chess/browser';

import type { EngineTransport } from './stockfish-engine';
import { createStockfishProvider } from './stockfish-provider';

/**
 * The other side of the seam: that Stockfish still behaves exactly as it did, and that the two
 * facts the interface refuses to carry — a rung is a `UCI_Elo`, a move is a timed search — are
 * applied here and only here.
 *
 * stockfish-engine.test.ts owns the protocol itself and is left alone; it is the regression net
 * for this refactor, so this file brings its own smaller script rather than borrowing its fake.
 */
class ScriptedTransport implements EngineTransport {
  readonly sent: string[] = [];
  terminated = false;
  /** What a `go` is answered with. Replaced per test. */
  searchOutput: string[] = ['info depth 9 score cp 21 pv e2e4', 'bestmove e2e4'];
  private listeners = new Set<(line: string) => void>();

  send(command: string): void {
    this.sent.push(command);
    if (command === 'uci') this.reply('uciok');
    else if (command === 'isready') this.reply('readyok');
    else if (command.startsWith('go')) this.reply(...this.searchOutput);
  }

  subscribe(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
    this.listeners.clear();
  }

  private reply(...lines: string[]): void {
    queueMicrotask(() => {
      for (const line of lines) for (const listener of [...this.listeners]) listener(line);
    });
  }
}

async function ready() {
  const transport = new ScriptedTransport();
  const provider = createStockfishProvider({ createTransport: () => transport });
  await provider.init();
  transport.sent.length = 0;
  return { transport, provider };
}

const BEGINNER = BOT_LEVELS[0]!;
const CLUB = BOT_LEVELS[2]!;
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('Stockfish behind the move provider interface', () => {
  it('identifies itself, so a log says which opponent played', async () => {
    const { provider } = await ready();
    expect(provider.id).toBe('stockfish');
  });

  it('turns a rung into a strength cap — the only place that mapping happens', async () => {
    const { transport, provider } = await ready();

    await provider.newGame(CLUB);

    expect(transport.sent).toEqual([
      'ucinewgame',
      'setoption name UCI_LimitStrength value true',
      `setoption name UCI_Elo value ${CLUB.elo}`,
      'isready',
    ]);
  });

  it('caps the weakest rung at Stockfish’s own floor, which is why ADR 0005 exists', async () => {
    const { transport, provider } = await ready();

    await provider.newGame(BEGINNER);

    expect(transport.sent).toContain(`setoption name UCI_Elo value ${MIN_BOT_ELO}`);
  });

  it('turns a position into a timed search, and a search into one move', async () => {
    const { transport, provider } = await ready();

    await expect(provider.chooseMove(START_FEN)).resolves.toBe('e2e4');

    // BOT_MOVE_TIME_MS is applied here because it is meaningless to a provider without a search.
    expect(transport.sent).toEqual([
      `position fen ${START_FEN}`,
      `go movetime ${BOT_MOVE_TIME_MS}`,
    ]);
  });

  it('reports no move rather than a made-up one', async () => {
    const { transport, provider } = await ready();
    transport.searchOutput = ['bestmove (none)'];

    await expect(provider.chooseMove(START_FEN)).resolves.toBeNull();
  });

  it('terminates the worker when disposed', async () => {
    const { transport, provider } = await ready();
    provider.dispose();
    expect(transport.terminated).toBe(true);
  });
});
