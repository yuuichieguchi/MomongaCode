import { describe, expect, it } from 'vitest';
import type { ElicitationRequestView } from '@momonga/protocol';
import { ToolInputRequired, defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { createStoppedRunReleaser } from '../../src/process/release-stopped.ts';
import { START_MS, makeEnv, toolKey } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, functionCallItem, requestedOffering } from './scripts.ts';

const SERVER = 'remote';
const CHECKPOINT = { kind: 'mrtr', rounds: 1, requestState: 'ask' };
const REQUESTS: ElicitationRequestView[] = [
  { key: 'who', mode: 'form', message: 'Who are you?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
];
const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };

const askTool = (released: Array<Record<string, unknown>>, beforeAsking: () => void = () => undefined): AnyTool =>
  defineTool<Record<string, unknown>>({
    name: 'Ask',
    description: 'Asks the user for a name before answering',
    kind: 'other',
    sideEffect: 'read_only',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 60_000,
    title: () => 'Ask',
    subject: () => ({ kind: 'none', tool: 'Ask' }),
    releaseCheckpoint: async (checkpoint) => void released.push(checkpoint),
    execute: async () => {
      beforeAsking();
      throw new ToolInputRequired({ server: SERVER, requests: REQUESTS, checkpoint: CHECKPOINT });
    },
  });

const parkOnElicitation = async (env: Env, released: Array<Record<string, unknown>>, limits: Record<string, unknown> = {}) => {
  env.gateway.script.push(callsStep([{ callId: 'call_ask', name: 'Ask', args: {} }]));
  const run = env.enqueue('Ask the user', { limits });
  await env.runOnce(env.worker('worker-1', { toolList: () => [askTool(released)] }));
  expect(env.run(run.id).status).toBe('WAITING_HUMAN');
  const key = env.fold(run.id).pendingCalls[env.gateway.callId('call_ask')]?.idemKey as string;
  return { run, key };
};

const releaserFor = (env: Env, released: Array<Record<string, unknown>>) =>
  createStoppedRunReleaser({
    store: env.store,
    tools: {
      envFor: (session) => ({ ...session.env }),
      toolSet: async () => env.snapshotTools([askTool(released)]),
      executor: env.executor,
    },
  });

const checkpointCleared = (env: Env, key: string): void => {
  const lookup = env.store.idempotency.get(key);
  expect(lookup).toMatchObject({ s: 'UNKNOWN' });
  expect(lookup && 'rec' in lookup ? lookup.rec.meta : undefined).not.toHaveProperty('checkpoint');
};

describe('releasing the checkpoint of a call whose input request was withdrawn', () => {
  it('releases it when the user cancels a run that waits for input', async () => {
    const env = await makeEnv();
    const released: Array<Record<string, unknown>> = [];
    const { run, key } = await parkOnElicitation(env, released);

    expect((await env.cancelToEnd(run.id)).status).toBe('CANCELLED');
    expect(env.ofType(run.id, 'tool.elicitation.cancelled')).toEqual([expect.objectContaining({ reason: 'withdrawn' })]);
    await releaserFor(env, released)(run.id, new AbortController().signal);

    expect(released).toEqual([CHECKPOINT]);
    checkpointCleared(env, key);
  });

  it('releases it when the request for input expires and the run stops', async () => {
    const env = await makeEnv();
    const released: Array<Record<string, unknown>> = [];
    const { run, key } = await parkOnElicitation(env, released, { approvalTtlMs: 1000 });

    env.clock.advance(1000);
    expect((await env.store.expireApprovals(env.clock.now()))).toEqual([run.id]);
    await releaserFor(env, released)(run.id, new AbortController().signal);

    expect(released).toEqual([CHECKPOINT]);
    checkpointCleared(env, key);
  });

  it('releases it when the run is cancelled after a crash left the request announced', async () => {
    const env = await makeEnv();
    const released: Array<Record<string, unknown>> = [];
    const run = env.enqueue('Ask the user');
    const key = toolKey(run.id, 1, 'call_ask');
    const claim = env.seed(
      run.id,
      [
        requestedOffering(1, ['Ask']),
        { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [functionCallItem({ callId: 'call_ask', name: 'Ask', args: {} })], usage: USAGE } },
        { type: 'tool.call', callId: 'call_ask', providerCallId: 'call_ask', name: 'Ask', kind: 'other', title: 'Ask', rawInput: {} },
        { type: 'tool.started', callId: 'call_ask', idemKey: key },
      ],
      'hold',
    );
    const ledger = env.store.idempotency.holding(claim);
    ledger.begin(key, { expiresAt: START_MS + 86_400_000, meta: { tool: 'Ask' } });
    ledger.checkpoint(key, CHECKPOINT);
    expect(env.store.requestElicitation(claim, { callId: 'call_ask', expiresAt: START_MS + 60_000, server: SERVER, requests: REQUESTS }).kind).toBe('ok');
    env.clock.advance(31_000);
    expect(env.cancel(run.id).status).toBe('CANCELLING');
    expect(env.ofType(run.id, 'tool.elicitation.cancelled')).toHaveLength(1);

    await env.runOnce(env.worker('worker-2', { toolList: () => [askTool(released)] }));

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(released).toEqual([CHECKPOINT]);
    expect(env.store.idempotency.get(key)).toMatchObject({ s: 'UNKNOWN' });
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.level === 'error')).toEqual([]);
  });

  it('releases it when the user cancels while the tool is asking, so the run reaches CANCELLING instead of WAITING_HUMAN', async () => {
    const env = await makeEnv();
    const released: Array<Record<string, unknown>> = [];
    env.gateway.script.push(callsStep([{ callId: 'call_ask', name: 'Ask', args: {} }]));
    const run = env.enqueue('Ask the user');
    const cancelWhileAsking = (): void => void env.cancel(run.id);

    await env.runOnce(env.worker('worker-1', { toolList: () => [askTool(released, cancelWhileAsking)] }));

    expect(env.run(run.id)).toMatchObject({ status: 'CANCELLING', leaseOwner: null });
    expect(released).toEqual([]);

    await env.runOnce(env.worker('worker-2', { toolList: () => [askTool(released)] }));

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(released).toEqual([CHECKPOINT]);
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.level === 'error')).toEqual([]);
  });
});
