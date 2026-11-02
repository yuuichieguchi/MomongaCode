import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectError, expectSchema, startService } from './helpers.ts';
import type { ServiceEnv } from './helpers.ts';

const viewed = <M extends object>(memory: M) => ({ ...memory, status: 'unbound' as const });

const seedCalls = async (env: ServiceEnv) => {
  const session = await env.createSession();
  const run = await env.createRun(session.id);
  const claim = env.claimRun(run.id);
  env.append(
    claim,
    ['c1', 'c2', 'c3'].map((callId) => ({
      type: 'tool.call' as const,
      callId,
      providerCallId: callId,
      name: 'MemorySave',
      kind: 'other' as const,
      title: 'Save a memory',
      rawInput: {},
    })),
  );
  return { session, run };
};

describe('memory api', () => {
  it('lists, reads and deletes memories with their provenance', async () => {
    const env = await startService({ fakeTimers: true });
    const { session, run } = await seedCalls(env);
    const user = env.store.memories.save({ origin: 'trusted', scope: 'user', project: null, text: 'prefers tabs', runId: run.id, step: 1, callId: 'c1' }).memory;
    const project = env.store.memories.save({ origin: 'trusted', scope: 'project', project: session.cwd, text: 'tests live in test/', runId: run.id, step: 2, callId: 'c2' }).memory;
    const call = env.runEvents(run.id).find((event) => event.type === 'tool.call' && event.callId === 'c1');

    const listed = await env.http('GET', '/v1/memories');
    expect(listed.status).toBe(200);
    expect(listed.json).toEqual({ memories: [viewed(user), viewed(project)] });
    expect(listed.json.memories[0].source).toEqual({ kind: 'tool', sessionId: session.id, runId: run.id, step: 1, callId: 'c1', seq: call?.seq });
    expectSchema('MemoriesResponse', listed.json);

    const read = await env.http('GET', `/v1/memories/${project.id}`);
    expect(read.status).toBe(200);
    expect(read.json).toEqual({ memory: viewed(project) });
    expectSchema('MemoryResponse', read.json);

    const removed = await env.http('DELETE', `/v1/memories/${user.id}`);
    expect(removed.status).toBe(204);
    expect(removed.text).toBe('');
    expect((await env.http('GET', '/v1/memories')).json).toEqual({ memories: [viewed(project)] });
    expectError(await env.http('GET', `/v1/memories/${user.id}`), 404, 'not_found');
    expectError(await env.http('DELETE', `/v1/memories/${user.id}`), 404, 'not_found');
  });

  it('filters by scope and by project', async () => {
    const env = await startService({ fakeTimers: true });
    const { session, run } = await seedCalls(env);
    const other = path.join(env.layout.root, 'other');
    fs.mkdirSync(other);
    const user = env.store.memories.save({ origin: 'trusted', scope: 'user', project: null, text: 'u', runId: run.id, step: 1, callId: 'c1' }).memory;
    const here = env.store.memories.save({ origin: 'trusted', scope: 'project', project: session.cwd, text: 'here', runId: run.id, step: 1, callId: 'c2' }).memory;
    const there = env.store.memories.save({ origin: 'trusted', scope: 'project', project: fs.realpathSync.native(other), text: 'there', runId: run.id, step: 1, callId: 'c3' }).memory;

    expect((await env.http('GET', '/v1/memories?scope=user')).json).toEqual({ memories: [viewed(user)] });
    expect((await env.http('GET', '/v1/memories?scope=project')).json).toEqual({ memories: [viewed(here), viewed(there)] });
    expect((await env.http('GET', `/v1/memories?project=${encodeURIComponent(other)}`)).json).toEqual({ memories: [viewed(there)] });
    expect((await env.http('GET', `/v1/memories?scope=project&project=${encodeURIComponent(session.cwd)}`)).json).toEqual({ memories: [viewed(here)] });
  });

  it('rejects an unknown scope, a relative project and a contradictory filter', async () => {
    const env = await startService({ fakeTimers: true });
    const unknownScope = await env.http('GET', '/v1/memories?scope=team');
    expectError(unknownScope, 400, 'invalid_request');
    expect(unknownScope.json.error.param).toBe('scope');
    const relative = await env.http('GET', '/v1/memories?project=relative/dir');
    expectError(relative, 400, 'invalid_request');
    expect(relative.json.error.param).toBe('project');
    expectError(await env.http('GET', `/v1/memories?scope=user&project=${encodeURIComponent(env.layout.project)}`), 400, 'invalid_request');
  });

  it('lists the memories of a project directory that no longer exists', async () => {
    const env = await startService({ fakeTimers: true });
    const { run } = await seedCalls(env);
    const gone = path.join(env.layout.root, 'gone');
    const memory = env.store.memories.save({ origin: 'trusted', scope: 'project', project: gone, text: 'left behind', runId: run.id, step: 1, callId: 'c1' }).memory;
    expect((await env.http('GET', `/v1/memories?project=${encodeURIComponent(gone)}`)).json).toEqual({ memories: [viewed(memory)] });
  });

  it('allows only reading and deleting', async () => {
    const env = await startService({ fakeTimers: true });
    const collection = await env.http('POST', '/v1/memories', { body: {} });
    expect(collection.status).toBe(405);
    expect(collection.headers['allow']).toBe('GET, HEAD');
    const item = await env.http('PUT', '/v1/memories/x', { body: {} });
    expect(item.status).toBe(405);
    expect(item.headers['allow']).toBe('GET, DELETE, HEAD');
  });
});
