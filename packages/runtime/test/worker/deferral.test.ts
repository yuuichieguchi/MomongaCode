import { describe, expect, it } from 'vitest';
import type { ResolvedContextSettings } from '@momonga/config';
import { TOOL_USAGE_WINDOW_RUNS } from '@momonga/memory';
import type { Capabilities, FunctionTool } from '@momonga/protocol';
import { defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { toolUsageWindowOf } from '../../src/worker/tool-usage-window.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const LOADER = 'LoadTools';
const WORK_TOOLS = ['Echo', 'Counter', 'Write'];

const toolsOf = (body: unknown): FunctionTool[] => (body as { tools?: FunctionTool[] }).tools ?? [];
const namesOf = (body: unknown): string[] => toolsOf(body).map((tool) => tool.name);
const loaderOf = (body: unknown): FunctionTool | undefined => toolsOf(body).find((tool) => tool.name === LOADER);
const enumOf = (body: unknown): unknown =>
  (loaderOf(body)?.parameters as { properties?: { names?: { items?: { enum?: unknown } } } } | undefined)?.properties?.names?.items?.enum;

const SMALL_WINDOW_TOKENS = 16_000;
const WORDS_OVER_THE_SMALL_WINDOW = 12_000;

const bigTool = (descriptionWords: number): AnyTool =>
  defineTool<Record<string, unknown>>({
    name: 'Big',
    description: 'Summarises a big corpus.',
    kind: 'read',
    sideEffect: 'read_only',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'word '.repeat(descriptionWords) } },
      required: ['query'],
      additionalProperties: false,
    },
    timeoutMs: 1_000,
    title: () => 'Big',
    subject: () => ({ kind: 'none', tool: 'Big' }),
    execute: async () => ({ status: 'completed', output: 'big' }),
  });

const workToolsOf = (env: Env, extra: readonly AnyTool[] = []) => (): AnyTool[] => [...env.toolbox.tools().filter((tool) => WORK_TOOLS.includes(tool.name)), ...extra];

const deferralEnv = async (context: Partial<ResolvedContextSettings> = {}, capabilities?: Capabilities) => {
  const env = await makeEnv(capabilities === undefined ? {} : { capabilities });
  env.settings.toolsValue = { ...env.settings.toolsValue, deferral: true };
  env.settings.contextValue = { ...env.settings.contextValue, ...context };
  return env;
};

const warmWindow = async (env: Env, extra: readonly AnyTool[] = []): Promise<string[]> => {
  const worker = env.worker('warm', { toolList: workToolsOf(env, extra) });
  const ids: string[] = [];
  for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS; index += 1) {
    env.gateway.script.push(callsStep([{ callId: `warm-${index}`, name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
    const run = env.enqueue(`warm ${index}`, { history: 'fresh' });
    await env.runOnce(worker);
    expect(env.run(run.id).status).toBe('COMPLETED');
    ids.push(run.id);
  }
  return ids;
};

const runDeferred = async (env: Env, steps: Parameters<typeof env.gateway.script.push>, extra: readonly AnyTool[] = []) => {
  env.gateway.script.push(...steps);
  const run = env.enqueue('Use the tools', { history: 'fresh' });
  await env.runOnce(env.worker('main', { toolList: workToolsOf(env, extra) }));
  return { run, requests: env.ofType(run.id, 'model.requested') };
};

const tokenPinOf = (env: Env, runId: string): unknown => env.ofType(runId, 'run.started')[0]?.pins['token'];

const completedOf = (env: Env, runId: string, name: string, nth: number) => {
  const call = env.ofType(runId, 'tool.call').filter((event) => event.name === name)[nth];
  return call === undefined ? undefined : env.ofType(runId, 'tool.completed').find((event) => event.callId === call.callId);
};

describe('pins.token.deferred is decided at root run start from the usage window (5.1, 7.2)', () => {
  it('pins an empty deferred set while the window holds fewer than N runs, and the never-called tools once it is full', async () => {
    const env = await deferralEnv();
    const warm = await warmWindow(env);

    const { run } = await runDeferred(env, [textStep('Done.')]);

    expect(tokenPinOf(env, warm[0] ?? '')).toEqual({ deferred: [] });
    expect(tokenPinOf(env, run.id)).toEqual({ deferred: ['Counter', 'Write'] });
  });
});

describe('the offer under a pinned deferred set (5.1, 5.2)', () => {
  it('withholds the deferred tools and offers LoadTools whose enum and catalog lines are the deferred set', async () => {
    const env = await deferralEnv();
    await warmWindow(env);

    const { requests } = await runDeferred(env, [textStep('Done.')]);
    const lines = (loaderOf(requests[0]?.body)?.description ?? '').split('\n');

    expect(namesOf(requests[0]?.body)).toEqual([LOADER, 'Echo']);
    expect(enumOf(requests[0]?.body)).toEqual(['Counter', 'Write']);
    expect(lines).toContain('Counter: Return an increasing count');
    expect(lines).toContain('Write: Write a file');
  });
});

describe('LoadTools adds the definitions from the next request (5.2, Q7)', () => {
  it.each([
    ['without cachePrefix', {}],
    ['under cachePrefix', { cachePrefix: true }],
    ['under observedCapacity, which keeps the first build offer for the claim (open item 14d)', { observedCapacity: true }],
  ])('appends tool.loaded and offers Write from the next request %s', async (_label, context) => {
    const env = await deferralEnv(context);
    await warmWindow(env);

    const { run, requests } = await runDeferred(env, [
      callsStep([{ callId: 'load-1', name: LOADER, args: { names: ['Write'] } }]),
      textStep('Done.'),
    ]);
    const write = toolsOf(requests[1]?.body).find((tool) => tool.name === 'Write');

    expect(env.ofType(run.id, 'tool.loaded').map((event) => event.names)).toEqual([['Write']]);
    expect(completedOf(env, run.id, LOADER, 0)?.status).toBe('completed');
    expect(namesOf(requests[0]?.body)).toEqual([LOADER, 'Echo']);
    expect(namesOf(requests[1]?.body)).toEqual([LOADER, 'Echo', 'Write']);
    expect(write?.description).toBe('Write a file');
    expect(new Set(Object.keys((write?.parameters as { properties: Record<string, unknown> }).properties))).toEqual(new Set(['file_path', 'content']));
    expect(env.fold(run.id).loadedTools).toEqual(['Write']);
  });

  it('records the changed tools array as the named event tools_loaded (T3-1, 8)', async () => {
    const env = await deferralEnv({ cachePrefix: true });
    await warmWindow(env);

    const { run, requests } = await runDeferred(env, [
      callsStep([{ callId: 'load-1', name: LOADER, args: { names: ['Write'] } }]),
      textStep('Done.'),
    ]);

    expect(requests[1]?.prefix).toMatchObject({ toolsChanged: true, causes: ['tools_loaded'] });
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'prefix_unexplained')).toEqual([]);
  });

  it('applies two loads of one response together and never removes them (T3-2, LoadBreaksOnce)', async () => {
    const env = await deferralEnv({ cachePrefix: true });
    await warmWindow(env);

    const { run, requests } = await runDeferred(env, [
      callsStep([
        { callId: 'load-1', name: LOADER, args: { names: ['Counter'] } },
        { callId: 'load-2', name: LOADER, args: { names: ['Write'] } },
      ]),
      callsStep([{ callId: 'echo-1', name: 'Echo', args: { value: 'x' } }]),
      textStep('Done.'),
    ]);

    expect(requests).toHaveLength(3);
    expect([...namesOf(requests[1]?.body)].sort()).toEqual(['Counter', 'Echo', LOADER, 'Write']);
    expect(namesOf(requests[1]?.body).slice(0, 2)).toEqual([LOADER, 'Echo']);
    expect(toolsOf(requests[2]?.body)).toEqual(toolsOf(requests[1]?.body));
    expect(requests[2]?.prefix).toMatchObject({ toolsChanged: false });
    expect(env.ofType(run.id, 'tool.loaded').flatMap((event) => event.names).sort()).toEqual(['Counter', 'Write']);
  });

  it('completes a second load of an already loaded tool without another tool.loaded', async () => {
    const env = await deferralEnv();
    await warmWindow(env);

    const { run, requests } = await runDeferred(env, [
      callsStep([{ callId: 'load-1', name: LOADER, args: { names: ['Write'] } }]),
      callsStep([{ callId: 'load-2', name: LOADER, args: { names: ['Write'] } }]),
      textStep('Done.'),
    ]);

    expect(env.ofType(run.id, 'tool.loaded')).toHaveLength(1);
    expect(completedOf(env, run.id, LOADER, 1)?.status).toBe('completed');
    expect(toolsOf(requests[2]?.body)).toEqual(toolsOf(requests[1]?.body));
  });

  it('refuses a load whose definition does not fit, with the measured reason, and changes nothing (T3-5)', async () => {
    const env = await deferralEnv({}, capabilitiesFor(SMALL_WINDOW_TOKENS));
    await warmWindow(env, [bigTool(1)]);

    const { run, requests } = await runDeferred(
      env,
      [callsStep([{ callId: 'load-big', name: LOADER, args: { names: ['Big'] } }]), textStep('Done.')],
      [bigTool(WORDS_OVER_THE_SMALL_WINDOW)],
    );
    const refused = completedOf(env, run.id, LOADER, 0);

    expect(enumOf(requests[0]?.body)).toEqual(['Big', 'Counter', 'Write']);
    expect(refused?.status).toBe('failed');
    expect(refused?.output).toContain('Big');
    expect(refused?.output).toMatch(/\d+ tokens/);
    expect(env.ofType(run.id, 'tool.loaded')).toEqual([]);
    expect(namesOf(requests[1]?.body)).toEqual([LOADER, 'Echo']);
  });
});

describe('only offered tools run (5.3, 0.2 #11, Q8)', () => {
  it('fails a call to a deferred tool that is not loaded, without running it', async () => {
    const env = await deferralEnv();
    await warmWindow(env);

    const { run } = await runDeferred(env, [callsStep([{ callId: 'count-1', name: 'Counter', args: { value: 'x' } }]), textStep('Done.')]);
    const completed = completedOf(env, run.id, 'Counter', 0);

    expect(completed?.status).toBe('failed');
    expect(completed?.output).toContain('load it with LoadTools first');
    expect(env.toolbox.executions.filter((execution) => execution.name === 'Counter')).toEqual([]);
  });

  it('fails a call to a tool that plan mode hid as not offered, even though the pin lists it as deferred', async () => {
    const env = await deferralEnv();
    await warmWindow(env);
    env.setMode('plan');

    const { run, requests } = await runDeferred(env, [
      callsStep([{ callId: 'write-1', name: 'Write', args: { file_path: `${env.project}/a.txt`, content: 'a' } }]),
      textStep('Done.'),
    ]);
    const completed = completedOf(env, run.id, 'Write', 0);

    expect(enumOf(requests[0]?.body)).toEqual(['Counter']);
    expect(completed?.status).toBe('failed');
    expect(completed?.output).toBe('Tool "Write" was not offered in the request that produced this call, so it cannot run. Available tools: LoadTools, Echo');
    expect(env.ofType(run.id, 'tool.permission.requested')).toEqual([]);
    expect(env.toolbox.executions.filter((execution) => execution.name === 'Write')).toEqual([]);
  });
});

describe('a pinned deferred tool counts as offered in the usage window (open item 8, T5-3)', () => {
  it('reports the deferred tools as offered by the run that withheld them, so they stay deferred for the next run', async () => {
    const env = await deferralEnv();
    await warmWindow(env);

    const first = await runDeferred(env, [textStep('Done.')]);
    const window = await toolUsageWindowOf(env.store, env.project);
    const second = await runDeferred(env, [textStep('Done.')]);

    expect(namesOf(first.requests[0]?.body)).toEqual([LOADER, 'Echo']);
    expect(window[0]?.offered).toEqual(expect.arrayContaining(['Counter', 'Echo', 'Write']));
    expect(window[0]?.called).toEqual([]);
    expect(tokenPinOf(env, second.run.id)).toEqual({ deferred: ['Counter', 'Write'] });
  });
});
