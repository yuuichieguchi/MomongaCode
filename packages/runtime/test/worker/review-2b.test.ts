import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { defineTool } from '@momonga/tools';
import { waitUntil, within } from './deferred.ts';
import { DEADLINE_MS, START_MS, makeEnv, toolKey, createdRun } from './harness.ts';
import { MODEL_ID, functionCallItem, requestedOffering, textStep } from './scripts.ts';

describe('worker recovery of a not_applied call under the current policy', () => {
  it('asks for approval before re-executing, then executes exactly once after allow_once', async () => {
    const env = await makeEnv();
    const target = path.join(env.project, 'patched.txt');
    const executed: string[] = [];
    const patch = defineTool<Record<string, unknown>>({
      name: 'Patch',
      description: 'Patch a file',
      kind: 'edit',
      sideEffect: 'write',
      subjectKind: 'path',
      inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false },
      timeoutMs: 60_000,
      title: () => 'Patch',
      subject: (input) => ({ kind: 'path', tool: 'Patch', paths: [String(input['file_path'])], access: 'write' }),
      execute: async (_input, ctx) => {
        executed.push(ctx.callId);
        return { status: 'completed', output: 'patched' };
      },
      reconcile: async () => ({ outcome: 'not_applied', output: '' }),
    });
    const toolList = () => [...env.toolbox.tools(), patch];
    const run = await env.enqueue('Patch the file');
    const key = toolKey(run.id, 1, 'call_p_1');
    const payloads: RunEventPayload[] = [
      requestedOffering(1, ['Patch']),
      {
        type: 'model.responded',
        step: 1,
        attempt: 1,
        response: {
          status: 'completed',
          output: [functionCallItem({ callId: 'call_p_1', name: 'Patch', args: { file_path: target } })],
          usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 },
        },
      },
      { type: 'tool.call', callId: 'call_p_1', providerCallId: 'call_p_1', name: 'Patch', kind: 'edit', title: 'Patch', rawInput: { file_path: target } },
      { type: 'tool.started', callId: 'call_p_1', idemKey: key },
    ];
    await env.seed(run.id, payloads, 'crash');
    env.store.idempotency.begin(key, { expiresAt: START_MS + 86_400_000, meta: { tool: 'Patch' } });

    await env.runOnce(env.worker('worker-1', { toolList }));

    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(env.ofType(run.id, 'tool.permission.requested').map((event) => event.callId)).toEqual(['call_p_1']);
    expect(executed).toEqual([]);
    expect(env.store.idempotency.get(key)?.s).toBe('PENDING');

    await env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(textStep('Patched.'));
    await env.runOnce(env.worker('worker-2', { toolList }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(executed).toEqual(['call_p_1']);
    expect(env.ofType(run.id, 'tool.completed')).toEqual([expect.objectContaining({ callId: 'call_p_1', status: 'completed', output: 'patched' })]);
  });
});

describe('worker reporter with a throwing onError hook', () => {
  it('falls back to the claim notice, keeps claiming and stops cleanly', async () => {
    const env = await makeEnv();
    const failing = await env.enqueue('Fails to load');
    const other = env.store.createSession({ cwd: env.project, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, permissionMode: 'manual', model: MODEL_ID });
    const healthy = await createdRun(await env.store.createRunAndEnqueue(other.id, { input: 'Say hello', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {} }));
    env.gateway.script.push(textStep('Hello.'));
    const store: RuntimeStore = {
      ...env.store,
      load: (runId) => {
        if (runId === failing.id) throw new Error('load exploded');
        return env.store.load(runId);
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const worker = env.worker('worker-1', {
        store,
        idlePollMs: 10,
        onError: () => {
          throw new Error('hook exploded');
        },
      });
      worker.start();
      await waitUntil(() => env.run(healthy.id).status === 'COMPLETED', 2_000, 'the healthy run to complete');
      await expect(within(worker.stop(), 1_000, 'the worker to stop')).resolves.toBeUndefined();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    const notices = env.ofType(failing.id, 'notice').filter((notice) => notice.message.includes('load exploded'));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('hook exploded');
    expect(unhandled).toEqual([]);
  });
});
