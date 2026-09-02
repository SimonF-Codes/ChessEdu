import { afterEach, describe, expect, it, vi } from 'vitest';

import { BOT_MOVE_TIME_MS, strengthOptions } from '@chessedu/chess/browser';

import { EngineError, type EngineTransport, StockfishEngine } from './stockfish-engine';

/**
 * A Stockfish that is only a script. The real transport is a Web Worker running 7 MB of
 * WebAssembly; what is worth testing is the conversation, so this replies the way Stockfish
 * does — asynchronously, one line at a time — and records what it was asked.
 */
class FakeEngine implements EngineTransport {
  readonly sent: string[] = [];
  terminated = false;

  /** Lines emitted in answer to a `go`. Replaced per test. */
  searchOutput: string[] = [
    'info depth 12 score cp 34 nodes 100 pv e2e4 e7e5',
    'bestmove e2e4 ponder e7e5',
  ];

  /** When true, `go` is met with silence — the hung-engine case. */
  silent = false;

  private listeners = new Set<(line: string) => void>();

  send(command: string): void {
    this.sent.push(command);
    if (command === 'uci') this.reply('id name Stockfish 18', 'uciok');
    else if (command === 'isready') this.reply('readyok');
    else if (command.startsWith('go') && !this.silent) this.reply(...this.searchOutput);
  }

  subscribe(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
    this.listeners.clear();
  }

  /** Push lines at the engine by hand, for the cases a script cannot express. */
  emit(...lines: string[]): void {
    for (const line of lines) {
      for (const listener of [...this.listeners]) listener(line);
    }
  }

  private reply(...lines: string[]): void {
    queueMicrotask(() => {
      for (const line of lines) {
        for (const listener of [...this.listeners]) listener(line);
      }
    });
  }
}

/** Let every queued microtask run, so "has it been sent yet" means something. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BLACK_TO_MOVE = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

async function ready(): Promise<{ transport: FakeEngine; engine: StockfishEngine }> {
  const transport = new FakeEngine();
  const engine = new StockfishEngine(transport);
  await engine.init();
  return { transport, engine };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the handshake', () => {
  it('does not resolve until the engine has said uciok and readyok', async () => {
    const { transport } = await ready();
    expect(transport.sent).toEqual(['uci', 'isready']);
  });
});

describe('newGame', () => {
  it('clears the hash and sets the strength cap before anything is searched', async () => {
    const { transport, engine } = await ready();
    transport.sent.length = 0;

    await engine.newGame(strengthOptions(1700));

    expect(transport.sent).toEqual([
      'ucinewgame',
      'setoption name UCI_LimitStrength value true',
      'setoption name UCI_Elo value 1700',
      'isready',
    ]);
  });
});

describe('search', () => {
  it('asks for the position, then the move', async () => {
    const { transport, engine } = await ready();
    transport.sent.length = 0;

    const result = await engine.search(START_FEN, BOT_MOVE_TIME_MS);

    expect(transport.sent).toEqual([
      `position fen ${START_FEN}`,
      `go movetime ${BOT_MOVE_TIME_MS}`,
    ]);
    expect(result.bestMoveUci).toBe('e2e4');
    expect(result.depth).toBe(12);
    expect(result.pv).toEqual(['e2e4', 'e7e5']);
  });

  it('reports the evaluation from White’s perspective whoever is to move', async () => {
    const { transport, engine } = await ready();
    // +34 for the side to move, and Black is to move, so White is 34 centipawns worse.
    transport.searchOutput = ['info depth 10 score cp 34 pv e7e5', 'bestmove e7e5'];

    const result = await engine.search(BLACK_TO_MOVE, BOT_MOVE_TIME_MS);

    expect(result.evaluation).toEqual({ cp: -34, mateIn: null });
  });

  it('keeps the deepest line, not the last one seen', async () => {
    const { transport, engine } = await ready();
    transport.searchOutput = [
      'info depth 4 score cp 10 pv d2d4',
      'info depth 18 score cp 60 pv e2e4 e7e5',
      'info depth 18 currmove g1f3 currmovenumber 2',
      'bestmove e2e4',
    ];

    const result = await engine.search(START_FEN, BOT_MOVE_TIME_MS);

    expect(result.depth).toBe(18);
    expect(result.evaluation).toEqual({ cp: 60, mateIn: null });
  });

  it('returns no move when the engine has none to give', async () => {
    const { transport, engine } = await ready();
    transport.searchOutput = ['bestmove (none)'];

    const result = await engine.search(START_FEN, BOT_MOVE_TIME_MS);

    expect(result.bestMoveUci).toBeNull();
  });

  it('runs one search at a time, because UCI is one conversation', async () => {
    const { transport, engine } = await ready();
    // Hold the first search open, so "the second one has not started" is observable.
    transport.silent = true;
    transport.sent.length = 0;

    const first = engine.search(START_FEN, BOT_MOVE_TIME_MS);
    const second = engine.search(BLACK_TO_MOVE, BOT_MOVE_TIME_MS);
    await flush();

    expect(transport.sent).toEqual([
      `position fen ${START_FEN}`,
      `go movetime ${BOT_MOVE_TIME_MS}`,
    ]);

    transport.emit('bestmove e2e4');
    await expect(first).resolves.toMatchObject({ bestMoveUci: 'e2e4' });
    await flush();

    expect(transport.sent).toEqual([
      `position fen ${START_FEN}`,
      `go movetime ${BOT_MOVE_TIME_MS}`,
      `position fen ${BLACK_TO_MOVE}`,
      `go movetime ${BOT_MOVE_TIME_MS}`,
    ]);

    transport.emit('bestmove e7e5');
    await expect(second).resolves.toMatchObject({ bestMoveUci: 'e7e5' });
  });

  it('gives up on an engine that stops answering rather than hanging the board', async () => {
    const { transport, engine } = await ready();
    transport.silent = true;
    vi.useFakeTimers();

    const search = engine.search(START_FEN, BOT_MOVE_TIME_MS);
    const assertion = expect(search).rejects.toBeInstanceOf(EngineError);
    await vi.advanceTimersByTimeAsync(60_000);

    await assertion;
  });

  it('lets the next search through after one has failed', async () => {
    const { transport, engine } = await ready();
    transport.silent = true;
    vi.useFakeTimers();

    const failing = engine.search(START_FEN, BOT_MOVE_TIME_MS);
    const rejected = expect(failing).rejects.toBeInstanceOf(EngineError);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;

    vi.useRealTimers();
    transport.silent = false;

    await expect(engine.search(START_FEN, BOT_MOVE_TIME_MS)).resolves.toMatchObject({
      bestMoveUci: 'e2e4',
    });
  });
});

describe('dispose', () => {
  it('terminates the worker', async () => {
    const { transport, engine } = await ready();
    engine.dispose();
    expect(transport.terminated).toBe(true);
  });

  it('is safe to call twice', async () => {
    const { engine } = await ready();
    engine.dispose();
    expect(() => engine.dispose()).not.toThrow();
  });

  it('fails a later search rather than waiting on a worker that is gone', async () => {
    const { engine } = await ready();
    engine.dispose();
    await expect(engine.search(START_FEN, BOT_MOVE_TIME_MS)).rejects.toBeInstanceOf(EngineError);
  });
});
