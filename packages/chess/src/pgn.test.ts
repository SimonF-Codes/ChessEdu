import { describe, expect, it } from 'vitest';

import { normalizeGame, parseClockToMs, resultFor } from './pgn';
import type { ChessComGame } from './pgn';

const PGN = [
  '[Event "Live Chess"]',
  '[Site "Chess.com"]',
  '[Date "2026.08.01"]',
  '[White "jrfx99"]',
  '[Black "someopponent"]',
  '[Result "1-0"]',
  '[ECO "C50"]',
  '[ECOUrl "https://www.chess.com/openings/Italian-Game"]',
  '[TimeControl "180"]',
  '[Termination "jrfx99 won by resignation"]',
  '',
  '1. e4 {[%clk 0:03:00]} 1... e5 {[%clk 0:02:59.5]} 2. Nf3 {[%clk 0:02:58.1]}',
  '2... Nc6 {[%clk 0:02:57]} 3. Bc4 {[%clk 0:02:55.9]} 1-0',
  '',
].join('\n');

const GAME: ChessComGame = {
  url: 'https://www.chess.com/game/live/1234567890',
  pgn: PGN,
  time_control: '180',
  time_class: 'blitz',
  rated: true,
  rules: 'chess',
  end_time: 1_785_000_000,
  eco: 'https://www.chess.com/openings/Italian-Game',
  white: { username: 'jrfx99', rating: 1240, result: 'win' },
  black: { username: 'someopponent', rating: 1255, result: 'resigned' },
};

describe('parseClockToMs', () => {
  it('parses hours, minutes and seconds', () => {
    expect(parseClockToMs('0:03:00')).toBe(180_000);
  });

  it('parses tenths of a second', () => {
    expect(parseClockToMs('0:02:59.5')).toBe(179_500);
  });

  it('parses a long time control', () => {
    expect(parseClockToMs('1:30:00')).toBe(5_400_000);
  });

  it('returns null for something that is not a clock', () => {
    expect(parseClockToMs('nonsense')).toBeNull();
  });
});

describe('resultFor', () => {
  it('reads a win', () => {
    expect(resultFor('win')).toBe('win');
  });

  it.each(['resigned', 'checkmated', 'timeout', 'abandoned'])('reads %s as a loss', (raw) => {
    expect(resultFor(raw)).toBe('loss');
  });

  it.each(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'])(
    'reads %s as a draw',
    (raw) => {
      expect(resultFor(raw)).toBe('draw');
    },
  );

  it('falls back to a loss for an unrecognised termination', () => {
    expect(resultFor('something-new-chesscom-added')).toBe('loss');
  });
});

describe('normalizeGame', () => {
  it('derives a stable id from the game url', () => {
    expect(normalizeGame(GAME, 'jrfx99').platformGameId).toBe('1234567890');
  });

  it('records which colour the user had, case-insensitively', () => {
    expect(normalizeGame(GAME, 'JRFX99').userColor).toBe('w');
    expect(normalizeGame(GAME, 'someopponent').userColor).toBe('b');
  });

  it('records the result from the user perspective', () => {
    expect(normalizeGame(GAME, 'jrfx99').userResult).toBe('win');
    expect(normalizeGame(GAME, 'someopponent').userResult).toBe('loss');
  });

  it('records the opponent rating for the strength model', () => {
    const game = normalizeGame(GAME, 'jrfx99');
    expect(game.userRating).toBe(1240);
    expect(game.opponentRating).toBe(1255);
    expect(game.opponentUsername).toBe('someopponent');
  });

  it('converts the end time to a date', () => {
    expect(normalizeGame(GAME, 'jrfx99').playedAt.toISOString()).toBe(
      new Date(1_785_000_000 * 1000).toISOString(),
    );
  });

  it('keeps the ECO code and the opening url', () => {
    const game = normalizeGame(GAME, 'jrfx99');
    expect(game.eco).toBe('C50');
    expect(game.ecoUrl).toBe('https://www.chess.com/openings/Italian-Game');
  });

  it('extracts every move in order with SAN and UCI', () => {
    const { moves } = normalizeGame(GAME, 'jrfx99');
    expect(moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    expect(moves.map((m) => m.uci)).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']);
  });

  it('numbers plies from 1 and alternates colour', () => {
    const { moves } = normalizeGame(GAME, 'jrfx99');
    expect(moves.map((m) => m.ply)).toEqual([1, 2, 3, 4, 5]);
    expect(moves.map((m) => m.color)).toEqual(['w', 'b', 'w', 'b', 'w']);
  });

  it('attaches the clock left after each move, for time-trouble analysis', () => {
    const { moves } = normalizeGame(GAME, 'jrfx99');
    expect(moves.map((m) => m.clockMs)).toEqual([180_000, 179_500, 178_100, 177_000, 175_900]);
  });

  it('records the position before each move, so analysis can resume mid-game', () => {
    const { moves } = normalizeGame(GAME, 'jrfx99');
    expect(moves[0]!.fenBefore).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(moves[1]!.fenBefore).toContain('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b');
  });

  it('counts the moves', () => {
    expect(normalizeGame(GAME, 'jrfx99').moveCount).toBe(5);
  });

  it('throws when the user did not play in the game, rather than guessing a colour', () => {
    expect(() => normalizeGame(GAME, 'a-third-party')).toThrow(/did not play/i);
  });
});

describe('normalizeGame with a set-up position', () => {
  // Chess.com daily and themed games can start from a given position: the PGN carries
  // [SetUp "1"] + [FEN ...] and the movetext begins mid-game. Found against the live API —
  // two of Hikaru's 2014 daily games are Richter-Veresov themed openings.
  const SETUP_PGN = [
    '[Event "Richter-Veresov Attack (Rated)"]',
    '[Site "Chess.com"]',
    '[White "AMFYOYO"]',
    '[Black "Hikaru"]',
    '[Result "0-1"]',
    '[SetUp "1"]',
    '[FEN "rnbqkb1r/ppp1pppp/5n2/3p2B1/3P4/2N5/PPP1PPPP/R2QKBNR b KQkq - 4 3"]',
    '[ECO "D00"]',
    '[TimeControl "1/259200"]',
    '',
    '3... c6 4. f3 Qb6 5. e4 dxe4 0-1',
    '',
  ].join('\n');

  const SETUP_GAME: ChessComGame = {
    url: 'https://www.chess.com/game/daily/86709136',
    pgn: SETUP_PGN,
    time_control: '1/259200',
    time_class: 'daily',
    rated: true,
    rules: 'chess',
    end_time: 1_395_628_369,
    white: { username: 'AMFYOYO', rating: 1863, result: 'resigned' },
    black: { username: 'Hikaru', rating: 2296, result: 'win' },
  };

  it('starts from the FEN rather than the initial position', () => {
    const game = normalizeGame(SETUP_GAME, 'Hikaru');
    expect(game.moves[0]!.fenBefore).toBe(
      'rnbqkb1r/ppp1pppp/5n2/3p2B1/3P4/2N5/PPP1PPPP/R2QKBNR b KQkq - 4 3',
    );
  });

  it('parses the moves that follow, which fail from the initial position', () => {
    const { moves } = normalizeGame(SETUP_GAME, 'Hikaru');
    expect(moves.map((m) => m.san)).toEqual(['c6', 'f3', 'Qb6', 'e4', 'dxe4']);
  });

  it('numbers plies from the real position in the game, not from one', () => {
    // The FEN says move 3 with Black to play, so this is ply 6.
    const { moves } = normalizeGame(SETUP_GAME, 'Hikaru');
    expect(moves[0]!.ply).toBe(6);
    expect(moves.map((m) => m.ply)).toEqual([6, 7, 8, 9, 10]);
  });

  it('gets the colours right for a game starting on Black', () => {
    const { moves } = normalizeGame(SETUP_GAME, 'Hikaru');
    expect(moves.map((m) => m.color)).toEqual(['b', 'w', 'b', 'w', 'b']);
  });

  it('still reads the result from the user perspective', () => {
    expect(normalizeGame(SETUP_GAME, 'Hikaru').userResult).toBe('win');
  });

  it('ignores a FEN header when SetUp is not set, since the game began normally', () => {
    const pgn = SETUP_PGN.replace('[SetUp "1"]\n', '').replace(
      '3... c6 4. f3 Qb6 5. e4 dxe4 0-1',
      '1. e4 e5 1-0',
    );
    const game = normalizeGame({ ...SETUP_GAME, pgn }, 'Hikaru');
    expect(game.moves[0]!.fenBefore).toBe(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
    expect(game.moves[0]!.ply).toBe(1);
  });

  it('falls back to the initial position when the FEN is unusable', () => {
    const pgn = SETUP_PGN.replace(
      'rnbqkb1r/ppp1pppp/5n2/3p2B1/3P4/2N5/PPP1PPPP/R2QKBNR b KQkq - 4 3',
      'not-a-fen',
    ).replace('3... c6 4. f3 Qb6 5. e4 dxe4 0-1', '1. e4 e5 1-0');
    const game = normalizeGame({ ...SETUP_GAME, pgn }, 'Hikaru');
    expect(game.moves.map((m) => m.san)).toEqual(['e4', 'e5']);
  });
});
