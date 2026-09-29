import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import type { PlyFacts } from '../lines';
import {
  attacksPiece,
  behindBest,
  captures,
  castles,
  checkmate,
  defendsHanging,
  develops,
  fork,
  givesCheck,
  occupiesCentre,
  oneOfSeveral,
  onlyLegalMove,
  onlyMove,
  opensLine,
  pawnBreak,
  pin,
  preparesBreak,
  winsMaterial,
} from './detectors';
import { contextFor } from './explain';
import type { MoveContext } from './types';

/**
 * Every detector on known positions: one where its claim is true, and at least one where a
 * careless version would fire and must not. The tutor is only as honest as these.
 */

const START = new Chess().fen();

/** The context for `san`, played after the SAN moves in `path` from the start position. */
function after(path: string, san: string, facts: PlyFacts | null = null): MoveContext {
  const board = new Chess();
  let previous: { fenBefore: string; san: string } | null = null;
  for (const move of path.split(' ').filter(Boolean)) {
    previous = { fenBefore: board.fen(), san: move };
    board.move(move);
  }
  return contextFor({ fenBefore: board.fen(), san, previous, facts });
}

/** The context for `san` from a FEN. */
function at(fen: string, san: string, facts: PlyFacts | null = null): MoveContext {
  return contextFor({ fenBefore: fen, san, facts });
}

function facts(partial: Partial<PlyFacts>): PlyFacts {
  return { scoreCp: 0, mateIn: null, pv: [], gapCp: null, ...partial };
}

const PONZIANI = 'e4 e5 Nf3 Nc6 c3';

describe('positional detectors', () => {
  describe('onlyLegalMove', () => {
    it('fires when the king has one escape', () => {
      // White king a1 in check from the rook on b2; taking it is the only move.
      expect(onlyLegalMove(at('k7/8/8/8/8/8/1r6/K7 w - - 0 1', 'Kxb2'))?.text).toBe(
        'the only legal move',
      );
    });

    it('does not fire from the start position', () => {
      expect(onlyLegalMove(at(START, 'e4'))).toBeNull();
    });
  });

  describe('checkmate', () => {
    it('fires on fool’s mate', () => {
      expect(checkmate(after('f3 e5 g4', 'Qh4#'))?.id).toBe('checkmate');
    });

    it('does not fire on a check that can be answered', () => {
      expect(checkmate(after('e4 f6', 'Qh5+'))).toBeNull();
    });
  });

  describe('castles', () => {
    it('fires on castling kingside and says so', () => {
      const motif = castles(after('e4 e5 Nf3 Nc6 Bc4 Bc5', 'O-O'));
      expect(motif?.text).toMatch(/^castles kingside/);
    });

    it('fires on castling queenside', () => {
      const motif = castles(at('r3k3/8/8/8/8/8/8/R3K3 w Q - 0 1', 'O-O-O'));
      expect(motif?.text).toMatch(/^castles queenside/);
    });

    it('does not fire on a king step', () => {
      expect(castles(at('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'Kf1'))).toBeNull();
    });
  });

  describe('develops', () => {
    it('fires on a knight’s first move', () => {
      expect(develops(after('e4 e5', 'Nf3'))?.text).toBe('develops the knight to f3');
    });

    it('fires on a bishop’s first move, for Black too', () => {
      expect(develops(after('e4 e5 Nf3', 'Bc5'))?.text).toBe('develops the bishop to c5');
    });

    it('does not fire on a knight’s second move', () => {
      expect(develops(after('e4 e5 Nf3 Nc6', 'Ng5'))).toBeNull();
    });

    it('does not call an early queen move development', () => {
      expect(develops(after('e4 e5', 'Qh5'))).toBeNull();
    });
  });

  describe('occupiesCentre', () => {
    it('fires on a pawn to e4', () => {
      expect(occupiesCentre(at(START, 'e4'))?.text).toBe('puts a pawn on e4, in the centre');
    });

    it('names a piece that lands in the centre', () => {
      expect(occupiesCentre(after('e4 e5 Nf3 Nc6 d4 exd4', 'Nxd4'))?.text).toBe(
        'brings the knight to d4, in the centre',
      );
    });

    it('does not fire on a flank pawn', () => {
      expect(occupiesCentre(at(START, 'a4'))).toBeNull();
    });
  });

  describe('captures', () => {
    it('names what was taken and where', () => {
      expect(captures(after(`${PONZIANI} d5`, 'exd5'))?.text).toBe('takes the pawn on d5');
    });

    it('calls taking back on the same square a recapture', () => {
      const motif = captures(after(`${PONZIANI} Nf6 d4 exd4`, 'cxd4'));
      expect(motif).toMatchObject({ id: 'recaptures', text: 'recaptures on d4' });
    });

    it('does not call a capture on another square a recapture', () => {
      // 3.Nxe5 took on e5; 3...dxe4 takes on e4.
      expect(captures(after('e4 e5 Nf3 d5 Nxe5', 'dxe4'))).toMatchObject({
        id: 'captures',
        text: 'takes the pawn on e4',
      });
    });

    it('names an en passant capture without the empty square it lands on', () => {
      expect(captures(after('e4 a6 e5 d5', 'exd6'))?.text).toBe('takes the pawn');
    });

    it('does not fire on a quiet move', () => {
      expect(captures(at(START, 'e4'))).toBeNull();
    });
  });

  describe('givesCheck', () => {
    it('fires on a check', () => {
      expect(givesCheck(after('e4 f6', 'Qh5+'))?.text).toBe('gives check');
    });

    it('leaves mate to `checkmate`', () => {
      expect(givesCheck(after('f3 e5 g4', 'Qh4#'))).toBeNull();
    });
  });

  describe('pawnBreak', () => {
    it('fires on 4.d4 in the Ponziani, which strikes at e5', () => {
      expect(pawnBreak(after(`${PONZIANI} Nf6`, 'd4'))?.text).toBe(
        'a pawn break: the pawn on d4 challenges the pawn on e5',
      );
    });

    it('fires on Black’s 3...d5, which strikes at e4', () => {
      expect(pawnBreak(after(PONZIANI, 'd5'))?.text).toMatch(/challenges the pawn on e4$/);
    });

    it('does not fire on 3.c3, which prepares a break but is not one', () => {
      expect(pawnBreak(after('e4 e5 Nf3 Nc6', 'c3'))).toBeNull();
    });

    it('does not fire on a pawn capture', () => {
      expect(pawnBreak(after(`${PONZIANI} d5`, 'exd5'))).toBeNull();
    });

    it('does not fire on 1.e4, which touches no pawn', () => {
      expect(pawnBreak(at(START, 'e4'))).toBeNull();
    });
  });

  describe('opensLine', () => {
    it('fires on 1.e4, opening the diagonal for the bishop on f1', () => {
      expect(opensLine(at(START, 'e4'))?.text).toBe('opens the diagonal for the bishop on f1');
    });

    it('does not fire on 1.Nf3, which frees one square for the rook', () => {
      expect(opensLine(at(START, 'Nf3'))).toBeNull();
    });

    it('does not count the rook moved by castling as opened', () => {
      expect(opensLine(after('e4 e5 Nf3 Nc6 Bc4 Bc5', 'O-O'))).toBeNull();
    });
  });

  describe('attacksPiece', () => {
    it('fires on 2.Nf3, which hits the undefended pawn on e5', () => {
      expect(attacksPiece(after('e4 e5', 'Nf3'))?.text).toBe('attacks the pawn on e5');
    });

    it('fires on a knight hitting a queen, defended or not', () => {
      expect(attacksPiece(after('e4 d5 exd5 Qxd5', 'Nc3'))?.text).toBe('attacks the queen on d5');
    });

    it('does not fire on a bishop eyeing a defended pawn', () => {
      // 3.Bc4 looks at f7, but the king defends it and a pawn is worth less than a bishop.
      expect(attacksPiece(after('e4 e5 Nf3 Nc6', 'Bc4'))).toBeNull();
    });

    it('does not fire on a defended piece of equal value', () => {
      // 3.Bb5 hits the knight on c6, which the b7 and d7 pawns defend.
      expect(attacksPiece(after('e4 e5 Nf3 Nc6', 'Bb5'))).toBeNull();
    });
  });

  describe('defendsHanging', () => {
    it('fires on 2...Nc6, which defends the attacked pawn on e5', () => {
      expect(defendsHanging(after('e4 e5 Nf3', 'Nc6'))?.text).toBe('defends the pawn on e5');
    });

    it('fires on 2...d6, the pawn defending instead', () => {
      expect(defendsHanging(after('e4 e5 Nf3', 'd6'))?.text).toBe('defends the pawn on e5');
    });

    it('does not fire on 2...Nf6, which leaves e5 hanging', () => {
      expect(defendsHanging(after('e4 e5 Nf3', 'Nf6'))).toBeNull();
    });

    it('does not fire when nothing was hanging', () => {
      expect(defendsHanging(after('e4 e5 Nf3 Nc6', 'Bc4'))).toBeNull();
    });
  });

  describe('pin', () => {
    it('fires on 4.Qa4 in the 3...d5 Ponziani, pinning the knight to the king', () => {
      expect(pin(after(`${PONZIANI} d5`, 'Qa4'))?.text).toBe('pins the knight on c6 to the king');
    });

    it('fires on a pin to a piece worth more than the one in front', () => {
      // Bb2 lines up through the knight on e5 onto the queen on f6.
      expect(pin(at('7k/8/5q2/4n3/8/8/8/K1B5 w - - 0 1', 'Bb2'))?.text).toBe(
        'pins the knight on e5 to the queen',
      );
    });

    it('does not fire when the piece behind is worth less than the one in front', () => {
      // Bb2 through the rook on e5 onto a knight on f6: the rook can step away and lose nothing.
      expect(pin(at('7k/8/5n2/4r3/8/8/8/K1B5 w - - 0 1', 'Bb2'))).toBeNull();
    });

    it('does not fire on 3.Bb5, where a pawn stands behind the knight', () => {
      expect(pin(after('e4 e5 Nf3 Nc6', 'Bb5'))).toBeNull();
    });

    it('does not fire for a piece that does not slide', () => {
      expect(pin(after('e4 e5', 'Nf3'))).toBeNull();
    });
  });

  describe('fork', () => {
    it('fires on a knight hitting king and rook', () => {
      expect(fork(at('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'Nc7+'))?.text).toBe(
        'forks the king and the rook',
      );
    });

    it('fires on a queen check that also hits a loose bishop', () => {
      expect(fork(at('4k3/8/8/1b6/8/8/8/3QK3 w - - 0 1', 'Qe2+'))?.text).toBe(
        'forks the king and the bishop',
      );
    });

    it('does not fire on a plain check', () => {
      expect(fork(after('e4 f6', 'Qh5+'))).toBeNull();
    });

    it('does not fire on a single threat', () => {
      expect(fork(after('e4 e5', 'Nf3'))).toBeNull();
    });
  });
});

describe('engine detectors — they read stored facts, and say nothing without them', () => {
  const d4 = () => after(`${PONZIANI} Nf6`, 'd4', facts({ scoreCp: 30, gapCp: 180 }));

  describe('onlyMove', () => {
    it('states the stored gap when every other move is clearly worse', () => {
      expect(onlyMove(d4())?.text).toBe(
        "the engine's only good move here: its next best is 180 centipawns worse",
      );
    });

    it('does not fire below the threshold', () => {
      expect(onlyMove(after(PONZIANI, 'd5', facts({ gapCp: 99 })))).toBeNull();
    });

    it('does not fire without facts, or without a gap', () => {
      expect(onlyMove(after(`${PONZIANI} Nf6`, 'd4'))).toBeNull();
      expect(onlyMove(after(`${PONZIANI} Nf6`, 'd4', facts({ gapCp: null })))).toBeNull();
    });
  });

  describe('oneOfSeveral', () => {
    it('states the stored gap when the engine barely prefers the move', () => {
      expect(oneOfSeveral(after(PONZIANI, 'd5', facts({ gapCp: 7 })))?.text).toBe(
        "one of several good moves: the engine's next best is only 7 centipawns behind",
      );
    });

    it('says so without a number when the engine rates another move equally', () => {
      expect(oneOfSeveral(after(PONZIANI, 'd5', facts({ gapCp: 0 })))?.text).toMatch(
        /just as highly$/,
      );
    });

    it('does not fire on a clear best move, a move behind the best, or no facts', () => {
      expect(oneOfSeveral(after(PONZIANI, 'd5', facts({ gapCp: 60 })))).toBeNull();
      expect(oneOfSeveral(after(PONZIANI, 'd5', facts({ gapCp: -7 })))).toBeNull();
      expect(oneOfSeveral(after(PONZIANI, 'd5'))).toBeNull();
    });
  });

  describe('behindBest', () => {
    it('states how far a branch reply sits behind the engine’s first choice', () => {
      expect(behindBest(after(PONZIANI, 'a6', facts({ gapCp: -67 })))?.text).toBe(
        "not the engine's first choice: 67 centipawns behind its best, close enough to be worth meeting",
      );
    });

    it('does not fire on the engine’s own first choice, or without facts', () => {
      expect(behindBest(after(PONZIANI, 'd5', facts({ gapCp: 7 })))).toBeNull();
      expect(behindBest(after(PONZIANI, 'a6'))).toBeNull();
    });
  });

  describe('winsMaterial', () => {
    const FORK = '4k3/8/8/1b6/8/8/8/3QK3 w - - 0 1';

    it('fires when the stored line comes out ahead and the stored score agrees', () => {
      const ctx = at(FORK, 'Qe2+', facts({ scoreCp: 900, pv: ['e8d8', 'e2b5'] }));
      expect(winsMaterial(ctx)?.text).toBe("wins material: the engine's line comes out a piece up");
    });

    it('does not fire when the score does not agree, from the mover’s side', () => {
      const ctx = at(FORK, 'Qe2+', facts({ scoreCp: 40, pv: ['e8d8', 'e2b5'] }));
      expect(winsMaterial(ctx)).toBeNull();
    });

    it('does not fire when the stored line never collects', () => {
      const ctx = at(FORK, 'Qe2+', facts({ scoreCp: 900, pv: ['e8d8'] }));
      expect(winsMaterial(ctx)).toBeNull();
    });

    it('does not fire without facts', () => {
      expect(winsMaterial(at(FORK, 'Qe2+'))).toBeNull();
    });

    it('reads a Black score from Black’s side', () => {
      // The mirror: Black forks, the stored score is White's view, so good for Black is negative.
      const mirror = '3qk3/8/8/8/1B6/8/8/4K3 b - - 0 1';
      const good = at(mirror, 'Qe7+', facts({ scoreCp: -900, pv: ['e1d1', 'e7b4'] }));
      expect(winsMaterial(good)?.id).toBe('wins-material');
      const bad = at(mirror, 'Qe7+', facts({ scoreCp: 900, pv: ['e1d1', 'e7b4'] }));
      expect(winsMaterial(bad)).toBeNull();
    });
  });

  describe('preparesBreak', () => {
    it('fires on 3.c3 when the stored line plays d4 next move', () => {
      const ctx = after('e4 e5 Nf3 Nc6', 'c3', facts({ pv: ['g8f6', 'd2d4', 'e5d4'] }));
      expect(preparesBreak(ctx)?.text).toBe(
        "prepares d4: the engine's line plays that pawn break next move",
      );
    });

    it('looks one move further, and no further', () => {
      const soon = after('e4 e5 Nf3 Nc6', 'c3', facts({ pv: ['g8f6', 'f1c4', 'f8c5', 'd2d4'] }));
      expect(preparesBreak(soon)?.text).toMatch(/the move after$/);
      const late = after(
        'e4 e5 Nf3 Nc6',
        'c3',
        facts({ pv: ['g8f6', 'f1c4', 'f8c5', 'e1g1', 'e8g8', 'd2d4'] }),
      );
      expect(preparesBreak(late)).toBeNull();
    });

    it('does not count the opponent’s break as the mover’s', () => {
      // 3...d5 in the PV is Black's move, not White's.
      const ctx = after('e4 e5 Nf3 Nc6', 'c3', facts({ pv: ['d7d5', 'f1b5'] }));
      expect(preparesBreak(ctx)).toBeNull();
    });

    it('does not fire on a move that is itself the break', () => {
      const ctx = after(`${PONZIANI} Nf6`, 'd4', facts({ pv: ['e5d4', 'e4e5'] }));
      expect(preparesBreak(ctx)).toBeNull();
    });

    it('does not fire without facts — 3.c3 on the root has none, and the library speaks for it', () => {
      expect(preparesBreak(after('e4 e5 Nf3 Nc6', 'c3'))).toBeNull();
    });

    it('stops quietly at a stored move that is not legal', () => {
      const ctx = after('e4 e5 Nf3 Nc6', 'c3', facts({ pv: ['a1a8', 'd2d4'] }));
      expect(preparesBreak(ctx)).toBeNull();
    });
  });
});
