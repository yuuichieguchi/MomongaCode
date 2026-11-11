import { describe, expect, it } from 'vitest';
import type { InputItem } from '@momonga/protocol';
import { TOKEN_SETTINGS_OFF } from './fake-settings.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';
import { bigStep, inputOf, padOf, withinTurnWorker } from './within-turn-support.ts';

const STEPS_SHRUNK_PREFIX = 'recent steps of the current turn were reduced';
const STEPS_SHRUNK_TO_ONE = 'recent steps of the current turn were reduced from 4 to 1 because the context budget was exceeded';

const callIdsIn = (items: readonly InputItem[]): string[] =>
  items.flatMap((item) => (item.type === 'function_call_output' ? [item.call_id] : []));

describe('a compaction that runs at a reduced protection level', () => {
  it('journals exactly one recent_steps_shrunk notice naming the reduced step count, although the rebuild after it fits at level 0', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(4000) });
    env.settings.contextValue = TOKEN_SETTINGS_OFF;
    env.gateway.script.push(
      bigStep('t0', { letter: 'a', size: 0, pad: 'x' }),
      bigStep('t1', { letter: 'a', size: 0, pad: 'y' }),
      ...[0, 1, 2, 3].map((index) => bigStep(`k${index}`, { letter: 'a', size: 0, pad: padOf(index, 2600) })),
      textStep('done'),
    );
    env.gateway.compactSummaries.push('S1');
    const run = await env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(1);
    const compacted = callIdsIn(inputOf(env.gateway.compacts[0]?.request ?? {}));
    const allCalls = env.ofType(run.id, 'tool.call').map((event) => event.callId);
    expect(allCalls).toHaveLength(6);
    expect(compacted, 'the compaction kept only the latest step, so it ran at keepSteps 1 instead of the requested 4').toEqual(allCalls.slice(0, 5));
    const afterCompaction = env.gateway.streams.at(-1);
    expect(callIdsIn(inputOf(afterCompaction?.body ?? {}))).toEqual(allCalls.slice(5));
    const notices = env.ofType(run.id, 'notice').map((event) => event.message);
    expect(notices.filter((message) => message.startsWith(STEPS_SHRUNK_PREFIX))).toEqual([STEPS_SHRUNK_TO_ONE]);
  });
});
