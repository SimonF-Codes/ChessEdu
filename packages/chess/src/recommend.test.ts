import { describe, expect, it } from 'vitest';

import { BOT_LEVELS, DEFAULT_BOT_LEVEL, MAX_BOT_ELO, MIN_BOT_ELO } from './bot';
import { STRETCH_ELO, dominantRating, recommendBotLevel } from './recommend';

const game = (timeClass: string, userRating: number | null, rated = true) => ({
  timeClass,
  userRating,
  rated,
});

describe('dominantRating', () => {
  it('has no opinion without games', () => {
    expect(dominantRating([])).toBeNull();
  });

  it('reads the rating from a single time class', () => {
    expect(dominantRating([game('blitz', 1200), game('blitz', 1240)])).toEqual({
      timeClass: 'blitz',
      rating: 1220,
    });
  });

  it('takes the median, so one disastrous run does not move it much', () => {
    const rating = dominantRating([
      game('blitz', 1200),
      game('blitz', 1210),
      game('blitz', 1220),
      game('blitz', 400),
    ]);
    expect(rating?.rating).toBe(1205);
  });

  it('uses the time class the player actually plays, not a blend of all of them', () => {
    // Mixing a 900 bullet rating into a 1600 rapid one would describe nobody.
    const rating = dominantRating([
      game('rapid', 1600),
      game('rapid', 1620),
      game('rapid', 1610),
      game('bullet', 900),
    ]);
    expect(rating?.timeClass).toBe('rapid');
    expect(rating?.rating).toBe(1610);
  });

  it('ignores unrated games, whose rating means nothing', () => {
    expect(dominantRating([game('blitz', 1500, false), game('blitz', 1200)])).toEqual({
      timeClass: 'blitz',
      rating: 1200,
    });
  });

  it('ignores games with no rating recorded', () => {
    expect(dominantRating([game('blitz', null), game('blitz', 1300)])).toEqual({
      timeClass: 'blitz',
      rating: 1300,
    });
  });

  it('has no opinion when nothing survives filtering', () => {
    expect(dominantRating([game('blitz', null), game('rapid', 1500, false)])).toBeNull();
  });

  it('breaks a tie in games played by the larger sample of ratings', () => {
    const rating = dominantRating([
      game('blitz', 1000),
      game('blitz', null),
      game('rapid', 1500),
      game('rapid', 1520),
    ]);
    expect(rating?.timeClass).toBe('rapid');
  });
});

describe('recommendBotLevel', () => {
  it('falls back to the default when the player has no rating yet', () => {
    const result = recommendBotLevel({ rating: null });
    expect(result.level).toEqual(DEFAULT_BOT_LEVEL);
    expect(result.reason).toBe('no-rating');
  });

  it('recommends a rung above the player, not at them', () => {
    const result = recommendBotLevel({ rating: 1500 });
    expect(result.level.elo).toBeGreaterThan(1500);
    expect(result.reason).toBe('stretch');
  });

  it('aims for the players rating plus the stretch', () => {
    // 1500 + 100 = 1600, so the lowest rung at or above that is Club (1700).
    expect(recommendBotLevel({ rating: 1500 }).level.id).toBe('club');
  });

  it('picks the exact rung when the target lands on one', () => {
    expect(recommendBotLevel({ rating: 1700 - STRETCH_ELO }).level.elo).toBe(1700);
  });

  it('does not recommend below the engine floor for a weak player', () => {
    const result = recommendBotLevel({ rating: 400 });
    expect(result.level.elo).toBe(MIN_BOT_ELO);
    expect(result.reason).toBe('floor');
  });

  it('caps at the strongest rung rather than promising more', () => {
    const result = recommendBotLevel({ rating: MAX_BOT_ELO + 500 });
    expect(result.level.elo).toBe(BOT_LEVELS[BOT_LEVELS.length - 1]!.elo);
    expect(result.reason).toBe('ceiling');
  });

  it('always returns a real rung from the ladder', () => {
    for (const rating of [null, 200, 800, 1320, 1500, 2000, 2600, 4000]) {
      const { level } = recommendBotLevel({ rating });
      expect(BOT_LEVELS).toContainEqual(level);
    }
  });

  it('never recommends a weaker bot to a stronger player', () => {
    const ratings = [800, 1200, 1600, 2000, 2400, 2800];
    const elos = ratings.map((rating) => recommendBotLevel({ rating }).level.elo);
    for (let i = 1; i < elos.length; i += 1) {
      expect(elos[i]!).toBeGreaterThanOrEqual(elos[i - 1]!);
    }
  });
});
