import { describe, expect, it } from 'vitest';
import type { ElicitationRequestView } from '@momonga/protocol';
import { ToolInputRequired, defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { START_MS, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const SERVER = 'remote';
const CHECKPOINT = { kind: 'mrtr', rounds: 1, requestState: 'ask' };
const REQUESTS: ElicitationRequestView[] = [
  { key: 'who', mode: 'form', message: 'Who are you?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
];

type Seen = { checkpoint: unknown; inputResponses: unknown };

const askTool = (seen: Seen[]): AnyTool =>
  defineTool<Record<string, unknown>>({
    name: 'Ask',
    description: 'Asks the user for a name before answering',
    kind: 'other',
    sideEffect: 'read_only',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 60_000,
    title: () => 'Ask',
    subject: () => ({ kind: 'none', tool: 'Ask' }),
    execute: async (_input, ctx) => {
      seen.push({ checkpoint: ctx.resume?.checkpoint, inputResponses: ctx.resume?.inputResponses });
      const answered = ctx.resume?.inputResponses?.['who'];
      if (answered === undefined) throw new ToolInputRequired({ server: SERVER, requests: REQUESTS, checkpoint: CHECKPOINT });
      return { status: 'completed', output: `hello ${JSON.stringify(answered)}` };
    },
  });

const ask = async (env: Env, seen: Seen[], limits: Record<string, unknown> = {}) => {
  env.gateway.script.push(callsStep([{ callId: 'call_ask', name: 'Ask', args: {} }]));
  const run = env.enqueue('Ask the user', { limits });
  const outcome = await env.runOnce(env.worker('worker-1', { toolList: () => [askTool(seen)] }));
  return { run, outcome };
};

describe('worker input request', () => {
  it('creates an elicitation, journals the request, keeps the checkpoint and releases to WAITING_HUMAN', async () => {
    const env = await makeEnv();
    const seen: Seen[] = [];

    const { run, outcome } = await ask(env, seen);

    expect(outcome).toBe('yielded');
    const current = env.run(run.id);
    expect(current.status).toBe('WAITING_HUMAN');
    expect(current.leaseOwner).toBeNull();
    const callId = env.gateway.callId('call_ask');
    const requested = env.ofType(run.id, 'tool.elicitation.requested');
    expect(requested).toEqual([expect.objectContaining({ callId, server: SERVER, requests: REQUESTS })]);
    const pending = env.store.pendingElicitationViews(run.id);
    expect(pending).toEqual([expect.objectContaining({ id: requested[0]?.inputId, callId, server: SERVER, requests: REQUESTS, expiresAt: START_MS + DEFAULT_TTL_MS })]);
    expect(env.fold(run.id).pendingCalls[callId]).toMatchObject({ status: 'awaiting_input', input: { inputId: requested[0]?.inputId, server: SERVER, requests: REQUESTS } });
    const key = env.fold(run.id).pendingCalls[callId]?.idemKey;
    expect(env.store.idempotency.get(key as string)).toMatchObject({ s: 'PENDING', rec: { meta: { checkpoint: CHECKPOINT } } });
    expect(env.ofType(run.id, 'tool.completed')).toEqual([]);
    expect(seen).toEqual([{ checkpoint: undefined, inputResponses: undefined }]);
  });

  it('uses approvalTtlMs from run.limits for the expiry of the request', async () => {
    const env = await makeEnv();

    const { run } = await ask(env, [], { approvalTtlMs: 123_000 });

    expect(env.store.pendingElicitationViews(run.id)[0]?.expiresAt).toBe(START_MS + 123_000);
  });

  it('never expires the request after the deadline of the run', async () => {
    const env = await makeEnv();
    const deadlineAt = START_MS + 60_000;
    env.gateway.script.push(callsStep([{ callId: 'call_ask', name: 'Ask', args: {} }]));
    const run = env.enqueue('Ask the user', { deadlineAt });

    await env.runOnce(env.worker('worker-1', { toolList: () => [askTool([])] }));

    expect(env.store.pendingElicitationViews(run.id)[0]?.expiresAt).toBe(deadlineAt);
  });

  it('resumes the call with the checkpoint and the answers of the person and completes the run', async () => {
    const env = await makeEnv();
    const seen: Seen[] = [];
    const { run } = await ask(env, seen);
    const inputId = env.ofType(run.id, 'tool.elicitation.requested')[0]?.inputId as string;
    const responses = { who: { action: 'accept' as const, content: { name: 'Ada' } } };
    const resolved = env.store.resolveElicitation(inputId, responses);
    expect(resolved.kind).toBe('ok');
    env.gateway.script.push(textStep('Greeted.'));

    expect(await env.runOnce(env.worker('worker-2', { toolList: () => [askTool(seen)] }))).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(seen.at(-1)).toEqual({ checkpoint: CHECKPOINT, inputResponses: responses });
    expect(env.ofType(run.id, 'tool.completed')).toEqual([
      expect.objectContaining({ callId: env.gateway.callId('call_ask'), status: 'completed', output: `hello ${JSON.stringify(responses.who)}` }),
    ]);
    expect(env.ofType(run.id, 'tool.elicitation.requested')).toHaveLength(1);
  });

  it('stops the run with approval_timeout and journals the cancellation when the request expires', async () => {
    const env = await makeEnv();
    const { run } = await ask(env, [], { approvalTtlMs: 1000 });

    env.clock.advance(1000);
    expect(env.store.expireApprovals(env.clock.now())).toEqual([run.id]);

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
    expect(env.ofType(run.id, 'tool.elicitation.cancelled')).toEqual([expect.objectContaining({ reason: 'expired' })]);
  });
});
