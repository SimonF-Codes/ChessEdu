'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { BOT_MOVE_TIME_MS, strengthOptions } from '@chessedu/chess/browser';

import { EngineError, StockfishEngine } from './stockfish-engine';
import { createWorkerTransport } from './worker-transport';

/**
 * One Stockfish worker for the lifetime of the component that asks for it.
 *
 * Loading is 7 MB of WebAssembly to fetch and compile, so the engine starts as soon as the
 * page mounts rather than on the first move, and the caller gets a status to render while it
 * does.
 */

export type EngineStatus = 'loading' | 'ready' | 'error';

export interface UseEngine {
  status: EngineStatus;
  /** Set when status is 'error'. */
  error: string | null;
  /** Reset the engine for a new game, capped at this rating. */
  newGame: (elo: number) => Promise<void>;
  /** The move the bot plays here, in UCI. Null when it has none. */
  bestMove: (fen: string) => Promise<string | null>;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'the engine stopped responding';

export function useEngine({ log = false }: { log?: boolean } = {}): UseEngine {
  const [status, setStatus] = useState<EngineStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const engineRef = useRef<StockfishEngine | null>(null);

  useEffect(() => {
    let live = true;
    const fail = (cause: unknown) => {
      if (!live) return;
      setError(message(cause));
      setStatus('error');
    };

    let engine: StockfishEngine;
    try {
      engine = new StockfishEngine(
        createWorkerTransport({
          onLine: log ? (line) => console.log('[engine]', line) : undefined,
          onError: fail,
        }),
      );
    } catch (cause) {
      fail(cause);
      return;
    }

    engineRef.current = engine;
    engine.init().then(() => {
      if (live) setStatus('ready');
    }, fail);

    return () => {
      live = false;
      engineRef.current = null;
      engine.dispose();
    };
  }, [log]);

  const newGame = useCallback(async (elo: number) => {
    await engineRef.current?.newGame(strengthOptions(elo));
  }, []);

  const bestMove = useCallback(async (fen: string) => {
    const engine = engineRef.current;
    if (!engine) throw new EngineError('the engine is not running');
    const { bestMoveUci } = await engine.search(fen, BOT_MOVE_TIME_MS);
    return bestMoveUci;
  }, []);

  return { status, error, newGame, bestMove };
}
