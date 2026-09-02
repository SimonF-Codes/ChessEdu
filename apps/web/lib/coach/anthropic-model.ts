import Anthropic from '@anthropic-ai/sdk';

import type { CommentaryModel } from './annotate';

/**
 * The Anthropic binding for the coach. Server-side only: the key is read from the environment
 * and never reaches the browser — see the security posture in docs/architecture.md.
 *
 * This is the one file in the coach that does I/O, and the only one not unit tested; every
 * decision worth testing lives behind the `CommentaryModel` interface in annotate.ts.
 */

export const COACH_MODEL = 'claude-opus-5';

/** A few explanations of a few sentences each. Generous, but nowhere near a timeout. */
export const COACH_MAX_TOKENS = 4096;

/** Whether coaching prose can be requested at all. The walkthrough works either way. */
export function isCoachConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function anthropicModel(options?: {
  client?: Anthropic;
  model?: string;
  maxTokens?: number;
}): CommentaryModel {
  const model = options?.model ?? COACH_MODEL;
  const maxTokens = options?.maxTokens ?? COACH_MAX_TOKENS;

  return {
    async complete({ system, prompt, signal }) {
      const client = options?.client ?? new Anthropic();

      const response = await client.messages.create(
        {
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal },
      );

      if (response.stop_reason === 'refusal') {
        throw new Error('the coaching model declined to answer');
      }

      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
    },
  };
}
