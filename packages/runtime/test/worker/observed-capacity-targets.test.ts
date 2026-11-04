import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import { PRIMARY_TARGET, inputTokensOf } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { textStep } from './scripts.ts';

const WINDOW = 8192;
const FALLBACK_TARGET = 'secondary';
const OVER_COUNT = 10;

const exactTarget = (): Capabilities => capabilitiesFor(WINDOW, { maxOutputTokens: 1024, tokenCounting: 'exact' });
const estimatedTarget = (): Capabilities => capabilitiesFor(WINDOW, { maxOutputTokens: 1024, tokenCounting: 'estimated' });

const observedEnv = async (targets: readonly string[]): Promise<Env> => {
  const env = await makeEnv({ capabilities: estimatedTarget() });
  env.settings.contextValue = { ...env.settings.contextValue, observedCapacity: true };
  env.gateway.capabilitiesByTarget.set(PRIMARY_TARGET, exactTarget());
  env.gateway.capabilitiesByTarget.set(FALLBACK_TARGET, estimatedTarget());
  env.gateway.targetsByAlias[env.session.modelAlias] = [...targets];
  env.gateway.countMethod = 'exact';
  return env;
};

describe('every target meter is folded at claim start and read for C (4.7, M4, M5)', () => {
  it('counts the first build input through the fallback target before that target ever answers', async () => {
    const env = await observedEnv([PRIMARY_TARGET, FALLBACK_TARGET]);
    env.gateway.script.push(textStep('Done.'));
    const run = env.enqueue('Echo something');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'meter.observed').map((event) => event.target)).toEqual([PRIMARY_TARGET]);
    expect(env.gateway.counts.some((request) => request.momonga?.target === FALLBACK_TARGET)).toBe(true);
  });
});

describe('the journaled meter keeps the report with context.observedCapacity (4.7, M5)', () => {
  it('journals kept = reported when the meter counted more than the server reported', async () => {
    const measuring = await observedEnv([PRIMARY_TARGET]);
    measuring.gateway.script.push(textStep('Done.'));
    measuring.enqueue('Echo something');
    await measuring.runOnce(measuring.worker());
    const counted = inputTokensOf(measuring.gateway.streams[0]!.body);
    const reported = counted - OVER_COUNT;

    const env = await observedEnv([PRIMARY_TARGET]);
    env.gateway.script.push(textStep('Done.', { usage: usageOf(reported, 5) }));
    const run = env.enqueue('Echo something');
    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'meter.observed')).toMatchObject([{ counted, reported, kept: reported }]);
  });
});
