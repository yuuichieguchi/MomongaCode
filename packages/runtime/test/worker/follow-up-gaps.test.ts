import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { defineTool } from '@momonga/tools';
import { deferred, waitUntil, within } from './deferred.ts';
import { START_MS, bodyDigest, makeEnv, toolKey } from './harness.ts';
import { assistantMessage, callsStep, functionCallItem, textStep } from './scripts.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };

const touchTool = (runs: string[]) =>
  defineTool<Record<string, unknown>>({
    name: 'Touch',
    description: 'A write without a reconcile hook',
    kind: 'edit',
    sideEffect: 'write',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    timeoutMs: 60_000,
    title: () => 'Touch',
    subject: () => ({ kind: 'none', tool: 'Touch' }),
    execute: async () => {
      runs.push('touch');
      return { status: 'completed', output: 'touched' };
    },
  });

describe('cancel recovery of an interrupted call', () => {
  it('reconciles a started call with a PENDING record as unknown before CANCELLED', async () => {
    const env = await makeEnv();
    const runs: string[] = [];
    const run = env.enqueue('Touch it');
    const key = toolKey(run.id, 1, 'call_t_1');
    env.seed(
      run.id,
      [
        { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [functionCallItem({ callId: 'call_t_1', name: 'Touch', args: { value: 'a' } })], usage: USAGE } },
        { type: 'tool.call', callId: 'call_t_1', providerCallId: 'call_t_1', name: 'Touch', kind: 'edit', title: 'Touch', rawInput: { value: 'a' } },
        { type: 'tool.started', callId: 'call_t_1', idemKey: key },
      ],
      'crash',
    );
    env.store.idempotency.begin(key, { expiresAt: START_MS + 86_400_000, meta: { tool: 'Touch' } });
    expect(env.cancel(run.id).status).toBe('CANCELLING');

    await env.runOnce(env.worker('worker-1', { toolList: () => [...env.toolbox.tools(), touchTool(runs)] }));

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(runs).toEqual([]);
    const reconciled = env.ofType(run.id, 'tool.reconciled');
    expect(reconciled).toEqual([expect.objectContaining({ callId: 'call_t_1', outcome: 'unknown' })]);
    const cancelled = env.ofType(run.id, 'run.status').at(-1);
    expect(cancelled).toMatchObject({ to: 'CANCELLED' });
    expect(reconciled[0]?.seq).toBeLessThan(cancelled?.seq ?? 0);
    expect(env.gateway.streams).toEqual([]);
  });
});

describe('per-call completion events', () => {
  it('appends tool.completed for a fast call while a slow call of the same batch is still running', async () => {
    const env = await makeEnv();
    const releaseSlow = deferred<void>();
    env.toolbox.hooks['Echo'] = async (input) => {
      if (input['value'] === 'slow') await within(releaseSlow.promise, 10_000, 'the slow call release');
    };
    env.gateway.script.push(
      callsStep([
        { callId: 'call_slow', name: 'Echo', args: { value: 'slow' } },
        { callId: 'call_fast', name: 'Echo', args: { value: 'fast' } },
      ]),
      textStep('Both done.'),
    );
    const run = env.enqueue('Slow and fast');
    const running = env.runOnce(env.worker());

    try {
      await waitUntil(
        () => env.ofType(run.id, 'tool.completed').some((event) => event.callId === 'call_fast'),
        3_000,
        'the fast call to be recorded while the slow call is blocked',
      );
      expect(env.ofType(run.id, 'tool.completed').map((event) => event.callId)).toEqual(['call_fast']);
    } finally {
      releaseSlow.resolve();
    }
    await within(running, 5_000, 'the run to finish');
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'tool.completed').map((event) => event.callId)).toEqual(['call_fast', 'call_slow']);
  }, 15_000);
});

describe('context notices and loaded instructions', () => {
  it('appends a context notice once per run even when every build reports it', async () => {
    const env = await makeEnv();
    const agentsPath = path.join(env.project, 'AGENTS.md');
    env.instructions.files.set(agentsPath, 'Untrusted rule.');
    env.settings.trustedValue = false;
    env.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
    const run = env.enqueue('Work');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams).toHaveLength(2);
    const message = `${agentsPath} was skipped because the project is not trusted`;
    expect(env.ofType(run.id, 'notice').filter((event) => event.message === message)).toHaveLength(1);
    expect(env.ofType(run.id, 'instructions.loaded')).toEqual([]);
  });

  it('appends instructions.loaded once for a newly loaded AGENTS.md', async () => {
    const env = await makeEnv();
    const agentsPath = path.join(env.project, 'AGENTS.md');
    env.instructions.files.set(agentsPath, 'Prefer small diffs.');
    env.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
    const run = env.enqueue('Work');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams).toHaveLength(2);
    const loaded = env.ofType(run.id, 'instructions.loaded');
    expect(loaded).toEqual([expect.objectContaining({ path: agentsPath, content: 'Prefer small diffs.' })]);
    expect(loaded[0]?.seq).toBeLessThan(env.ofType(run.id, 'model.requested')[0]?.seq ?? 0);
  });
});

describe('incomplete responses', () => {
  it('records the response status and the incomplete reason', async () => {
    const env = await makeEnv();
    const { incompleteStep } = await import('./scripts.ts');
    env.gateway.script.push(incompleteStep([assistantMessage('msg_cut', 'cut')]));
    const run = env.enqueue('Long');

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'model.responded')[0]?.response).toMatchObject({ status: 'incomplete', incompleteReason: 'max_output_tokens' });
  });

  it('records a completed response with status completed and no incomplete reason', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Fine.'));
    const run = env.enqueue('Short');

    await env.runOnce(env.worker());

    const response = env.ofType(run.id, 'model.responded')[0]?.response;
    expect(response?.status).toBe('completed');
    expect(response).not.toHaveProperty('incompleteReason');
  });

  it('recovers a crash after a recorded incomplete answer to STOPPED(max_tokens)', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Long');
    env.seed(
      run.id,
      [
        {
          type: 'model.responded',
          step: 1,
          attempt: 1,
          response: { status: 'incomplete', incompleteReason: 'max_output_tokens', output: [assistantMessage('msg_cut', 'cut')], usage: USAGE },
        },
      ],
      'crash',
    );

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'max_tokens' });
    expect(env.gateway.streams).toEqual([]);
  });
});

describe('final-summary guard on recovery', () => {
  it('does not execute a function call returned by the recorded final-summary call and stops with the limit reason', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work', { limits: { maxSteps: 1 } });
    const summaryBody = {
      model: 'fm',
      input: [],
      tools: [],
      tool_choice: 'none',
      parallel_tool_calls: false,
      max_output_tokens: 4096,
      store: false,
      stream: true,
    };
    const payloads: RunEventPayload[] = [
      { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [functionCallItem({ callId: 'call_e_1', name: 'Echo', args: { value: 'x' } })], usage: USAGE } },
      { type: 'tool.call', callId: 'call_e_1', providerCallId: 'call_e_1', name: 'Echo', kind: 'read', title: 'Echo x', rawInput: { value: 'x' } },
      { type: 'tool.completed', callId: 'call_e_1', status: 'completed', output: 'echo:x' },
      { type: 'model.requested', step: 2, attempt: 1, digest: bodyDigest(summaryBody), body: summaryBody },
      { type: 'model.responded', step: 2, attempt: 1, response: { status: 'completed', output: [functionCallItem({ callId: 'call_e_2', name: 'Echo', args: { value: 'y' } })], usage: USAGE } },
    ];
    env.seed(run.id, payloads, 'crash');

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'max_steps' });
    expect(env.toolbox.executions).toEqual([]);
    expect(env.ofType(run.id, 'tool.started')).toEqual([]);
    expect(env.gateway.streams).toEqual([]);
  });
});
