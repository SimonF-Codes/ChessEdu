import Link from 'next/link';

import { type RecurringDeviation, type RepertoireNode, topLines } from '@chessedu/chess';

import { loadOpenings } from '../../../lib/openings';
import { requireUser } from '../../../lib/session';

/**
 * The repertoire the player actually plays, and where it leaves theory.
 *
 * Everything shown here is computed in `@chessedu/chess` and read in `lib/openings.ts`. This
 * file renders; it decides nothing.
 */

/** SAN moves as numbered movetext: `['e4','c5','Nf3'] -> "1. e4 c5 2. Nf3"`. */
function formatLine(san: readonly string[]): string {
  const parts: string[] = [];
  for (const [index, move] of san.entries()) {
    if (index % 2 === 0) parts.push(`${index / 2 + 1}.`);
    parts.push(move);
  }
  return parts.join(' ');
}

function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function LineTable({ title, root }: { title: string; root: RepertoireNode }) {
  const lines = topLines(root, 8);

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <span className="text-sm text-neutral-500">
          {root.games} {root.games === 1 ? 'game' : 'games'}
        </span>
      </div>

      {lines.length === 0 ? (
        <p className="text-sm text-neutral-500">No games with this colour yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-neutral-500">
            <tr className="border-b border-neutral-200 dark:border-neutral-800">
              <th className="py-2 font-medium">Line</th>
              <th className="py-2 text-right font-medium">Games</th>
              <th className="py-2 text-right font-medium">Score</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr
                key={line.san.join(' ')}
                className="border-b border-neutral-100 align-top dark:border-neutral-900"
              >
                <td className="py-2 pr-4">
                  <div className="font-mono text-xs">{formatLine(line.san)}</div>
                  <div className="text-neutral-500">
                    {line.name ?? 'Not in theory'}
                    {line.eco ? ` · ${line.eco}` : ''}
                  </div>
                </td>
                <td className="py-2 text-right tabular-nums">{line.games}</td>
                <td className="py-2 text-right tabular-nums">{formatScore(line.score)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DeviationCard({ deviation }: { deviation: RecurringDeviation }) {
  return (
    <li className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="font-medium">{deviation.name ?? 'Outside named theory'}</div>
          <div className="font-mono text-xs text-neutral-500">
            {deviation.line.length === 0 ? 'from the start' : formatLine(deviation.line)}
          </div>
        </div>
        <div className="text-right text-sm">
          <div className="tabular-nums">
            {deviation.games} {deviation.games === 1 ? 'game' : 'games'} ·{' '}
            {formatScore(deviation.score)}
          </div>
          <div className="text-neutral-500">
            {deviation.wins}W {deviation.draws}D {deviation.losses}L
          </div>
        </div>
      </div>

      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-neutral-500">You play</dt>
          <dd className="font-mono text-xs">
            {deviation.played
              .map((move) => `${move.san}${move.games > 1 ? ` (${move.games})` : ''}`)
              .join(', ')}
          </dd>
        </div>
        <div>
          <dt className="text-neutral-500">Theory plays</dt>
          <dd className="font-mono text-xs">
            {deviation.bookMoves
              .slice(0, 6)
              .map((move) => move.san)
              .join(', ')}
            {deviation.bookMoves.length > 6 ? ` +${deviation.bookMoves.length - 6}` : ''}
          </dd>
        </div>
      </dl>

      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {deviation.avgCentipawnLoss === null ? (
          <span className="text-neutral-500">Not analysed yet — no engine verdict to show.</span>
        ) : (
          <>
            Stockfish puts this at{' '}
            <span className="tabular-nums">{Math.round(deviation.avgCentipawnLoss)}</span>{' '}
            centipawns on average
            {deviation.worstClassification && deviation.worstClassification !== 'good'
              ? `, at worst a ${deviation.worstClassification}`
              : ''}
            , or <span className="tabular-nums">{Math.round(deviation.cost)}</span> across every
            game you have played it.
          </>
        )}
      </p>
    </li>
  );
}

export default async function OpeningsPage() {
  const user = await requireUser();
  const view = await loadOpenings(user.id);

  if (!view) {
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">No repertoire yet</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Link your Chess.com account and ChessEdu will build your opening repertoire out of the
          games you have actually played.
        </p>
        <Link
          href="/link"
          className="inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          Link Chess.com
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Openings</h1>
        <p className="text-sm text-neutral-500">
          {view.gameCount === 0
            ? 'Sync queued. Your repertoire will appear here as games are pulled in.'
            : `Built from your ${view.gameCount} most recent games. Theory from the Lichess ECO data set.`}
        </p>
      </div>

      {view.gameCount > 0 ? (
        <>
          <section className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold tracking-tight">Where you leave theory</h2>
              <p className="text-sm text-neutral-500">
                Positions where theory had a move and you played another, ranked by how often you
                play it times what the engine says it costs.
              </p>
            </div>

            {view.deviations.length === 0 ? (
              <p className="text-sm text-neutral-500">
                Nothing to show yet — your games either stay in theory or run past the end of it.
              </p>
            ) : (
              <ul className="space-y-3">
                {view.deviations.map((deviation) => (
                  <DeviationCard key={deviation.key} deviation={deviation} />
                ))}
              </ul>
            )}

            {view.awaitingAnalysis && view.deviations.length > 0 ? (
              <p className="text-sm text-neutral-500">
                These are ranked by frequency alone — none of these games have been analysed yet.
              </p>
            ) : null}
          </section>

          <div className="grid gap-10 md:grid-cols-2">
            <LineTable title="As White" root={view.repertoire.white} />
            <LineTable title="As Black" root={view.repertoire.black} />
          </div>
        </>
      ) : null}
    </div>
  );
}
