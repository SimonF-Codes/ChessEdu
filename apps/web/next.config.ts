import type { NextConfig } from 'next';

const config: NextConfig = {
  // The workspace packages ship TypeScript source rather than a build step.
  transpilePackages: ['@chessedu/db', '@chessedu/chess', '@chessedu/chesscom'],
  experimental: {
    // Server actions handle the account link; keep the payload small.
    serverActions: { bodySizeLimit: '1mb' },
  },
  eslint: {
    // Lint runs once from the repo root in CI, not again per app.
    ignoreDuringBuilds: true,
  },
};

export default config;
