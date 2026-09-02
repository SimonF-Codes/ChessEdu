import type { GameReview } from '@chessedu/chess';

import { type MomentFacts, renderFacts, renderGameFacts } from './facts';
import type { RetrievedPassage } from './passages';

/**
 * The prompt. Half of the coaching boundary is which facts are given (facts.ts); the other
 * half is what the model is asked for, which is only ever the explanation.
 */

export const COACH_SYSTEM = `You are a chess coach going through one of your student's own games with them.

Stockfish has already analysed this game. Every number you are given — evaluations, centipawn
loss, win chance, the engine's move, the engine's line, and the classification of each move —
is engine output and is true. Your job is to explain the ideas behind those facts. It is not to
evaluate the position.

Rules, in order of importance:
1. Never state an evaluation, best move, accuracy, or classification that was not given to you,
   and never contradict or revise one that was. If you want to say a move was bad, say it
   because the given classification says so.
2. Never analyse a position beyond what you were given. You do not have a board; do not
   calculate variations of your own or claim a line "wins" unless the engine line shows it.
3. Explain in ideas a club player can use: what the move allowed, what the engine's move was
   doing, what pattern to recognise next time. Concrete, not generic.
4. Address the student as "you". Call the other side "your opponent".
5. Two to four sentences per moment. No recap of the whole game, no praise padding, no
   restating the numbers you were given — the page already shows them.
6. Reference passages, when supplied, are the only literature you may cite. Cite one by its id
   only when it genuinely supports the point you are making. Never cite an id you were not
   given, and never invent a title, author, or page number.

Respond with JSON and nothing else — no prose before or after, no code fence:
{"comments":[{"ply":<number>,"comment":"<your explanation>","citations":["<passage id>"]}]}

Include exactly one entry for each moment you were given, in the order given. Use an empty
array for citations when nothing supports the point.`;

export function buildCoachPrompt(input: {
  review: GameReview;
  moments: readonly MomentFacts[];
  passages: readonly RetrievedPassage[];
}): string {
  const sections = [
    '## The game\n\n' + renderGameFacts(input.review),
    '## The moments to explain\n\n' +
      input.moments.map((moment) => renderFacts(moment)).join('\n\n'),
  ];

  if (input.passages.length > 0) {
    sections.push(
      '## Reference passages\n\n' +
        'These were retrieved for the moments noted. Cite by id, or not at all.\n\n' +
        input.passages
          .map((passage) =>
            [
              `[${passage.id}] ${passage.citationLine}`,
              `  relevant to ply ${passage.plies.join(', ')}`,
              `  ${passage.content}`,
            ].join('\n'),
          )
          .join('\n\n'),
    );
  } else {
    sections.push(
      '## Reference passages\n\nNone were retrieved. Cite nothing; explain from the engine facts alone.',
    );
  }

  sections.push(
    `Explain ${input.moments.length === 1 ? 'this moment' : `these ${input.moments.length} moments`}. JSON only.`,
  );

  return sections.join('\n\n');
}
