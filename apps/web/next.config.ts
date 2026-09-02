import type { NextConfig } from 'next';

const config: NextConfig = {
  // The workspace packages ship TypeScript source rather than a build step.
  transpilePackages: ['@chessedu/db', '@chessedu/chess', '@chessedu/chesscom', '@chessedu/corpus'],
  experimental: {
    // Server actions handle the account link; keep the payload small.
    serverActions: { bodySizeLimit: '1mb' },
  },
  async headers() {
    return [
      {
        // The engine is 7 MB and its name carries its version, so it can be cached hard.
        source: '/engines/:file*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
  // Deliberately no Cross-Origin-Opener-Policy or Cross-Origin-Embedder-Policy, at any scope.
  // They would buy a multi-threaded Stockfish and cost Google sign-in and every remote image;
  // the browser engine is the single-threaded build for exactly that reason. Before adding
  // them, read docs/adr/0002-browser-engine.md — the recipe and its price are in
  // docs/browser-engine.md.
  eslint: {
    // Lint runs once from the repo root in CI, not again per app.
    ignoreDuringBuilds: true,
  },
};

export default config;
