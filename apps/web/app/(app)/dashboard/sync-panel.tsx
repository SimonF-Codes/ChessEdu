'use client';

import { useState, useTransition } from 'react';

import type { SyncStatus } from '../../../lib/sync-status';

import { requestSync } from './actions';

/**
 * What the sync is doing, and a way to ask for another one.
 *
 * Every line here is derived from a real job row. The page this replaced printed "Sync queued."
 * whenever the game count was zero, which said the same thing whether a sync was running, had
 * failed, or had never been asked for.
 */
export function SyncPanel({
  status,
  summary,
  unattended,
  backlog,
}: {
  status: SyncStatus;
  summary: string;
  unattended: boolean;
  backlog: number;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  const tone =
    status.state === 'failed'
      ? 'border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40'
      : 'border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/40';

  return (
    <div className={`space-y-3 rounded-lg border p-4 ${tone}`}>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">{summary}</p>

      {status.state === 'failed' && status.error ? (
        <pre className="overflow-x-auto rounded bg-neutral-900 p-3 text-xs text-red-200">
          {status.error}
        </pre>
      ) : null}

      {unattended ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          It has been queued for a while with nothing picking it up. That usually means no worker
          is running.
        </p>
      ) : null}

      {backlog > 0 ? (
        <p className="text-xs text-neutral-500">
          {backlog.toLocaleString()} {backlog === 1 ? 'game' : 'games'} still to analyse.
        </p>
      ) : null}

      {status.state === 'queued' || status.state === 'running' ? null : (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const outcome = await requestSync();
              setResult(outcome.ok ? 'Queued.' : outcome.reason);
            })
          }
          className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {pending ? 'Queueing…' : status.state === 'never' ? 'Sync my games' : 'Sync again'}
        </button>
      )}

      {result ? <p className="text-xs text-neutral-500">{result}</p> : null}
    </div>
  );
}
