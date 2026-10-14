import { describe, expect, it } from 'vitest';

import {
  STALE_QUEUE_MS,
  type SyncStatus,
  describeSyncStatus,
  looksUnattended,
} from './sync-status';

const at = (iso: string) => new Date(iso);

describe('describeSyncStatus', () => {
  it('distinguishes never-run from queued', () => {
    // The whole point of this module: these two used to read identically.
    const never = describeSyncStatus({ state: 'never' }, 'srf48');
    const queued = describeSyncStatus({ state: 'queued', since: at('2026-10-14T04:00:00Z') }, 'srf48');

    expect(never).toContain('srf48');
    expect(never).not.toEqual(queued);
  });

  it('names the account when nothing has ever been queued', () => {
    expect(describeSyncStatus({ state: 'never' }, 'srf48')).toBe('No sync has been run for srf48 yet.');
  });

  it('reports a failure with its attempt count, singular and plural', () => {
    const one: SyncStatus = { state: 'failed', since: at('2026-10-14T04:00:00Z'), attempts: 1, error: 'boom' };
    const three: SyncStatus = { ...one, attempts: 3 };

    expect(describeSyncStatus(one, 'srf48')).toContain('1 attempt.');
    expect(describeSyncStatus(three, 'srf48')).toContain('3 attempts.');
  });

  it('separates a finished sync that found games from one that found none', () => {
    const empty: SyncStatus = { state: 'done', since: at('2026-10-14T04:00:00Z'), games: 0 };
    const full: SyncStatus = { state: 'done', since: at('2026-10-14T04:00:00Z'), games: 4173 };

    expect(describeSyncStatus(empty, 'srf48')).toContain('no games');
    expect(describeSyncStatus(full, 'srf48')).toContain('4,173');
  });
});

describe('looksUnattended', () => {
  const now = at('2026-10-14T05:00:00Z').getTime();

  it('flags a job that has sat in the queue past the threshold', () => {
    const since = new Date(now - STALE_QUEUE_MS - 1000);
    expect(looksUnattended({ state: 'queued', since }, now)).toBe(true);
  });

  it('leaves a freshly queued job alone', () => {
    const since = new Date(now - 1000);
    expect(looksUnattended({ state: 'queued', since }, now)).toBe(false);
  });

  it('never flags a job a worker is already holding', () => {
    // Running means something picked it up, however long it has been going.
    const since = new Date(now - STALE_QUEUE_MS * 100);
    expect(looksUnattended({ state: 'running', since }, now)).toBe(false);
  });

  it('never flags a state that is not waiting on a worker', () => {
    expect(looksUnattended({ state: 'never' }, now)).toBe(false);
    expect(looksUnattended({ state: 'done', since: new Date(0), games: 0 }, now)).toBe(false);
  });
});
