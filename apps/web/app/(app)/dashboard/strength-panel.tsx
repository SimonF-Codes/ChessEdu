import {
  MIN_MOVES_PER_PHASE,
  PHASES,
  type Phase,
  type PhaseStrength,
  type StrengthProfile,
  practiceWeights,
} from '@chessedu/chess';

/**
 * The per-phase strength model, rendered.
 *
 * Every number on this panel comes from `game_analysis`, which is Stockfish output — see
 * section 9 of docs/architecture.md. This file formats; it never decides.
 */

const PHASE_LABELS: Record<Phase, string> = {
  opening: 'Opening',
  middlegame: 'Middlegame',
  endgame: 'Endgame',
};

const PHASE_BLURBS: Record<Phase, string> = {
  opening: 'Up to move 12, both armies intact',
  middlegame: 'Pieces on, plans over calculation',
  endgame: 'Queens and most pieces traded',
};

function formatAccuracy(accuracy: number | null): string {
  return accuracy === null ? '—' : `${accuracy.toFixed(1)}%`;
}

function PhaseCard({ strength, isFocus }: { strength: PhaseStrength; isFocus: boolean }) {
  const remaining = Math.max(0, MIN_MOVES_PER_PHASE - strength.moves);

  return (
    <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{PHASE_LABELS[strength.phase]}</h3>
          <p className="text-xs text-neutral-500">{PHASE_BLURBS[strength.phase]}</p>
        </div>
        {isFocus ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Weakest
          </span>
        ) : null}
      </div>

      <p className="mt-3 text-3xl font-semibold tabular-nums tracking-tight">
        {formatAccuracy(strength.accuracy)}
      </p>
      <p className="text-xs text-neutral-500">engine accuracy</p>

      <div
        className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
        role="presentation"
      >
        <div
          className="h-full rounded-full bg-neutral-900 dark:bg-white"
          style={{ width: `${Math.min(100, Math.max(0, strength.accuracy ?? 0))}%` }}
        />
      </div>

      <dl className="mt-4 space-y-1 text-xs text-neutral-500">
        <div className="flex justify-between">
          <dt>Avg. centipawn loss</dt>
          <dd className="tabular-nums text-neutral-700 dark:text-neutral-300">
            {strength.moves > 0 ? strength.averageCentipawnLoss : '—'}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>Blunders / 100 moves</dt>
          <dd className="tabular-nums text-neutral-700 dark:text-neutral-300">
            {strength.moves > 0 ? strength.blundersPerHundredMoves.toFixed(1) : '—'}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>Moves counted</dt>
          <dd className="tabular-nums text-neutral-700 dark:text-neutral-300">{strength.moves}</dd>
        </div>
      </dl>

      <p className="mt-3 text-xs text-neutral-500">
        {!strength.rated
          ? `${remaining} more moves in this phase before it counts.`
          : strength.deficit !== null && strength.deficit > 0.05
            ? `${strength.deficit.toFixed(1)} points behind your best phase.`
            : 'Your strongest phase.'}
      </p>
    </div>
  );
}

export function StrengthPanel({ profile }: { profile: StrengthProfile }) {
  const weights = practiceWeights(profile);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium">Strength by phase</h2>
        <p className="text-sm text-neutral-500">
          {profile.games} analysed {profile.games === 1 ? 'game' : 'games'} · {profile.moves} of
          your moves
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {PHASES.map((phase) => (
          <PhaseCard
            key={phase}
            strength={profile.phases[phase]}
            isFocus={profile.focus === phase}
          />
        ))}
      </div>

      <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">Where your practice should go</h3>
          <p className="text-xs text-neutral-500">
            {profile.focus
              ? `Weighted towards the ${PHASE_LABELS[profile.focus].toLowerCase()}.`
              : 'Even until a phase has enough moves to judge.'}
          </p>
        </div>

        <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          {PHASES.map((phase, index) => (
            <div
              key={phase}
              className={
                index === 0
                  ? 'bg-neutral-900 dark:bg-white'
                  : index === 1
                    ? 'bg-neutral-600 dark:bg-neutral-400'
                    : 'bg-neutral-400 dark:bg-neutral-600'
              }
              style={{ width: `${weights[phase] * 100}%` }}
            />
          ))}
        </div>

        <ul className="mt-3 grid gap-1 text-xs text-neutral-500 sm:grid-cols-3">
          {PHASES.map((phase) => (
            <li key={phase} className="flex justify-between gap-2 sm:block">
              <span>{PHASE_LABELS[phase]}</span>{' '}
              <span className="tabular-nums text-neutral-700 dark:text-neutral-300">
                {Math.round(weights[phase] * 100)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
