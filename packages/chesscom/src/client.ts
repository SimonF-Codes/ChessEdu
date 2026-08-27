import type { ChessComGame } from '@chessedu/chess';

/**
 * A client for the Chess.com Published-Data API.
 *
 * The API is unauthenticated and read-only. Three of its behaviours shape this client, and all
 * three are documented in docs/chess-com-linking.md:
 *
 *  - parallel requests from one IP are rate limited, serial ones are not, so every request
 *    goes through one queue;
 *  - archives support conditional requests, so a re-sync of an unchanged month costs a 304;
 *  - requests without a descriptive User-Agent are blocked.
 */

export const CHESSCOM_BASE = 'https://api.chess.com/pub';

export interface ChessComProfile {
  '@id': string;
  url: string;
  username: string;
  player_id: number;
  name?: string;
  location?: string;
  country?: string;
  followers?: number;
  joined?: number;
  last_online?: number;
  status?: string;
}

export interface ConditionalHeaders {
  etag?: string | null;
  lastModified?: string | null;
}

/**
 * `RequestInit` plus `cache`, which the Node typings omit but both Node and the browser
 * honour. The verification poll needs `no-store` to see a profile edit made seconds ago.
 */
export type FetchInit = RequestInit & { cache?: 'no-store' | 'no-cache' | 'default' };

/** The slice of `fetch` this client uses. Narrowed so a test can substitute a plain function. */
export type FetchLike = (url: string, init?: FetchInit) => Promise<Response>;

export type ArchiveResponse =
  | { status: 'unchanged' }
  | {
      status: 'ok';
      games: ChessComGame[];
      etag: string | null;
      lastModified: string | null;
    };

export interface ChessComClientOptions {
  /** Contact address embedded in the User-Agent, as Chess.com asks. */
  contact: string;
  fetchImpl?: FetchLike;
  /** Floor between the start of one request and the next. */
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class ChessComError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ChessComError';
  }
}

export function buildUserAgent(contact: string): string {
  return `ChessEdu/0.1 (personal chess trainer; +${contact})`;
}

/** Chess.com usernames are case-insensitive and always lowercase in URLs. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Chess.com usernames are 3 to 25 characters of letters, digits, underscore and hyphen, and
 * must start with a letter or digit. Checked before any request so a typo costs nothing.
 */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,24}$/;

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(normalizeUsername(username));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ChessComClient {
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Serialises every request: the tail of this chain is the next free slot. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: ChessComClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    this.userAgent = buildUserAgent(options.contact);
    this.minIntervalMs = options.minIntervalMs ?? 250;
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Public profile, or null when the username does not exist. */
  async getProfile(username: string): Promise<ChessComProfile | null> {
    const response = await this.request(
      `${CHESSCOM_BASE}/player/${encodeURIComponent(normalizeUsername(username))}`,
      // The verification poll must see an edit made seconds ago, so never serve it from cache.
      { cache: 'no-store' },
    );
    if (response.status === 404) return null;
    await this.assertOk(response);
    return (await response.json()) as ChessComProfile;
  }

  /** Monthly archive URLs, oldest first. */
  async getArchiveUrls(username: string): Promise<string[]> {
    const response = await this.request(
      `${CHESSCOM_BASE}/player/${encodeURIComponent(normalizeUsername(username))}/games/archives`,
    );
    if (response.status === 404) return [];
    await this.assertOk(response);
    const body = (await response.json()) as { archives?: string[] };
    return body.archives ?? [];
  }

  /**
   * One month of games. Pass the stored validators to get a `unchanged` result when nothing
   * has changed, which is the normal case for every month but the current one.
   */
  async getArchive(url: string, conditional: ConditionalHeaders = {}): Promise<ArchiveResponse> {
    const headers: Record<string, string> = {};
    if (conditional.etag) headers['If-None-Match'] = conditional.etag;
    if (conditional.lastModified) headers['If-Modified-Since'] = conditional.lastModified;

    const response = await this.request(url, { headers });
    if (response.status === 304) return { status: 'unchanged' };
    await this.assertOk(response);

    const body = (await response.json()) as { games?: ChessComGame[] };
    return {
      status: 'ok',
      games: body.games ?? [],
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    };
  }

  private async assertOk(response: Response): Promise<void> {
    if (response.ok || response.status === 304) return;
    throw new ChessComError(
      `Chess.com responded ${response.status} for ${response.url}`,
      response.status,
    );
  }

  /**
   * Every request funnels through here: one at a time, spaced by `minIntervalMs`, retrying a
   * 429 for as long as `maxRetries` allows and honouring `Retry-After`.
   */
  private request(url: string, init: FetchInit = {}): Promise<Response> {
    const run = this.queue.then(() => this.executeWithRetry(url, init));
    // Keep the chain alive even when a caller lets a rejection through.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async executeWithRetry(url: string, init: FetchInit): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const since = Date.now() - this.lastRequestAt;
      if (since < this.minIntervalMs) await this.sleep(this.minIntervalMs - since);
      this.lastRequestAt = Date.now();

      const response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          'User-Agent': this.userAgent,
          ...(init.headers as Record<string, string> | undefined),
        },
      });

      if (response.status !== 429 || attempt >= this.maxRetries) return response;
      await this.sleep(retryAfterMs(response.headers.get('retry-after'), attempt));
    }
  }
}

/** `Retry-After` in seconds if the server sent one, otherwise exponential backoff. */
export function retryAfterMs(header: string | null, attempt: number): number {
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return Math.min(60_000, 1000 * 2 ** attempt);
}
