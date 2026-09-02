import { requireUser } from '../../../lib/session';
import { PlayBoard } from './play-board';

export const metadata = { title: 'Play — ChessEdu' };

export default async function PlayPage() {
  await requireUser();

  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Play</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Stockfish, capped at a rating, running in this tab rather than on a server — so a move
          costs nothing and never queues behind the analysis of your history. Games played here are
          not saved and are not part of that history.
        </p>
      </div>

      <PlayBoard />
    </div>
  );
}
