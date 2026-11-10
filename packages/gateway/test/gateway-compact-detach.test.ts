import { describe, expect, it } from 'vitest';
import type { AdapterCompactRequest, AdapterCompactResult, AdapterContext, ProviderAdapter } from '@momonga/gateway';
import { createScriptedAdapter, usageOf, waitFor } from '@momonga/testkit';
import { postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { openRawPost } from './gateway-support.ts';

const DETACHED_MAX_MS = 60_000;
const compactBody = { model: 'scripted/scripted-primary', input: userInput('summarise this conversation') };

type StubbornCompactAdapter = ProviderAdapter & { readonly calls: number[]; release(): void };

const createStubbornCompactAdapter = (): StubbornCompactAdapter => {
  const base = createScriptedAdapter({ calls: [] });
  const calls: number[] = [];
  let open = false;
  const waiters: Array<() => void> = [];
  return {
    ...base,
    calls,
    release: () => {
      open = true;
      for (const wake of waiters.splice(0)) wake();
    },
    compact: async (_request: AdapterCompactRequest, _ctx: AdapterContext): Promise<AdapterCompactResult> => {
      const index = calls.length;
      calls.push(index);
      if (index === 0 && !open) await new Promise<void>((resolve) => waiters.push(resolve));
      return { summary: `summary ${index}`, usage: usageOf(40, 8), usageSource: 'reported' };
    },
  };
};

const compactWithKey = (client: Awaited<ReturnType<typeof startGateway>>['client'], key: string) =>
  postJson(client, '/v1/responses/compact', compactBody, { 'idempotency-key': key }).then(readJson);

describe('keyed compaction after the detach expiry', () => {
  it('starts a new call for a retry with the same key while the aborted one is still settling', async () => {
    const primary = createStubbornCompactAdapter();
    const { client, socketPath, timers } = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, config: { detachedMaxMs: DETACHED_MAX_MS } });
    registerCleanup(() => primary.release());
    const raw = await openRawPost(socketPath, '/v1/responses/compact', compactBody, { headers: { 'idempotency-key': 'dx-1' } });
    await waitFor(() => primary.calls.length === 1, { description: 'first compact call' });
    raw.socket.destroy();
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === DETACHED_MAX_MS), { description: 'detach timer armed' });
    timers.advance(DETACHED_MAX_MS);
    const retried = await compactWithKey(client, 'dx-1');
    expect(retried.status).toBe(200);
    expect(primary.calls).toHaveLength(2);
  });
});

describe('keyed compaction that finishes with a client attached', () => {
  it('leaves no detach timer behind', async () => {
    const primary = createStubbornCompactAdapter();
    primary.release();
    const { client, timers } = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, config: { detachedMaxMs: DETACHED_MAX_MS } });
    expect((await compactWithKey(client, 'dx-2')).status).toBe(200);
    expect(timers.pending().filter((timer) => timer.delayMs === DETACHED_MAX_MS)).toEqual([]);
  });
});
