import { canonicalJson } from '@momonga/foundation';
import type { CreateResponseBody, Usage } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import { tokensOfText } from './fake-gateway.ts';
import { makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

export type FirstRequest = { inputUpper: number; toolTokens: number };

export const firstRequestOf = async (task = 'Work'): Promise<FirstRequest> => {
  const env = await makeEnv();
  env.gateway.script.push(textStep('probe'));
  const run = await env.enqueue(task);
  await env.runOnce(env.worker());
  const [first] = env.ofType(run.id, 'model.requested');
  if (first?.budget === undefined) throw new Error('the probe run sent no model request with a budget record');
  const body = first.body as CreateResponseBody;
  return {
    inputUpper: first.budget.reservedTokens - first.budget.maxOutputTokens,
    toolTokens: (body.tools ?? []).reduce((sum, tool) => sum + tokensOfText(canonicalJson(tool)), 0),
  };
};

export const SUMMARY_ONLY_LIMIT = 200_000;

const SUMMARY_ROOM_ABOVE_FIRST_INPUT = 100;

export type SummaryOnlyBudget = { limits: { maxTotalTokens: number }; left: number; usageUpTo(spentBefore?: number): Usage };

export const summaryOnlyBudget = async (task = 'Work'): Promise<SummaryOnlyBudget> => {
  const first = await firstRequestOf(task);
  if (first.toolTokens <= 3 * SUMMARY_ROOM_ABOVE_FIRST_INPUT) throw new Error(`the offered tools count ${first.toolTokens} tokens, too few to tell a tool step from a summary step by size`);
  const left = first.inputUpper + SUMMARY_ROOM_ABOVE_FIRST_INPUT;
  return {
    limits: { maxTotalTokens: SUMMARY_ONLY_LIMIT },
    left,
    usageUpTo: (spentBefore = 0) => usageOf(10, SUMMARY_ONLY_LIMIT - left - spentBefore - 10),
  };
};
