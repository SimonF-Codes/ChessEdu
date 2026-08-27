import { describe, expect, it } from 'vitest';

import type { Classification, Phase } from '@chessedu/chess';

import { summarize } from './analyze';

type Entry = {
  winPercentLoss: number;
  centipawnLoss: number;
  classification: Classification;
  phase: Phase;
};

const entry = (over: Partial<Entry> = {}): Entry => ({
  winPercentLoss: 0,
  centipawnLoss: 0,
  classification: 'good',
  phase: 'middlegame',
  ...over,
});

describe('summarize', () => {
  it('handles a side with no moves without dividing by zero', () => {
    const result = summarize([]);
    expect(result.accuracy).toBeNull();
    expect(result.acpl).toBe(0);
    expect(result.counts.blunder).toBe(0);
  });

  it('counts each classification', () => {
    const result = summarize([
      entry({ classification: 'blunder' }),
      entry({ classification: 'blunder' }),
      entry({ classification: 'mistake' }),
      entry({ classification: 'good' }),
    ]);
    expect(result.counts).toEqual({ blunder: 2, mistake: 1, inaccuracy: 0, good: 1 });
  });

  it('averages centipawn loss across the side moves', () => {
    const result = summarize([
      entry({ centipawnLoss: 10 }),
      entry({ centipawnLoss: 20 }),
      entry({ centipawnLoss: 30 }),
    ]);
    expect(result.acpl).toBe(20);
  });

  it('reports every phase, including ones the game never reached', () => {
    const result = summarize([entry({ phase: 'opening' })]);
    expect(Object.keys(result.byPhase).sort()).toEqual(['endgame', 'middlegame', 'opening']);
    expect(result.byPhase.endgame.moves).toBe(0);
    expect(result.byPhase.endgame.accuracy).toBeNull();
  });

  it('splits accuracy by phase, which is the point of the strength model', () => {
    const result = summarize([
      entry({ phase: 'opening', winPercentLoss: 0 }),
      entry({ phase: 'opening', winPercentLoss: 0 }),
      entry({ phase: 'endgame', winPercentLoss: 40, classification: 'blunder' }),
    ]);

    expect(result.byPhase.opening.accuracy).toBeGreaterThan(95);
    expect(result.byPhase.endgame.accuracy).toBeLessThan(50);
    expect(result.byPhase.endgame.blunders).toBe(1);
    expect(result.byPhase.opening.blunders).toBe(0);
  });

  it('counts moves per phase', () => {
    const result = summarize([
      entry({ phase: 'opening' }),
      entry({ phase: 'middlegame' }),
      entry({ phase: 'middlegame' }),
    ]);
    expect(result.byPhase.opening.moves).toBe(1);
    expect(result.byPhase.middlegame.moves).toBe(2);
  });
});
