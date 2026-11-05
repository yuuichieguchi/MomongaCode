import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_USAGE_WINDOW_RUNS, deferredSetOf } from '@momonga/memory';
import type { RunEventPayload } from '@momonga/protocol';
import { createAgentsPort, createChildRuns } from '@momonga/runtime';
import { createNodeSkillFileSystem } from '@momonga/skills';
import type { AnyTool } from '@momonga/tools';
import { toolUsageWindowOf } from '../../src/worker/tool-usage-window.ts';
import { TOOL_OFFERED, bodyWatchedStore } from './body-watched-store.ts';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const LOADER = 'LoadTools';
const WORK_TOOLS = ['Echo', 'Counter', 'Write'];

const offered = (names: readonly string[]): RunEventPayload => ({ type: TOOL_OFFERED, names: [...names] }) as unknown as RunEventPayload;

const requested = (step: number, names: readonly string[]): RunEventPayload => ({
  type: 'model.requested',
  step,
  attempt: 1,
  digest: `d${step}`,
  body: { model: 'fm', input: 'seed', tools: names.map((name) => ({ type: 'function', name })) },
});

const called = (callId: string, name: string): RunEventPayload => ({
  type: 'tool.call',
  callId,
  providerCallId: callId,
  name,
  kind: 'read',
  title: `${name} ${callId}`,
  rawInput: {},
});

const pastRun = (env: Env, payloads: readonly RunEventPayload[]): string => {
  env.clock.advance(1);
  const run = env.enqueue('Past work', { history: 'fresh' });
  const claim = env.seed(run.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'default' }, ...payloads], 'hold');
  expect(env.store.transition(claim, ['RUNNING'], 'COMPLETED').kind).toBe('ok');
  return run.id;
};

const toolsOf = (env: Env, toolNames: readonly string[]) => (): AnyTool[] => env.toolbox.tools().filter((tool) => toolNames.includes(tool.name));

const namesSentTo = (env: Env, runId: string): string[] =>
  env.gateway.streams
    .filter((stream) => (stream.body.metadata as Record<string, unknown> | undefined)?.['run_id'] === runId)
    .flatMap((stream) => (stream.body.tools ?? []).flatMap((tool) => (tool.type === 'function' ? [tool.name] : [])));

const deferralEnv = async (): Promise<Env> => {
  const env = await makeEnv();
  env.settings.toolsValue = { ...env.settings.toolsValue, deferral: true };
  return env;
};

const warmWindow = async (env: Env): Promise<void> => {
  const worker = env.worker('warm', { toolList: toolsOf(env, WORK_TOOLS) });
  for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS; index += 1) {
    env.gateway.script.push(callsStep([{ callId: `warm-${index}`, name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
    env.enqueue(`warm ${index}`, { history: 'fresh' });
    await env.runOnce(worker);
  }
};

const eventsOf = (env: Env, runId: string): { seq: number; type: string; names?: string[] }[] =>
  env.events(runId).map((event) => event as unknown as { seq: number; type: string; names?: string[] });

describe('the tool usage window reads one offered-names record per run (person item 9, a\')', () => {
  it('takes the offered names of a run from its record, not from its request bodies', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    pastRun(env, [offered(['Glob', 'Read']), requested(1, ['Bash', 'Read']), called('call_a', 'Read')]);
    const { store, reads } = bodyWatchedStore(env.store);

    const window = toolUsageWindowOf(store, env.session.cwd);

    expect(window).toEqual([{ offered: ['Glob', 'Read'], called: ['Read'] }]);
    expect(reads.bodyReads).toEqual([]);
  });

  it('counts offered and called names over the twenty-run window from the records alone', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    pastRun(env, [offered(['Bash', 'Glob', 'Grep', 'Read']), called('call_old', 'Bash')]);
    for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS; index += 1) pastRun(env, [offered(['Glob', 'Grep', 'Read']), called(`call_${index}`, 'Read')]);
    const { store, reads } = bodyWatchedStore(env.store);

    const window = toolUsageWindowOf(store, env.session.cwd);

    expect(window).toEqual(Array.from({ length: TOOL_USAGE_WINDOW_RUNS }, () => ({ offered: ['Glob', 'Grep', 'Read'], called: ['Read'] })));
    expect(deferredSetOf({ runs: window })).toEqual(['Glob', 'Grep']);
    expect(reads.bodyReads).toEqual([]);
  });

  it('counts the pinned deferred set as offered, including a pinned tool that plan mode kept out of every request', async () => {
    const env = await deferralEnv();
    await warmWindow(env);
    env.setMode('plan');
    env.gateway.script.push(textStep('Done.'));
    const run = env.enqueue('Use the tools', { history: 'fresh' });
    await env.runOnce(env.worker('main', { toolList: toolsOf(env, WORK_TOOLS) }));
    expect(env.ofType(run.id, 'run.started')[0]?.pins['token']).toEqual({ deferred: ['Counter', 'Write'] });
    expect(namesSentTo(env, run.id)).toEqual(['Echo', LOADER]);
    const { store, reads } = bodyWatchedStore(env.store);

    const window = toolUsageWindowOf(store, env.project);

    expect(window[0]).toEqual({ offered: ['Counter', 'Echo', LOADER, 'Write'], called: [] });
    expect(reads.bodyReads).toEqual([]);
  });

  it('attributes the tools offered only to a child run to its root run', async () => {
    const env = await makeEnv();
    const directory = path.join(env.project, '.momonga', 'agents');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'counter.md'), '---\nname: counter\ndescription: counter agent\ntools: Echo, Counter\n---\nYou count.\n');
    const agents = () =>
      createAgentsPort({
        home: env.home,
        fileSystem: createNodeSkillFileSystem(),
        settings: { trusted: () => env.settings.trustedValue },
        runs: createChildRuns({ store: env.store, modelAliases: async () => ['fm'] }),
      });
    const rootWorker = env.worker('root', { agents: agents(), toolList: toolsOf(env, ['Echo']) });
    const childWorker = env.worker('child', { agents: agents(), toolList: toolsOf(env, ['Echo', 'Counter']) });
    env.gateway.script.push(
      callsStep([{ callId: 'delegate-1', name: 'Agent', args: { description: 'count', prompt: 'Count once', subagent_type: 'counter' } }]),
      textStep('counted'),
      textStep('Done.'),
    );
    const root = env.enqueue('Delegate the count', { history: 'fresh' });
    await env.runOnce(rootWorker);
    const [child] = env.store.listChildRuns(root.id);
    if (child === undefined) throw new Error('the root run created no child run');
    await env.runOnce(childWorker);
    await env.runOnce(rootWorker);
    expect(env.run(child.id).status).toBe('COMPLETED');
    expect(env.run(root.id).status).toBe('COMPLETED');
    expect(namesSentTo(env, root.id)).not.toContain('Counter');
    expect(namesSentTo(env, child.id)).toContain('Counter');
    const { store, reads } = bodyWatchedStore(env.store);

    const window = toolUsageWindowOf(store, env.project);

    expect(window).toHaveLength(1);
    expect(window[0]?.offered).toContain('Counter');
    expect(window[0]?.offered).toEqual([...new Set([...namesSentTo(env, root.id), ...namesSentTo(env, child.id)])].sort());
    expect(reads.bodyReads).toEqual([]);
  });

  it('updates the record of a run when tools_loaded adds a tool mid-run', async () => {
    const env = await deferralEnv();
    await warmWindow(env);
    env.gateway.script.push(callsStep([{ callId: 'load-1', name: LOADER, args: { names: ['Write'] } }]), textStep('Done.'));
    const run = env.enqueue('Use the tools', { history: 'fresh' });
    await env.runOnce(env.worker('main', { toolList: toolsOf(env, WORK_TOOLS) }));
    const events = eventsOf(env, run.id);
    const loadedAt = events.find((event) => event.type === 'tool.loaded')?.seq;
    if (loadedAt === undefined) throw new Error('the run recorded no tool.loaded');
    const records = events.filter((event) => event.type === TOOL_OFFERED);
    const { store, reads } = bodyWatchedStore(env.store);

    const window = toolUsageWindowOf(store, env.project);

    const startedAt = events.find((event) => event.type === 'run.started')?.seq ?? Infinity;
    const firstRequestAt = events.find((event) => event.type === 'model.requested')?.seq ?? -Infinity;
    expect(records.filter((record) => record.seq > startedAt && record.seq < firstRequestAt).map((record) => record.names)).toEqual([['Counter', 'Echo', LOADER, 'Write']]);
    expect(records.filter((record) => record.seq > loadedAt).map((record) => record.names)).toEqual([['Counter', 'Echo', LOADER, 'Write']]);
    expect(window[0]).toEqual({ offered: ['Counter', 'Echo', LOADER, 'Write'], called: [LOADER] });
    expect(reads.bodyReads).toEqual([]);
  });
});
