import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSION_MODES, unknownEffectOptions } from '@momonga/protocol';
import type { PermissionMode, RunEventPayload } from '@momonga/protocol';
import { DEADLINE_MS, START_MS, makeEnv, toolKey, typesOf } from './harness.ts';
import type { Env } from './harness.ts';
import { functionCallItem, requestedOffering, textStep } from './scripts.ts';

const CALLS = ['call_w_1', 'call_w_2'] as const;

const interrupted = async (env: Env, callIds: readonly string[]): Promise<string> => {
  const run = await env.enqueue('Write the files');
  const targetOf = (callId: string): string => path.join(env.project, `${callId}.txt`);
  const payloads: RunEventPayload[] = [
    requestedOffering(1, ['Write']),
    {
      type: 'model.responded',
      step: 1,
      attempt: 1,
      response: {
        status: 'completed',
        output: callIds.map((callId) => functionCallItem({ callId, name: 'Write', args: { file_path: targetOf(callId), content: 'x' } })),
        usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 },
      },
    },
    ...callIds.flatMap((callId): RunEventPayload[] => [
      { type: 'tool.call', callId, providerCallId: callId, name: 'Write', kind: 'edit', title: `Write ${targetOf(callId)}`, rawInput: { file_path: targetOf(callId), content: 'x' } },
      { type: 'tool.started', callId, idemKey: toolKey(run.id, 1, callId) },
    ]),
  ];
  await env.seed(run.id, payloads, 'crash');
  for (const callId of callIds) env.store.idempotency.begin(toolKey(run.id, 1, callId), { expiresAt: START_MS + 86_400_000, meta: { tool: 'Write' } });
  return run.id;
};

const pendingOf = (env: Env, runId: string) => env.store.approvals.listPending(runId);

const answer = async (env: Env, runId: string): Promise<void> => {
  const [approval] = pendingOf(env, runId);
  if (approval === undefined) throw new Error('expected a pending approval');
  expect((await env.store.resolveApproval(approval.id, 'allow_once')).kind).toBe('ok');
};

const requestsAfterUnknown = (env: Env, runId: string): string[] => {
  const types = typesOf(env.events(runId));
  return types.slice(types.indexOf('tool.reconciled')).filter((type) => type === 'model.requested');
};

describe('a tool call whose effect is unknown after a crash', () => {
  it('asks a person and waits: one pending unknown_effect approval, WAITING_HUMAN, and no model request after the unknown outcome', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    const runId = await interrupted(env, ['call_w_1']);
    env.gateway.script.push(textStep('Checked.'));

    await env.runOnce(env.worker());

    expect(env.ofType(runId, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: 'call_w_1', outcome: 'unknown' })]);
    expect(env.run(runId).status).toBe('WAITING_HUMAN');
    expect(pendingOf(env, runId)).toEqual([expect.objectContaining({ kind: 'unknown_effect', callId: 'call_w_1', options: unknownEffectOptions() })]);
    expect(env.ofType(runId, 'tool.unknown.requested')).toEqual([expect.objectContaining({ callIds: ['call_w_1'] })]);
    expect(env.ofType(runId, 'tool.permission.requested')).toEqual([]);
    expect(requestsAfterUnknown(env, runId)).toEqual([]);
    expect(env.gateway.script).toHaveLength(1);
  });

  it('continues after the answer, asks nothing again and makes the model request', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    const runId = await interrupted(env, ['call_w_1']);
    await env.runOnce(env.worker('worker-1'));
    await answer(env, runId);
    expect(env.run(runId).status).toBe('QUEUED');
    env.gateway.script.push(textStep('Checked.'));

    await env.runOnce(env.worker('worker-2'));

    expect(env.run(runId).status).toBe('COMPLETED');
    expect(env.ofType(runId, 'tool.unknown.requested')).toHaveLength(1);
    expect(env.ofType(runId, 'tool.unknown.resolved')).toHaveLength(1);
    expect(env.fold(runId).unknownEffects).toEqual({ call_w_1: expect.objectContaining({ acknowledged: true }) });
    expect(env.toolbox.executions).toEqual([]);
  });

  it.each(PERMISSION_MODES.map((mode) => [mode] as const))('asks in the mode %s', async (mode: PermissionMode) => {
    const env = await makeEnv({ mode });
    const runId = await interrupted(env, ['call_w_1']);
    env.gateway.script.push(textStep('Checked.'));

    await env.runOnce(env.worker());

    expect(env.run(runId).status).toBe('WAITING_HUMAN');
    expect(pendingOf(env, runId).map((approval) => approval.kind)).toEqual(['unknown_effect']);
    expect(requestsAfterUnknown(env, runId)).toEqual([]);
  });

  it('asks once for two unknown calls of one step, keyed by the first, and the answer acknowledges both', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    const runId = await interrupted(env, CALLS);

    await env.runOnce(env.worker('worker-1'));

    expect(pendingOf(env, runId)).toEqual([expect.objectContaining({ kind: 'unknown_effect', callId: 'call_w_1' })]);
    expect(env.ofType(runId, 'tool.unknown.requested')).toEqual([expect.objectContaining({ callIds: [...CALLS] })]);
    await answer(env, runId);
    env.gateway.script.push(textStep('Checked.'));
    await env.runOnce(env.worker('worker-2'));
    expect(env.run(runId).status).toBe('COMPLETED');
    expect(env.fold(runId).unknownEffects).toEqual({ call_w_1: expect.objectContaining({ acknowledged: true }), call_w_2: expect.objectContaining({ acknowledged: true }) });
  });

  it('a crash between the unknown outcome and the ask: the next claim asks, once', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    const run = await env.enqueue('Write the file');
    const target = path.join(env.project, 'out.txt');
    await env.seed(
      run.id,
      [
        requestedOffering(1, ['Write']),
        {
          type: 'model.responded',
          step: 1,
          attempt: 1,
          response: { status: 'completed', output: [functionCallItem({ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } })], usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
        },
        { type: 'tool.call', callId: 'call_w_1', providerCallId: 'call_w_1', name: 'Write', kind: 'edit', title: `Write ${target}`, rawInput: { file_path: target, content: 'x' } },
        { type: 'tool.started', callId: 'call_w_1', idemKey: toolKey(run.id, 1, 'call_w_1') },
        { type: 'tool.reconciled', callId: 'call_w_1', outcome: 'unknown', output: 'Its effect is unknown.' },
      ],
      'crash',
    );
    env.gateway.script.push(textStep('Checked.'));

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(env.ofType(run.id, 'tool.unknown.requested')).toHaveLength(1);
    expect(requestsAfterUnknown(env, run.id)).toEqual([]);
  });

  it('a claim of the waiting run before the answer writes no second approval row', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    const runId = await interrupted(env, ['call_w_1']);
    await env.runOnce(env.worker('worker-1'));
    env.raw().prepare("UPDATE runs SET status = 'QUEUED' WHERE id = ?").run(runId);

    await env.runOnce(env.worker('worker-2'));

    expect(env.run(runId).status).toBe('WAITING_HUMAN');
    expect(env.raw().prepare('SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?').get(runId)).toEqual({ n: 1 });
    expect(env.ofType(runId, 'tool.unknown.requested')).toHaveLength(1);
    expect(requestsAfterUnknown(env, runId)).toEqual([]);
  });

  it('a cancel while it waits ends CANCELLED and withdraws the approval', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    const runId = await interrupted(env, ['call_w_1']);
    await env.runOnce(env.worker());

    expect((await env.cancelToEnd(runId)).status).toBe('CANCELLED');

    expect(pendingOf(env, runId)).toEqual([]);
    expect(env.ofType(runId, 'tool.unknown.cancelled')).toEqual([expect.objectContaining({ reason: 'withdrawn' })]);
  });

  it('no answer: the run waits until its deadline, which stops it with timeout and withdraws the approval', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    const runId = await interrupted(env, ['call_w_1']);
    await env.runOnce(env.worker());
    const rethrow = (error: unknown): never => {
      throw error;
    };

    expect(await env.store.expireApprovals(DEADLINE_MS - 1, rethrow)).toEqual([]);
    expect(env.run(runId).status).toBe('WAITING_HUMAN');
    env.clock.set(DEADLINE_MS);
    expect(await env.store.expireApprovals(DEADLINE_MS, rethrow)).toEqual([runId]);

    expect(env.run(runId)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect(pendingOf(env, runId)).toEqual([]);
  });
});
