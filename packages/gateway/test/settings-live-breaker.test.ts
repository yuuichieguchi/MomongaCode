import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, createScriptedAdapter } from '@momonga/testkit';
import { createReasoningOriginCodec } from '../src/core/reasoning-origin.ts';
import { createRedactor } from '../src/core/redaction.ts';
import { createRouter } from '../src/core/router.ts';
import type { Router, RouterOptions } from '../src/core/router.ts';
import { HMAC_KEY, START_MS, buildConfig, counterForTest } from './gateway-helpers.ts';
import type { ConfigOverrides } from './gateway-helpers.ts';

const clock = createFakeClock(START_MS);
const timers = createFakeTimers(clock);

const routerOf = (overrides: ConfigOverrides, previous?: Router): Router =>
  createRouter({
    config: buildConfig({ breaker: { failureThreshold: 2, openMs: 30_000 }, ...overrides }),
    adapters: { a: createScriptedAdapter({ calls: [] }), b: createScriptedAdapter({ calls: [] }) },
    clock,
    timers,
    redactor: createRedactor({ credentials: [] }),
    reasoningOrigin: createReasoningOriginCodec(HMAC_KEY),
    ...(previous === undefined ? {} : { previous }),
  } as RouterOptions);

const targetOf = (router: Router, alias: string, name: string) => {
  const found = router.targetsOf(alias).find((target) => target.name === name);
  if (found === undefined) throw new Error(`alias ${alias} has no target ${name}`);
  return found;
};

const tripBreaker = (router: Router, name: string): void => {
  const { breaker } = targetOf(router, 'fast', name);
  for (let failure = 0; failure < 2; failure += 1) {
    const request = Symbol(`request ${failure}`);
    breaker.admit(request);
    breaker.record(request, 'failure');
  }
  expect(breaker.state).toBe('open');
};

const BEFORE: ConfigOverrides = {
  aliases: { fast: ['a', 'b'] },
  targets: { a: { model: 'model-a', counter: counterForTest('a') }, b: { model: 'model-b', counter: counterForTest('b') } },
};

describe('S1 gateway: the breaker is carried over by the identity of the target across a settings change (design-settings-live 3.1, createRouter with previous)', () => {
  it('an open breaker of a target whose definition did not change stays open after an unrelated settings change', () => {
    const before = routerOf(BEFORE);
    tripBreaker(before, 'a');
    const after = routerOf({ ...BEFORE, aliases: { fast: ['a', 'b'], other: ['a', 'b'] } }, before);
    expect(targetOf(after, 'other', 'a').breaker.state).toBe('open');
    expect(targetOf(after, 'fast', 'a').breaker).toBe(targetOf(before, 'fast', 'a').breaker);
  });

  it('a target whose definition changed starts with a closed breaker, while its unchanged sibling keeps its own', () => {
    const before = routerOf(BEFORE);
    tripBreaker(before, 'a');
    tripBreaker(before, 'b');
    const after = routerOf({ ...BEFORE, targets: { ...BEFORE.targets, a: { model: 'model-a-changed', counter: counterForTest('a-changed') } } }, before);
    expect(targetOf(after, 'fast', 'a').breaker.state).toBe('closed');
    expect(targetOf(after, 'fast', 'b').breaker.state).toBe('open');
  });
});
