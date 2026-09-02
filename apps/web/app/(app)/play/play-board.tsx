'use client';

import { Chess } from 'chess.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chessboard } from 'react-chessboard';

import {
  BOT_LEVELS,
  type BotLevel,
  type Color,
  DEFAULT_BOT_LEVEL,
  type Outcome,
  findBotLevel,
  outcomeOf,
  parseUciMove,
} from '@chessedu/chess/browser';

import { useEngine } from '../../../lib/engine/use-engine';

/**
 * A game against Stockfish, entirely in the browser.
 *
 * chess.js is the referee here, not the engine: legality, check and every drawing rule are
 * decided locally, and the engine is asked for a move and nothing else. The bot's move goes
 * through the same `move()` call a dragged piece does, so a bad one is rejected rather than
 * trusted. See §10 of docs/architecture.md.
 */

type SideChoice = Color | 'random';

/**
 * A render-safe view of a mutable Chess. The board is driven from this rather than from the
 * instance, so React actually sees each move.
 */
interface Position {
  fen: string;
  turn: Color;
  history: string[];
  outcome: Outcome | null;
  inCheck: boolean;
}

function snapshot(game: Chess): Position {
  return {
    fen: game.fen(),
    turn: game.turn(),
    history: game.history(),
    outcome: outcomeOf(game),
    inCheck: game.isCheck(),
  };
}

const colorName = (color: Color) => (color === 'w' ? 'White' : 'Black');

const describe = (error: unknown) =>
  error instanceof Error ? error.message : 'the engine stopped responding';

export function PlayBoard() {
  // `?engineLog=1` puts every UCI line in the console — see docs/browser-engine.md.
  const log = useMemo(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('engineLog') === '1',
    [],
  );
  const { status, error, newGame, bestMove } = useEngine({ log });

  const gameRef = useRef(new Chess());
  const [position, setPosition] = useState<Position>(() => snapshot(gameRef.current));
  const [level, setLevel] = useState<BotLevel>(DEFAULT_BOT_LEVEL);
  const [side, setSide] = useState<SideChoice>('w');
  const [playerColor, setPlayerColor] = useState<Color>('w');
  const [gameId, setGameId] = useState(0);
  const [resigned, setResigned] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  const finished = resigned || position.outcome !== null;

  /**
   * Reset the engine whenever a game starts or the level changes. Declared before the move
   * effect so `ucinewgame` is queued ahead of any search — the engine runs one command at a
   * time, so the order they are queued in is the order they happen in.
   */
  useEffect(() => {
    if (status !== 'ready') return;
    newGame(level.elo).catch((cause) => setFault(describe(cause)));
  }, [status, level, gameId, newGame]);

  /** The bot moves whenever it is the bot's turn and the game is still going. */
  useEffect(() => {
    if (status !== 'ready' || finished || position.turn === playerColor) return;

    let live = true;
    setThinking(true);

    bestMove(position.fen)
      .then((uci) => {
        if (!live) return;
        const move = uci === null ? null : parseUciMove(uci);
        if (!move) {
          setFault('the engine had no move to play here');
          return;
        }
        try {
          gameRef.current.move(move);
        } catch {
          // Trusting the engine's move blindly is how a board ends up in an impossible state.
          setFault(`the engine suggested a move that is not legal here (${uci})`);
          return;
        }
        setPosition(snapshot(gameRef.current));
      })
      .catch((cause) => {
        if (live) setFault(describe(cause));
      })
      .finally(() => {
        if (live) setThinking(false);
      });

    return () => {
      live = false;
    };
  }, [status, finished, position, playerColor, bestMove]);

  const startNewGame = useCallback(() => {
    gameRef.current = new Chess();
    setPosition(snapshot(gameRef.current));
    setPlayerColor(side === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : side);
    setResigned(false);
    setFault(null);
    setGameId((id) => id + 1);
  }, [side]);

  const takeBack = useCallback(() => {
    if (thinking) return;
    const game = gameRef.current;
    // Both plies: undoing only the bot's reply would just hand it the move again.
    game.undo();
    if (game.turn() !== playerColor) game.undo();
    setResigned(false);
    setFault(null);
    setPosition(snapshot(game));
  }, [thinking, playerColor]);

  const handleDrop = useCallback(
    (from: string, to: string): boolean => {
      const game = gameRef.current;
      if (status !== 'ready' || thinking || finished) return false;
      if (game.turn() !== playerColor) return false;

      try {
        // Always a queen: under-promotion is a rarity that is not worth a modal here.
        game.move({ from, to, promotion: 'q' });
      } catch {
        return false;
      }

      setPosition(snapshot(game));
      return true;
    },
    [status, thinking, finished, playerColor],
  );

  const message = (): string => {
    if (status === 'loading') return 'Loading Stockfish. Around 7 MB, once.';
    if (status === 'error') return `The engine did not load: ${error}`;
    if (fault) return `The engine went wrong: ${fault}`;
    if (resigned) return `You resigned. ${level.name} wins.`;
    if (position.outcome) return position.outcome.message;
    if (thinking) return `${level.name} is thinking…`;
    if (position.turn === playerColor) {
      return position.inCheck ? 'Your move — you are in check.' : 'Your move.';
    }
    return `${colorName(position.turn)} to move.`;
  };

  const pairs: { number: number; white?: string; black?: string }[] = [];
  position.history.forEach((san, index) => {
    if (index % 2 === 0) {
      pairs.push({ number: index / 2 + 1, white: san });
      return;
    }
    const last = pairs[pairs.length - 1];
    if (last) last.black = san;
  });

  const problem = status === 'error' || fault !== null;

  return (
    <div className="flex flex-col gap-8 lg:flex-row">
      <div className="w-full max-w-[520px]">
        <Chessboard
          id="play-board"
          position={position.fen}
          onPieceDrop={(from, to) => handleDrop(from, to)}
          boardOrientation={playerColor === 'w' ? 'white' : 'black'}
          arePiecesDraggable={status === 'ready' && !thinking && !finished}
          autoPromoteToQueen
          animationDuration={200}
          customBoardStyle={{ borderRadius: '0.5rem' }}
        />
      </div>

      <div className="w-full max-w-sm space-y-6">
        <p
          role="status"
          className={
            problem
              ? 'text-sm text-red-600 dark:text-red-400'
              : 'text-sm text-neutral-600 dark:text-neutral-400'
          }
        >
          {message()}
        </p>

        <div className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-neutral-500">Opponent</span>
            <select
              value={level.id}
              onChange={(event) => {
                setLevel(findBotLevel(event.target.value) ?? DEFAULT_BOT_LEVEL);
                startNewGame();
              }}
              className="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700"
            >
              {BOT_LEVELS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} · {option.elo}
                </option>
              ))}
            </select>
            <span className="block text-xs text-neutral-500">{level.blurb}</span>
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-neutral-500">You play</span>
            <select
              value={side}
              onChange={(event) => setSide(event.target.value as SideChoice)}
              className="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700"
            >
              <option value="w">White</option>
              <option value="b">Black</option>
              <option value="random">Random</option>
            </select>
            <span className="block text-xs text-neutral-500">
              Applies to the next new game. You are {colorName(playerColor)} in this one.
            </span>
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={startNewGame}
              className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              New game
            </button>
            <button
              type="button"
              onClick={takeBack}
              disabled={thinking || position.history.length === 0}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm disabled:opacity-40 dark:border-neutral-700"
            >
              Take back
            </button>
            <button
              type="button"
              onClick={() => setResigned(true)}
              disabled={finished || position.history.length === 0}
              className="rounded-lg px-4 py-2 text-sm text-red-600 disabled:opacity-40"
            >
              Resign
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <h2 className="text-xs font-medium text-neutral-500">Moves</h2>
          {pairs.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing played yet.</p>
          ) : (
            <ol className="max-h-64 overflow-y-auto text-sm tabular-nums">
              {pairs.map((pair) => (
                <li key={pair.number} className="flex gap-3 py-0.5">
                  <span className="w-6 text-neutral-400">{pair.number}.</span>
                  <span className="w-16">{pair.white}</span>
                  <span className="w-16">{pair.black ?? ''}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
