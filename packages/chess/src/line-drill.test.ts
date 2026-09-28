import { describe, expect, it } from 'vitest';

import {
  type DrillLine,
  type LineAttemptRecord,
  type PlyAttempt,
  type PlyResult,
  MAX_PLY_ELAPSED_MS,
  learnerPlies,
  lineOutcome,
  plyLabel,
  normaliseAttempt,
  selectNextLine,
  summariseLineHistory,
} from './line-drill';
import { QUICK_SOLVE_MS } from './srs';

/** 1.e4 e5 2.Nf3 Nc6 3.c3 d5 4.Qa4 — White to learn: plies 1, 3, 5, 7. */
const LINE: DrillLine = {
  learnerColor: 'w',
  plies: [
    { ply: 1, color: 'w', san: 'e4' },
    { ply: 2, color: 'b', san: 'e5' },
    { ply: 3, color: 'w', san: 'Nf3' },
    { ply: 4, color: 'b', san: 'Nc6' },
    { ply: 5, color: 'w', san: 'c3' },
    { ply: 6, color: 'b', san: 'd5' },
    { ply: 7, color: 'w', san: 'Qa4' },
  ],
};

const LEARNER_PLIES = [1, 3, 5, 7];

function attempt(results: PlyResult[], elapsedMs = 2_000): PlyAttempt[] {
  return results.map((result, index) => ({
    ply: LEARNER_PLIES[index]!,
    result,
    elapsedMs,
    wrongUci: result === 'first_try' ? [] : ['a2a3'],
  }));
}

const clean = (): PlyAttempt[] => attempt(['first_try', 'first_try', 'first_try', 'first_try']);

describe('plyLabel', () => {
  it('numbers White moves "n." and Black moves "n..."', () => {
    expect(plyLabel(1, 'e4')).toBe('1.e4');
    expect(plyLabel(2, 'e5')).toBe('1...e5');
    expect(plyLabel(7, 'Qa4')).toBe('4.Qa4');
    expect(plyLabel(10, 'Nf6')).toBe('5...Nf6');
  });
});

describe('learnerPlies', () => {
  it('returns only the moves the learner has to find', () => {
    expect(learnerPlies(LINE).map((p) => p.ply)).toEqual(LEARNER_PLIES);
    expect(learnerPlies({ ...LINE, learnerColor: 'b' }).map((p) => p.ply)).toEqual([2, 4, 6]);
  });
});

describe('lineOutcome — derived from the board, never self-reported', () => {
  it('is easy when every move is first try and quick', () => {
    expect(lineOutcome(clean(), 4)).toBe('easy');
  });

  it('is good when every move is first try but one was slow', () => {
    const plies = clean();
    plies[2] = { ...plies[2]!, elapsedMs: QUICK_SOLVE_MS };
    expect(lineOutcome(plies, 4)).toBe('good');
  });

  it('is hard when any move needed a second attempt', () => {
    expect(lineOutcome(attempt(['first_try', 'second_try', 'first_try', 'first_try']), 4)).toBe(
      'hard',
    );
  });

  it('is again when any move was revealed, however clean the rest', () => {
    expect(lineOutcome(attempt(['first_try', 'first_try', 'first_try', 'revealed']), 4)).toBe(
      'again',
    );
  });

  it('is again when the line was abandoned', () => {
    expect(lineOutcome(attempt(['first_try', 'abandoned', 'abandoned', 'abandoned']), 4)).toBe(
      'again',
    );
  });

  it('is again when a reveal and a second try are both present — the worst wins', () => {
    expect(lineOutcome(attempt(['second_try', 'revealed', 'first_try', 'first_try']), 4)).toBe(
      'again',
    );
  });

  it('is again when the attempt covers fewer moves than the line has', () => {
    expect(lineOutcome(clean().slice(0, 3), 4)).toBe('again');
  });
});

describe('normaliseAttempt', () => {
  it('accepts one entry per learner move, in order', () => {
    expect(normaliseAttempt(LINE, clean())).toEqual(clean());
  });

  it('rejects an attempt that skips a move', () => {
    expect(normaliseAttempt(LINE, clean().slice(0, 3))).toBeNull();
  });

  it('rejects an attempt that claims an opponent’s ply', () => {
    const plies = clean();
    plies[1] = { ...plies[1]!, ply: 4 };
    expect(normaliseAttempt(LINE, plies)).toBeNull();
  });

  it('rejects an unknown result', () => {
    const plies = clean() as { result: string }[];
    plies[0]!.result = 'perfect';
    expect(normaliseAttempt(LINE, plies as PlyAttempt[])).toBeNull();
  });

  it('clamps elapsed time into range, since the client clock is not trusted', () => {
    const plies = clean();
    plies[0] = { ...plies[0]!, elapsedMs: -50 };
    plies[1] = { ...plies[1]!, elapsedMs: 10 * MAX_PLY_ELAPSED_MS };
    plies[2] = { ...plies[2]!, elapsedMs: 1234.7 };
    const normalised = normaliseAttempt(LINE, plies)!;
    expect(normalised.map((p) => p.elapsedMs)).toEqual([0, MAX_PLY_ELAPSED_MS, 1235, 2000]);
  });

  it('keeps at most two wrong moves per ply, and only well-formed ones', () => {
    const plies = clean();
    plies[0] = { ...plies[0]!, result: 'revealed', wrongUci: ['a2a3', 'h2h3', 'b2b3', 'nonsense'] };
    expect(normaliseAttempt(LINE, plies)![0]!.wrongUci).toEqual(['a2a3', 'h2h3']);
  });
});

describe('summariseLineHistory', () => {
  const at = (day: number) => new Date(Date.UTC(2026, 8, day));
  const record = (day: number, plies: PlyAttempt[]): LineAttemptRecord => ({
    attemptId: `a${day}`,
    attemptedAt: at(day),
    plies,
  });

  it('says so when the line has never been tried', () => {
    const history = summariseLineHistory(LINE, []);
    expect(history.attempts).toBe(0);
    expect(history.summary).toBe('Not attempted yet.');
    expect(history.breakdown).toBeNull();
  });

  it('reports a clean run as clean', () => {
    const history = summariseLineHistory(LINE, [record(3, clean())]);
    expect(history.cleanPrefix).toBe(4);
    expect(history.breakdown).toBeNull();
    expect(history.summary).toBe('All 4 moves clean.');
  });

  it('names the move the latest attempt broke down on, and how long the clean prefix was', () => {
    const history = summariseLineHistory(LINE, [
      record(3, attempt(['first_try', 'first_try', 'second_try', 'first_try'])),
    ]);
    expect(history.cleanPrefix).toBe(2);
    expect(history.breakdown?.label).toBe('3.c3');
    expect(history.summary).toBe('First 2 moves clean — broke down at 3.c3.');
  });

  it('says a move was missed N times running when it keeps failing', () => {
    // Newest first, as the database returns them.
    const history = summariseLineHistory(LINE, [
      record(5, attempt(['first_try', 'first_try', 'first_try', 'revealed'])),
      record(4, attempt(['first_try', 'first_try', 'first_try', 'second_try'])),
      record(3, attempt(['first_try', 'first_try', 'first_try', 'revealed'])),
      record(2, clean()),
    ]);
    const qa4 = history.plies.find((p) => p.ply === 7)!;
    expect(qa4.missStreak).toBe(3);
    expect(qa4.attempts).toBe(4);
    expect(qa4.firstTry).toBe(1);
    expect(history.summary).toBe('First 3 moves clean — 4.Qa4 missed 3 times running.');
  });

  it('names the worst streak even when the latest attempt broke somewhere else', () => {
    const history = summariseLineHistory(LINE, [
      record(5, attempt(['second_try', 'first_try', 'first_try', 'revealed'])),
      record(4, attempt(['first_try', 'first_try', 'first_try', 'revealed'])),
    ]);
    expect(history.breakdown?.label).toBe('1.e4');
    expect(history.summary).toBe(
      'Broke down on the first move, 1.e4 — 4.Qa4 missed 2 times running.',
    );
  });

  it('counts per ply across every attempt it is given', () => {
    const history = summariseLineHistory(LINE, [
      record(4, attempt(['first_try', 'revealed', 'first_try', 'first_try'])),
      record(3, clean()),
    ]);
    expect(history.attempts).toBe(2);
    expect(history.plies.map((p) => [p.label, p.firstTry, p.attempts])).toEqual([
      ['1.e4', 2, 2],
      ['2.Nf3', 1, 2],
      ['3.c3', 2, 2],
      ['4.Qa4', 2, 2],
    ]);
  });
});

describe('selectNextLine', () => {
  const NOW = new Date('2026-09-28T12:00:00Z');
  const DAY_MS = 86_400_000;

  it('picks the most overdue reviewed line first', () => {
    const next = selectNextLine(
      [
        { id: 'new', key: 'a', dueAt: null },
        { id: 'late', key: 'b', dueAt: new Date(NOW.getTime() - 3 * DAY_MS) },
        { id: 'later', key: 'c', dueAt: new Date(NOW.getTime() - 5 * DAY_MS) },
      ],
      NOW,
    );
    expect(next?.id).toBe('later');
  });

  it('offers a never-tried line when nothing reviewed is due, in stable key order', () => {
    const next = selectNextLine(
      [
        { id: 'future', key: 'a', dueAt: new Date(NOW.getTime() + DAY_MS) },
        { id: 'second', key: 'z', dueAt: null },
        { id: 'first', key: 'm', dueAt: null },
      ],
      NOW,
    );
    expect(next?.id).toBe('first');
  });

  it('returns null when everything has been tried and nothing is due', () => {
    expect(
      selectNextLine([{ id: 'x', key: 'a', dueAt: new Date(NOW.getTime() + DAY_MS) }], NOW),
    ).toBeNull();
  });
});
