# The browser engine

How Stockfish runs in the tab, why there are no COOP/COEP headers, and what to do if that ever
has to change. The decision and the alternatives are in
[ADR 0002](adr/0002-browser-engine.md); this page is the operational half.

## What gets served

| File                            | Size   | Served at                                |
| ------------------------------- | ------ | ---------------------------------------- |
| `stockfish-18-lite-single.js`   | 21 KB  | `/engines/stockfish-18-lite-single.js`   |
| `stockfish-18-lite-single.wasm` | 7.0 MB | `/engines/stockfish-18-lite-single.wasm` |

Stockfish 18, `lite` (the small NNUE net, embedded in the `.wasm` — there is no separate
weights file), `single` (no `SharedArrayBuffer`, no threads, no isolation requirement).

They are **fetched, never committed**, the same rule `.gitignore` already applies to the
worker's native binary and its `.nnue` weights:

```bash
npm run engine:fetch          # explicit
npm run dev                   # predev runs it
npm run build                 # prebuild runs it
```

`scripts/fetch-stockfish.mjs` downloads both files from the pinned version on unpkg and checks
each against a SHA-256 recorded in the script. A mismatch is a hard failure — the checksum is
the only thing standing between a CDN and arbitrary code in the tab. It is a no-op when the
files are already on disk and hashing clean, so it costs nothing on a warm checkout and nothing
in CI beyond the first build.

**To move to a new Stockfish release:** bump `ENGINE_VERSION` in the script, run
`npm run engine:fetch`, take the two hashes it prints as wrong, and paste them in. Then play a
game — the UCI dialect is stable, but `UCI_Elo`'s range is not guaranteed to be.

## Why there are no COOP/COEP headers

The threaded build needs `SharedArrayBuffer`, which needs the document to be cross-origin
isolated, which needs:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Under `require-corp`, **every cross-origin subresource must opt in** with a
`Cross-Origin-Resource-Policy` header of its own. Two things in this app do not and cannot:

1. **Google sign-in.** `COOP: same-origin` cuts `window.opener`, the channel any popup-based
   Google sign-in uses; `require-corp` blocks Google-hosted assets outright. The redirect flow
   Auth.js uses today happens to survive, which is worse than failing loudly — it means the
   breakage waits for whoever next adds One Tap or a popup fallback.
2. **Remote images.** `images.chesscomfiles.com` sends no CORP header. Avatars and flags simply
   stop rendering, and it is not our origin to fix.

The single-threaded build costs one core and buys past all of it. Strength is capped by
`UCI_Elo` well below what one core reaches, so the core count is not the limiting factor —
see the consequences section of [ADR 0002](adr/0002-browser-engine.md).

## If threads are ever genuinely needed

Deep local analysis of a whole game in the tab is the plausible reason; a faster bot is not.
The scoped version — isolation on the play route only, the rest of the site untouched — goes in
`apps/web/next.config.ts`:

```ts
const config: NextConfig = {
  async headers() {
    return [
      {
        source: '/play/:path*',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
      },
    ];
  },
};
```

Then, and only then, switch `ENGINE_FILE` in `scripts/fetch-stockfish.mjs` to the threaded
build (`stockfish-18-lite.js` / `.wasm`) and set `Threads` in
`apps/web/lib/engine/stockfish-engine.ts`.

Before doing that, know what it costs:

- Same-origin subresources stay fine (`/engines/*` included) — it is cross-origin ones that
  break. Audit every one used under `/play`, and expect opponent avatars to be among them.
- Navigating between `/play` and the rest of the app stops being a client-side transition: the
  browser must tear down the document to change isolation state.
- Verify with `crossOriginIsolated === true` in the console on `/play` and `false` on
  `/dashboard`, then sign out and back in _through a fresh browser profile_. The auth breakage
  does not reproduce on a warm session.

## Strength

`UCI_LimitStrength` plus `UCI_Elo`, clamped to the range Stockfish 18 accepts (**1320–3190**).
The mapping is a pure function in `packages/chess/src/bot.ts`, unit tested, and is the only
place that decides how strong a bot is.

Below 1320 Stockfish cannot be weakened except by crippling its search, which produces the kind
of blunder no 900-rated human makes — an engine playing a 12-ply-deep move and then hanging a
queen for nothing. That is what Maia exists for. Bots under 1320 are out of scope until Lc0
hosting is answered (docs/architecture.md §14).

Search time per bot move is `BOT_MOVE_TIME_MS` (300 ms). It is a responsiveness knob, not a
strength knob: at a capped Elo, more thinking time does not make the engine play better.

## Troubleshooting

| Symptom                                    | Cause                                                                                                                                                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Engine failed to load" on `/play`         | `public/engines/` is empty. Run `npm run engine:fetch`.                                                                                                                                                                 |
| `npm run engine:fetch` fails on a checksum | Either the pin was bumped without updating the hash, or the download was tampered with or truncated. Never "fix" it by pasting in the hash the script just computed unless you have checked it against the npm tarball. |
| Board accepts moves, bot never replies     | Look for `bestmove` in the console with `?engineLog=1` on the URL. A UCI option the build rejects (`Threads` on a single build, an out-of-range `UCI_Elo`) makes Stockfish ignore the whole `setoption` line silently.  |
| First move after load takes seconds        | Expected on a cold cache: 7 MB of WASM to fetch and compile. It is served immutable, so it is once per deploy.                                                                                                          |
