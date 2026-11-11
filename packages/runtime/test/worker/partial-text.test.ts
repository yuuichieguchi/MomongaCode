import { describe, expect, it } from 'vitest';
import type { RunEventPayload, StreamEvent } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import type { GatewayPort } from '@momonga/runtime';
import { foldRunState, initialRunState } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { responseResource } from '@momonga/testkit';
import { streamModel } from '../../src/worker/model-stream.ts';
import type { ClaimContext } from '../../src/worker/claim-context.ts';
import { fatalStoreError } from './cancel-fixture.ts';
import { deferred, within } from './deferred.ts';
import { LEASE_MS, bodyDigest, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { MODEL_ID, textStep } from './scripts.ts';

const ITEM_ID = 'msg_partial';

const untilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

const openingEvents = (chunks: readonly string[]): StreamEvent[] => [
  { type: 'response.created', sequence_number: 0, response: responseResource({ id: 'resp_partial', model: MODEL_ID, status: 'in_progress' }) },
  {
    type: 'response.output_item.added',
    sequence_number: 1,
    output_index: 0,
    item: { type: 'message', id: ITEM_ID, status: 'in_progress', role: 'assistant', content: [] },
  },
  ...chunks.map(
    (delta, index): StreamEvent => ({ type: 'response.output_text.delta', sequence_number: 2 + index, item_id: ITEM_ID, output_index: 0, content_index: 0, delta }),
  ),
];

const partialGateway = (env: Env, chunks: readonly string[], afterChunks: (signal: AbortSignal) => Promise<never>): GatewayPort => ({
  ...env.gateway,
  stream: (_body, options) =>
    (async function* () {
      yield* openingEvents(chunks);
      await afterChunks(options.signal);
    })(),
});

const journaledText = (env: Env, runId: string): string =>
  env
    .ofType(runId, 'agent.message.delta')
    .filter((event) => event.itemId === ITEM_ID)
    .map((event) => event.text)
    .join('');

describe('partial assistant text on an interrupted stream', () => {
  it('flushes the buffered deltas when the stream fails, so the journal holds the complete received text', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Talk');
    const gateway = partialGateway(env, ['Hello ', 'wor', 'ld'], async () => {
      throw new GatewayRequestError({ status: 0, type: 'transport', code: 'stream_interrupted', message: 'the gateway stream was interrupted: other side closed' });
    });

    await env.runOnce(env.worker('worker-1', { gateway }));

    expect(env.run(run.id).status).toBe('QUEUED');
    expect(journaledText(env, run.id)).toBe('Hello world');
    expect(env.fold(run.id).streaming).toEqual({ step: 1, attempt: 1, seen: true, items: [{ itemId: ITEM_ID, text: 'Hello world' }] });
  });

  it('flushes the buffered deltas when the run is cancelled mid-stream', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Talk');
    const gateway = partialGateway(env, ['Partial ', 'answer'], async (signal) => {
      await env.store.requestCancel(run.id);
      await untilAborted(signal);
      throw new Error('The operation was aborted');
    });

    await env.settled(env.runOnce(env.worker('worker-1', { gateway, cancelPollMs: 5 })), 'the cancelled claim to settle');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(journaledText(env, run.id)).toBe('Partial answer');
  });

  it('appends nothing and does not throw when the lease is lost during the stream', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Talk');
    const stolen = deferred<number>();
    let stolenFlag = false;
    const appendsAfterSteal: unknown[] = [];
    const store: RuntimeStore = {
      ...env.store,
      append: (claim, payloads) => {
        if (stolenFlag && claim.workerId === 'worker-1') appendsAfterSteal.push(payloads);
        return env.store.append(claim, payloads);
      },
    };
    const gateway = partialGateway(env, ['never ', 'journaled'], async (signal) => {
      env.clock.advance(LEASE_MS + 1);
      expect(env.store.claim('worker-thief')?.runId).toBe(run.id);
      stolenFlag = true;
      stolen.resolve(env.run(run.id).lastSeq);
      await untilAborted(signal);
      throw new Error('The operation was aborted');
    });

    const running = env.runOnce(env.worker('worker-1', { gateway, heartbeatMs: 10, store }));
    const stolenAtSeq = await within(stolen.promise, 5_000, 'the lease to be stolen');
    await expect(env.settled(running, 'the first worker to stop after losing its lease')).resolves.toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'RUNNING', leaseOwner: 'worker-thief', lastSeq: stolenAtSeq });
    expect(env.ofType(run.id, 'agent.message.delta')).toEqual([]);
    expect(appendsAfterSteal).toEqual([]);
    expect(env.fatals).toEqual([]);
  });

  it('propagates a fatal store error raised by the abort flush to the worker and does not requeue', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Talk');
    const fatal = fatalStoreError();
    const store: RuntimeStore = {
      ...env.store,
      append: (claim, payloads) => {
        if (payloads.some((payload) => payload.type === 'agent.message.delta')) throw fatal;
        return env.store.append(claim, payloads);
      },
    };
    const gateway = partialGateway(env, ['Hello'], async () => {
      throw new Error('gateway connection reset');
    });

    await expect(env.runOnce(env.worker('worker-1', { gateway, store }))).rejects.toBe(fatal);

    expect(env.run(run.id).status).toBe('RUNNING');
    expect(env.ofType(run.id, 'notice')).toEqual([]);
  });

  it('records a non-fatal flush error and still throws the original stream error', async () => {
    const env = await makeEnv();
    const flushError = new Error('journal append failed');
    const streamError = new Error('gateway connection reset');
    const failures: unknown[] = [];
    const ctx = {
      journal: {
        verifyLease: () => undefined,
        append: () => {
          throw flushError;
        },
      },
      control: {
        inFlight: {},
        signal: new AbortController().signal,
        leaseLost: () => false,
        failure: () => failures[0],
        fail: (error: unknown) => {
          failures.push(error);
        },
        recordingRaised: <T>(pending: Promise<T>): Promise<T> => pending,
      },
      options: {
        clock: env.clock,
        gateway: {
          ...env.gateway,
          stream: () =>
            (async function* () {
              yield* openingEvents(['Hello']);
              throw streamError;
            })(),
        },
      },
      run: { deadlineAt: Number.MAX_SAFE_INTEGER },
      agentSpan: { traceparent: undefined },
    } as unknown as ClaimContext;

    await expect(streamModel(ctx, { model: 'fm', input: [] }, 'key', { step: 1, attempt: 1 }, 'recorded')).rejects.toBe(streamError);
    expect(failures).toEqual([flushError]);
  });

  it('clears the partial text when recovery restarts the stream', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work');
    const body = { model: 'fm', input: [{ type: 'message', role: 'user', content: 'Work' }], store: false, stream: true };
    const seeded: RunEventPayload[] = [
      { type: 'model.requested', step: 1, attempt: 1, digest: bodyDigest(body), body },
      { type: 'agent.message.delta', step: 1, attempt: 1, itemId: ITEM_ID, text: 'stale partial' },
    ];
    await env.seed(run.id, seeded, 'crash');
    env.gateway.script.push(textStep('Full answer.'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    const events = env.events(run.id);
    const restartIndex = events.findIndex((event) => event.type === 'model.stream.restarted');
    expect(restartIndex).toBeGreaterThan(0);
    const initial = initialRunState({ runId: run.id, sessionId: run.sessionId });
    const beforeRestart = events.slice(0, restartIndex).reduce(foldRunState, initial);
    const atRestart = events.slice(0, restartIndex + 1).reduce(foldRunState, initial);
    expect(beforeRestart.streaming).toEqual({ step: 1, attempt: 1, seen: true, items: [{ itemId: ITEM_ID, text: 'stale partial' }] });
    expect(atRestart.streaming).toBeUndefined();
    expect(env.fold(run.id).streaming).toBeUndefined();
  });

  it('still restarts a recovered stream that emitted only reasoning before the crash', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work');
    const body = { model: 'fm', input: [{ type: 'message', role: 'user', content: 'Work' }], store: false, stream: true };
    await env.seed(
      run.id,
      [
        { type: 'model.requested', step: 1, attempt: 1, digest: bodyDigest(body), body },
        { type: 'agent.thought.delta', step: 1, attempt: 1, itemId: 'rs_1', text: 'thinking' },
      ],
      'crash',
    );
    env.gateway.script.push(textStep('Full answer.'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'model.stream.restarted')).toEqual([expect.objectContaining({ step: 1, attempt: 1 })]);
  });
});
