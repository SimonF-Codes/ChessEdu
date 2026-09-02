import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SESSION_SIZE,
  MAX_THEME_SHARE,
  THEME_PRIOR_RATE,
  type ReviewCandidate,
  candidateScore,
  overdueUrgency,
  selectReviewSession,
  themeFailureRate,
  themeFailureRates,
} from './review';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let counter = 0;

/** A due-now candidate with no review history, unless the test says otherwise. */
function candidate(overrides: Partial<ReviewCandidate> = {}): ReviewCandidate {
  counter += 1;
  return {
    id: `p${String(counter).padStart(3, '0')}`,
    themes: ['middlegame'],
    dueAt: NOW,
    intervalDays: 1,
    repetitions: 0,
    lapses: 0,
    ...overrides,
  };
}

/** A due date `days` before now, i.e. that much overdue. */
function overdueBy(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function themesOf(selection: readonly ReviewCandidate[]): string[] {
  return selection.map((item) => item.themes[0] ?? '');
}

describe('themeFailureRates', () => {
  it('smooths towards the prior, so one unlucky review cannot outrank a long bad record', () => {
    const rates = themeFailureRates([
      // One review, one lapse. A raw rate would call this 100% failure.
      candidate({ themes: ['lucky'], repetitions: 0, lapses: 1 }),
      // Fifty reviews, forty lapses. This is the theme actually worth practising.
      ...Array.from({ length: 5 }, () => candidate({ themes: ['bad'], repetitions: 2, lapses: 8 })),
    ]);

    expect(rates.get('bad')!).toBeGreaterThan(rates.get('lucky')!);
    expect(rates.get('lucky')!).toBeLessThan(1);
  });

  it('counts a theme against every puzzle that carries it', () => {
    const rates = themeFailureRates([
      candidate({ themes: ['fork', 'endgame'], repetitions: 0, lapses: 4 }),
      candidate({ themes: ['endgame'], repetitions: 4, lapses: 0 }),
    ]);

    // 'fork' sees only the failing puzzle; 'endgame' sees both, so it must sit lower.
    expect(rates.get('fork')!).toBeGreaterThan(rates.get('endgame')!);
  });

  it('gives an unreviewed theme the prior rather than a zero it has not earned', () => {
    const rates = themeFailureRates([candidate({ themes: ['fresh'] })]);
    expect(rates.get('fresh')!).toBeCloseTo(THEME_PRIOR_RATE, 10);
  });
});

describe('themeFailureRate', () => {
  it('takes the worst of a puzzle theme set: it inherits its weakest motif', () => {
    const rates = new Map([
      ['weak', 0.9],
      ['strong', 0.1],
    ]);
    expect(themeFailureRate(candidate({ themes: ['strong', 'weak'] }), rates)).toBeCloseTo(0.9, 10);
  });

  it('falls back to the prior for a puzzle with no themes at all', () => {
    expect(themeFailureRate(candidate({ themes: [] }), new Map())).toBeCloseTo(
      THEME_PRIOR_RATE,
      10,
    );
  });
});

describe('overdueUrgency', () => {
  it('is zero for a puzzle that has only just come due', () => {
    expect(overdueUrgency(candidate({ dueAt: NOW }), NOW)).toBe(0);
  });

  it('measures lateness against the interval of the puzzle, not in absolute days', () => {
    const shortInterval = candidate({ intervalDays: 1, dueAt: overdueBy(5) });
    const longInterval = candidate({ intervalDays: 100, dueAt: overdueBy(5) });
    expect(overdueUrgency(shortInterval, NOW)).toBeGreaterThan(overdueUrgency(longInterval, NOW));
  });

  it('saturates below 1, so an ancient puzzle cannot own the queue forever', () => {
    const ancient = overdueUrgency(candidate({ intervalDays: 1, dueAt: overdueBy(3_650) }), NOW);
    expect(ancient).toBeLessThan(1);
    expect(ancient).toBeGreaterThan(0.99);
  });

  it('never goes negative for a puzzle that is not due yet', () => {
    const future = candidate({ dueAt: new Date(NOW.getTime() + 10 * DAY_MS) });
    expect(overdueUrgency(future, NOW)).toBe(0);
  });
});

describe('selectReviewSession', () => {
  it('returns nothing for an empty pool', () => {
    expect(selectReviewSession([], { now: NOW })).toEqual([]);
  });

  it('never returns a puzzle that is not due yet', () => {
    const due = candidate({ dueAt: overdueBy(1) });
    const notYet = candidate({ dueAt: new Date(NOW.getTime() + DAY_MS) });
    expect(selectReviewSession([notYet, due], { now: NOW })).toEqual([due]);
  });

  it('fills at most the session size', () => {
    const pool = Array.from({ length: 40 }, () => candidate());
    expect(selectReviewSession(pool, { now: NOW })).toHaveLength(DEFAULT_SESSION_SIZE);
    expect(selectReviewSession(pool, { now: NOW, sessionSize: 4 })).toHaveLength(4);
  });

  it('puts the themes the player fails most first when urgency is equal', () => {
    const failing = Array.from({ length: 3 }, () =>
      candidate({ themes: ['endgame'], repetitions: 0, lapses: 5 }),
    );
    const solid = Array.from({ length: 3 }, () =>
      candidate({ themes: ['opening'], repetitions: 5, lapses: 0 }),
    );

    const session = selectReviewSession([...solid, ...failing], { now: NOW });

    expect(themesOf(session).slice(0, 3)).toEqual(['endgame', 'endgame', 'endgame']);
  });

  it('still surfaces a badly overdue puzzle from a theme the player is good at', () => {
    // The blend, in one assertion: weakness re-orders the queue, it does not replace it.
    const overdueButEasyTheme = candidate({
      themes: ['opening'],
      repetitions: 8,
      lapses: 0,
      intervalDays: 1,
      dueAt: overdueBy(30),
    });
    const freshButWeakTheme = candidate({
      themes: ['endgame'],
      repetitions: 0,
      lapses: 9,
      intervalDays: 1,
      dueAt: NOW,
    });

    const session = selectReviewSession([freshButWeakTheme, overdueButEasyTheme], { now: NOW });
    expect(session[0]).toBe(overdueButEasyTheme);
  });

  it('caps how much of a session one theme may take when there is an alternative', () => {
    const endgame = Array.from({ length: 8 }, () =>
      candidate({ themes: ['endgame'], repetitions: 0, lapses: 6 }),
    );
    const opening = Array.from({ length: 4 }, () =>
      candidate({ themes: ['opening'], repetitions: 6, lapses: 0 }),
    );

    const session = selectReviewSession([...endgame, ...opening], { now: NOW, sessionSize: 6 });
    const cap = Math.ceil(6 * MAX_THEME_SHARE);

    expect(session).toHaveLength(6);
    expect(themesOf(session).filter((theme) => theme === 'endgame')).toHaveLength(cap);
  });

  it('applies the cap to every theme a multi-theme puzzle carries', () => {
    const pool = [
      ...Array.from({ length: 6 }, () =>
        candidate({ themes: ['fork', 'middlegame'], repetitions: 0, lapses: 6 }),
      ),
      ...Array.from({ length: 6 }, () => candidate({ themes: ['opening'], repetitions: 6 })),
    ];

    const session = selectReviewSession(pool, { now: NOW, sessionSize: 4 });
    expect(themesOf(session).filter((theme) => theme === 'fork')).toHaveLength(
      Math.ceil(4 * MAX_THEME_SHARE),
    );
  });

  it('yields the cap rather than returning a short session when the backlog is one theme', () => {
    // A player whose whole backlog is one motif should still get a full session: the cap exists
    // to diversify where diversity exists, not to withhold practice.
    const pool = Array.from({ length: 9 }, () => candidate({ themes: ['endgame'], lapses: 3 }));
    expect(selectReviewSession(pool, { now: NOW, sessionSize: 6 })).toHaveLength(6);
  });

  it('is deterministic: the same pool in a different order gives the same session', () => {
    const pool = [
      candidate({ themes: ['endgame'], lapses: 4, dueAt: overdueBy(3) }),
      candidate({ themes: ['opening'], repetitions: 3, dueAt: overdueBy(9) }),
      candidate({ themes: ['middlegame'], lapses: 1, repetitions: 2, dueAt: overdueBy(1) }),
      candidate({ themes: ['endgame'], lapses: 2, dueAt: overdueBy(3) }),
    ];

    const forward = selectReviewSession(pool, { now: NOW, sessionSize: 3 }).map((p) => p.id);
    const reversed = selectReviewSession([...pool].reverse(), { now: NOW, sessionSize: 3 }).map(
      (p) => p.id,
    );
    expect(reversed).toEqual(forward);
  });

  it('breaks a score tie by due date, oldest first', () => {
    const older = candidate({ dueAt: overdueBy(4), intervalDays: 4 });
    const newer = candidate({ dueAt: overdueBy(2), intervalDays: 2 });
    const rates = themeFailureRates([older, newer]);

    // Same interval-relative lateness, same theme: only the due date separates them.
    expect(candidateScore(older, rates, NOW)).toBeCloseTo(candidateScore(newer, rates, NOW), 10);
    expect(selectReviewSession([newer, older], { now: NOW })[0]).toBe(older);
  });

  it('preserves the caller row type, so the database row survives selection', () => {
    const row = { ...candidate(), fen: '8/8/8/8/8/8/8/K6k w - - 0 1' };
    const [selected] = selectReviewSession([row], { now: NOW });
    expect(selected?.fen).toBe('8/8/8/8/8/8/8/K6k w - - 0 1');
  });
});
