import { afterEach, describe, expect, it } from 'vitest';
import { catalogKey, createPlanCatalog } from '../src/plan/catalog.ts';
import { fakeAuth } from './plan-auth-support.ts';
import { startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const boundSleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const LISTED = { slug: 'gpt-x', display_name: 'GPT X', visibility: 'list', context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], default_reasoning_level: 'medium' };

describe('a capability record written before the list reported reasoning', () => {
  it('is read as reasoning not reported, and the next read of the list refreshes it with the reported levels', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const signal = new AbortController().signal;
    await h.store.write(catalogKey(h.profile.id, 'work'), JSON.stringify({ readAt: '2026-11-01T00:00:00.000Z', models: { 'gpt-x': { contextWindow: 272000, maxOutputTokens: 68000, source: 'reported' }, 'gpt-y': { unreported: true } } }), signal);
    const catalog = createPlanCatalog({ store: h.store, clock: h.clock, outbound: (_signal, use) => use(async () => new Response(JSON.stringify({ models: [LISTED] }), { status: 200 })), sleep: boundSleep });
    await catalog.load(h.profile.id, 'work', signal);
    expect(catalog.capabilitiesOf(h.profile.id, 'work', 'gpt-x')).toEqual({ contextWindow: 272000, maxOutputTokens: 68000 });
    await catalog.read({ profile: h.profile, account: 'work', refresh: true, auth: fakeAuth(), signal });
    expect(catalog.capabilitiesOf(h.profile.id, 'work', 'gpt-x')).toEqual({ contextWindow: 272000, maxOutputTokens: 68000, reasoning: { control: 'reasoning_effort', lowest: 'low', efforts: ['low', 'medium'], default: 'medium' } });
    expect(await catalog.record(h.profile.id, 'work', signal)).toMatchObject({ models: { 'gpt-x': { reasoning: { efforts: ['low', 'medium'], default: 'medium' } } } });
  });
});
