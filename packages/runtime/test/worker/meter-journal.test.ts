import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { PRIMARY_TARGET } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const isModelRequested = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'model.requested' && 'body' in value;

const requestedIn = (value: unknown, depth = 0): number => {
  if (depth > 4 || typeof value !== 'object' || value === null) return 0;
  if (isModelRequested(value)) return 1;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.reduce((sum: number, child) => sum + requestedIn(child, depth + 1), 0);
};

const countingUntilFirstRequest = (env: Env): { store: RuntimeStore; returned: () => number } => {
  let returned = 0;
  let starting = true;
  const store = new Proxy(env.store, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (property === 'append' && requestedIn(args[1]) > 0) starting = false;
        const result: unknown = (value as (...parameters: unknown[]) => unknown).apply(target, args);
        if (starting) returned += requestedIn(result);
        return result;
      };
    },
  });
  return { store, returned: () => returned };
};

const threeSteps = (tag: string) => [
  callsStep([{ callId: `call_${tag}_1`, name: 'Echo', args: { value: `${tag} one` } }]),
  callsStep([{ callId: `call_${tag}_2`, name: 'Echo', args: { value: `${tag} two` } }]),
  textStep(`${tag} done.`),
];

describe('the claim start reads only the request bodies the fold keeps', () => {
  it('returns at most one model.requested to the claim start of a long alias-only session and still splits on the latest kept report of the alias', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(16384, { maxOutputTokens: 1024 }) });
    const aliasOf = env.session.modelAlias;
    env.gateway.script.push(...threeSteps('a'));
    const first = env.enqueue('First task');
    await env.runOnce(env.worker());
    env.gateway.script.push(...threeSteps('c'));
    const third = env.enqueue('Second task');
    await env.runOnce(env.worker());
    env.setModelAlias('other-model');
    env.gateway.script.push(...threeSteps('b'));
    const other = env.enqueue('Task for the other model');
    await env.runOnce(env.worker());
    env.setModelAlias(aliasOf);

    for (const run of [first, third, other]) expect(env.run(run.id).status).toBe('COMPLETED');
    const otherRequests = env.ofType(other.id, 'model.requested');
    expect(otherRequests.length).toBeGreaterThan(0);
    for (const request of otherRequests) expect((request.body as { model?: unknown }).model).toBe('other-model');
    const kept = env.ofType(third.id, 'meter.observed');
    expect(env.ofType(first.id, 'meter.observed')).toHaveLength(3);
    expect(kept).toHaveLength(3);
    expect(env.ofType(other.id, 'meter.observed').length).toBeGreaterThan(0);
    const latestKept = kept.at(-1);
    if (latestKept === undefined) throw new Error('the second alias run reported nothing');
    const otherLatest = env.ofType(other.id, 'meter.observed').at(-1);
    expect(otherLatest?.kept).not.toBe(latestKept.kept);

    const streamsBefore = env.gateway.streams.length;
    const { store, returned } = countingUntilFirstRequest(env);
    env.gateway.script.push(textStep('New run done.'));
    const next = env.enqueue('The new task');
    await env.runOnce(env.worker('worker-2', { store }));

    expect(env.run(next.id).status).toBe('COMPLETED');
    expect(env.gateway.streams.length).toBe(streamsBefore + 1);
    expect(returned()).toBeLessThanOrEqual(1);
    expect(env.ofType(next.id, 'meter.observed')[0]).toMatchObject({ target: PRIMARY_TARGET, fallback: false, known: latestKept.kept });
  });
});
