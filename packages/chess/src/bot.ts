import { setOptionCommand, type UciOption } from './uci';

/**
 * How strong a bot plays. The only place that decides it.
 *
 * Strength is capped with Stockfish's own `UCI_LimitStrength` / `UCI_Elo` rather than by
 * starving the search, because a crippled search does not play like a weaker human — it plays
 * a deep move and then hangs a piece for nothing. That also fixes the floor: `UCI_Elo` stops
 * at 1320 and there is no honest way to go below it with Stockfish. Bots under 1320 are what
 * Maia is for, and are out of scope — see docs/adr/0002-browser-engine.md.
 */

/** The range Stockfish 18 accepts for `UCI_Elo`. Outside it, the option is ignored. */
export const MIN_BOT_ELO = 1320;
export const MAX_BOT_ELO = 3190;

/**
 * Search time per bot move. A responsiveness knob, not a strength one: at a capped Elo the
 * engine deliberately picks a weaker move, so more thinking time buys nothing.
 */
export const BOT_MOVE_TIME_MS = 300;

export interface BotLevel {
  /** Stable id, safe in a URL or a form value. */
  id: string;
  name: string;
  elo: number;
  /** One line of orientation for the picker. */
  blurb: string;
}

/**
 * Rungs rather than a slider: the point is to play something a little above your current
 * level, and a slider invites fiddling with a number the engine only approximates anyway.
 */
export const BOT_LEVELS: readonly BotLevel[] = [
  {
    id: 'beginner',
    name: 'Beginner',
    elo: MIN_BOT_ELO,
    blurb: 'As gently as Stockfish can play. Its floor, not a beginner’s.',
  },
  { id: 'casual', name: 'Casual', elo: 1500, blurb: 'Punishes hanging pieces, little else.' },
  { id: 'club', name: 'Club', elo: 1700, blurb: 'Sees short tactics. Will take a free pawn.' },
  {
    id: 'strong-club',
    name: 'Strong club',
    elo: 1900,
    blurb: 'Plans, and makes you prove the endgame.',
  },
  {
    id: 'candidate',
    name: 'Candidate master',
    elo: 2200,
    blurb: 'Needs a real idea, not just no blunders.',
  },
  { id: 'master', name: 'Master', elo: 2500, blurb: 'Wins won positions. Grinds level ones.' },
];

export const DEFAULT_BOT_LEVEL: BotLevel = BOT_LEVELS[2]!;

export function findBotLevel(id: string | null | undefined): BotLevel | undefined {
  return BOT_LEVELS.find((level) => level.id === id);
}

/**
 * Bring any number into the range Stockfish honours. Anything that is not a number at all
 * lands on the floor: a bot that is too weak is a bad game, a bot that is silently full
 * strength is a bewildering one.
 */
export function clampBotElo(elo: number): number {
  if (!Number.isFinite(elo)) return MIN_BOT_ELO;
  return Math.min(MAX_BOT_ELO, Math.max(MIN_BOT_ELO, Math.round(elo)));
}

/**
 * The UCI options that cap the engine at a rating.
 *
 * `UCI_LimitStrength` comes first: `UCI_Elo` does nothing until it is on, and an engine that
 * ignored the cap would look exactly like one that had not been sent it.
 */
export function strengthOptions(elo: number): UciOption[] {
  return [
    { name: 'UCI_LimitStrength', value: 'true' },
    { name: 'UCI_Elo', value: String(clampBotElo(elo)) },
  ];
}

/** The same options as the lines to write to the engine. */
export function strengthCommands(elo: number): string[] {
  return strengthOptions(elo).map(setOptionCommand);
}
