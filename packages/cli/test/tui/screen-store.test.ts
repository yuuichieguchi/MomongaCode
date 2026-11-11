import { describe, expect, it, vi } from 'vitest';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { createRowCache as createRowCacheWith } from '../../src/tui/screen/row-cache.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import { appendEntry, foldEvent, sessionTokens, subagentEnded, subagentStarted } from '../../src/tui/transcript.ts';
import { eventOf, fold, foldChild, plainOf, seeded, storeOf, ROW_RENDERERS, ROW_SCHEDULE } from './screen-fakes.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const createRowCache = (renderers: Parameters<typeof createRowCacheWith>[0] = ROW_RENDERERS) => createRowCacheWith(renderers, ROW_SCHEDULE);

const call = { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Read', kind: 'read', title: 'Read /a', rawInput: {} };
const delta = (itemId: string, text: string) => ({ type: 'agent.message.delta', attempt: 0, itemId, text });

describe('the transcript store', () => {
  it('gives every entry a growing id and raises the version of exactly the entry that changed', () => {
    const store = storeOf([delta('a', 'Hel'), call, delta('b', 'x')]);
    const ids = [0, 1, 2].map((index) => store.at(index).id);
    expect(ids[0]).toBeLessThan(ids[1] ?? 0);
    expect(ids[1]).toBeLessThan(ids[2] ?? 0);
    const before = [0, 1, 2].map((index) => store.at(index).version);
    foldEvent(store, eventOf({ type: 'tool.started', callId: 'c1', idemKey: 'k' }));
    expect([0, 1, 2].map((index) => store.at(index).version)).toEqual([before[0], (before[1] ?? 0) + 1, before[2]]);
    expect(store.indexOfId(ids[2] ?? -1)).toBe(2);
  });

  it('tells its subscribers the entry and its version, and moves one store version per change', () => {
    const store = createTranscriptStore();
    const told: [number | undefined, number][] = [];
    const stop = store.subscribe((entryId, version) => told.push([entryId, version]));
    storeOf([call, { type: 'tool.started', callId: 'c1', idemKey: 'k' }], store);
    const entry = store.at(0);
    expect(told.filter(([entryId]) => entryId !== undefined)).toEqual([
      [entry.id, 0],
      [entry.id, 1],
    ]);
    expect(told.filter(([entryId]) => entryId === undefined)).toEqual([[undefined, 2]]);
    const version = store.version();
    stop();
    storeOf([{ type: 'tool.completed', callId: 'c1', status: 'completed', output: '' }], store);
    expect(told).toHaveLength(3);
    expect(store.version()).toBeGreaterThan(version);
  });

  it('reaches the entry of a key without reading the other entries', () => {
    const store = storeOf([call, ...Array.from({ length: 50 }, (_, index) => ({ ...call, callId: `k${index}` }))]);
    expect(store.byKey('call:k49')?.entry).toMatchObject({ callId: 'k49' });
    expect(store.byKey('call:none')).toBeUndefined();
  });

  it('never removes an entry: a newer plan retires the older one in place and is shown last', () => {
    const plan = (content: string) => ({ type: 'plan.updated', entries: [{ content, priority: 'high', status: 'pending' }] });
    const store = storeOf([plan('one'), call, plan('two')]);
    expect(store.count()).toBe(3);
    expect(store.at(0).entry.kind).toBe('retired');
    expect(plainOf(store).entries.map((entry) => entry.kind)).toEqual(['tool', 'plan']);
  });

  it('counts the leading entries that can no longer change, and keeps the banner live while it is the only entry', () => {
    const store = createTranscriptStore();
    appendEntry(store, { kind: 'banner', banner: { config: { version: '1', home: '/h', color: false }, model: 'a', cwd: '/h', notices: [] } }, 'banner');
    expect(store.settledCount()).toBe(0);
    storeOf([call], store);
    expect(store.settledCount()).toBe(1);
    storeOf([{ type: 'tool.completed', callId: 'c1', status: 'completed', output: '' }, delta('a', 'x')], store);
    expect(store.settledCount()).toBe(2);
  });

  it('sums the tokens of the session over its runs and adds the live run', () => {
    const usage = (totalTokens: number) => ({ type: 'usage.updated', inputTokens: totalTokens, outputTokens: 0, totalTokens });
    const store = storeOf([usage(10), usage(15), { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }, usage(7)]);
    expect(sessionTokens(store.state())).toBe(22);
    storeOf([{ type: 'run.status', from: 'RUNNING', to: 'FAILED' }], store);
    expect(sessionTokens(store.state())).toBe(22);
    expect(createTranscriptStore().state().contextTokens).toBe(0);
  });

  it('empties on a reset, keeps its ids growing and starts a new epoch', () => {
    const store = storeOf([call]);
    const last = store.at(0).id;
    const epoch = store.epoch();
    store.reset();
    expect(store.count()).toBe(0);
    expect(store.epoch()).toBe(epoch + 1);
    storeOf([call], store);
    expect(store.at(0).id).toBeGreaterThan(last);
    expect(store.indexOfId(store.at(0).id)).toBe(0);
    expect(store.indexOfId(last)).toBeUndefined();
  });

  it('lists the running subagents with the title of the tool each one runs and whether it waits for an approval', () => {
    const store = createTranscriptStore();
    subagentStarted(store, 'reviewer', 'child', 1000);
    const child = (event: Record<string, unknown>) => ({ ...eventOf(event), runId: 'child' });
    foldChild([child({ ...call, title: 'Read /b' }), child({ type: 'tool.started', callId: 'c1', idemKey: 'k' })], 'reviewer', store);
    expect(store.state().subagents).toEqual([{ runId: 'child', agent: 'reviewer', title: 'Read /b', startedAt: 1000, awaitingApproval: false }]);
    foldChild([child({ type: 'tool.permission.requested', approvalId: 'ap', callId: 'c1', subjectDigest: 'd', options: [], shown: { title: 'approval', input: {} } })], 'reviewer', store);
    expect(store.state().subagents[0]?.awaitingApproval).toBe(true);
    foldChild([child({ type: 'tool.permission.resolved', approvalId: 'ap', optionId: 'o' })], 'reviewer', store);
    expect(store.state().subagents[0]?.awaitingApproval).toBe(false);
    subagentEnded(store, 'child');
    expect(store.state().subagents).toEqual([]);
  });

  it('folds the same events to the same store whatever is read between them (P1)', () => {
    const random = seeded(7);
    const events = Array.from({ length: 200 }, (_, index) => {
      const pick = random();
      if (pick < 0.5) return delta(`m${Math.floor(index / 20)}`, `t${index} `);
      if (pick < 0.7) return { ...call, callId: `c${index}` };
      if (pick < 0.8) return { type: 'plan.updated', entries: [{ content: `p${index}`, priority: 'low', status: 'pending' }] };
      if (pick < 0.9) return { type: 'usage.updated', inputTokens: index, outputTokens: 0, totalTokens: index };
      return { type: 'run.status', from: 'RUNNING', to: pick < 0.95 ? 'COMPLETED' : 'RUNNING' };
    });
    const straight = fold(events);
    const store = createTranscriptStore();
    const cache = createRowCache();
    for (const event of events) {
      foldEvent(store, eventOf(event));
      if (random() < 0.3 && store.count() > 0) cache.rowsOf(store.at(store.count() - 1), 20 + Math.floor(random() * 40));
    }
    expect(plainOf(store)).toEqual(straight);
  });
});
