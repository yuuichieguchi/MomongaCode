import { describe, expect, it } from 'vitest';
import { defineTool } from '@momonga/tools';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { START_MS, makeEnv, toolKey } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, functionCallItem, requestedOffering, textStep } from './scripts.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };

const cancelRequestedAt = (events: readonly RunEvent[]): number => {
  const index = events.findIndex((event) => event.type === 'run.status' && event.to === 'CANCELLING');
  if (index === -1) throw new Error('the run has no run.status event to CANCELLING');
  return index;
};

const requestsAfterCancel = (env: Env, runId: string): string[] => {
  const events = env.events(runId);
  return events
    .slice(cancelRequestedAt(events))
    .map((event) => event.type)
    .filter((type) => type.endsWith('.requested') && type !== 'model.requested');
};

const blockUntilAborted = (env: Env, toolName: string): Promise<void> =>
  new Promise<void>((started) => {
    env.toolbox.hooks[toolName] = async (_input, ctx) => {
      started();
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    };
  });

describe('a run whose cancellation was requested never asks a person', () => {
  it('an approved command cancelled while it runs at the start of the next claim ends CANCELLED with no approval', async () => {
    const env = await makeEnv();
    const started = blockUntilAborted(env, 'Bash');
    env.gateway.script.push(callsStep([{ callId: 'call_sleep', name: 'Bash', args: { command: 'sleep 25' } }]), textStep('never sent'));
    const run = await env.enqueue('Sleep');
    await env.runOnce(env.worker());
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    await env.resolveApproval(run.id, 'allow_once');

    const running = env.runOnce(env.worker('worker-2'));
    await env.settled(started, 'the approved command to start');
    await env.store.requestCancel(run.id);
    await env.settled(running, 'the worker to finish after cancel');

    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ outcome: 'unknown' })]);
    expect(requestsAfterCancel(env, run.id)).toEqual([]);
    expect(env.ofType(run.id, 'tool.unknown.requested')).toEqual([]);
    expect(env.store.approvals.listPending(run.id)).toEqual([]);
    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('a cancel that arrives while a recovery claim reconciles an interrupted call ends CANCELLED with no approval', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const run = await env.enqueue('Work');
    const slow = defineTool<Record<string, unknown>>({
      name: 'Slow',
      description: 'A command whose effect cannot be reconciled',
      kind: 'execute',
      output: 'harness',
      sideEffect: 'exec',
      subjectKind: 'none',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      timeoutMs: 60_000,
      title: () => 'Slow',
      subject: () => ({ kind: 'none', tool: 'Slow' }),
      execute: async () => ({ status: 'completed', output: 'done' }),
      reconcile: async () => {
        await env.store.requestCancel(run.id);
        return { outcome: 'unknown', output: 'The effect of Slow is unknown.' };
      },
    });
    const seeded: RunEventPayload[] = [
      requestedOffering(1, ['Slow']),
      { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [functionCallItem({ callId: 'call_slow', name: 'Slow', args: { value: 'x' } })], usage: USAGE } },
      { type: 'tool.call', callId: 'call_slow', providerCallId: 'call_slow', name: 'Slow', kind: 'execute', title: 'Slow', rawInput: { value: 'x' } },
      { type: 'tool.started', callId: 'call_slow', idemKey: toolKey(run.id, 1, 'call_slow') },
    ];
    await env.seed(run.id, seeded, 'crash');
    env.store.idempotency.begin(toolKey(run.id, 1, 'call_slow'), { expiresAt: START_MS + 86_400_000, meta: { tool: 'Slow' } });
    env.gateway.script.push(textStep('never sent'));

    await env.runOnce(env.worker('worker-2', { toolList: () => [...env.toolbox.tools(), slow] }));

    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: 'call_slow', outcome: 'unknown' })]);
    expect(requestsAfterCancel(env, run.id)).toEqual([]);
    expect(env.ofType(run.id, 'tool.unknown.requested')).toEqual([]);
    expect(env.store.approvals.listPending(run.id)).toEqual([]);
    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.gateway.streams).toEqual([]);
  });

  it('a command cancelled while it runs inside the drive loop ends CANCELLED with no approval', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const started = blockUntilAborted(env, 'Bash');
    env.gateway.script.push(callsStep([{ callId: 'call_sleep', name: 'Bash', args: { command: 'sleep 25' } }]), textStep('never sent'));
    const run = await env.enqueue('Sleep');

    const running = env.runOnce(env.worker());
    await env.settled(started, 'the command to start');
    await env.store.requestCancel(run.id);
    await env.settled(running, 'the worker to finish after cancel');

    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ outcome: 'unknown' })]);
    expect(requestsAfterCancel(env, run.id)).toEqual([]);
    expect(env.store.approvals.listPending(run.id)).toEqual([]);
    expect(env.run(run.id).status).toBe('CANCELLED');
  });
});
