import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineTool } from '@momonga/tools';
import { makeEnv, textOf } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const waitForApproval = async (env: Env) => {
  env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'x' } }]));
  const run = env.enqueue('Write the file');
  await env.runOnce(env.worker('worker-1'));
  expect(env.run(run.id).status).toBe('WAITING_HUMAN');
  env.resolveApproval(run.id, 'allow_once');
  return run;
};

const extraTool = defineTool<Record<string, unknown>>({
  name: 'Extra',
  description: 'An extra tool added after a restart',
  kind: 'read',
  sideEffect: 'read_only',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  timeoutMs: 1000,
  title: () => 'Extra',
  subject: () => ({ kind: 'none', tool: 'Extra' }),
  execute: async () => ({ status: 'completed', output: 'extra' }),
});

describe('worker pins across attempts', () => {
  it('fails with pins_mismatch when the system prompt digest differs on a later attempt', async () => {
    const env = await makeEnv();
    const run = await waitForApproval(env);

    await env.runOnce(env.worker('worker-2', { systemPrompt: ({ cwd }) => `A different prompt for ${cwd}.` }));

    const failed = env.run(run.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error?.code).toBe('pins_mismatch');
    expect(env.toolbox.executions).toEqual([]);
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('fails with pins_mismatch when the session model alias differs on a later attempt', async () => {
    const env = await makeEnv();
    const run = await waitForApproval(env);
    env.setModelAlias('other-model');

    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'pins_mismatch' } });
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('emits a notice and continues when the tool set digest differs on a later attempt', async () => {
    const env = await makeEnv();
    const run = await waitForApproval(env);
    const noticesBefore = env.ofType(run.id, 'notice').length;
    env.gateway.script.push(textStep('Written.'));

    await env.runOnce(env.worker('worker-2', { toolList: () => [...env.toolbox.tools(), extraTool] }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'notice').length).toBeGreaterThan(noticesBefore);
    const starts = env.ofType(run.id, 'run.started');
    expect(starts.map((event) => event.attempt)).toEqual([1, 2]);
    expect(starts[1]?.pins).toEqual(starts[0]?.pins);
  });

  it('re-pins the instructions on a later attempt so an edited AGENTS.md does not fail recovery', async () => {
    const env = await makeEnv();
    const agentsPath = path.join(env.project, 'AGENTS.md');
    env.instructions.files.set(agentsPath, 'Rule one: be careful.');
    const run = await waitForApproval(env);
    env.instructions.files.set(agentsPath, 'Rule two: be quick.');
    env.gateway.script.push(textStep('Written.'));

    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    const input = env.gateway.streams[1]?.body.input;
    expect(Array.isArray(input) && input.some((item) => textOf(item).includes('Rule two: be quick.'))).toBe(true);
    const first = env.gateway.streams[0]?.body.input;
    expect(Array.isArray(first) && first.some((item) => textOf(item).includes('Rule one: be careful.'))).toBe(true);
  });
});
