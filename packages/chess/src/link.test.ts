import { describe, expect, it } from 'vitest';

import {
  MAX_VERIFY_ATTEMPTS,
  NONCE_PREFIX,
  NONCE_TTL_MS,
  evaluateChallenge,
  generateLinkNonce,
  profileProvesOwnership,
  reverificationNeeded,
} from './link';

const NONCE = `${NONCE_PREFIX}7f3a91c2e5d40b16`;

describe('generateLinkNonce', () => {
  it('is prefixed so the user can tell what it is', () => {
    expect(generateLinkNonce()).toMatch(new RegExp(`^${NONCE_PREFIX}[0-9a-f]{16}$`));
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateLinkNonce()));
    expect(seen.size).toBe(200);
  });
});

describe('profileProvesOwnership', () => {
  it('accepts the nonce alone in the location field', () => {
    expect(profileProvesOwnership({ location: NONCE }, NONCE)).toBe(true);
  });

  it('accepts the nonce alongside a real location, so the user keeps their profile', () => {
    expect(profileProvesOwnership({ location: `Berlin — ${NONCE}` }, NONCE)).toBe(true);
  });

  it('accepts the nonce in the name field as a fallback', () => {
    expect(profileProvesOwnership({ name: `Simon ${NONCE}` }, NONCE)).toBe(true);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(profileProvesOwnership({ location: `  ${NONCE.toUpperCase()}  ` }, NONCE)).toBe(true);
  });

  it('rejects a profile that does not carry the nonce', () => {
    expect(profileProvesOwnership({ location: 'Berlin', name: 'Simon' }, NONCE)).toBe(false);
  });

  it('rejects a different nonce, even one sharing the prefix', () => {
    expect(profileProvesOwnership({ location: `${NONCE_PREFIX}0000000000000000` }, NONCE)).toBe(
      false,
    );
  });

  it('rejects a truncated nonce', () => {
    expect(profileProvesOwnership({ location: NONCE.slice(0, -2) }, NONCE)).toBe(false);
  });

  it('rejects an empty profile', () => {
    expect(profileProvesOwnership({}, NONCE)).toBe(false);
  });

  it('never passes on an empty nonce, whatever the profile says', () => {
    expect(profileProvesOwnership({ location: 'anything' }, '')).toBe(false);
  });
});

describe('evaluateChallenge', () => {
  const createdAt = new Date('2026-08-27T12:00:00Z');
  const base = { nonce: NONCE, createdAt, attempts: 0, consumedAt: null };

  it('verifies when the profile carries the nonce inside the window', () => {
    const result = evaluateChallenge({
      challenge: base,
      profile: { location: NONCE },
      now: new Date(createdAt.getTime() + 60_000),
    });
    expect(result).toEqual({ ok: true });
  });

  it('fails when the profile has not been updated yet', () => {
    const result = evaluateChallenge({
      challenge: base,
      profile: { location: 'Berlin' },
      now: new Date(createdAt.getTime() + 60_000),
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('expires after the TTL even with a correct nonce', () => {
    const result = evaluateChallenge({
      challenge: base,
      profile: { location: NONCE },
      now: new Date(createdAt.getTime() + NONCE_TTL_MS + 1),
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('is single use', () => {
    const result = evaluateChallenge({
      challenge: { ...base, consumedAt: new Date(createdAt.getTime() + 10_000) },
      profile: { location: NONCE },
      now: new Date(createdAt.getTime() + 60_000),
    });
    expect(result).toEqual({ ok: false, reason: 'already_used' });
  });

  it('stops a polling loop once attempts are exhausted', () => {
    const result = evaluateChallenge({
      challenge: { ...base, attempts: MAX_VERIFY_ATTEMPTS },
      profile: { location: NONCE },
      now: new Date(createdAt.getTime() + 60_000),
    });
    expect(result).toEqual({ ok: false, reason: 'too_many_attempts' });
  });

  it('checks expiry before the profile, so a stale nonce never leaks a match', () => {
    const result = evaluateChallenge({
      challenge: base,
      profile: { location: NONCE },
      now: new Date(createdAt.getTime() + NONCE_TTL_MS * 10),
    });
    expect(result.ok).toBe(false);
  });
});

describe('reverificationNeeded', () => {
  const verifiedAt = new Date('2026-01-01T00:00:00Z');
  const base = {
    storedPlatformUserId: '42',
    currentPlatformUserId: '42',
    verifiedAt,
    lastSyncedAt: new Date('2026-08-01T00:00:00Z'),
    now: new Date('2026-09-02T00:00:00Z'),
  };

  it('lets a healthy, recently synced link through', () => {
    expect(reverificationNeeded(base)).toBeNull();
  });

  it('revokes when the player id behind the username has changed', () => {
    expect(reverificationNeeded({ ...base, currentPlatformUserId: '99' })).toBe('renamed');
  });

  it('treats a changed player id as revoked even if the link was proved yesterday', () => {
    expect(
      reverificationNeeded({
        ...base,
        currentPlatformUserId: '99',
        verifiedAt: new Date('2026-09-01T00:00:00Z'),
        lastSyncedAt: new Date('2026-09-01T00:00:00Z'),
      }),
    ).toBe('renamed');
  });

  it('expires a link that has not synced for over a year', () => {
    expect(
      reverificationNeeded({ ...base, lastSyncedAt: new Date('2025-08-01T00:00:00Z') }),
    ).toBe('stale');
  });

  it('measures staleness from the proof when the link has never synced', () => {
    expect(
      reverificationNeeded({
        ...base,
        verifiedAt: new Date('2025-01-01T00:00:00Z'),
        lastSyncedAt: null,
      }),
    ).toBe('stale');
  });

  it('does not expire a never-synced link that was only just proved', () => {
    expect(
      reverificationNeeded({
        ...base,
        verifiedAt: new Date('2026-09-01T00:00:00Z'),
        lastSyncedAt: null,
      }),
    ).toBeNull();
  });

  it('reports a rename rather than staleness when both are true', () => {
    expect(
      reverificationNeeded({
        ...base,
        currentPlatformUserId: '99',
        lastSyncedAt: new Date('2024-01-01T00:00:00Z'),
      }),
    ).toBe('renamed');
  });

  it('does not treat a link predating the check as renamed', () => {
    // No stored id means nothing to compare, not a mismatch.
    expect(reverificationNeeded({ ...base, storedPlatformUserId: null })).toBeNull();
  });

  it('compares ids as strings, so numeric formatting cannot cause a false revoke', () => {
    expect(
      reverificationNeeded({ ...base, storedPlatformUserId: '42', currentPlatformUserId: '42' }),
    ).toBeNull();
  });

  it('revokes a link with no verification at all', () => {
    expect(reverificationNeeded({ ...base, verifiedAt: null })).toBe('unverified');
  });
});
