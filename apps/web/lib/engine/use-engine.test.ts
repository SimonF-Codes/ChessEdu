// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BOT_LEVELS, type BotLevel } from '@chessedu/chess/browser';

import type { MoveProvider, MoveProviderOptions } from './move-provider';
import { useEngine } from './use-engine';

/**
 * The proof that the seam is a seam.
 *
 * ADR 0005 puts Maia behind this hook: a network with no protocol to speak, no search to
 * lengthen and no `UCI_Elo` to set. Nothing of that is buildable yet, so what is tested here is
 * the claim the refactor actually makes — that `use-engine` drives *anything* implementing
 * MoveProvider, and adding Maia is a new file rather than a change to this one.
 *
 * ScriptedProvider is that second implementation. It is not a fake Stockfish; it is not an
 * engine at all. It returns moves from a list. If this suite passes while
 * stockfish-provider.test.ts also passes, the interface is carrying both.
 */
class ScriptedProvider implements MoveProvider {
  readonly id = 'scripted';
  /** The rungs it was told to start a game at — the whole rung, not a number. */
  readonly games: BotLevel[] = [];
  /** The positions it was asked about, in order. */
  readonly asked: string[] = [];
  initialised = false;
  disposed = false;
  /** Played in order. Once exhausted, it has no move — the stalemate-shaped case. */
  moves: string[] = ['d7d5'];
  /** When set, `init` rejects with it: the weights did not load. */
  initFailure: Error | null = null;

  async init(): Promise<void> {
    if (this.initFailure) throw this.initFailure;
    this.initialised = true;
  }

  async newGame(level: BotLevel): Promise<void> {
    this.games.push(level);
  }

  async chooseMove(fen: string): Promise<string | null> {
    this.asked.push(fen);
    return this.moves.shift() ?? null;
  }

  dispose(): void {
    this.disposed = true;
  }
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const CLUB = BOT_LEVELS[2]!;

/** One stable factory per render, so the hook does not rebuild the provider on every render. */
function renderEngine(provider: MoveProvider = new ScriptedProvider()) {
  const createProvider = () => provider;
  return renderHook(() => useEngine({ createProvider }));
}

async function readyEngine(provider: ScriptedProvider = new ScriptedProvider()) {
  const rendered = renderEngine(provider);
  await waitFor(() => expect(rendered.result.current.status).toBe('ready'));
  return { provider, ...rendered };
}

afterEach(cleanup);

describe('driving a provider that is not an engine', () => {
  it('is loading until the provider has initialised, then ready', async () => {
    const provider = new ScriptedProvider();
    const { result } = renderEngine(provider);

    expect(result.current.status).toBe('loading');

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(provider.initialised).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('hands the provider the whole rung, leaving it to decide what strength means', async () => {
    const { provider, result } = await readyEngine();

    await result.current.newGame(CLUB);

    // Not `CLUB.elo`: a network picks a weights file, and `UCI_Elo` would mean nothing to it.
    expect(provider.games).toEqual([CLUB]);
  });

  it('plays the move the provider chose, from the position it was given', async () => {
    const { provider, result } = await readyEngine();

    await expect(result.current.chooseMove(START_FEN)).resolves.toBe('d7d5');
    expect(provider.asked).toEqual([START_FEN]);
  });

  it('passes on "no move here" rather than inventing one', async () => {
    const provider = new ScriptedProvider();
    provider.moves = [];
    const { result } = await readyEngine(provider);

    await expect(result.current.chooseMove(START_FEN)).resolves.toBeNull();
  });

  it('lets the provider go when the component does', async () => {
    const { provider, unmount } = await readyEngine();

    unmount();

    expect(provider.disposed).toBe(true);
  });
});

describe('a provider that does not come up', () => {
  it('reports a failure to load rather than waiting forever', async () => {
    const provider = new ScriptedProvider();
    provider.initFailure = new Error('the weights did not download');
    const { result } = renderEngine(provider);

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('the weights did not download');
  });

  it('reports one that throws on construction', async () => {
    // Stable reference: a fresh factory on every render would rebuild the provider on every
    // render, which is a different bug from the one under test.
    const createProvider = () => {
      throw new Error('no WebGPU and no fallback');
    };
    const { result } = renderHook(() => useEngine({ createProvider }));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('no WebGPU and no fallback');
  });

  it('reports one that fails asynchronously, outside any call being awaited', async () => {
    let report: ((error: Error) => void) | undefined;
    const provider = new ScriptedProvider();
    const createProvider = (options?: MoveProviderOptions) => {
      report = options?.onError;
      return provider;
    };
    const { result } = renderHook(() => useEngine({ createProvider }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    report?.(new Error('the worker died'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('the worker died');
  });

  it('refuses a move when there is no provider at all', async () => {
    const { result, unmount } = await readyEngine();
    const { chooseMove } = result.current;

    unmount();

    await expect(chooseMove(START_FEN)).rejects.toThrow('the engine is not running');
  });
});
