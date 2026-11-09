import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaPaths, ruleEnforcementOf } from '@momonga/foundation';
import { SandboxPolicyError } from '@momonga/sandbox';
import type { Sandbox } from '@momonga/sandbox';
import { fakePolicyFilesystem, withTempDir } from '@momonga/testkit';
import { memoryTextProblem } from '@momonga/tools';
import { createEvidenceRunner } from '../../src/process/evidence-run.ts';
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
    const user = (await env.store.memories.save({ origin: 'trusted', scope: 'user', project: null, text: 'prefers tabs', runId: run.id, step: 1, callId: 'c1' })).memory;
    const project = (await env.store.memories.save({ origin: 'trusted', scope: 'project', project: session.cwd, text: 'tests live in test/', runId: run.id, step: 2, callId: 'c2' })).memory;
    const call = env.runEvents(run.id).find((event) => event.type === 'tool.call' && event.callId === 'c1');

    const listed = await env.http('GET', '/v1/memories');
    expect(listed.status).toBe(200);
    expect(listed.json).toEqual({ memories: [viewed(user), viewed(project)], next: null });
    expect(listed.json.memories[0].source).toEqual({ kind: 'tool', sessionId: session.id, runId: run.id, step: 1, callId: 'c1', seq: call?.seq });
    expectSchema('MemoriesResponse', listed.json);

    const read = await env.http('GET', `/v1/memories/${project.id}`);
    expect(read.status).toBe(200);
    expect(read.json).toEqual({ memory: viewed(project) });
    expectSchema('MemoryResponse', read.json);

    const removed = await env.http('DELETE', `/v1/memories/${user.id}`);
    expect(removed.status).toBe(204);
    expect(removed.text).toBe('');
    expect((await env.http('GET', '/v1/memories')).json).toEqual({ memories: [viewed(project)], next: null });
    const retired = await env.http('GET', `/v1/memories/${user.id}`);
    expect(retired.status).toBe(200);
    expect(retired.json.memory.retiredAt).toEqual(expect.any(Number));
    expect((await env.http('DELETE', `/v1/memories/${user.id}`)).status).toBe(204);
    expectError(await env.http('DELETE', '/v1/memories/0193a1b2-0000-7000-8000-00000000dead'), 404, 'not_found');
  });

  it('filters by scope and by project', async () => {
    const env = await startService({ fakeTimers: true });
    const { session, run } = await seedCalls(env);
    const other = path.join(env.layout.root, 'other');
    fs.mkdirSync(other);
    const user = (await env.store.memories.save({ origin: 'trusted', scope: 'user', project: null, text: 'u', runId: run.id, step: 1, callId: 'c1' })).memory;
    const here = (await env.store.memories.save({ origin: 'trusted', scope: 'project', project: session.cwd, text: 'here', runId: run.id, step: 1, callId: 'c2' })).memory;
    const there = (await env.store.memories.save({ origin: 'trusted', scope: 'project', project: fs.realpathSync.native(other), text: 'there', runId: run.id, step: 1, callId: 'c3' })).memory;

    expect((await env.http('GET', '/v1/memories?scope=user')).json).toEqual({ memories: [viewed(user)], next: null });
    expect((await env.http('GET', '/v1/memories?scope=project')).json).toEqual({ memories: [viewed(here), viewed(there)], next: null });
    expect((await env.http('GET', `/v1/memories?project=${encodeURIComponent(other)}`)).json).toEqual({ memories: [viewed(there)], next: null });
    expect((await env.http('GET', `/v1/memories?scope=project&project=${encodeURIComponent(session.cwd)}`)).json).toEqual({ memories: [viewed(here)], next: null });
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
    const memory = (await env.store.memories.save({ origin: 'trusted', scope: 'project', project: gone, text: 'left behind', runId: run.id, step: 1, callId: 'c1' })).memory;
    expect((await env.http('GET', `/v1/memories?project=${encodeURIComponent(gone)}`)).json).toEqual({ memories: [viewed(memory)], next: null });
  });

  it('allows only reading, adding and deleting', async () => {
    const env = await startService({ fakeTimers: true });
    const collection = await env.http('PUT', '/v1/memories', { body: {} });
    expect(collection.status).toBe(405);
    expect(collection.headers['allow']).toBe('GET, POST, HEAD');
    const item = await env.http('PUT', '/v1/memories/x', { body: {} });
    expect(item.status).toBe(405);
    expect(item.headers['allow']).toBe('GET, DELETE, HEAD');
  });
});

describe('reading memories when the evidence process cannot start', () => {
  const COMMIT = '0123456789abcdef0123456789abcdef01234567';

  const failingSandbox = (failure: Error): Sandbox => ({
    kind: 'none',
    spawn: () => {
      throw failure;
    },
  });

  const failures: [string, () => Error][] = [
    ['a placeholder journal that cannot be written', () => Object.assign(new Error('the placeholder journal failed'), { code: 'ENOSPC' })],
    ['too many open files', () => Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })],
    ['a refusal of the sandbox policy', () => new SandboxPolicyError('writable_root_not_absolute', 'refused')],
  ];

  for (const [label, make] of failures) {
    it(`answers unverifiable and not 500 when the spawn fails for ${label}`, async (context) => {
      const home = withTempDir(context, { asHome: true });
      const sandbox = failingSandbox(make());
      const env = await startService({
        fakeTimers: true,
        evidenceRun: createEvidenceRunner({ paths: momongaPaths(home), home, fs: fakePolicyFilesystem(), sandbox, env: {}, enforcement: ruleEnforcementOf('none') }),
      });
      const { session, run } = await seedCalls(env);
      expect((await env.http('PUT', '/v1/trust', { body: { path: session.cwd, decision: 'trusted' } })).status).toBe(200);
      const saved = (await env.store.memories.save({
        origin: 'trusted',
        scope: 'project',
        project: session.cwd,
        text: 'tests live in test/',
        runId: run.id,
        step: 1,
        callId: 'c1',
        evidence: [{ kind: 'commit', sha: COMMIT }],
      })).memory;

      const listed = await env.http('GET', '/v1/memories');
      const read = await env.http('GET', `/v1/memories/${saved.id}`);

      expect(listed.status).toBe(200);
      expect(listed.json.memories).toMatchObject([{ id: saved.id, status: 'unverifiable' }]);
      expect(read.status).toBe(200);
      expect(read.json.memory.status).toBe('unverifiable');
    });
  }

  it('keeps answering 500 for an error of our own after the process ran', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const sandbox: Sandbox = {
      kind: 'none',
      spawn: () => ({
        pid: 1,
        pgid: 1,
        stdout: (async function* (): AsyncGenerator<Uint8Array> {
          throw new TypeError('reading the output failed');
        })(),
        stderr: (async function* (): AsyncGenerator<Uint8Array> {})(),
        exited: Promise.resolve({ code: 0, signal: null }),
      }),
    };
    const env = await startService({
      fakeTimers: true,
      evidenceRun: createEvidenceRunner({ paths: momongaPaths(home), home, fs: fakePolicyFilesystem(), sandbox, env: {}, enforcement: ruleEnforcementOf('none') }),
    });
    const { session, run } = await seedCalls(env);
    expect((await env.http('PUT', '/v1/trust', { body: { path: session.cwd, decision: 'trusted' } })).status).toBe(200);
    await env.store.memories.save({ origin: 'trusted', scope: 'project', project: session.cwd, text: 'tests live in test/', runId: run.id, step: 1, callId: 'c1', evidence: [{ kind: 'commit', sha: COMMIT }] });

    expect((await env.http('GET', '/v1/memories')).status).toBe(500);
  });
});

describe('adding a memory as a person', () => {
  const trusted = async (env: ServiceEnv): Promise<string> => {
    expect((await env.http('PUT', '/v1/trust', { body: { path: env.layout.projectReal, decision: 'trusted' } })).status).toBe(200);
    return env.layout.projectReal;
  };

  const add = (env: ServiceEnv, body: Record<string, unknown>) => env.http('POST', '/v1/memories', { body });

  it('stores a project memory with the origin of a person, a command source and the hash of each path', async () => {
    const env = await startService({ fakeTimers: true });
    const project = await trusted(env);
    fs.writeFileSync(path.join(project, 'config.ts'), 'export const LIMIT = 10;\n');

    const response = await add(env, { text: 'LIMIT in config.ts is 10.', scope: 'project', project, paths: ['config.ts'] });

    expect(response.status).toBe(201);
    expectSchema('MemoryResponse', response.json);
    expect(response.json.memory).toMatchObject({
      scope: 'project',
      origin: 'trusted',
      project,
      text: 'LIMIT in config.ts is 10.',
      status: 'verified',
      source: { kind: 'command', at: expect.any(Number) },
      evidence: [{ kind: 'file', project, path: 'config.ts', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }],
    });
    expect(env.store.memories.get(response.json.memory.id)?.source.kind).toBe('command');
  });

  it('shows the memory as stale once the bound file changes', async () => {
    const env = await startService({ fakeTimers: true });
    const project = await trusted(env);
    fs.writeFileSync(path.join(project, 'config.ts'), 'export const LIMIT = 10;\n');
    const { json } = await add(env, { text: 'LIMIT is 10.', scope: 'project', project, paths: ['config.ts'] });
    fs.writeFileSync(path.join(project, 'config.ts'), 'export const LIMIT = 20;\n');

    expect((await env.http('GET', `/v1/memories/${json.memory.id}`)).json.memory.status).toBe('stale');
  });

  it('stores a user memory that is bound to no path', async () => {
    const env = await startService({ fakeTimers: true });

    const response = await add(env, { text: 'prefers tabs', scope: 'user' });

    expect(response.status).toBe(201);
    expect(response.json.memory).toMatchObject({ scope: 'user', origin: 'trusted', project: null, evidence: [], source: { kind: 'command' } });
  });

  it('refuses a project memory in a folder that is not trusted', async () => {
    const env = await startService({ fakeTimers: true });
    fs.writeFileSync(path.join(env.layout.projectReal, 'config.ts'), 'x');

    const response = await add(env, { text: 'a note', scope: 'project', project: env.layout.projectReal, paths: ['config.ts'] });

    expectError(response, 400, 'invalid_request');
    expect(response.json.error.message).toContain('not a trusted folder');
    expect(env.store.memories.list()).toEqual([]);
  });

  it('refuses a path outside the project', async () => {
    const env = await startService({ fakeTimers: true });
    const project = await trusted(env);
    fs.writeFileSync(path.join(env.layout.root, 'outside.ts'), 'x');

    const response = await add(env, { text: 'a note', scope: 'project', project, paths: ['../outside.ts'] });

    expectError(response, 400, 'invalid_request');
    expect(response.json.error).toMatchObject({ param: 'paths', message: expect.stringContaining('outside the project') });
    expect(env.store.memories.list()).toEqual([]);
  });

  it('refuses a path that leaves the project through a link', async () => {
    const env = await startService({ fakeTimers: true });
    const project = await trusted(env);
    fs.writeFileSync(path.join(env.layout.root, 'secret.ts'), 'x');
    fs.symlinkSync(path.join(env.layout.root, 'secret.ts'), path.join(project, 'link.ts'));

    const response = await add(env, { text: 'a note', scope: 'project', project, paths: ['link.ts'] });

    expectError(response, 400, 'invalid_request');
    expect(response.json.error.message).toContain('leaves the project');
  });

  it('refuses a path that does not exist', async () => {
    const env = await startService({ fakeTimers: true });
    const project = await trusted(env);

    const response = await add(env, { text: 'a note', scope: 'project', project, paths: ['missing.ts'] });

    expectError(response, 400, 'invalid_request');
    expect(response.json.error).toMatchObject({ param: 'paths', message: expect.stringContaining('does not exist') });
    expect(env.store.memories.list()).toEqual([]);
  });

  it('refuses text that looks like a credential, as MemorySave does', async () => {
    const env = await startService({ fakeTimers: true });
    const project = await trusted(env);

    const response = await add(env, { text: 'the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', scope: 'project', project });

    expectError(response, 400, 'invalid_request');
    expect(response.json.error).toMatchObject({ param: 'text', message: expect.stringContaining('credential') });
    expect(env.store.memories.list()).toEqual([]);
  });

  it.each(['the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', '   \n  '])('answers with the refusal of memoryTextProblem for %j, the one MemorySave and reflection use', async (text) => {
    const env = await startService({ fakeTimers: true });
    const project = await trusted(env);
    const problem = memoryTextProblem(text);

    const response = await add(env, { text, scope: 'project', project });

    expectError(response, 400, 'invalid_request');
    expect(problem).toBeDefined();
    expect(response.json.error).toMatchObject({ param: 'text', message: problem?.message });
  });

  it('refuses a user memory that names a project or a path', async () => {
    const env = await startService({ fakeTimers: true });
    const project = await trusted(env);

    expectError(await add(env, { text: 'a note', scope: 'user', project }), 400, 'invalid_request');
    expectError(await add(env, { text: 'a note', scope: 'user', paths: ['config.ts'] }), 400, 'invalid_request');
  });

  it('refuses a project memory without a project and a body that is not a memory', async () => {
    const env = await startService({ fakeTimers: true });

    expectError(await add(env, { text: 'a note', scope: 'project' }), 400, 'invalid_request');
    expectError(await add(env, { text: '', scope: 'user' }), 400, 'invalid_request');
    expectError(await add(env, { scope: 'user' }), 400, 'invalid_request');
  });
});
