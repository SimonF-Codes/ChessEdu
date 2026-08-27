/** Worker configuration, read once at boot so a missing value fails immediately. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export interface WorkerConfig {
  databaseUrl: string;
  chesscomContact: string;
  stockfishPath: string;
  stockfishDepth: number;
  stockfishThreads: number;
  stockfishHashMb: number;
  /** How long to wait before polling again when the queue is empty. */
  idlePollMs: number;
  workerId: string;
}

export function loadConfig(): WorkerConfig {
  return {
    databaseUrl: required('DATABASE_URL'),
    // Chess.com blocks requests without a descriptive User-Agent, so this is not optional.
    chesscomContact: required('CHESSCOM_CONTACT'),
    stockfishPath: process.env.STOCKFISH_PATH ?? '/usr/local/bin/stockfish',
    stockfishDepth: Number(process.env.STOCKFISH_DEPTH ?? 16),
    stockfishThreads: Number(process.env.STOCKFISH_THREADS ?? 2),
    stockfishHashMb: Number(process.env.STOCKFISH_HASH_MB ?? 512),
    idlePollMs: Number(process.env.IDLE_POLL_MS ?? 5000),
    workerId: process.env.FLY_MACHINE_ID ?? `local-${process.pid}`,
  };
}
