import { BOT_LEVELS, DEFAULT_BOT_LEVEL, MAX_BOT_ELO, MIN_BOT_ELO, type BotLevel } from './bot';

/**
 * Which bot to offer a player.
 *
 * The idea note asks for an opponent "just above my current level". The honest input for that
 * is the player's own Chess.com rating, which is already an Elo and already calibrated against
 * thousands of humans. The per-phase strength model is deliberately *not* used here: it
 * measures accuracy, and turning accuracy into an Elo would mean inventing a conversion
 * constant and presenting the result as if it meant something. The phase model answers a
 * different question — what to practise — and `practiceWeights` in strength.ts is where that
 * lives.
 */

/** How far above the player to aim. Enough to be uncomfortable, not enough to be pointless. */
export const STRETCH_ELO = 100;

export interface RatingSample {
  timeClass: string;
  userRating: number | null;
  rated: boolean;
}

export interface DominantRating {
  timeClass: string;
  rating: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * The player's rating, in the time control they actually play.
 *
 * Averaging across time classes would describe nobody — a 900 bullet rating and a 1600 rapid
 * rating are two facts about the same person, and their mean is a third thing that is not true
 * of either. So: pick the class with the most rated games, and take its median. The median
 * rather than the mean because one bad run should not move the recommendation much.
 */
export function dominantRating(samples: readonly RatingSample[]): DominantRating | null {
  const byClass = new Map<string, number[]>();

  for (const sample of samples) {
    // An unrated game's rating is not a measurement of anything.
    if (!sample.rated || sample.userRating === null) continue;
    const bucket = byClass.get(sample.timeClass) ?? [];
    bucket.push(sample.userRating);
    byClass.set(sample.timeClass, bucket);
  }

  let best: DominantRating | null = null;
  let bestCount = 0;

  for (const [timeClass, ratings] of byClass) {
    if (ratings.length <= bestCount) continue;
    bestCount = ratings.length;
    best = { timeClass, rating: median(ratings) };
  }

  return best;
}

export type RecommendationReason =
  /** No rated games to go on, so this is a starting point rather than a recommendation. */
  | 'no-rating'
  /** A rung above the player's rating. */
  | 'stretch'
  /** The player is below what Stockfish can play down to — see ADR 0002. */
  | 'floor'
  /** The player is at or beyond the strongest rung offered. */
  | 'ceiling';

export interface Recommendation {
  level: BotLevel;
  reason: RecommendationReason;
  /** What the recommendation aimed at before snapping to a rung. Null without a rating. */
  targetElo: number | null;
}

/**
 * The rung to start a player on. Always a real rung from the ladder, never an arbitrary number.
 */
export function recommendBotLevel(input: { rating: number | null }): Recommendation {
  if (input.rating === null) {
    return { level: DEFAULT_BOT_LEVEL, reason: 'no-rating', targetElo: null };
  }

  const target = input.rating + STRETCH_ELO;
  const weakest = BOT_LEVELS[0]!;
  const strongest = BOT_LEVELS[BOT_LEVELS.length - 1]!;

  if (target <= MIN_BOT_ELO) {
    return { level: weakest, reason: 'floor', targetElo: target };
  }
  if (target >= MAX_BOT_ELO || target > strongest.elo) {
    return { level: strongest, reason: 'ceiling', targetElo: target };
  }

  // The lowest rung that still asks something of the player.
  const level = BOT_LEVELS.find((candidate) => candidate.elo >= target) ?? strongest;
  return { level, reason: 'stretch', targetElo: target };
}

/** One line explaining the choice, so the number is not presented as an oracle. */
export function recommendationMessage(recommendation: Recommendation, timeClass?: string): string {
  const name = recommendation.level.name;
  switch (recommendation.reason) {
    case 'no-rating':
      return `Starting at ${name}. Once some rated games are analysed, this follows your rating.`;
    case 'stretch':
      return `${name}, a little above your ${timeClass ?? ''} rating.`.replace('  ', ' ');
    case 'floor':
      return `${name} — the gentlest Stockfish plays. It will still be a stretch.`;
    case 'ceiling':
      return `${name}, the strongest bot here.`;
  }
}
