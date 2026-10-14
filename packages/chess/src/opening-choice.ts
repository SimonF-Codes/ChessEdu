import { type BranchRule, type LineSpec, PONZIANI_BRANCHING, lineDepthFor } from './lines';

/**
 * Which openings to drill, read from the player's own games
 * (docs/adr/0009-openings-from-the-games.md).
 *
 * An opening family is ranked by the points it costs — `games × (0.5 − score)` — not by how often
 * it is played: a frequent opening the player already wins needs no drill. Families with too few
 * games to mean anything are not ranked, and families that score 50% or better are never chosen.
 * Each chosen family becomes a `LineSpec` whose root and learner come from the games too.
 *
 * Pure: the aggregation in apps/worker hands over rows, and everything decided about them is
 * decided here.
 */

type Color = 'w' | 'b';

/** Below this many games on one side, a family's score is noise. */
export const FAMILY_MIN_GAMES = 40;

/** Families generated per run: three done well beat six met at once. */
export const DEFAULT_FAMILY_COUNT = 3;

/** How many of a game's opening moves the aggregation hands over, to find a family's root in. */
export const ROOT_SEARCH_PLIES = 8;

/** A move identifies a family when at least this share of the games reaching it are the family. */
export const ROOT_IDENTIFIES = 0.8;

/** A root never fixes a move that fewer than this share of the family's games played. */
export const ROOT_MIN_SHARE = 0.5;

/**
 * How the opponent branches in a family drawn from the games: the Ponziani's numbers (ADR 0007).
 * Where the player's games have measured replies they come first; this is the cap and the fill.
 */
export const FAMILY_BRANCHING: readonly BranchRule[] = PONZIANI_BRANCHING;

/** Some number of the family's games that opened with the same moves. */
export interface OpeningCount {
  /** The game's first moves, at most `ROOT_SEARCH_PLIES`, in SAN. */
  sans: readonly string[];
  games: number;
}

/** One opening family on one side, aggregated over the player's games. */
export interface FamilyRecord {
  color: Color;
  /** `openingFamily` of the games' `eco_url`, e.g. `Scandinavian-Defense`. */
  family: string;
  games: number;
  /** Win 1, draw ½, loss 0. */
  points: number;
  /** The commonest ECO code among the family's games. */
  eco: string | null;
  openings: readonly OpeningCount[];
}

/** One row of the aggregation: games sharing a side, an opening name, an ECO code and first moves. */
export interface GameGroup {
  color: Color;
  ecoUrl: string | null;
  eco: string | null;
  sans: readonly string[];
  games: number;
  points: number;
}

/** Strip the move suffix (`-2.e5`, `-3...d6-4.c3`, `...3.Nxe4`) from an opening slug. */
function withoutMoves(slug: string): string[] {
  const words = slug.split('-');
  const at = words.findIndex((word) => /^\d/.test(word) || word.includes('...'));
  if (at === -1) return words;
  // `Scandinavian-Defense-Closed...3.Nxe4` puts the name and the moves in one word.
  const head = words[at]!.split('...')[0]!;
  return [...words.slice(0, at), ...(head && !/^\d/.test(head) ? [head] : [])];
}

/**
 * The family of a Chess.com opening URL: the slug without its moves, cut after its first
 * `Defense` or `Gambit`. A defence or a gambit is one decision and its sub-variations are where it
 * goes; an "Opening", "Game" or "Variation" name is often a catch-all, kept whole. Null when the
 * URL names no opening.
 */
export function openingFamily(ecoUrl: string | null): string | null {
  const match = ecoUrl?.match(/\/openings\/([^/?#]+)/);
  if (!match) return null;
  const words = withoutMoves(match[1]!);
  const cut = words.findIndex((word) => word === 'Defense' || word === 'Gambit');
  const family = (cut === -1 ? words : words.slice(0, cut + 1)).join('-');
  return family || null;
}

/** Group the aggregation's rows into families, per side. Games with no opening name are left out. */
export function foldFamilyRecords(groups: readonly GameGroup[]): FamilyRecord[] {
  const byKey = new Map<
    string,
    { record: FamilyRecord & { openings: OpeningCount[] }; ecos: Map<string, number> }
  >();
  for (const group of groups) {
    const family = openingFamily(group.ecoUrl);
    if (!family) continue;
    const key = `${group.color} ${family}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        record: { color: group.color, family, games: 0, points: 0, eco: null, openings: [] },
        ecos: new Map(),
      };
      byKey.set(key, entry);
    }
    entry.record.games += group.games;
    entry.record.points += group.points;
    if (group.eco) entry.ecos.set(group.eco, (entry.ecos.get(group.eco) ?? 0) + group.games);

    const sans = group.sans.slice(0, ROOT_SEARCH_PLIES);
    const same = entry.record.openings.find(
      (o) => o.sans.length === sans.length && o.sans.every((san, i) => san === sans[i]),
    );
    if (same) same.games += group.games;
    else entry.record.openings.push({ sans, games: group.games });
  }

  return [...byKey.values()].map(({ record, ecos }) => ({
    ...record,
    eco: [...ecos].sort(([a, n], [b, m]) => m - n || (a < b ? -1 : a > b ? 1 : 0))[0]?.[0] ?? null,
  }));
}

/** A family ranked: its totals, its score and the points it costs against an even result. */
export interface FamilyStanding {
  color: Color;
  family: string;
  games: number;
  points: number;
  score: number;
  pointsLost: number;
}

/**
 * Every family with at least `minGames` games, most points lost first. Ties — exact, since results
 * are half-points — go to more games, then Black before White, then the name, so the order never
 * depends on the input's. Strengths stay in, at the bottom; `chooseOpenings` leaves them out.
 */
export function familyStandings(
  records: readonly Pick<FamilyRecord, 'color' | 'family' | 'games' | 'points'>[],
  options: { minGames?: number } = {},
): FamilyStanding[] {
  const minGames = options.minGames ?? FAMILY_MIN_GAMES;
  return records
    .filter((record) => record.games >= minGames)
    .map(({ color, family, games, points }) => ({
      color,
      family,
      games,
      points,
      score: points / games,
      pointsLost: games * 0.5 - points,
    }))
    .sort(
      (a, b) =>
        b.pointsLost - a.pointsLost ||
        b.games - a.games ||
        (a.color === b.color ? 0 : a.color === 'b' ? -1 : 1) ||
        (a.family < b.family ? -1 : a.family > b.family ? 1 : 0),
    );
}

/** How many of `openings` games begin with `prefix`. */
function gamesThrough(openings: readonly OpeningCount[], prefix: readonly string[]): number {
  let games = 0;
  for (const opening of openings) {
    if (prefix.every((san, i) => opening.sans[i] === san)) games += opening.games;
  }
  return games;
}

/**
 * The moves that define a family: follow its most common sequence and stop at the first move that
 * identifies it — at least `ROOT_IDENTIFIES` of the player's games on that side that reach the move
 * are in the family — never fixing a move fewer than `ROOT_MIN_SHARE` of its games played. If no
 * move identifies it, the root is as far as that half of its games agree. `records` is every
 * family the player has, so the root can be told apart from the rest; empty when nothing is known.
 */
export function familyRoot(record: FamilyRecord, records: readonly FamilyRecord[]): string[] {
  const sameSide = records.filter((r) => r.color === record.color).flatMap((r) => r.openings);
  const root: string[] = [];

  for (let depth = 0; depth < ROOT_SEARCH_PLIES; depth += 1) {
    const next = new Map<string, number>();
    for (const opening of record.openings) {
      const san = opening.sans[depth];
      if (san !== undefined && root.every((s, i) => opening.sans[i] === s)) {
        next.set(san, (next.get(san) ?? 0) + opening.games);
      }
    }
    const [move, games] =
      [...next].sort(([a, n], [b, m]) => m - n || (a < b ? -1 : a > b ? 1 : 0))[0] ?? [];
    if (move === undefined || games === undefined || games < record.games * ROOT_MIN_SHARE) break;

    root.push(move);
    if (games >= gamesThrough(sameSide, root) * ROOT_IDENTIFIES) break;
  }
  return root;
}

const POSSESSIVE = new Set(['Kings', 'Queens', 'Bishops']);

/** A family slug as words: `Queens-Gambit` is "Queen's Gambit". */
export function familyLabel(family: string): string {
  return family
    .split('-')
    .map((word) => (POSSESSIVE.has(word) ? `${word.slice(0, -1)}'s` : word))
    .join(' ');
}

/** The `opening_line.family` a family's lines are stored under: slug and side. */
export function lineFamilyId(color: Color, family: string): string {
  return `${family.toLowerCase()}-${color === 'w' ? 'white' : 'black'}`;
}

/** A stored line family for the drill: `queens-gambit-black` is "Queen's Gambit, as Black". */
export function lineFamilyLabel(id: string, learnerColor: Color): string {
  const words = id
    .replace(/-(white|black)$/, '')
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('-');
  return `${familyLabel(words)}, as ${learnerColor === 'w' ? 'White' : 'Black'}`;
}

/** A family as a `LineSpec`; null when its root cannot be found. The shape is ADR 0006's. */
export function familySpec(
  record: FamilyRecord,
  records: readonly FamilyRecord[],
): LineSpec | null {
  const rootSan = familyRoot(record, records);
  if (rootSan.length === 0) return null;
  return {
    family: lineFamilyId(record.color, record.family),
    eco: record.eco ?? '',
    name: familyLabel(record.family),
    rootSan,
    learnerColor: record.color,
    depthPlies: lineDepthFor(record.color),
    branching: FAMILY_BRANCHING,
  };
}

export interface ChosenOpening {
  standing: FamilyStanding;
  spec: LineSpec;
}

/**
 * The families to drill: the `count` that cost the most points, each at least `minGames` games,
 * none that the player scores 50% or better in. A family whose root cannot be found is skipped and
 * the next one taken.
 */
export function chooseOpenings(
  records: readonly FamilyRecord[],
  options: { count?: number; minGames?: number } = {},
): ChosenOpening[] {
  const count = options.count ?? DEFAULT_FAMILY_COUNT;
  const byKey = new Map(records.map((record) => [`${record.color} ${record.family}`, record]));
  const chosen: ChosenOpening[] = [];
  for (const standing of familyStandings(records, options)) {
    if (chosen.length >= count || standing.pointsLost <= 0) break;
    const spec = familySpec(byKey.get(`${standing.color} ${standing.family}`)!, records);
    if (spec) chosen.push({ standing, spec });
  }
  return chosen;
}
