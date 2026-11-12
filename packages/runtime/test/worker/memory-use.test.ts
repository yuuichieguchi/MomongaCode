import { describe, expect, it } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import { createMemoryPort } from '@momonga/runtime';
import type { Worker } from '@momonga/runtime';
import { defineTool } from '@momonga/tools';
import { runMemoryUpkeep } from '../../src/memory/upkeep.ts';
import { createRecordViews } from '../../src/memory/views.ts';
import { makeEnv, textOf, unavailableEvidenceRun } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const DAY_MS = 86_400_000;

const NOTE = 'launch with zorpLauncher';

const memoryPortOf = (env: Env) => createMemoryPort({ platform: process.platform, store: env.store, settings: env.settings, evidenceRun: unavailableEvidenceRun });

const memoryWorker = (env: Env, id: string, extra: Parameters<Env['worker']>[1] = {}): Worker => env.worker(id, { memories: memoryPortOf(env), ...extra });

const saveNote = async (env: Env): Promise<string> => {
  env.gateway.script.push(callsStep([{ callId: 'call_m_1', name: 'MemorySave', args: { text: NOTE, scope: 'user' } }]), textStep('Remembered.'));
  const run = await env.enqueue('Remember this', { history: 'fresh' });
  await env.runOnce(memoryWorker(env, 'saver'));
  expect(env.run(run.id).status).toBe('COMPLETED');
  const saved = env.store.memories.list().find((memory) => memory.text === NOTE);
  if (saved === undefined) throw new Error('the note was not saved');
  return saved.id;
};

const requestText = (env: Env, from: number): string =>
  env.gateway.streams
    .slice(from)
    .map((stream) => (stream.body.input as unknown[]).map(textOf).join('\n'))
    .join('\n');

const upkeep = (env: Env) =>
  runMemoryUpkeep({
    fileSystem: nodeFileSystem,
    store: env.store,
    clock: env.clock,
    views: createRecordViews({ store: env.store, evidenceRun: () => unavailableEvidenceRun() }),
    forgetAfterDays: async () => 90,
    batchSize: 100,
    signal: new AbortController().signal,
  });

describe('use is contribution, never being shown', () => {
  it('an unbound note injected in every run and never used is archived after forgetAfterDays', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const id = await saveNote(env);
    for (let index = 0; index < 3; index += 1) {
      env.clock.advance(31 * DAY_MS);
      env.gateway.script.push(textStep('Hello.'));
      const before = env.gateway.streams.length;
      const run = await env.enqueue('Say hello', { history: 'fresh', deadlineAt: env.clock.now() + 3_600_000 });
      await env.runOnce(memoryWorker(env, `worker-${index}`));
      expect(env.run(run.id).status).toBe('COMPLETED');
      expect(requestText(env, before)).toContain(`<memory id="${id}"`);
    }
    await upkeep(env);
    expect(env.store.memories.get(id)?.state).toBe('archived');
  });

  it('a note used after MemorySearch is kept', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    let added = '';
    const prepare = defineTool<Record<string, never>>({
      name: 'Prepare',
      description: 'Adds a note while the run is under way',
      kind: 'other',
      sideEffect: 'read_only',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 60_000,
      title: () => 'Prepare',
      subject: () => ({ kind: 'none', tool: 'Prepare' }),
      execute: async () => {
        added = env.store.memories.addByCommand({ scope: 'user', project: null, text: NOTE, evidence: [] }).id;
        return { status: 'completed', output: 'prepared' };
      },
    });
    env.gateway.script.push(
      callsStep([{ callId: 'call_p', name: 'Prepare', args: {} }]),
      callsStep([{ callId: 'call_s', name: 'MemorySearch', args: { query: 'launch' } }]),
      textStep('Running zorpLauncher.'),
    );
    env.clock.advance(60_000);
    const run = await env.enqueue('Start the service', { history: 'fresh' });
    await env.runOnce(memoryWorker(env, 'worker-1', { toolList: () => [prepare] }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(added).not.toBe('');
    expect(requestText(env, 0)).not.toContain(`<memory id="${added}"`);
    const [completed] = env.ofType(run.id, 'tool.completed').filter((event) => event.output.includes(added));
    expect(completed?.memories).toEqual([added]);
    expect(env.store.memories.get(added)?.contributedAt).toBe(env.clock.now());
  });
});
