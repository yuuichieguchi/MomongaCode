import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import { buildRunReport } from '@momonga/observability';
import { heldEndOf } from '@momonga/protocol';
import type { RunEvent } from '@momonga/protocol';
import { fixedSandboxBindings } from '@momonga/runtime';
import { createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { defineTool } from '@momonga/tools';
import { START_MS, makeEnv, toolKey } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { createFidelityFold } from '../../src/memory/fidelity-fold.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const CONTENT = 'approved content';

const CHECK = 'true';

const target = (env: Env): string => path.join(env.project, 'out.txt');

const mandate = (env: Env) => ({ scope: { allow: ['Bash(ls:*)'], ask: [`Write(/${target(env)})`] }, completion: { conditions: [{ command: CHECK, when: 'after_mutation' as const }] } });

const reportingWrite = defineTool<Record<string, unknown>>({
  name: 'Write',
  description: 'Write a file and report it',
  kind: 'edit',
  sideEffect: 'write',
  subjectKind: 'path',
  inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'], additionalProperties: false },
  timeoutMs: 60_000,
  title: (input) => `Write ${String(input['file_path'])}`,
  subject: (input) => ({ kind: 'path', tool: 'Write', paths: [String(input['file_path'])], access: 'write' }),
  execute: async (input) => {
    const file = String(input['file_path']);
    const content = String(input['content']);
    fs.writeFileSync(file, content);
    return { status: 'completed', output: 'written', files: [{ path: file, sha256: sha256Hex(content), access: 'write' }], mutated: true };
  },
});

const spawning = (): Sandbox => ({ ...createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform, killGraceMs: 200 }), kind: 'seatbelt' });

const reporting = (env: Env, workerId: string) =>
  env.worker(workerId, { toolList: () => [...env.toolbox.tools().filter((tool) => tool.name !== 'Write'), reportingWrite], tools: { sandboxes: fixedSandboxBindings(spawning()) } });

type WorkerOf = (env: Env, workerId: string) => ReturnType<Env['worker']>;

const plain: WorkerOf = (env, workerId) => env.worker(workerId);

const heldWrite = async (env: Env, workerOf: WorkerOf): Promise<{ runId: string; callId: string; approvalId: string }> => {
  env.gateway.script.push(callsStep([{ callId: 'call_w', name: 'Write', args: { file_path: target(env), content: CONTENT } }]), textStep('Done except the write.'));
  const run = await env.enqueue('Write', { mandate: mandate(env) });
  await env.runOnce(workerOf(env, 'worker-1'));
  const [held] = env.ofType(run.id, 'tool.held');
  if (held === undefined) throw new Error('the write was not held');
  return { runId: run.id, callId: held.callId, approvalId: held.approvalId };
};

const textOf = (item: unknown): string => JSON.stringify(item);

const settlementsOf = (env: Env, runId: string, callId: string): RunEvent[] =>
  env.events(runId).filter((event) => (event.type === 'tool.completed' || event.type === 'tool.reconciled' || event.type === 'tool.held.resolved') && event.callId === callId);

describe('a held call that runs after its approval settles through the events of any call', () => {
  it('records tool.started and a tool.completed that carries the facts of the call and the link to its hold', async () => {
    const env = await makeEnv();
    const { runId, callId, approvalId } = await heldWrite(env, reporting);
    env.gateway.script.push(textStep('All done.'));

    await env.resolveApproval(runId, 'allow_once');
    await env.runOnce(reporting(env, 'worker-2'));

    expect(env.run(runId).status).toBe('COMPLETED');
    expect(fs.readFileSync(target(env), 'utf8')).toBe(CONTENT);
    expect(env.ofType(runId, 'tool.started').map((event) => event.callId)).toEqual([callId]);
    expect(env.ofType(runId, 'tool.held.resolved')).toEqual([]);
    const [placeholder, late, ...more] = settlementsOf(env, runId, callId);
    expect(more).toEqual([]);
    expect(placeholder).toMatchObject({ type: 'tool.completed', denial: { source: 'held' } });
    expect(late).toMatchObject({ type: 'tool.completed', status: 'completed', held: { approvalId }, files: [expect.objectContaining({ path: target(env), access: 'write' })] });
    if (late === undefined) throw new Error('the late call did not settle');
    expect(heldEndOf(late)).toEqual({ callId, approvalId, outcome: 'executed', status: 'completed' });
  });

  it('moves the last mutation of the run, so the declared check runs after it; enters the written facts and the changes of the report; is shown to the model once as a late result', async () => {
    const env = await makeEnv();
    const { runId, callId } = await heldWrite(env, reporting);
    env.gateway.script.push(textStep('All done.'));

    await env.resolveApproval(runId, 'allow_once');
    await env.runOnce(reporting(env, 'worker-2'));

    const late = env.ofType(runId, 'tool.completed').find((event) => event.callId === callId && event.denial === undefined);
    if (late === undefined) throw new Error('the late call did not settle');
    const state = env.fold(runId);
    expect(state.lastMutationSeq).toBe(late.seq);
    expect(state.heldCalls).toEqual({});
    expect(state.workingFacts.written.map((fact) => fact.path)).toEqual([target(env)]);
    expect(state.history.filter((entry) => entry.item.type === 'function_call_output')).toHaveLength(1);
    const shown = state.history.filter((entry) => textOf(entry.item).includes('late_tool_result'));
    expect(shown).toHaveLength(1);
    expect(textOf(shown[0]?.item)).toContain('a person approved it and it has now run');
    expect(env.ofType(runId, 'verification.started')).toEqual([expect.objectContaining({ command: CHECK, mutationSeq: late.seq })]);
    expect(env.ofType(runId, 'verification.completed')).toEqual([expect.objectContaining({ outcome: 'passed', mutationSeq: late.seq })]);
    expect(env.run(runId).status).toBe('COMPLETED');
    const report = buildRunReport(env.events(runId));
    expect(report.changes).toEqual({ files: [expect.objectContaining({ path: target(env), lastSeq: late.seq })], mutatingCalls: 1 });
    expect(report.delegation?.held).toEqual([expect.objectContaining({ callId, outcome: 'executed', status: 'completed', resolvedSeq: late.seq })]);
  });

  it('gives the files of the late call to the fidelity fold as executed text', async () => {
    const env = await makeEnv();
    const { runId } = await heldWrite(env, reporting);
    env.gateway.script.push(textStep('All done.'));
    await env.resolveApproval(runId, 'allow_once');
    await env.runOnce(reporting(env, 'worker-2'));

    const fold = createFidelityFold([{ token: 'out.txt', claim: 'executed' }], env.project, 'f'.repeat(32), () => undefined);
    for (const event of env.events(runId)) if (event.type !== 'user.message') await fold.add(event);

    expect(fold.attested()).toEqual(['out.txt']);
  });

  it('reconciles a late call that a crash interrupted: the unknown outcome carries the link, ends the hold and asks a person', async () => {
    const env = await makeEnv();
    const { runId, callId, approvalId } = await heldWrite(env, plain);
    await env.resolveApproval(runId, 'allow_once');
    const key = toolKey(runId, 1, callId);
    await env.seed(runId, [{ type: 'tool.started', callId, idemKey: key, basis: 'person' }], 'crash');
    env.store.idempotency.begin(key, { expiresAt: START_MS + 86_400_000, meta: { tool: 'Write' } });

    await env.runOnce(env.worker('worker-2'));

    expect(env.ofType(runId, 'tool.reconciled')).toEqual([expect.objectContaining({ callId, outcome: 'unknown', held: { approvalId } })]);
    expect(env.ofType(runId, 'tool.permission.requested')).toHaveLength(1);
    const state = env.fold(runId);
    expect(state.heldCalls).toEqual({});
    expect(state.unknownEffects).toEqual({ [callId]: expect.objectContaining({ acknowledged: false }) });
    expect(state.history.filter((entry) => entry.item.type === 'function_call_output')).toHaveLength(1);
    expect(env.run(runId).status).toBe('WAITING_HUMAN');
    expect(env.store.approvals.listPending(runId).map((approval) => approval.kind)).toEqual(['unknown_effect']);
  });

  it('reconciles a started late call under the step it was held in when the run is cancelled', async () => {
    const env = await makeEnv();
    const { runId, callId, approvalId } = await heldWrite(env, plain);
    await env.resolveApproval(runId, 'allow_once');
    const key = toolKey(runId, 1, callId);
    await env.seed(runId, [{ type: 'tool.started', callId, idemKey: key, basis: 'person' }], 'crash');
    env.store.idempotency.begin(key, { expiresAt: START_MS + 86_400_000, meta: { tool: 'Write' } });
    expect(env.fold(runId).step).toBe(2);
    expect((await env.cancel(runId)).status).toBe('CANCELLING');

    await env.runOnce(env.worker('worker-2'));

    expect(env.run(runId).status).toBe('CANCELLED');
    expect(env.ofType(runId, 'tool.reconciled')).toEqual([expect.objectContaining({ callId, outcome: 'unknown', held: { approvalId } })]);
    expect(env.fold(runId).heldCalls).toEqual({});
    expect(env.fold(runId).history.filter((entry) => entry.item.type === 'function_call_output')).toHaveLength(1);
  });
});
