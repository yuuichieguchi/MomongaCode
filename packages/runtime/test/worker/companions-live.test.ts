import { describe, expect, it } from 'vitest';
import { defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const JOB_TOOLS = ['BashOutput', 'KillBash'];
const JOB_ID = 'bash_aaaaaaaaaaaa';

const jobTool = (name: string): AnyTool =>
  defineTool<Record<string, unknown>>({
    name,
    description: `${name} test tool`,
    kind: 'execute',
    sideEffect: 'read_only',
    subjectKind: 'none',
    companionOf: 'Bash',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 1000,
    title: () => name,
    subject: () => ({ kind: 'none', tool: name }),
    execute: async () => ({ status: 'completed', output: 'ok' }),
  });

const withJobTools = (env: Env) => (): AnyTool[] => [...env.toolbox.tools(), jobTool('BashOutput'), jobTool('KillBash')];

const jobToolsIn = (env: Env, index: number): string[] =>
  (env.gateway.streams[index]?.body.tools ?? []).flatMap((tool) => (tool.type === 'function' && JOB_TOOLS.includes(tool.name) ? [tool.name] : []));

const startJob = (env: Env, runId: string): void => {
  env.store.jobs.start({ id: JOB_ID, idemKey: 'k'.repeat(64), sessionId: env.session.id, runId, callId: 'c', command: 'sleep 100' });
};

const bashDeniedEnv = async (cachePrefix: boolean): Promise<Env> => {
  const env = await makeEnv();
  env.settings.extraRules.push({ effect: 'deny', rule: 'Bash' });
  env.settings.contextValue = { ...env.settings.contextValue, cachePrefix };
  env.gateway.script.push(callsStep([{ callId: 'echo-1', name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
  return env;
};

describe('companions follow the session jobs live at each build unless the offer is frozen (review M2)', () => {
  it('offers the job tools from the next build of the same claim when a job starts mid-claim, with every token setting off', async () => {
    const env = await bashDeniedEnv(false);
    const run = env.enqueue('Work');
    env.toolbox.hooks.Echo = async () => startJob(env, run.id);

    await env.runOnce(env.worker('w1', { toolList: withJobTools(env) }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'run.started')).toHaveLength(1);
    expect(jobToolsIn(env, 0)).toEqual([]);
    expect(jobToolsIn(env, 1)).toEqual(JOB_TOOLS);
  });

  it('withdraws the job tools from the next build of the same claim when the job ends mid-claim, with every token setting off', async () => {
    const env = await bashDeniedEnv(false);
    const run = env.enqueue('Work');
    startJob(env, run.id);
    env.toolbox.hooks.Echo = async () => {
      env.store.jobs.finish(JOB_ID, { status: 'exited', exitCode: 0 });
    };

    await env.runOnce(env.worker('w1', { toolList: withJobTools(env) }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'run.started')).toHaveLength(1);
    expect(jobToolsIn(env, 0)).toEqual(JOB_TOOLS);
    expect(jobToolsIn(env, 1)).toEqual([]);
  });

  it('keeps the job state of claim start for the whole claim under cachePrefix', async () => {
    const env = await bashDeniedEnv(true);
    const run = env.enqueue('Work');
    env.toolbox.hooks.Echo = async () => startJob(env, run.id);

    await env.runOnce(env.worker('w1', { toolList: withJobTools(env) }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'run.started')).toHaveLength(1);
    expect(jobToolsIn(env, 0)).toEqual([]);
    expect(jobToolsIn(env, 1)).toEqual([]);
  });
});
