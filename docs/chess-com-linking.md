# Linking a Chess.com account

## The constraint

**Chess.com has no public OAuth.** The Published-Data API at `https://api.chess.com/pub/...`
is unauthenticated and read-only — anyone can fetch anyone's public games. There is a partner
programme with real OAuth, but it is gated and not available for a personal project.

Two consequences shape the whole design:

1. **We cannot ask Chess.com to authenticate the user for us.** Typing a username proves
   nothing — anyone could type `hikaru` and claim his history.
2. **We do not need write access.** Read-only public data is exactly what the analytics want,
   so the missing OAuth costs us nothing except the ownership proof.

So we build the ownership proof ourselves.

## The proof: a nonce in the public profile

The user puts a one-time code somewhere on their Chess.com profile that only the account owner
can edit. We read it back through the public API. If it matches, they own the account.

```mermaid
sequenceDiagram
    actor U as User
    participant W as ChessEdu
    participant DB as Postgres
    participant CC as api.chess.com

    U->>W: "Link jrfx99"
    W->>CC: GET /pub/player/jrfx99
    CC-->>W: 200 profile (or 404 -> reject early)
    W->>DB: insert link_challenge(nonce, expires 30m)
    W-->>U: Put this in your profile Location:<br/>chessedu-verify-7f3a91c2e5
    U->>U: edits profile on chess.com
    U->>W: "I have done it"
    W->>CC: GET /pub/player/jrfx99 (cache-busted)
    CC-->>W: profile { location: "chessedu-verify-7f3a91c2e5" }
    W->>W: constant-time compare vs stored nonce
    W->>DB: chess_accounts.verifiedAt = now()<br/>consume challenge
    W->>DB: enqueue ingest job
    W-->>U: Linked. You can remove the code now.
```

**Which field.** `location` is the default: it is free text, shown on the public profile, and
returned by `/pub/player/{username}` as `location`. `name` works as a fallback for users who
would rather not touch their location. Both are checked; a match in either passes.

**Nonce rules** (implemented in `packages/chess/src/link.ts`, tested in `link.test.ts`):

- 16 hex chars from `crypto.randomBytes(8)` — not `Math.random`.
- Prefixed `chessedu-verify-` so it is obvious to the user and to us what it is.
- Expires after 30 minutes; single-use, consumed on success.
- Compared with `crypto.timingSafeEqual` after normalisation (trim, lowercase). The profile
  field is matched by **substring** so the user can keep their real location alongside it.
- Rate limited to 10 verification attempts per challenge, to stop a poll loop hammering the API.

**After verification** the user is told they can delete the code. Verification is a one-time
event; `verifiedAt` is stored, and the nonce is not re-checked on later syncs.

## Re-verification

The link is re-proved if the username changes (Chess.com allows renames) or if the account has
not synced for over a year. Both are cheap to detect: `/pub/player/{username}` returns a stable
`player_id`, so a rename is a `player_id` that no longer matches the stored one.

## Ingest, and being a good API citizen

The endpoints we use, in order:

| Endpoint | Purpose |
|---|---|
| `/pub/player/{username}` | Profile, `player_id`, and the verification field |
| `/pub/player/{username}/games/archives` | List of monthly archive URLs |
| `/pub/player/{username}/games/{YYYY}/{MM}` | One month of games as JSON with embedded PGN |

Rules the client follows (`packages/chesscom/src/client.ts`, tested in `client.test.ts`):

- **Serial, never parallel.** Chess.com tolerates sequential requests but returns `429` for
  parallel ones from the same IP. The worker fetches one archive at a time.
- **Conditional requests.** Archives are cached with their `ETag` / `Last-Modified`; a re-sync
  sends `If-None-Match` and treats `304` as "nothing new this month". Only the current month
  normally changes.
- **A descriptive `User-Agent`** with a contact address. Chess.com blocks generic and empty
  agents.
- **Backoff on 429**, respecting `Retry-After`, with exponential fallback.
- **Only the current and future months are re-fetched** once a past month has been seen with a
  stable ETag — historical months are immutable in practice.

## Why not scrape, and why not ask for a password

Both were considered and rejected. Scraping breaks the terms of service and the markup;
asking for Chess.com credentials would be phishing our own user for a third-party password
we have no right to hold. The nonce flow gets a real ownership proof with neither problem.
