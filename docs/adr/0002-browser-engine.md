# ADR 0002: A single-threaded Stockfish in the browser, and no cross-origin isolation

- **Status:** accepted
- **Date:** 2026-08-27

## Context

[ADR 0001](0001-stack.md) put `stockfish.wasm` in the browser "for anything interactive" and
left it at that. Building the Play page forces the detail, because the engine ships in two
incompatible shapes:

- **Multi-threaded.** Uses `SharedArrayBuffer`, and therefore only runs on a page the browser
  has marked _cross-origin isolated_. That mark is bought with two response headers on the
  document:

  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```

- **Single-threaded.** No `SharedArrayBuffer` anywhere in the build, so no headers, so no
  isolation. One core.

Cross-origin isolation is not a local setting. It changes how the whole document relates to
every other origin it touches, and this app touches several:

- **Google sign-in.** `COOP: same-origin` severs `window.opener` between the document and any
  window it opens, which is the channel every popup-based Google sign-in uses. Auth.js is on a
  full-page redirect today, so the redirect itself survives — but the failure is silent and
  arrives the day anyone adds One Tap, the Google-hosted button, or a popup fallback. Worse,
  `COEP: require-corp` blocks Google-hosted subresources outright: nothing loads cross-origin
  unless _the other origin_ opts in with `Cross-Origin-Resource-Policy`, and Google's endpoints
  do not.
- **Remote images.** Chess.com avatars and country flags come from `images.chesscomfiles.com`,
  which sends no `Cross-Origin-Resource-Policy` header. Under `require-corp` every one of them
  fails to load. We cannot add a header to someone else's CDN, so the only fixes are proxying
  every image through our own origin or `COEP: credentialless`, which Safari does not support.

So the honest framing is not "should the engine have threads" but "is threading worth breaking
sign-in and every remote image for". Which turns on how much engine strength we actually need
— and the answer is: very little. The bot is _deliberately capped_ below full strength (README:
"Stockfish at capped ELO... tuned just above my current level"), and a hint or an eval bar is a
sub-second search.

## Decision

**Ship the single-threaded build. Set no COOP or COEP header anywhere, at any scope.**

Concretely, `stockfish-18-lite-single.{js,wasm}` from
[`nmrugg/stockfish.js`](https://github.com/nmrugg/stockfish.js) v18.0.8, run in an ordinary Web
Worker, fetched into `apps/web/public/engines/` at build time and never committed — the rule
`.gitignore` already states for engine binaries. The runbook is
[browser-engine.md](../browser-engine.md).

`Threads` is never set; the `lite` net is embedded in the `.wasm`, so there is one file to serve
and no weights to fetch separately.

## Alternatives rejected

- **Multi-threaded engine, headers site-wide.** The option that costs the most for the least.
  It breaks remote images on every page, including pages that will never run an engine, and
  leaves a tripwire under the auth flow for whoever next touches sign-in. Paying that across the
  whole site to speed up a search we then throw strength away from is backwards.

- **Multi-threaded engine, headers scoped to `/play` only.** Genuinely possible — Next's
  `headers()` takes a `source` matcher, and the recipe is written down in
  [browser-engine.md](../browser-engine.md) in case a future feature needs it. Rejected for now
  because scoping narrows the blast radius without changing its nature: `/play` is exactly where
  an opponent avatar belongs, so the images break on the one route that pays for the headers.
  It also splits the app into two isolation domains, which is a real cognitive cost — client
  navigation between an isolated and a non-isolated route forces a full document load, and the
  next person to add a cross-origin asset has to know which half of the site they are in. The
  prize is engine strength the bot is designed not to use.

- **Run the bot on the Fly worker instead.** The engine is already there, native and fast. But
  every bot move becomes a network round trip plus a queue hop, and interactive moves would
  compete for the same single machine as the multi-minute batch analysis — the precise coupling
  ADR 0001 introduced the browser engine to avoid.

- **`COEP: credentialless` instead of `require-corp`.** Lets no-CORP images through in Chromium,
  and is not implemented in Safari. A cross-browser bug that only appears on some browsers is
  worse than a decision.

- **Proxying remote images through our own origin.** Would satisfy `require-corp`, at the cost
  of an image proxy to write, cache and pay for, on a personal project, to enable threads we do
  not need.

- **asm.js (`stockfish-18-asm.js`) as a fallback.** WebAssembly is available in every browser
  this project targets. A second engine build is a second thing to keep working.

- **Maia or Lc0 in the browser.** Explicitly out of scope. They are a different problem —
  weights measured in tens of megabytes and a different runtime — and remain the open question
  ADR 0001 §9 records. Nothing here forecloses them: the engine sits behind the transport
  seam in `apps/web/lib/engine/`, which takes any worker speaking UCI.

## Consequences

- One core, and the build says so: it reports `option name Threads type spin default 1 min 1
max 1`. Measured in Chrome on this machine it searches about 1.3M nodes/second and reaches
  depth 15 in the 300 ms a bot move is given. Strength is set by `UCI_Elo`, not by nodes, so
  the cap does the limiting long before the core count does.
- **No page in this app may assume cross-origin isolation.** `SharedArrayBuffer` is undefined
  and `performance.now()` stays coarse. If that ever changes, it changes in this ADR first.
- Google sign-in and remote images keep working with no proxy, no allowlist, and no per-route
  header rules — the reason to revisit is a _new_ feature that needs threads, not a faster bot.
- Stockfish's own `UCI_Elo` floor is 1320. Below that the engine can only be weakened by
  degrading its search, which produces blunders no human of that rating would make. Bots below
  1320 are a Maia problem, not a Stockfish one, and are out of scope.
- The engine is GPLv3. It is fetched as a standalone asset and served as-is with its license
  banner intact; nothing in this repository links against it or derives from it.
