'use client';

import { useActionState, useState, useTransition } from 'react';

import type { StartLinkResult, VerifyLinkResult } from '../../../lib/link-account';
import { startLinkAction, verifyLinkAction } from './actions';

/**
 * Two steps, because that is what proving ownership without OAuth costs: ask for the username,
 * then wait while the user pastes a code into their Chess.com profile.
 */
export function LinkForm() {
  const [started, startAction, starting] = useActionState<StartLinkResult | null, FormData>(
    startLinkAction,
    null,
  );
  const [verified, setVerified] = useState<VerifyLinkResult | null>(null);
  const [verifying, startVerify] = useTransition();

  if (verified?.ok) {
    return (
      <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm dark:border-green-900 dark:bg-green-950">
        <p className="font-medium">Linked {verified.username}.</p>
        <p className="mt-1 text-neutral-600 dark:text-neutral-400">
          Your history is syncing now. You can remove the code from your Chess.com profile.
        </p>
      </div>
    );
  }

  if (started?.ok) {
    return (
      <div className="space-y-4">
        <ol className="space-y-3 text-sm">
          <li>
            1. Open your{' '}
            <a
              href="https://www.chess.com/settings"
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              Chess.com profile settings
            </a>
            .
          </li>
          <li>
            2. Put this code in your <strong>Location</strong> (or <strong>Name</strong>) field
            and save:
            <code className="mt-2 block rounded bg-neutral-100 px-3 py-2 font-mono text-xs dark:bg-neutral-900">
              {started.nonce}
            </code>
          </li>
          <li>3. Come back here and check. You can remove the code afterwards.</li>
        </ol>

        <button
          type="button"
          disabled={verifying}
          onClick={() => startVerify(async () => setVerified(await verifyLinkAction()))}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {verifying ? 'Checking…' : 'I have added the code'}
        </button>

        {verified && !verified.ok ? (
          <p className="text-sm text-red-600 dark:text-red-400">{verified.message}</p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={startAction} className="space-y-3">
      <label htmlFor="username" className="block text-sm font-medium">
        Chess.com username
      </label>
      <div className="flex gap-2">
        <input
          id="username"
          name="username"
          required
          autoComplete="off"
          spellCheck={false}
          className="w-64 rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={starting}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {starting ? 'Checking…' : 'Continue'}
        </button>
      </div>
      {started && !started.ok ? (
        <p className="text-sm text-red-600 dark:text-red-400">{started.message}</p>
      ) : null}
    </form>
  );
}
