import { describe, expect, it } from 'vitest';

import {
  BOT_LEVELS,
  DEFAULT_BOT_LEVEL,
  MAX_BOT_ELO,
  MIN_BOT_ELO,
  clampBotElo,
  findBotLevel,
  strengthCommands,
  strengthOptions,
} from './bot';

describe('bot levels', () => {
  it('offers ids that are unique, so a form value picks exactly one', () => {
    const ids = BOT_LEVELS.map((level) => level.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('runs from weakest to strongest, which is the order the picker shows', () => {
    const elos = BOT_LEVELS.map((level) => level.elo);
    expect(elos).toEqual([...elos].sort((a, b) => a - b));
  });

  it('stays inside the range Stockfish honours', () => {
    for (const level of BOT_LEVELS) {
      expect(level.elo).toBeGreaterThanOrEqual(MIN_BOT_ELO);
      expect(level.elo).toBeLessThanOrEqual(MAX_BOT_ELO);
    }
  });

  it('starts at the engine floor rather than pretending to go below it', () => {
    expect(BOT_LEVELS[0]?.elo).toBe(MIN_BOT_ELO);
  });

  it('has a default that is one of the levels', () => {
    expect(BOT_LEVELS).toContain(DEFAULT_BOT_LEVEL);
  });
});

describe('findBotLevel', () => {
  it('finds a level by id', () => {
    expect(findBotLevel('club')?.name).toBe('Club');
  });

  it('returns undefined for an id that is not on the list, so the caller decides', () => {
    expect(findBotLevel('grandmaster')).toBeUndefined();
    expect(findBotLevel(null)).toBeUndefined();
    expect(findBotLevel(undefined)).toBeUndefined();
  });
});

describe('clampBotElo', () => {
  it('leaves a rating inside the range alone', () => {
    expect(clampBotElo(1700)).toBe(1700);
  });

  it('pulls a rating below the floor up to it', () => {
    expect(clampBotElo(800)).toBe(MIN_BOT_ELO);
    expect(clampBotElo(-1)).toBe(MIN_BOT_ELO);
  });

  it('pulls a rating above the ceiling down to it', () => {
    expect(clampBotElo(4000)).toBe(MAX_BOT_ELO);
  });

  it('rounds, because UCI_Elo is an integer option', () => {
    expect(clampBotElo(1700.6)).toBe(1701);
  });

  it('falls back to the floor for anything that is not a number', () => {
    expect(clampBotElo(Number.NaN)).toBe(MIN_BOT_ELO);
    expect(clampBotElo(Number.POSITIVE_INFINITY)).toBe(MIN_BOT_ELO);
  });
});

describe('strengthOptions', () => {
  it('turns the limit on before setting the rating it limits to', () => {
    expect(strengthOptions(1700)).toEqual([
      { name: 'UCI_LimitStrength', value: 'true' },
      { name: 'UCI_Elo', value: '1700' },
    ]);
  });

  it('clamps rather than sending a value the engine would ignore', () => {
    expect(strengthOptions(600)).toContainEqual({ name: 'UCI_Elo', value: String(MIN_BOT_ELO) });
    expect(strengthOptions(9000)).toContainEqual({ name: 'UCI_Elo', value: String(MAX_BOT_ELO) });
  });

  it('renders as setoption lines', () => {
    expect(strengthCommands(1500)).toEqual([
      'setoption name UCI_LimitStrength value true',
      'setoption name UCI_Elo value 1500',
    ]);
  });
});
