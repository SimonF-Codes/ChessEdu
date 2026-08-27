import { describe, expect, it } from 'vitest';

import { isSettledMonth, parseArchiveUrl } from './ingest';

describe('parseArchiveUrl', () => {
  it('reads the year and month', () => {
    expect(parseArchiveUrl('https://api.chess.com/pub/player/jrfx99/games/2026/08')).toEqual({
      year: 2026,
      month: 8,
    });
  });

  it('returns null for anything else', () => {
    expect(parseArchiveUrl('https://api.chess.com/pub/player/jrfx99/games/archives')).toBeNull();
  });
});

describe('isSettledMonth', () => {
  const now = new Date('2026-08-27T00:00:00Z');

  it('treats an earlier month this year as settled', () => {
    expect(isSettledMonth({ year: 2026, month: 7 }, now)).toBe(true);
  });

  it('treats a previous year as settled', () => {
    expect(isSettledMonth({ year: 2025, month: 12 }, now)).toBe(true);
  });

  it('never treats the current month as settled, since games are still being played', () => {
    expect(isSettledMonth({ year: 2026, month: 8 }, now)).toBe(false);
  });

  it('does not treat a future month as settled', () => {
    expect(isSettledMonth({ year: 2026, month: 9 }, now)).toBe(false);
  });

  it('handles the year boundary', () => {
    const january = new Date('2027-01-03T00:00:00Z');
    expect(isSettledMonth({ year: 2026, month: 12 }, january)).toBe(true);
    expect(isSettledMonth({ year: 2027, month: 1 }, january)).toBe(false);
  });
});
