import { redirect } from 'next/navigation';

import { signIn } from '../auth';
import { currentUser } from '../lib/session';

export default async function LandingPage() {
  const user = await currentUser();
  if (user) redirect('/dashboard');

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-8 px-6">
      <div className="space-y-4">
        <h1 className="text-4xl font-semibold tracking-tight">ChessEdu</h1>
        <p className="text-lg text-neutral-600 dark:text-neutral-400">
          A chess trainer built on your own games. Link your Chess.com account, let an engine go
          through your history, and get coaching, a repertoire and puzzles drawn from the
          mistakes you actually make.
        </p>
      </div>

      <form
        action={async () => {
          'use server';
          await signIn('google', { redirectTo: '/dashboard' });
        }}
      >
        <button
          type="submit"
          className="rounded-lg bg-neutral-900 px-5 py-3 text-sm font-medium text-white transition hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Continue with Google
        </button>
      </form>

      <p className="text-xs text-neutral-500">
        Sign-in is Google only, so no password is ever stored here. Linking a Chess.com account
        uses a one-time code on your public profile: ChessEdu never asks for your Chess.com
        password.
      </p>
    </main>
  );
}
