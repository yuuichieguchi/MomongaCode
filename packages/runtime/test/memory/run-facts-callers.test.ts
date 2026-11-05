import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { JournalThreadError } from '@momonga/store';
import { ToolExecutionError } from '@momonga/tools';
import { createFakeTimers } from '@momonga/testkit';
import { createMemoryPort, createReflector, isRunVerified } from '@momonga/runtime';
import { createFakeGateway } from '../worker/fake-gateway.ts';
import { capabilitiesFor } from '../worker/harness.ts';
import { textStep } from '../worker/scripts.ts';
import { bash, fileTool } from './reflection-fixture.ts';
import { HEAD, SHA, factsStore, seqOf } from './run-facts-fixture.ts';

vi.setConfig({ testTimeout: 120_000 });

const SIGNAL = new AbortController().signal;
const VERIFICATION = { commands: ['npm test'], manifests: ['package.json'] };

const checkedRun = (project: string, steps: number): RunEventPayload[] => [
  ...fileTool('w1', 'Write', { path: path.join(project, 'src/a.ts'), sha256: SHA, access: 'write' }),
  ...Array.from({ length: steps }, (_unused, index) => bash(`t${index}`, 'npm test', 0, 'y'.repeat(1_000))).flat(),
  { type: 'tool.call', callId: 'call_m_1', providerCallId: 'call_m_1', name: 'MemorySave', kind: 'other', title: 'save', rawInput: {} },
];

const threadFailure = (): Promise<never> => Promise.reject(new JournalThreadError('journal thread exited with code 1'));

type Env = ReturnType<typeof factsStore>;

const memoryTools = async (env: Env) => {
  const port = createMemoryPort({
    store: env.store,
    settings: { trusted: () => true, verification: async () => VERIFICATION },
    evidenceRun: () => async () => ({ exitCode: 0, stdout: `${HEAD}\n` }),
  } as never);
  const { tools } = await port.load(env.session, SIGNAL);
  const save = tools.find((tool) => tool.name === 'MemorySave');
  if (save === undefined) throw new Error('the memory port offers no MemorySave');
  return (runId: string, paths: string[]) =>
    save.execute({ text: 'a.ts parses the config', scope: 'project', paths } as never, { runId, step: 1, callId: 'call_m_1', signal: SIGNAL } as never);
};

const reflectorFor = (env: Env, gateway: ReturnType<typeof createFakeGateway>) =>
  createReflector({
    store: env.store,
    gateway,
    settings: {
      trusted: () => true,
      verification: async () => VERIFICATION,
      memory: async () => ({ reflection: { enabled: true }, forgetAfterDays: 90, repositoryFacts: true }),
    },
    clock: env.clock,
    isIdle: () => true,
    evidenceRun: () => async () => ({ exitCode: 0, stdout: `${HEAD}\n` }),
    maxAttempts: 3,
    attemptTimeoutMs: 600_000,
    timers: createFakeTimers(env.clock),
    random: () => 0.5,
  } as never);

describe('isRunVerified reads the verdict from the journal thread (inventory row 6)', () => {
  it.each([15, 150])('decodes no journal row on the main thread for a verified run of %i checks', async (steps) => {
    const env = factsStore();
    const run = await env.finished(checkedRun(env.project, steps));

    const { value, rows } = await env.decodedDuring(() => isRunVerified({ store: env.store, settings: { verification: async () => VERIFICATION } } as never, run.id));

    expect(value).toBe(true);
    expect(rows).toBe(0);
  });

  it('rejects with the JournalThreadError of a failed thread and answers no verdict of its own', async () => {
    const env = factsStore({ verdict: threadFailure });
    const run = await env.finished(checkedRun(env.project, 1));

    await expect(isRunVerified({ store: env.store, settings: { verification: async () => VERIFICATION } } as never, run.id)).rejects.toBeInstanceOf(JournalThreadError);
  });
});

describe('MemorySave binds its evidence through the journal thread (inventory row 6)', () => {
  it.each([15, 150])('binds the recorded hash, the head commit and the latest check, decoding no journal row on the main thread, after %i checks', async (steps) => {
    const env = factsStore();
    const run = await env.finished(checkedRun(env.project, steps));
    const events = env.allEvents(run.id);
    const save = await memoryTools(env);

    const { rows } = await env.decodedDuring(() => save(run.id, ['src/a.ts']));

    const [memory] = env.store.memories.list({ project: env.project });
    expect(memory?.evidence).toEqual([
      { kind: 'file', project: env.project, path: 'src/a.ts', sha256: SHA },
      { kind: 'commit', sha: HEAD },
      { kind: 'check', runId: run.id, callId: `t${steps - 1}`, seq: seqOf(events, 'tool.completed', `t${steps - 1}`), command: 'npm test', exitCode: 0 },
    ]);
    expect(rows).toBe(0);
  });

  it('still refuses a path the run never read or wrote, from the thread facts', async () => {
    const env = factsStore();
    const run = await env.finished(checkedRun(env.project, 1));
    const save = await memoryTools(env);

    await expect(save(run.id, ['src/never.ts'])).rejects.toThrow('src/never.ts was not read or written in this run');
    expect(env.store.memories.list({ project: env.project })).toEqual([]);
  });

  it('lets a JournalThreadError escape the tool unchanged, so the claim requeues by O2 instead of the model reading a tool failure', async () => {
    const env = factsStore({ evidence: threadFailure });
    const run = await env.finished(checkedRun(env.project, 1));
    const save = await memoryTools(env);

    const failure = await save(run.id, ['src/a.ts']).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(JournalThreadError);
    expect(failure).not.toBeInstanceOf(ToolExecutionError);
    expect(env.store.memories.list({ project: env.project })).toEqual([]);
  });
});

describe('the reflector reads verdict, facts, evidence and input from the journal thread (inventory row 6)', () => {
  const reflectedRows = async (steps: number) => {
    const env = factsStore();
    const run = await env.finished(checkedRun(env.project, steps));
    const gateway = createFakeGateway(capabilitiesFor(100_000, { structuredOutput: 'json_schema' }));
    gateway.script.push(textStep(JSON.stringify({ candidates: [] })));
    const { value, rows } = await env.decodedDuring(() => reflectorFor(env, gateway).runOne(SIGNAL));
    return { value, rows, run, env };
  };

  it('decodes the same number of journal rows on the main thread at 15 and 150 checks', async () => {
    const small = await reflectedRows(15);
    const large = await reflectedRows(150);

    expect(small.value).toBe('ran');
    expect(large.value).toBe('ran');
    expect(large.rows).toBe(small.rows);
  });

  it('keeps the job for a retry with backoff when the thread fails, drops no candidate for evidence, and does not fail the job', async () => {
    const env = factsStore({ verdict: threadFailure });
    const run = await env.finished(checkedRun(env.project, 1));
    const gateway = createFakeGateway(capabilitiesFor(100_000, { structuredOutput: 'json_schema' }));

    await expect(reflectorFor(env, gateway).runOne(SIGNAL)).rejects.toBeInstanceOf(JournalThreadError);

    const job = (env.store as unknown as { reflection: { get(runId: string): { state: string; attempts: number; dropped: unknown[] } | undefined } }).reflection.get(run.id);
    expect(job).toMatchObject({ attempts: 1, dropped: [] });
    expect(job?.state).not.toBe('failed');
    expect(gateway.streams).toEqual([]);
  });
});
