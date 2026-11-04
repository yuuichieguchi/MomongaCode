import { describe, expect, it } from 'vitest';
import { ESTIMATED_ERROR_BOUND_RATIO, marginFloorFor } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import { PRIMARY_TARGET, fakeCounterOf, inputTokensOf } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { textStep } from './scripts.ts';

const WINDOW = 8192;
const FLOOR = marginFloorFor(WINDOW);
const RATIO = 0.25;
const FALLBACK_TARGET = 'secondary';
const LARGE_TASK = `Echo something ${'padding '.repeat(2200)}`;

const calibratedExactFirst = (): Capabilities => capabilitiesFor(WINDOW, { maxOutputTokens: 1024, tokenCounting: 'exact', tokenErrorRatio: RATIO });
const estimatedFallback = (): Capabilities => capabilitiesFor(WINDOW, { maxOutputTokens: 1024, tokenCounting: 'estimated' });
const mergedAlias = (): Capabilities =>
  capabilitiesFor(WINDOW, { maxOutputTokens: 1024, tokenCounting: 'estimated', tokenErrorRatio: Math.max(RATIO, ESTIMATED_ERROR_BOUND_RATIO) });

const aliasEnv = async (): Promise<Env> => {
  const env = await makeEnv({ capabilities: mergedAlias() });
  env.gateway.capabilitiesByTarget.set(PRIMARY_TARGET, calibratedExactFirst());
  env.gateway.capabilitiesByTarget.set(FALLBACK_TARGET, estimatedFallback());
  env.gateway.targetsByAlias[env.session.modelAlias] = [PRIMARY_TARGET, FALLBACK_TARGET];
  env.gateway.countMethod = 'exact';
  return env;
};

const measuredCount = async (): Promise<number> => {
  const env = await aliasEnv();
  env.gateway.script.push(textStep('Done.'));
  env.enqueue(LARGE_TASK);
  await env.runOnce(env.worker());
  return inputTokensOf(env.gateway.streams[0]!.body);
};

describe('a configured tokenErrorRatio of the first target on a mixed alias', () => {
  it('applies the calibration to the exact replies of that target when the merged counting is estimated', async () => {
    const count = await measuredCount();
    const reported = Math.floor(count * 0.85);
    expect(count - reported).toBeGreaterThan(FLOOR);
    expect(count - reported).toBeLessThan(FLOOR + Math.ceil(RATIO * count));
    const env = await aliasEnv();
    env.gateway.script.push(textStep('Done.', { usage: usageOf(reported, 5) }));
    const run = env.enqueue(LARGE_TASK);

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'meter.observed')).toMatchObject([{ target: PRIMARY_TARGET, counter: fakeCounterOf(PRIMARY_TARGET), fallback: false, counted: count, reported, tokenCounting: 'exact', tokenErrorRatio: RATIO }]);
    expect({ status: env.run(run.id).status, error: env.run(run.id).error?.code }).toEqual({ status: 'COMPLETED', error: undefined });
  });
});
