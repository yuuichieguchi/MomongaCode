import { describe, expect, it } from 'vitest';
import type { ResolvedContextSettings } from '@momonga/config';
import { TOOL_USAGE_WINDOW_RUNS } from '@momonga/memory';
import type { FunctionTool } from '@momonga/protocol';
import type { AnyTool } from '@momonga/tools';
import { deferred, waitUntil, within } from './deferred.ts';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const LOADER = 'LoadTools';
const WORK_TOOLS = ['Echo', 'Counter', 'Write'];
const TOOL_TIMER_MS = 300;
const SLOW_TEST_MS = 60_000;

const toolsOf = (body: unknown): FunctionTool[] => (body as { tools?: FunctionTool[] }).tools ?? [];
const namesOf = (body: unknown): string[] => toolsOf(body).map((tool) => tool.name);

const workToolsOf = (env: Env) => (): AnyTool[] => env.toolbox.tools().filter((tool) => WORK_TOOLS.includes(tool.name));

const deferralEnv = async (context: Partial<ResolvedContextSettings> = {}): Promise<Env> => {
  const env = await makeEnv();
  env.settings.toolsValue = { ...env.settings.toolsValue, deferral: true };
  env.settings.contextValue = { ...env.settings.contextValue, ...context };
  const warm = env.worker('warm', { toolList: workToolsOf(env) });
  for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS; index += 1) {
    env.gateway.script.push(callsStep([{ callId: `warm-${index}`, name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
    const run = await env.enqueue(`warm ${index}`, { history: 'fresh' });
    await env.runOnce(warm);
    expect(env.run(run.id).status).toBe('COMPLETED');
  }
  return env;
};

const loaderCallIds = (env: Env, runId: string): string[] => env.ofType(runId, 'tool.call').filter((event) => event.name === LOADER).map((event) => event.callId);

const runWithTimedOutAdmission = async (env: Env) => {
  const admissionGate = deferred<void>();
  let gated = false;
  env.gateway.countHook = async (request) => {
    if (gated || !(request.tools ?? []).some((tool) => tool.type === 'function' && tool.name === 'Write')) return;
    gated = true;
    await admissionGate.promise;
  };
  env.gateway.script.push(
    callsStep([{ callId: 'load-1', name: LOADER, args: { names: ['Write'] } }]),
    callsStep([{ callId: 'load-2', name: LOADER, args: { names: ['Write'] } }]),
    callsStep([{ callId: 'echo-1', name: 'Echo', args: { value: 'after' } }]),
    textStep('Done.'),
  );
  const run = await env.enqueue('Use the tools', { history: 'fresh', deadlineAt: env.clock.now() + TOOL_TIMER_MS });
  const running = env.runOnce(env.worker('main', { toolList: workToolsOf(env) }));
  await waitUntil(() => loaderCallIds(env, run.id).length >= 1 && env.ofType(run.id, 'tool.reconciled').some((event) => event.callId === loaderCallIds(env, run.id)[0]), 20_000, 'the first LoadTools to end by its timer');
  admissionGate.resolve();
  await within(running, 20_000, 'the run to finish');
  const [first, second] = loaderCallIds(env, run.id);
  const completed = async (callId: string | undefined) => env.ofType(run.id, 'tool.completed').find((event) => event.callId === callId);
  return { run, gated: () => gated, first: env.ofType(run.id, 'tool.reconciled').find((event) => event.callId === first), second: await completed(second), requests: env.ofType(run.id, 'model.requested') };
};

describe('a tool is loaded exactly when tool.loaded is journaled (review H3)', () => {
  it('records no load for a LoadTools whose admission outlived its timer, and admits the next LoadTools of the same tool', async () => {
    const env = await deferralEnv();

    const { run, gated, first, second, requests } = await runWithTimedOutAdmission(env);

    expect(gated()).toBe(true);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(first).toMatchObject({ outcome: 'not_applied', interrupted: 'timeout' });
    expect(second?.status).toBe('completed');
    expect(second?.output).not.toMatch(/already loaded/);
    expect(env.ofType(run.id, 'tool.loaded').map((event) => event.names)).toEqual([['Write']]);
    expect(env.fold(run.id).loadedTools).toEqual(['Write']);
    expect(requests).toHaveLength(4);
    expect(namesOf(requests[1]?.body)).not.toContain('Write');
    expect(namesOf(requests[2]?.body)).toContain('Write');
  }, SLOW_TEST_MS);

  it.each([
    ['under observedCapacity', { observedCapacity: true }],
    ['under observedCapacity and cachePrefix', { observedCapacity: true, cachePrefix: true }],
  ])('changes the stored offer only at the append of tool.loaded %s', async (_label, context) => {
    const env = await deferralEnv(context);

    const { run, requests } = await runWithTimedOutAdmission(env);

    const loaded = env.ofType(run.id, 'tool.loaded');
    expect(loaded.map((event) => event.names)).toEqual([['Write']]);
    for (const request of requests) {
      const offersWrite = namesOf(request.body).includes('Write');
      expect({ step: request.step, offersWrite }).toEqual({ step: request.step, offersWrite: request.seq > loaded[0]!.seq });
    }
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'prefix_unexplained')).toEqual([]);
  }, SLOW_TEST_MS);
});
