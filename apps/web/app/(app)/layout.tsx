import Link from 'next/link';

import { signOut } from '../../auth';
import { requireUser } from '../../lib/session';

/**
 * Everything under this layout requires a signed-in user.
 *
 * The check lives here rather than in middleware because sessions are stored in the database
 * and cannot be validated on the edge — see the note in auth.ts. Each server action re-checks
 * independently; this layout is for the redirect, not the authorisation.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-6">
      <header className="flex items-center justify-between border-b border-neutral-200 py-4 dark:border-neutral-800">
        <nav className="flex items-center gap-6 text-sm">
          <Link href="/dashboard" className="font-semibold">
            ChessEdu
          </Link>
          <Link href="/dashboard" className="text-neutral-600 hover:underline dark:text-neutral-400">
            Dashboard
          </Link>
          <Link
            href="/openings"
            className="text-neutral-600 hover:underline dark:text-neutral-400"
          >
            Openings
          </Link>
          <Link href="/link" className="text-neutral-600 hover:underline dark:text-neutral-400">
            Accounts
          </Link>
        </nav>
        <form
          action={async () => {
            'use server';
            await signOut({ redirectTo: '/' });
          }}
        >
          <button type="submit" className="text-sm text-neutral-500 hover:underline">
            Sign out {user.name ? `(${user.name})` : ''}
          </button>
        </form>
      </header>
      <main className="flex-1 py-8">{children}</main>
    </div>
  );
}
