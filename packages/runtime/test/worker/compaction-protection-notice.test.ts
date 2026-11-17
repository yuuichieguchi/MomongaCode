import { describe, expect, it } from 'vitest';
import { ESTIMATED_CHARACTERS_PER_TOKEN, largestSummaryCapFor, summaryPromptTokensFor, tokensForText } from '@momonga/protocol';
import type { InputItem } from '@momonga/protocol';
import { summaryInputCeilingFor } from '../../../context/src/budget.ts';
import { omittedMarker } from '../../../context/src/tool-output.ts';
import { defaultContextSettings } from '@momonga/config';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';
import { bigStep, inputOf, padOf, withinTurnWorker } from './within-turn-support.ts';

const STEPS_SHRUNK_PREFIX = 'recent steps of the current turn were reduced';
const STEPS_SHRUNK_TO_ONE = 'recent steps of the current turn were reduced from 4 to 1 because the context budget was exceeded';

const CONTEXT_WINDOW = 4000;
const PADDED_STEPS_COMPACTED = 3;
const SHORT_STEPS_COMPACTED = 2;
const EMPTY_OUTPUT_TOKENS = 24;
const TASK = 'Fill the context';

const stepItemsTokens = (pad: string): number => {
  const callId = `call_${'0'.repeat(32)}`;
  return tokensForText(JSON.stringify([
    { type: 'function_call', id: 'fc_k0', call_id: callId, name: 'Big', arguments: JSON.stringify({ letter: 'a', size: 0, pad }), status: 'completed' },
    { type: 'function_call_output', call_id: callId, output: omittedMarker(EMPTY_OUTPUT_TOKENS, 'a'.repeat(64), undefined) },
  ]));
};

const padCharsFittingOneSummaryRequest = (): number => {
  const capabilities = capabilitiesFor(CONTEXT_WINDOW);
  const summaryCap = largestSummaryCapFor(capabilities);
  const taskTokens = tokensForText(JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: TASK }] }));
  const shortStepsTokens = (SHORT_STEPS_COMPACTED) * stepItemsTokens('');
  const regionRoom = summaryInputCeilingFor(capabilities, summaryCap) - summaryPromptTokensFor(undefined) - summaryCap - taskTokens - shortStepsTokens;
  const tokensPerStep = Math.floor(regionRoom / PADDED_STEPS_COMPACTED);
  return (tokensPerStep - stepItemsTokens('')) * ESTIMATED_CHARACTERS_PER_TOKEN;
};

const callIdsIn = (items: readonly InputItem[]): string[] =>
  items.flatMap((item) => (item.type === 'function_call_output' ? [item.call_id] : []));

describe('a compaction that runs at a reduced protection level', () => {
  it('journals exactly one recent_steps_shrunk notice naming the reduced step count, although the rebuild after it fits at level 0', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(CONTEXT_WINDOW) });
    env.settings.contextValue = defaultContextSettings();
    env.gateway.script.push(
      bigStep('t0', { letter: 'a', size: 0, pad: 'x' }),
      bigStep('t1', { letter: 'a', size: 0, pad: 'y' }),
      ...[0, 1, 2, 3].map((index) => bigStep(`k${index}`, { letter: 'a', size: 0, pad: padOf(index, padCharsFittingOneSummaryRequest()) })),
      textStep('done'),
    );
    env.gateway.compactSummaries.push('S1');
    const run = await env.enqueue(TASK);

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(1);
    const compacted = callIdsIn(inputOf(env.gateway.compacts[0]?.request ?? {}));
    const allCalls = env.ofType(run.id, 'tool.call').map((event) => event.callId);
    expect(allCalls).toHaveLength(6);
    expect(compacted, 'every step before the latest fits one summary request, so the compaction replaces them all and keeps only the latest step').toEqual(allCalls.slice(0, 5));
    const afterCompaction = env.gateway.streams.at(-1);
    expect(callIdsIn(inputOf(afterCompaction?.body ?? {}))).toEqual(allCalls.slice(5));
    const notices = env.ofType(run.id, 'notice').map((event) => event.message);
    expect(notices.filter((message) => message.startsWith(STEPS_SHRUNK_PREFIX))).toEqual([STEPS_SHRUNK_TO_ONE]);
  });
});
