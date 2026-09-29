import Link from 'next/link';
import { notFound } from 'next/navigation';

import { db } from '@chessedu/db';

import { loadLearnView } from '../../../../../lib/line-drill';
import { requireUser } from '../../../../../lib/session';
import { type LearnLineData, LearnLine } from './learn-line';

export const metadata = { title: 'Learn a line — ChessEdu' };

/**
 * Learn mode: walk a line at your own pace with the tutor explaining every move. It reads and
 * writes nothing — no attempt, no schedule — because learning is not measurement
 * (docs/adr/0008-computed-tutor-and-learn-mode.md). The explanations are computed in the browser
 * from the stored line; no model is called.
 */
export default async function LearnPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ply?: string }>;
}) {
  await requireUser();
  const [{ id }, { ply }] = await Promise.all([params, searchParams]);

  const view = await loadLearnView({ db: db(), lineId: id });
  if (view === null) notFound();

  const { line, siblings } = view;
  const toData = (stored: { id: string; name: string; plies: typeof line.plies }) => ({
    id: stored.id,
    name: stored.name,
    // `facts` is absent on lines stored before ADR 0008; make that an explicit null.
    plies: stored.plies.map((p) => ({ ...p, facts: p.facts ?? null })),
  });

  const data: LearnLineData = {
    ...toData(line),
    eco: line.eco,
    family: line.family,
    learnerColor: line.learnerColor,
  };
  const start = Math.min(Math.max(Math.trunc(Number(ply)) || 0, 0), line.plies.length);

  return (
    <div className="space-y-6">
      <Link href="/lines" className="text-sm text-neutral-500 hover:underline">
        ← All lines
      </Link>
      <LearnLine key={line.id} line={data} siblings={siblings.map(toData)} startAt={start} />
    </div>
  );
}
