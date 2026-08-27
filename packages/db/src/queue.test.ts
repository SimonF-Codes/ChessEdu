import { describe, expect, it } from 'vitest';

import { BASE_RETRY_MS, MAX_RETRY_MS, nextRetryDelayMs } from './queue';

describe('nextRetryDelayMs', () => {
  it('waits the base delay after the first failure', () => {
    expect(nextRetryDelayMs(1)).toBe(BASE_RETRY_MS);
  });

  it('doubles with each further failure', () => {
    expect(nextRetryDelayMs(2)).toBe(BASE_RETRY_MS * 2);
    expect(nextRetryDelayMs(3)).toBe(BASE_RETRY_MS * 4);
  });

  it('caps so a wedged job does not drift out to days', () => {
    expect(nextRetryDelayMs(50)).toBe(MAX_RETRY_MS);
  });

  it('handles a zero attempt count without going negative', () => {
    expect(nextRetryDelayMs(0)).toBe(BASE_RETRY_MS);
  });
});
