import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MemoryRecord, RunEventPayload } from '@momonga/protocol';
import { createFakeTimers, NEVER_CANCELLED } from '@momonga/testkit';
import type { RuntimeStore } from '@momonga/store';
import { memoryTextProblem } from '@momonga/tools';
import * as memory from '@momonga/memory';
import { REQUEUE_BASE_MS } from '../../src/process/constants.ts';
import { enqueue, harness, makeStoreDir, newSession } from '../../../store/test/helpers.ts';
import { createFakeGateway } from '../worker/fake-gateway.ts';
import { capabilitiesFor } from '../worker/harness.ts';
import { withInProcessFacts } from './in-process-facts.ts';
import { textStep } from '../worker/scripts.ts';
import { bash, exported, fileTool, finishClaimed, checked, conditionIdOf, verdictSeqOf } from './reflection-fixture.ts';

type Dropped = { ordinal: number; text: string | null; cause: string; reason: string };

type Job = { state: string; attempts: number; lastError: string | null; dropped: Dropped[] };

type Api = {
  reflection: { get(runId: string): Job | undefined };
  contextCharges: { list(): Record<string, unknown>[] };
  memories: RuntimeStore['memories'] & { candidates(): MemoryRecord[] };
};

type Reflector = { runOne(signal: AbortSignal): Promise<'idle' | 'busy' | 'ran'> };

const SIGNAL = new AbortController().signal;
const MAX_ATTEMPTS = 3;
const HEAD = 'b'.repeat(40);
const MANIFEST_SHA = 'c'.repeat(64);
const SOURCE_SHA = 'a'.repeat(64);
const COMMANDS = ['npm test', 'npm run lint'];
const MANIFESTS = ['package.json'];
const DUPLICATE_REASON = 'the same text is already a live memory, a candidate waiting for review, or a candidate a person rejected';

const factText = (command: string): string => {
  const found = (memory as Record<string, unknown>)['repositoryFactText'];
  if (typeof found !== 'function') throw new Error('@momonga/memory does not export repositoryFactText');
  return (found as (command: string) => string)(command);
};

const NPM_TEST_FACT = 'Run `npm test` to verify a change in this repository.';
const LINT_FACT = 'Run `npm run lint` to verify a change in this repository.';

type Options = { enabled?: boolean; facts?: boolean; trusted?: boolean };

const setup = async ({ enabled = false, facts = true, trusted = true }: Options = {}) => {
  const opened = harness();
  const { clock } = opened;
  const store = withInProcessFacts(opened.store, opened.dbPath);
  const project = makeStoreDir();
  if (trusted) await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
  const session = newSession(store, project);
  const gateway = createFakeGateway(capabilitiesFor(100_000, { structuredOutput: 'json_schema' }));
  const settings = {
    trusted: async (target: { cwd: string }) => (await store.trust.decisionAsked(target.cwd, NEVER_CANCELLED)).decision === 'trusted',
    verification: async () => ({ commands: [...COMMANDS], manifests: [...MANIFESTS] }),
    memory: async () => ({ reflection: { enabled }, forgetAfterDays: 90, repositoryFacts: facts }),
  };
  const reflector = (): Reflector =>
    exported<(options: unknown) => Reflector>('createReflector')({
      store,
      gateway,
      settings,
      clock,
      isIdle: () => true,
      evidenceRun: () => async () => ({ exitCode: 0, stdout: `${HEAD}\n` }),
      maxAttempts: MAX_ATTEMPTS,
      attemptTimeoutMs: 600_000,
      timers: createFakeTimers(clock),
      random: () => 0.5,
    });
  const finishedRun = async (events: readonly RunEventPayload[]) => {
    const run = await enqueue(store, session.id, 'fix the bug');
    await finishClaimed(store, events);
    return run;
  };
  return { store, api: store as unknown as Api, clock, project, session, gateway, reflector, finishedRun };
};

const VERIFIED_TWICE = (project: string): RunEventPayload[] => [
  ...fileTool('w1', 'Write', { path: path.join(project, 'src/a.ts'), sha256: SOURCE_SHA, access: 'write' }),
  ...fileTool('r1', 'Read', { path: path.join(project, 'package.json'), sha256: MANIFEST_SHA, access: 'read' }),
  ...checked('npm test', 0, 'ok'),
  ...checked('npm run lint', 0, 'ok'),
];

const UNVERIFIED = (project: string): RunEventPayload[] => [
  ...fileTool('w1', 'Write', { path: path.join(project, 'src/a.ts'), sha256: SOURCE_SHA, access: 'write' }),
  ...checked('npm test', 1, 'failed'),
];

const seqOf = (store: RuntimeStore, runId: string, command: string): number => verdictSeqOf(store.readRunEvents(runId, 0, 1000), command);

const candidatesOf = async (env: Awaited<ReturnType<typeof setup>>, runId: string) =>
  env.api.memories
    .candidates()
    .filter((record) => record.source.kind === 'reflection' && record.source.runId === runId)
    .map((record) => ({ text: record.text, kind: record.kind, scope: record.scope, origin: record.origin, project: record.project, ordinal: record.source.kind === 'reflection' ? record.source.ordinal : -1 }));

describe('repository fact text', () => {
  it('passes the memory text rule, so a fact is never dropped for its own wording', () => {
    for (const command of COMMANDS) expect(memoryTextProblem(factText(command))).toBeUndefined();
    expect(factText('npm test')).toBe(NPM_TEST_FACT);
  });
});

describe('repository facts with reflection off', () => {
  it('saves one procedure candidate per passing verification command, with no model call and no charge', async () => {
    const env = await setup({ enabled: false, facts: true });
    const run = await env.finishedRun(VERIFIED_TWICE(env.project));
    expect(await env.reflector().runOne(SIGNAL)).toBe('ran');
    expect(env.gateway.streams).toEqual([]);
    expect(env.api.contextCharges.list()).toEqual([]);
    expect(env.api.reflection.get((await run).id)).toMatchObject({ state: 'done', lastError: 'reflection is off', dropped: [] });
    expect(await candidatesOf(env, (await run).id)).toEqual([
      { text: NPM_TEST_FACT, kind: 'procedure', scope: 'project', origin: 'trusted', project: env.project, ordinal: 0 },
      { text: LINT_FACT, kind: 'procedure', scope: 'project', origin: 'trusted', project: env.project, ordinal: 1 },
    ]);
  });

  it('binds each fact to the manifests the run read, the commit, and the check of its own command', async () => {
    const env = await setup({ enabled: false, facts: true });
    const run = await env.finishedRun(VERIFIED_TWICE(env.project));
    await env.reflector().runOne(SIGNAL);
    const evidence = Object.fromEntries(env.api.memories.candidates().map((record) => [record.text, record.evidence]));
    expect(evidence[NPM_TEST_FACT]).toEqual([
      { kind: 'file', project: env.project, path: 'package.json', sha256: MANIFEST_SHA },
      { kind: 'commit', sha: HEAD },
      { kind: 'check', runId: (await run).id, conditionId: conditionIdOf('npm test'), seq: seqOf(env.store, (await run).id, 'npm test'), command: 'npm test', exitCode: 0 },
    ]);
    expect(evidence[LINT_FACT]).toEqual([
      { kind: 'file', project: env.project, path: 'package.json', sha256: MANIFEST_SHA },
      { kind: 'commit', sha: HEAD },
      { kind: 'check', runId: (await run).id, conditionId: conditionIdOf('npm run lint'), seq: seqOf(env.store, (await run).id, 'npm run lint'), command: 'npm run lint', exitCode: 0 },
    ]);
  });

  it('drops a fact that is already a candidate with cause duplicate, and keeps the other', async () => {
    const env = await setup({ enabled: false, facts: true });
    await env.finishedRun([...fileTool('w0', 'Write', { path: path.join(env.project, 'src/a.ts'), sha256: SOURCE_SHA, access: 'write' }), ...checked('npm test', 0, 'ok')]);
    await env.reflector().runOne(SIGNAL);
    const run = await env.finishedRun(VERIFIED_TWICE(env.project));
    await env.reflector().runOne(SIGNAL);
    expect(env.api.reflection.get((await run).id)).toMatchObject({ state: 'done', lastError: 'reflection is off', dropped: [{ ordinal: 0, text: NPM_TEST_FACT, cause: 'duplicate', reason: DUPLICATE_REASON }] });
    expect((await candidatesOf(env, (await run).id)).map((candidate) => [candidate.text, candidate.ordinal])).toEqual([[LINT_FACT, 1]]);
  });

  it('keeps today\'s ending when facts are off', async () => {
    const env = await setup({ enabled: false, facts: false });
    const run = await env.finishedRun(VERIFIED_TWICE(env.project));
    await env.reflector().runOne(SIGNAL);
    expect(env.api.reflection.get((await run).id)).toMatchObject({ state: 'done', lastError: 'reflection is off', dropped: [] });
    expect(env.api.memories.candidates()).toEqual([]);
  });

  it('builds no fact for a run that is not a verified success, and ends it as reflection off', async () => {
    const env = await setup({ enabled: false, facts: true });
    const run = await env.finishedRun(UNVERIFIED(env.project));
    await env.reflector().runOne(SIGNAL);
    expect(env.api.reflection.get((await run).id)).toMatchObject({ state: 'done', lastError: 'reflection is off' });
    expect(env.api.memories.candidates()).toEqual([]);
  });

  it('builds no fact for a run made outside a trusted folder', async () => {
    const env = await setup({ enabled: false, facts: true, trusted: false });
    const run = await env.finishedRun(VERIFIED_TWICE(env.project));
    await env.reflector().runOne(SIGNAL);
    expect(env.api.reflection.get((await run).id)).toMatchObject({ state: 'done', lastError: 'the run was not made in a trusted folder' });
    expect(env.api.memories.candidates()).toEqual([]);
  });
});

describe('repository facts with reflection on', () => {
  it('ends an unverified run with no fact and no model call', async () => {
    const env = await setup({ enabled: true, facts: true });
    const run = await env.finishedRun(UNVERIFIED(env.project));
    await env.reflector().runOne(SIGNAL);
    expect(env.gateway.streams).toEqual([]);
    expect(env.api.reflection.get((await run).id)).toMatchObject({ state: 'done', lastError: 'the run is not a verified success' });
    expect(env.api.memories.candidates()).toEqual([]);
  });

  it('settles the facts with the model candidates and the one charge, numbering the model candidates after the facts', async () => {
    const env = await setup({ enabled: true, facts: true });
    const run = await env.finishedRun(VERIFIED_TWICE(env.project));
    env.gateway.script.push(textStep(JSON.stringify({ candidates: [{ text: NPM_TEST_FACT, kind: 'fact', paths: [] }, { text: 'the fixture needs a seed', kind: 'fact', paths: [] }] })));
    expect(await env.reflector().runOne(SIGNAL)).toBe('ran');
    expect(env.gateway.streams).toHaveLength(1);
    expect(env.api.contextCharges.list()).toHaveLength(1);
    expect(env.api.reflection.get((await run).id)).toMatchObject({ state: 'done', lastError: null, dropped: [{ ordinal: 2, text: NPM_TEST_FACT, cause: 'duplicate', reason: DUPLICATE_REASON }] });
    expect((await candidatesOf(env, (await run).id)).map((candidate) => [candidate.text, candidate.kind, candidate.ordinal])).toEqual([
      [NPM_TEST_FACT, 'procedure', 0],
      [LINT_FACT, 'procedure', 1],
      ['the fixture needs a seed', 'fact', 3],
    ]);
  });

  it('writes the facts when the job fails at its last attempt, and not before', async () => {
    const env = await setup({ enabled: true, facts: true });
    const run = await env.finishedRun(VERIFIED_TWICE(env.project));
    const reflector = env.reflector();
    const failure = new Error('connection lost');
    env.gateway.script.push({ events: [], error: failure }, { events: [], error: failure }, { events: [], error: failure });
    await expect(reflector.runOne(SIGNAL)).rejects.toBe(failure);
    expect(env.api.reflection.get((await run).id)).toMatchObject({ state: 'running', attempts: 1 });
    expect(env.api.memories.candidates()).toEqual([]);
    env.clock.advance(REQUEUE_BASE_MS * 4);
    await expect(reflector.runOne(SIGNAL)).rejects.toBe(failure);
    expect(env.api.memories.candidates()).toEqual([]);
    env.clock.advance(REQUEUE_BASE_MS * 4);
    await expect(reflector.runOne(SIGNAL)).rejects.toBe(failure);
    expect(env.api.reflection.get((await run).id)).toMatchObject({ state: 'failed', attempts: MAX_ATTEMPTS, lastError: 'connection lost' });
    expect((await candidatesOf(env, (await run).id)).map((candidate) => [candidate.text, candidate.kind, candidate.ordinal])).toEqual([
      [NPM_TEST_FACT, 'procedure', 0],
      [LINT_FACT, 'procedure', 1],
    ]);
    expect(env.api.contextCharges.list()).toEqual([]);
  });
});
