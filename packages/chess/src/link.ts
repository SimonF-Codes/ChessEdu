import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Chess.com has no public OAuth, so owning an account is proved by placing a one-time nonce
 * in a profile field only the owner can edit, then reading it back through the public API.
 * See docs/chess-com-linking.md.
 */

export const NONCE_PREFIX = 'chessedu-verify-';
export const NONCE_TTL_MS = 30 * 60 * 1000;
export const MAX_VERIFY_ATTEMPTS = 10;

/** The subset of `/pub/player/{username}` we read the proof out of. */
export interface ChessComProfileFields {
  location?: string | null;
  name?: string | null;
}

export interface LinkChallengeState {
  nonce: string;
  createdAt: Date;
  attempts: number;
  consumedAt: Date | null;
}

export type ChallengeFailure = 'expired' | 'already_used' | 'too_many_attempts' | 'not_found';

export type ChallengeResult = { ok: true } | { ok: false; reason: ChallengeFailure };

export function generateLinkNonce(): string {
  return `${NONCE_PREFIX}${randomBytes(8).toString('hex')}`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Constant-time comparison of two equal-length strings. Falls back to a plain `false` for
 * mismatched lengths, which leaks only the length — the nonce length is a public constant.
 */
function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * True when a profile field carries the nonce. Matched as a substring so the user can keep
 * their real location alongside the code, but each candidate window is still compared in
 * constant time.
 */
function fieldCarriesNonce(field: string | null | undefined, nonce: string): boolean {
  if (!field) return false;
  const haystack = normalize(field);
  const needle = normalize(nonce);
  if (needle.length === 0 || haystack.length < needle.length) return false;

  let found = false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    // No early break: every window is compared so timing does not reveal the match position.
    found = safeEquals(haystack.slice(i, i + needle.length), needle) || found;
  }
  return found;
}

export function profileProvesOwnership(
  profile: ChessComProfileFields,
  nonce: string,
): boolean {
  if (!nonce) return false;
  return fieldCarriesNonce(profile.location, nonce) || fieldCarriesNonce(profile.name, nonce);
}

export function evaluateChallenge(input: {
  challenge: LinkChallengeState;
  profile: ChessComProfileFields;
  now: Date;
}): ChallengeResult {
  const { challenge, profile, now } = input;

  // Order matters: state checks run before the profile is consulted, so an expired or spent
  // challenge can never report a match.
  if (challenge.consumedAt) return { ok: false, reason: 'already_used' };
  if (challenge.attempts >= MAX_VERIFY_ATTEMPTS) {
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (now.getTime() - challenge.createdAt.getTime() > NONCE_TTL_MS) {
    return { ok: false, reason: 'expired' };
  }
  if (!profileProvesOwnership(profile, challenge.nonce)) {
    return { ok: false, reason: 'not_found' };
  }
  return { ok: true };
}

export function challengeFailureMessage(reason: ChallengeFailure): string {
  switch (reason) {
    case 'expired':
      return 'That code expired. Start the link again to get a fresh one.';
    case 'already_used':
      return 'That code has already been used. Start the link again.';
    case 'too_many_attempts':
      return 'Too many checks for one code. Start the link again to get a fresh one.';
    case 'not_found':
      return 'We could not find the code on your Chess.com profile yet. Save your profile, give it a moment, and check again.';
  }
}
