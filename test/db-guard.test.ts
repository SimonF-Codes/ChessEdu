import { describe, expect, it } from 'vitest';

import { assertSeparateTestDatabase } from './db-guard';

const NEON_DEV = 'postgresql://u:p@ep-solitary-pine-avypim9q-pooler.c-11.aws.neon.tech/neondb';
const NEON_TEST = 'postgresql://u:p@ep-blue-paper-avdc6o0f-pooler.c-11.aws.neon.tech/neondb';

describe('assertSeparateTestDatabase', () => {
  it('allows two different branches', () => {
    expect(() =>
      assertSeparateTestDatabase({ DATABASE_URL: NEON_DEV, TEST_DATABASE_URL: NEON_TEST }),
    ).not.toThrow();
  });

  it('refuses when both point at the same database', () => {
    expect(() =>
      assertSeparateTestDatabase({ DATABASE_URL: NEON_DEV, TEST_DATABASE_URL: NEON_DEV }),
    ).toThrow(/REFUSING TO RUN/);
  });

  it('refuses even when only the credentials differ', () => {
    // A rotated password is still the same database. This is the case that actually bit.
    expect(() =>
      assertSeparateTestDatabase({
        DATABASE_URL: NEON_DEV,
        TEST_DATABASE_URL: NEON_DEV.replace('u:p@', 'other:secret@'),
      }),
    ).toThrow(/REFUSING TO RUN/);
  });

  it('refuses when the host differs only by case', () => {
    expect(() =>
      assertSeparateTestDatabase({
        DATABASE_URL: NEON_DEV,
        TEST_DATABASE_URL: NEON_DEV.toUpperCase().replace('POSTGRESQL', 'postgresql'),
      }),
    ).toThrow(/REFUSING TO RUN/);
  });

  it('treats different databases on one host as separate', () => {
    expect(() =>
      assertSeparateTestDatabase({
        DATABASE_URL: `${NEON_DEV}`,
        TEST_DATABASE_URL: NEON_DEV.replace('/neondb', '/neondb_test'),
      }),
    ).not.toThrow();
  });

  it('says nothing when no test database is configured — the suites skip themselves', () => {
    expect(() => assertSeparateTestDatabase({ DATABASE_URL: NEON_DEV })).not.toThrow();
  });

  it('says nothing when there is no app database to collide with', () => {
    expect(() => assertSeparateTestDatabase({ TEST_DATABASE_URL: NEON_TEST })).not.toThrow();
  });

  it('does not guess about an unparseable url', () => {
    expect(() =>
      assertSeparateTestDatabase({ DATABASE_URL: 'not a url', TEST_DATABASE_URL: 'not a url' }),
    ).not.toThrow();
  });
});
