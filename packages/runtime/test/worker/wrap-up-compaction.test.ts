import { describe, expect, it } from 'vitest';
import { COMPACT_AT, ESTIMATED_CHARACTERS_PER_TOKEN, summaryItemTokensFor, summaryTokenCapFor, tokensForText } from '@momonga/protocol';
import { defaultContextSettings } from '@momonga/config';
import { DEFAULT_KEEP_RECENT_STEPS, inputCeilingFor, proactiveGainFor } from '@momonga/context';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';
import { bigStep, padOf, withinTurnWorker } from './within-turn-support.ts';

const CONTEXT_WINDOW = 4000;
const proactiveBarTokens = (): number => proactiveGainFor(summaryItemTokensFor(summaryTokenCapFor(capabilitiesFor(CONTEXT_WINDOW))), 0);
const highWaterTokens = (): number => Math.floor((COMPACT_AT.num * inputCeilingFor(capabilitiesFor(CONTEXT_WINDOW))) / COMPACT_AT.den);

const stepBandBelowHighWater = (stepsBelow: number): { lower: number; upper: number } => ({
  lower: Math.ceil(proactiveBarTokens() / (stepsBelow + 1 - DEFAULT_KEEP_RECENT_STEPS)),
  upper: Math.floor(highWaterTokens() / (stepsBelow + 0.5)),
});

const STEPS_BELOW_HIGH_WATER = (() => {
  let stepsBelow = DEFAULT_KEEP_RECENT_STEPS;
  while (stepBandBelowHighWater(stepsBelow).lower > stepBandBelowHighWater(stepsBelow).upper) stepsBelow++;
  return stepsBelow;
})();
const STEP_COUNT = STEPS_BELOW_HIGH_WATER + 1;

const stepPadChars = (): number => {
  const { lower, upper } = stepBandBelowHighWater(STEPS_BELOW_HIGH_WATER);
  const stepTokens = Math.floor((lower + upper) / 2);
  const envelopeTokens = tokensForText(JSON.stringify({ name: 'Big', arguments: JSON.stringify({ letter: 'a', size: 0, pad: '' }) }));
  return (stepTokens - envelopeTokens) * ESTIMATED_CHARACTERS_PER_TOKEN;
};

const paddedSteps = () => Array.from({ length: STEP_COUNT }, (_unused, index) => bigStep(`k${index}`, { letter: 'a', size: 0, pad: padOf(index, stepPadChars()) }));

describe('wrap-up build', () => {
  it('makes no proactive compaction call although the context is above the high-water mark', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(4000) });
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.settings.contextValue = defaultContextSettings();
    env.gateway.script.push(...paddedSteps(), textStep('Here is what I did.'));
    const run = await env.enqueue('Fill the context', { limits: { maxSteps: STEP_COUNT } });

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'max_steps' });
    expect(env.gateway.streams).toHaveLength(STEP_COUNT + 1);
    expect(env.gateway.streams[STEP_COUNT]?.body.tool_choice).toBe('none');
    expect(env.gateway.compacts).toEqual([]);
    expect(env.ofType(run.id, 'context.compacted')).toEqual([]);
  });

  it('compacts proactively at the same step when the run is not wrapping up', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(4000) });
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.settings.contextValue = defaultContextSettings();
    env.gateway.script.push(...paddedSteps(), textStep('done'));
    const run = await env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(1);
  });
});
