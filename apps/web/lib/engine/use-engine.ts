'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { BotLevel } from '@chessedu/chess/browser';

import { createDefaultProvider } from './default-provider';
import { type MoveProvider, MoveProviderError, type MoveProviderFactory } from './move-provider';

/**
 * One opponent for the lifetime of the component that asks for it.
 *
 * Loading is megabytes to fetch and compile — WebAssembly for Stockfish, weights for anything
 * ADR 0005 brings later — so the provider starts as soon as the page mounts rather than on the
 * first move, and the caller gets a status to render while it does.
 *
 * Nothing in this file knows which opponent it has. It holds a `MoveProvider` and calls four
 * methods on it; a protocol, a search, a network are all below that seam. If a name like
 * Stockfish or a command like `go` ever appears here, the seam has moved back up. See §10.1 of
 * docs/architecture.md.
 */

export type EngineStatus = 'loading' | 'ready' | 'error';

export interface UseEngine {
  status: EngineStatus;
  /** Set when status is 'error'. */
  error: string | null;
  /** Reset for a new game at this rung. What the rung means is the provider's business. */
  newGame: (level: BotLevel) => Promise<void>;
  /** The move the bot plays here, in UCI. Null when it has none. */
  chooseMove: (fen: string) => Promise<string | null>;
}

export interface UseEngineOptions {
  /** Mirror the provider's diagnostics to the console — the `?engineLog=1` switch. */
  log?: boolean;
  /**
   * Which provider to run. Production takes the default; tests pass a scripted one to prove
   * this hook drives anything satisfying the interface. Must be a stable reference — the
   * provider is rebuilt when it changes.
   */
  createProvider?: MoveProviderFactory;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'the engine stopped responding';

export function useEngine({
  log = false,
  createProvider = createDefaultProvider,
}: UseEngineOptions = {}): UseEngine {
  const [status, setStatus] = useState<EngineStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const providerRef = useRef<MoveProvider | null>(null);

  useEffect(() => {
    let live = true;
    const fail = (cause: unknown) => {
      if (!live) return;
      setError(message(cause));
      setStatus('error');
    };

    let provider: MoveProvider;
    try {
      provider = createProvider({
        onLog: log ? (line) => console.log('[engine]', line) : undefined,
        onError: fail,
      });
    } catch (cause) {
      fail(cause);
      return;
    }

    providerRef.current = provider;
    provider.init().then(() => {
      if (live) setStatus('ready');
    }, fail);

    return () => {
      live = false;
      providerRef.current = null;
      provider.dispose();
    };
  }, [log, createProvider]);

  const newGame = useCallback(async (level: BotLevel) => {
    await providerRef.current?.newGame(level);
  }, []);

  const chooseMove = useCallback(async (fen: string) => {
    const provider = providerRef.current;
    if (!provider) throw new MoveProviderError('the engine is not running');
    return provider.chooseMove(fen);
  }, []);

  return { status, error, newGame, chooseMove };
}
