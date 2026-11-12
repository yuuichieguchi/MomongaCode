import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { USER_SHELL_TAG } from '@momonga/protocol';
import { defineTool } from '@momonga/tools';
import { capabilitiesFor, makeEnv, textOf } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const waitForApproval = async (env: Env) => {
  env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'x' } }]));
  const run = await env.enqueue('Write the file');
  await env.runOnce(env.worker('worker-1'));
  expect(env.run(run.id).status).toBe('WAITING_HUMAN');
  await env.resolveApproval(run.id, 'allow_once');
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

describe('the recorded tool.call event', () => {
  it('carries the side effect the tool declares, independent of its kind', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'x' } }]));
    const run = await env.enqueue('Write the file');
    await env.runOnce(env.worker('worker-1'));
    const [call] = env.events(run.id).filter((event) => event.type === 'tool.call');
    expect(call).toMatchObject({ name: 'Write', sideEffect: 'write' });
  });
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

  it('fails with pins_mismatch when the session model changed without a model.changed event', async () => {
    const env = await makeEnv();
    const run = await waitForApproval(env);
    env.setModel('other-model');
    env.gateway.script.push(textStep('Written.'));

    await env.runOnce(env.worker('worker-2'));

    const failed = env.run(run.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error?.code).toBe('pins_mismatch');
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('fails with pins_mismatch when the recorded model.changed events do not lead from the pinned model to the session model', async () => {
    const env = await makeEnv();
    const run = await waitForApproval(env);
    env.store.setModel(env.session.id, 'other-model');
    env.setModel('third-model');
    env.gateway.script.push(textStep('Written.'));

    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id).error?.code).toBe('pins_mismatch');
  });

  it('keeps the pinned model when the switch is recorded by a model.changed event and the chain ends at the session model', async () => {
    const env = await makeEnv();
    const run = await waitForApproval(env);
    env.store.setModel(env.session.id, 'other-model');
    env.store.setModel(env.session.id, 'third-model');
    env.gateway.script.push(textStep('Written.'));

    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams.map((stream) => stream.body.model)).toEqual(['fm', 'fm']);
    const starts = env.ofType(run.id, 'run.started');
    expect(starts[1]?.pins).toEqual(starts[0]?.pins);
  });

  it('pins the changed model in a run that starts after the change', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('First.'), textStep('Second.'));
    const first = await env.enqueue('First task');
    await env.runOnce(env.worker('worker-1'));
    env.setModel('other-model');
    const second = await env.enqueue('Second task');
    await env.runOnce(env.worker('worker-1'));

    expect(env.run(first.id).status).toBe('COMPLETED');
    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(env.gateway.streams.map((stream) => stream.body.model)).toEqual(['fm', 'other-model']);
    expect(env.ofType(second.id, 'run.started')[0]?.pins).toMatchObject({ model: 'other-model' });
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

describe('the output of ! commands on a small window', () => {
  it('is not pinned: three large outputs raise no pinned_overflow and reach the model through the history, each within the item limit', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(8192, { maxOutputTokens: 1024 }) });
    for (const index of [1, 2, 3]) {
      env.store.userShell.record(env.session.id, { command: `make step${index}`, exitCode: 0, output: `out${index} ${'z'.repeat(20_000)}`, include: true });
    }
    env.gateway.script.push(textStep('Done.'));
    const run = await env.enqueue('why does it fail');

    await env.runOnce(env.worker());

    expect(env.run(run.id).error?.code).not.toBe('pinned_overflow');
    expect(env.run(run.id).status).toBe('COMPLETED');
    const sent = JSON.stringify(env.gateway.streams[0]?.body.input);
    for (const index of [1, 2, 3]) expect(sent).toContain(JSON.stringify(`<${USER_SHELL_TAG} command=${JSON.stringify(`make step${index}`)}`).slice(1, -1));
    expect(sent).not.toContain('z'.repeat(20_000));
  });
});

