import { describe, expect, it } from 'vitest';
import { COMPACT_AT, ESTIMATED_CHARACTERS_PER_TOKEN, tokensForText } from '@momonga/protocol';
import { defaultContextSettings } from '@momonga/config';
import { inputCeilingFor } from '../../../context/src/budget.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';
import { bigStep, padOf, withinTurnWorker } from './within-turn-support.ts';

const CONTEXT_WINDOW = 4000;
const STEPS_BELOW_HIGH_WATER = 5;
const STEP_SCALE_FOR_SUMMARY_ITEM = 1.06;

const stepPadChars = (): number => {
  const ceiling = inputCeilingFor(capabilitiesFor(CONTEXT_WINDOW));
  const highWaterTokens = Math.floor((COMPACT_AT.num * ceiling) / COMPACT_AT.den);
  const stepTokens = Math.floor((highWaterTokens / (STEPS_BELOW_HIGH_WATER + 0.5)) * STEP_SCALE_FOR_SUMMARY_ITEM);
  const envelopeTokens = tokensForText(JSON.stringify({ name: 'Big', arguments: JSON.stringify({ letter: 'a', size: 0, pad: '' }) }));
  return (stepTokens - envelopeTokens) * ESTIMATED_CHARACTERS_PER_TOKEN;
};

const sixPaddedSteps = () => [0, 1, 2, 3, 4, 5].map((index) => bigStep(`k${index}`, { letter: 'a', size: 0, pad: padOf(index, stepPadChars()) }));

describe('wrap-up build', () => {
  it('makes no proactive compaction call although the context is above the high-water mark', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(4000) });
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.settings.contextValue = defaultContextSettings();
    env.gateway.script.push(...sixPaddedSteps(), textStep('Here is what I did.'));
    const run = await env.enqueue('Fill the context', { limits: { maxSteps: 6 } });

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'max_steps' });
    expect(env.gateway.streams).toHaveLength(7);
    expect(env.gateway.streams[6]?.body.tool_choice).toBe('none');
    expect(env.gateway.compacts).toEqual([]);
    expect(env.ofType(run.id, 'context.compacted')).toEqual([]);
  });

  it('compacts proactively at the same step when the run is not wrapping up', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(4000) });
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.settings.contextValue = defaultContextSettings();
    env.gateway.script.push(...sixPaddedSteps(), textStep('done'));
    const run = await env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(1);
  });
});
