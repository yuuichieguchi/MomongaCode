import { describe, expect, it } from 'vitest';
import { defineTool } from '@momonga/tools';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const jobTool = defineTool<Record<string, unknown>>({
  name: 'JobStatus',
  description: 'Reads a job',
  kind: 'execute',
  sideEffect: 'read_only',
  requiresJobs: true,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  timeoutMs: 1000,
  title: () => 'JobStatus',
  subject: () => ({ kind: 'none', tool: 'JobStatus' }),
  execute: async () => ({ status: 'completed', output: 'ok' }),
});

const namesOf = (env: Awaited<ReturnType<typeof makeEnv>>, index: number): string[] =>
  (env.gateway.streams[index]?.body.tools ?? []).flatMap((tool) => (tool.type === 'function' ? [tool.name] : []));

describe('model-visible tools that need a job', () => {
  it('stay hidden until the session has a job and then appear for the next model call of the same run', async () => {
    const env = await makeEnv();
    const worker = env.worker('w1', { toolList: () => [...env.toolbox.tools(), jobTool] });
    const run = env.enqueue('Work');
    env.toolbox.hooks['Echo'] = () => {
      env.store.jobs.start({ id: 'bash_aaaaaaaaaaaa', idemKey: 'k'.repeat(64), sessionId: env.session.id, runId: run.id, callId: 'c', command: 'sleep 1' });
    };
    env.gateway.script.push(callsStep([{ callId: 'a', name: 'Echo', args: { value: 'x' } }]), textStep('done'));
    await env.runOnce(worker);
    expect(namesOf(env, 0)).toContain('Echo');
    expect(namesOf(env, 0)).not.toContain('JobStatus');
    expect(namesOf(env, 1)).toContain('JobStatus');
  });
});
