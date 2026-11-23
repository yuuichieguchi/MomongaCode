import { describe, expect, it, vi } from 'vitest';
import type { MemoryRecord } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { makeStoreDir } from '../../../store/test/helpers.ts';
import { startService } from './helpers.ts';
import type { ServiceEnv } from './helpers.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const CLASSIFIER = 'guard';

type Lifecycle = { saveCandidate(input: Record<string, unknown>): { memory: MemoryRecord } };

const lifecycleOf = (store: RuntimeStore): Lifecycle => store.memories as unknown as Lifecycle;

const seeded = async (env: ServiceEnv) => {
  const session = await env.createSession();
  const run = await env.createRun(session.id);
  let ordinal = 0;
  const candidate = (text: string, project: string = session.cwd): MemoryRecord => {
    ordinal += 1;
    return lifecycleOf(env.store).saveCandidate({ scope: 'project', origin: 'trusted', project, text, runId: run.id, ordinal, kind: 'fact', evidence: [] }).memory;
  };
  const left = (memory: MemoryRecord): void => {
    expect(env.store.memoryJudgements.commit({ memoryId: memory.id, outcome: 'left', classifier: CLASSIFIER, verdict: 'unsafe', confidence: 'high', openSessionIds: [] })).toBe('recorded');
  };
  return { session, run, candidate, left };
};

const query = (project: string): string => `/v1/memory-judgements?project=${encodeURIComponent(project)}`;

const recordOf = (body: Record<string, unknown>): unknown => body['judgement'] ?? body;

describe('reading the owed judgements of a folder', () => {
  it('answers the owed records of that folder only, in review order', async () => {
    const env = await startService({ fakeTimers: true });
    const { session, candidate, left } = await seeded(env);
    const first = candidate('first');
    const second = candidate('second');
    const elsewhere = candidate('elsewhere', makeStoreDir());
    candidate('not judged');
    left(first);
    left(second);
    left(elsewhere);
    const response = await env.http('GET', query(session.cwd));
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ judgements: env.store.memoryJudgements.owed(session.cwd) });
    expect(response.json.judgements.map((entry: { memoryId: string }) => entry.memoryId)).toEqual([first.id, second.id]);
    expect(response.json.judgements[0]).toMatchObject({ memoryId: first.id, outcome: 'left', classifier: CLASSIFIER, verdict: 'unsafe', confidence: 'high', owed: true, closed: false });
  });

  it('answers an empty list once the records are shown', async () => {
    const env = await startService({ fakeTimers: true });
    const { session, candidate, left } = await seeded(env);
    const memory = candidate('first');
    left(memory);
    env.store.memoryJudgements.markShown([memory.id]);
    expect((await env.http('GET', query(session.cwd))).json).toEqual({ judgements: [] });
  });

  it('refuses a request without a folder', async () => {
    const env = await startService({ fakeTimers: true });
    const response = await env.http('GET', '/v1/memory-judgements');
    expect(response.status).toBe(400);
    expect(response.json.error.param).toBe('project');
  });
});

describe('reading the judgement of one memory', () => {
  it('answers the record with whether it is owed', async () => {
    const env = await startService({ fakeTimers: true });
    const { candidate, left } = await seeded(env);
    const memory = candidate('first');
    left(memory);
    const owed = await env.http('GET', `/v1/memory-judgements/${memory.id}`);
    expect(owed.status).toBe(200);
    expect(recordOf(owed.json)).toEqual({ ...env.store.memoryJudgements.get(memory.id), owed: true, closed: false });
    env.store.memoryJudgements.markShown([memory.id]);
    const shown = await env.http('GET', `/v1/memory-judgements/${memory.id}`);
    expect(recordOf(shown.json)).toMatchObject({ memoryId: memory.id, outcome: 'left', owed: false, closed: false });
  });

  it.each([
    ['accepts', 'accept'],
    ['rejects', 'reject'],
  ] as const)('answers the record closed once the person %s the memory, shown or not', async (_name, action) => {
    const env = await startService({ fakeTimers: true });
    const { candidate, left } = await seeded(env);
    const unshown = candidate('unshown');
    const shown = candidate('shown');
    left(unshown);
    left(shown);
    env.store.memoryJudgements.markShown([shown.id]);
    for (const memory of [unshown, shown]) {
      const decided = await env.http('POST', `/v1/memories/${memory.id}/${action}`, { body: {} });
      expect(decided.status).toBeLessThan(300);
      const read = await env.http('GET', `/v1/memory-judgements/${memory.id}`);
      expect(recordOf(read.json)).toMatchObject({ memoryId: memory.id, owed: false, closed: true });
    }
  });

  it('answers the record closed once the person deletes the memory', async () => {
    const env = await startService({ fakeTimers: true });
    const { candidate, left } = await seeded(env);
    const memory = candidate('first');
    left(memory);
    env.store.memoryJudgements.markShown([memory.id]);
    env.store.memories.retire(memory.id);
    const read = await env.http('GET', `/v1/memory-judgements/${memory.id}`);
    expect(recordOf(read.json)).toMatchObject({ memoryId: memory.id, owed: false, closed: true });
  });

  it('answers 404 for a memory without a record and for an unknown memory', async () => {
    const env = await startService({ fakeTimers: true });
    const { candidate } = await seeded(env);
    const memory = candidate('never judged');
    expect((await env.http('GET', `/v1/memory-judgements/${memory.id}`)).status).toBe(404);
    expect((await env.http('GET', '/v1/memory-judgements/missing')).status).toBe(404);
  });
});

describe('marking judgements shown', () => {
  it('marks the named records shown, and marking again changes nothing', async () => {
    const env = await startService({ fakeTimers: true });
    const { session, candidate, left } = await seeded(env);
    const first = candidate('first');
    const second = candidate('second');
    left(first);
    left(second);
    const marked = await env.http('POST', '/v1/memory-judgements/shown', { body: { memoryIds: [first.id] } });
    expect(marked.status).toBeGreaterThanOrEqual(200);
    expect(marked.status).toBeLessThan(300);
    expect(env.store.memoryJudgements.get(first.id)?.owed).toBe(false);
    expect(env.store.memoryJudgements.get(second.id)?.owed).toBe(true);
    const again = await env.http('POST', '/v1/memory-judgements/shown', { body: { memoryIds: [first.id] } });
    expect(again.status).toBe(marked.status);
    expect(env.store.memoryJudgements.owed(session.cwd).map((entry) => entry.memoryId)).toEqual([second.id]);
  });

  it('refuses a body without a list of memory ids', async () => {
    const env = await startService({ fakeTimers: true });
    expect((await env.http('POST', '/v1/memory-judgements/shown', { body: {} })).status).toBe(400);
    expect((await env.http('POST', '/v1/memory-judgements/shown', { body: { memoryIds: [1] } })).status).toBe(400);
  });

  it('is refused to a caller that is not the person, like accepting a memory', async () => {
    const env = await startService({ fakeTimers: true });
    const { candidate, left } = await seeded(env);
    const memory = candidate('first');
    left(memory);
    const refused = await env.http('POST', '/v1/memory-judgements/shown', { body: { memoryIds: [memory.id] }, person: false });
    const accept = await env.http('POST', `/v1/memories/${memory.id}/accept`, { body: {}, person: false });
    expect({ status: refused.status, error: refused.json?.error }).toEqual({ status: accept.status, error: accept.json?.error });
    expect(refused.status).toBe(403);
    expect(env.store.memoryJudgements.get(memory.id)?.owed).toBe(true);
  });
});
