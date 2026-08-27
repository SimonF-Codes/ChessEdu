import { describe, expect, it, vi } from 'vitest';

import {
  ChessComClient,
  ChessComError,
  buildUserAgent,
  isValidUsername,
  normalizeUsername,
  retryAfterMs,
} from './client';
import type { FetchInit, FetchLike } from './client';

const noSleep = () => Promise.resolve();

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function clientWith(fetchImpl: FetchLike, overrides = {}) {
  return new ChessComClient({
    contact: 'me@example.com',
    fetchImpl,
    minIntervalMs: 0,
    sleep: noSleep,
    ...overrides,
  });
}

describe('buildUserAgent', () => {
  it('identifies the app and carries a contact, which Chess.com requires', () => {
    const agent = buildUserAgent('me@example.com');
    expect(agent).toContain('ChessEdu');
    expect(agent).toContain('me@example.com');
  });
});

describe('normalizeUsername', () => {
  it('lowercases and trims, since usernames are case-insensitive', () => {
    expect(normalizeUsername('  JrFx99 ')).toBe('jrfx99');
  });
});

describe('isValidUsername', () => {
  it.each(['jrfx99', 'abc', 'a-b_c', 'JrFx99'])('accepts %s', (name) => {
    expect(isValidUsername(name)).toBe(true);
  });

  it.each([
    ['ab', 'too short'],
    ['a'.repeat(26), 'too long'],
    ['-leading', 'starts with a hyphen'],
    ['has space', 'contains a space'],
    ['has.dot', 'contains a dot'],
    ['', 'empty'],
    ['../../etc/passwd', 'path traversal'],
  ])('rejects %s (%s)', (name) => {
    expect(isValidUsername(name)).toBe(false);
  });
});

describe('retryAfterMs', () => {
  it('honours a Retry-After in seconds', () => {
    expect(retryAfterMs('12', 0)).toBe(12_000);
  });

  it('backs off exponentially when the header is missing', () => {
    expect(retryAfterMs(null, 0)).toBe(1000);
    expect(retryAfterMs(null, 3)).toBe(8000);
  });

  it('ignores a nonsense header', () => {
    expect(retryAfterMs('soon', 1)).toBe(2000);
  });

  it('caps the backoff', () => {
    expect(retryAfterMs(null, 20)).toBe(60_000);
  });
});

describe('ChessComClient.getProfile', () => {
  it('sends a descriptive User-Agent', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: FetchInit) => json({ username: 'jrfx99', player_id: 1 }));
    await clientWith(fetchImpl).getProfile('jrfx99');

    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('ChessEdu');
  });

  it('lowercases the username in the url', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: FetchInit) => json({ username: 'jrfx99', player_id: 1 }));
    await clientWith(fetchImpl).getProfile('JrFx99');
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.chess.com/pub/player/jrfx99');
  });

  it('bypasses the cache so a just-saved profile edit is visible', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: FetchInit) => json({ username: 'jrfx99', player_id: 1 }));
    await clientWith(fetchImpl).getProfile('jrfx99');
    expect(fetchImpl.mock.calls[0]![1]!.cache).toBe('no-store');
  });

  it('returns null for an unknown user rather than throwing', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: FetchInit) => new Response('', { status: 404 }));
    const profile = await clientWith(fetchImpl).getProfile('nobody');
    expect(profile).toBeNull();
  });

  it('throws with the status for a server error', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: FetchInit) => new Response('', { status: 500 }));
    await expect(
      clientWith(fetchImpl).getProfile('jrfx99'),
    ).rejects.toBeInstanceOf(ChessComError);
  });
});

describe('ChessComClient.getArchive', () => {
  const url = 'https://api.chess.com/pub/player/jrfx99/games/2026/08';

  it('sends the stored validators as conditional headers', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: FetchInit) => json({ games: [] }));
    await clientWith(fetchImpl).getArchive(url, {
      etag: 'W/"abc"',
      lastModified: 'Mon, 03 Aug 2026 10:00:00 GMT',
    });

    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('W/"abc"');
    expect(headers['If-Modified-Since']).toBe('Mon, 03 Aug 2026 10:00:00 GMT');
  });

  it('reports an unchanged month on a 304 without parsing a body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: FetchInit) => new Response(null, { status: 304 }));
    const result = await clientWith(fetchImpl).getArchive(url, {
      etag: 'W/"abc"',
    });
    expect(result).toEqual({ status: 'unchanged' });
  });

  it('returns the games and the new validators to store', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: FetchInit) =>
      json(
        { games: [{ url: 'https://www.chess.com/game/live/1' }] },
        { headers: { etag: 'W/"def"', 'last-modified': 'Tue, 04 Aug 2026 10:00:00 GMT' } },
      ),
    );
    const result = await clientWith(fetchImpl).getArchive(url);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.games).toHaveLength(1);
    expect(result.etag).toBe('W/"def"');
    expect(result.lastModified).toBe('Tue, 04 Aug 2026 10:00:00 GMT');
  });

  it('retries a 429 and succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, _init?: FetchInit) => {
      calls += 1;
      if (calls === 1) return new Response('', { status: 429, headers: { 'retry-after': '1' } });
      return json({ games: [] });
    });

    const result = await clientWith(fetchImpl).getArchive(url);
    expect(result.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries and surfaces the 429', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: FetchInit) => new Response('', { status: 429 }));
    const client = clientWith(fetchImpl, { maxRetries: 2 });

    await expect(client.getArchive(url)).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('request serialisation', () => {
  it('never has two requests in flight at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (_url: string, _init?: FetchInit) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return json({ games: [] });
    });

    const client = clientWith(fetchImpl);
    await Promise.all([
      client.getArchive('https://api.chess.com/pub/a'),
      client.getArchive('https://api.chess.com/pub/b'),
      client.getArchive('https://api.chess.com/pub/c'),
    ]);

    expect(peak).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('keeps serialising after a request fails', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, _init?: FetchInit) => {
      calls += 1;
      if (calls === 1) throw new Error('network down');
      return json({ games: [] });
    });

    const client = clientWith(fetchImpl);
    await expect(client.getArchive('https://api.chess.com/pub/a')).rejects.toThrow('network down');
    await expect(client.getArchive('https://api.chess.com/pub/b')).resolves.toMatchObject({
      status: 'ok',
    });
  });
});
