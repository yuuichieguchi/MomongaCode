import { describe, expect, it } from 'vitest';
import type { ElicitationRequestView } from '@momonga/protocol';
import { ToolInputRequired, defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { START_MS, makeEnv, toolKey } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, functionCallItem, textStep } from './scripts.ts';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const SERVER = 'remote';
const CHECKPOINT = { kind: 'mrtr', rounds: 1, requestState: 'ask' };
const REQUESTS: ElicitationRequestView[] = [
  { key: 'who', mode: 'form', message: 'Who are you?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
];

type Seen = { checkpoint: unknown; inputResponses: unknown };

type Release = (checkpoint: Record<string, unknown>) => Promise<void>;

const askTool = (seen: Seen[], release?: Release): AnyTool =>
  defineTool<Record<string, unknown>>({
    name: 'Ask',
    description: 'Asks the user for a name before answering',
    kind: 'other',
    sideEffect: 'read_only',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 60_000,
    title: () => 'Ask',
    subject: () => ({ kind: 'none', tool: 'Ask' }),
    ...(release === undefined ? {} : { releaseCheckpoint: release }),
    execute: async (_input, ctx) => {
      seen.push({ checkpoint: ctx.resume?.checkpoint, inputResponses: ctx.resume?.inputResponses });
      const answered = ctx.resume?.inputResponses?.['who'];
      if (answered === undefined) throw new ToolInputRequired({ server: SERVER, requests: REQUESTS, checkpoint: CHECKPOINT });
      return { status: 'completed', output: `hello ${JSON.stringify(answered)}` };
    },
  });

const ask = async (env: Env, seen: Seen[], limits: Record<string, unknown> = {}, release?: Release) => {
  env.gateway.script.push(callsStep([{ callId: 'call_ask', name: 'Ask', args: {} }]));
  const run = await env.enqueue('Ask the user', { limits });
  const outcome = await env.runOnce(env.worker('worker-1', { toolList: () => [askTool(seen, release)] }));
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
    const pending = await env.store.pendingElicitationViews(run.id);
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

    expect((await env.store.pendingElicitationViews(run.id))[0]?.expiresAt).toBe(START_MS + 123_000);
  });

  it('never expires the request after the deadline of the run', async () => {
    const env = await makeEnv();
    const deadlineAt = START_MS + 60_000;
    env.gateway.script.push(callsStep([{ callId: 'call_ask', name: 'Ask', args: {} }]));
    const run = await env.enqueue('Ask the user', { deadlineAt });

    await env.runOnce(env.worker('worker-1', { toolList: () => [askTool([])] }));

    expect((await env.store.pendingElicitationViews(run.id))[0]?.expiresAt).toBe(deadlineAt);
  });

  it('resumes the call with the checkpoint and the answers of the person and completes the run', async () => {
    const env = await makeEnv();
    const seen: Seen[] = [];
    const { run } = await ask(env, seen);
    const inputId = env.ofType(run.id, 'tool.elicitation.requested')[0]?.inputId as string;
    const responses = { who: { action: 'accept' as const, content: { name: 'Ada' } } };
    const resolved = await env.store.resolveElicitation(inputId, responses);
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
    expect(await env.store.expireApprovals(env.clock.now(), (error: unknown) => { throw error; })).toEqual([run.id]);

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
    expect(env.ofType(run.id, 'tool.elicitation.cancelled')).toEqual([expect.objectContaining({ reason: 'expired' })]);
  });
});

describe('cancelling a run that waits for input', () => {
  const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };

  const seedAwaiting = async (env: Env) => {
    const run = await env.enqueue('Ask the user');
    const key = toolKey(run.id, 1, 'call_ask');
    const claim = await env.seed(
      run.id,
      [
        { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [functionCallItem({ callId: 'call_ask', name: 'Ask', args: {} })], usage: USAGE } },
        { type: 'tool.call', callId: 'call_ask', providerCallId: 'call_ask', name: 'Ask', kind: 'other', title: 'Ask', rawInput: {} },
        { type: 'tool.started', callId: 'call_ask', idemKey: key },
        { type: 'tool.elicitation.requested', inputId: 'input-1', callId: 'call_ask', server: SERVER, requests: REQUESTS },
      ],
      'crash',
    );
    const ledger = env.store.idempotency.holding(claim);
    ledger.begin(key, { expiresAt: START_MS + 86_400_000, meta: { tool: 'Ask' } });
    ledger.checkpoint(key, CHECKPOINT);
    expect((await env.cancel(run.id)).status).toBe('CANCELLING');
    return { run, key };
  };

  it('hands the checkpoint of the waiting call to its tool, clears it and cancels the run', async () => {
    const env = await makeEnv();
    const released: Array<Record<string, unknown>> = [];
    const { run, key } = await seedAwaiting(env);

    await env.runOnce(env.worker('worker-1', { toolList: () => [askTool([], async (checkpoint) => void released.push(checkpoint))] }));

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(released).toEqual([CHECKPOINT]);
    const lookup = env.store.idempotency.get(key);
    expect(lookup).toMatchObject({ s: 'UNKNOWN' });
    expect(lookup && 'rec' in lookup ? lookup.rec.meta : undefined).not.toHaveProperty('checkpoint');
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.level === 'error')).toEqual([]);
  });

  it('cancels the run and journals an error notice when the tool cannot release the checkpoint, keeping the record for retry', async () => {
    const env = await makeEnv();
    const { run, key } = await seedAwaiting(env);

    await env.runOnce(
      env.worker('worker-1', {
        toolList: () => [
          askTool([], async () => {
            throw new Error('the server is unreachable');
          }),
        ],
      }),
    );

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.level === 'error').map((notice) => notice.message)).toEqual([
      'Calls waiting for input could not be released before the run was cancelled: the server is unreachable',
    ]);
    expect(env.store.idempotency.get(key)).toMatchObject({ s: 'PENDING', rec: { meta: { checkpoint: CHECKPOINT } } });
  });
});
