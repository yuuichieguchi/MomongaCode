import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import type { Capabilities, CountTokensRequest, CreateResponseBody, InputItem } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import { PRIMARY_TARGET, fakeCounterOf, inputTokensOf } from './fake-gateway.ts';
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
  env.gateway.chainsByModel[env.session.model] = [...targets];
  env.gateway.countMethod = 'exact';
  return env;
};

describe('every target meter is folded at claim start and read for C (4.7, M4, M5)', () => {
  it('counts the first build input through the fallback target before that target ever answers', async () => {
    const env = await observedEnv([PRIMARY_TARGET, FALLBACK_TARGET]);
    env.gateway.script.push(textStep('Done.'));
    const run = await env.enqueue('Echo something');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'meter.observed').map((event) => event.target)).toEqual([PRIMARY_TARGET]);
    expect(env.gateway.counts.some((request) => request.momonga?.target === FALLBACK_TARGET)).toBe(true);
  });
});

const inputOf = (body: CreateResponseBody): InputItem[] => {
  if (!Array.isArray(body.input)) throw new Error('the request carries no input items');
  return body.input;
};

const isSplitCountOf = (target: string, systemItem: string) => (request: CountTokensRequest): boolean => {
  if (request.momonga?.target !== target || request.momonga.lenient_items !== undefined) return false;
  if (typeof request.input === 'string' || request.input.length === 0) return false;
  return canonicalJson(request.input[0]) !== systemItem;
};

describe('a fallback meter is restored at claim start from its own counter events (4.7, M4)', () => {
  it('splits the fallback count on the report its counter journaled in an earlier run of the session', async () => {
    const env = await makeEnv({ capabilities: estimatedTarget() });
    env.settings.contextValue = { ...env.settings.contextValue, observedCapacity: true };
    env.gateway.capabilitiesByTarget.set(PRIMARY_TARGET, exactTarget());
    env.gateway.capabilitiesByTarget.set(FALLBACK_TARGET, estimatedTarget());
    env.gateway.chainsByModel[env.session.model] = [FALLBACK_TARGET];
    env.gateway.script.push(textStep('Done.'), textStep('Again.'));
    const earlier = await env.enqueue('Echo something');
    await env.runOnce(env.worker());
    expect(env.ofType(earlier.id, 'meter.observed')).toMatchObject([{ target: FALLBACK_TARGET, counter: fakeCounterOf(FALLBACK_TARGET) }]);
    const systemItem = canonicalJson(inputOf(env.gateway.streams[0]!.body)[0]);

    env.gateway.chainsByModel[env.session.model] = [PRIMARY_TARGET, FALLBACK_TARGET];
    const countsBefore = env.gateway.counts.length;
    const later = await env.enqueue('Echo something else');
    await env.runOnce(env.worker('worker-2'));

    expect(env.run(later.id).status).toBe('COMPLETED');
    expect(env.gateway.counts.slice(countsBefore).some(isSplitCountOf(FALLBACK_TARGET, systemItem))).toBe(true);
  });
});

describe('the journaled meter keeps the report with context.observedCapacity (4.7, M5)', () => {
  it('journals kept = reported when the meter counted more than the server reported', async () => {
    const measuring = await observedEnv([PRIMARY_TARGET]);
    measuring.gateway.script.push(textStep('Done.'));
    await measuring.enqueue('Echo something');
    await measuring.runOnce(measuring.worker());
    const counted = inputTokensOf(measuring.gateway.streams[0]!.body);
    const reported = counted - OVER_COUNT;

    const env = await observedEnv([PRIMARY_TARGET]);
    env.gateway.script.push(textStep('Done.', { usage: usageOf(reported, 5) }));
    const run = await env.enqueue('Echo something');
    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'meter.observed')).toMatchObject([{ counted, reported, kept: reported }]);
  });
});
