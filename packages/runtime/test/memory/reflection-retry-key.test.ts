import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VERIFICATION_MANIFESTS } from '@momonga/config';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { CreateResponseBody, StreamEvent } from '@momonga/protocol';
import type { GatewayCallOptions } from '@momonga/runtime';
import { createFakeTimers, NEVER_CANCELLED } from '@momonga/testkit';
import { createIdempotencyRegistry } from '../../../gateway/src/core/idempotency.ts';
import { GATEWAY_CONFIG_DEFAULTS } from '../../../gateway/src/defaults.ts';
import type { StoredIdempotency } from '../../../gateway/src/core/store.ts';
import type { Services } from '../../../gateway/src/core/services.ts';
import { REQUEUE_BASE_MS } from '../../src/process/constants.ts';
import { enqueue, harness, makeStoreDir, newSession } from '../../../store/test/helpers.ts';
import { createFakeGateway } from '../worker/fake-gateway.ts';
import { capabilitiesFor } from '../worker/harness.ts';
import { textStep } from '../worker/scripts.ts';
import { withInProcessFacts } from './in-process-facts.ts';
import { bash, exported, fileTool, finishClaimed, checked } from './reflection-fixture.ts';

const CHECK_COMMANDS = ['npm test'];

type Reflector = { runOne(signal: AbortSignal): Promise<'idle' | 'busy' | 'ran'> };
type Job = { state: string; attempts: number; lastError: string | null };
type ReflectionApi = { reflection: { get(runId: string): Job | undefined; complete(completion: unknown): unknown } };

const SIGNAL = new AbortController().signal;
const SHA = 'a'.repeat(64);
const RETRY_DUE_MS = REQUEUE_BASE_MS * 4;
const EMPTY_REPLY = JSON.stringify({ candidates: [] });

const isStoredTerminal = (frames: readonly StreamEvent[]): boolean => {
  const last = frames.at(-1);
  return last !== undefined && (last.type === 'response.completed' || last.type === 'response.incomplete');
};

const digestOf = (body: CreateResponseBody): string => {
  const unstreamed: Record<string, unknown> = { ...body };
  delete unstreamed.stream;
  return sha256Hex(canonicalJson(unstreamed));
};

const setup = async () => {
  const opened = harness();
  const { clock, dbPath } = opened;
  const store = withInProcessFacts(opened.store, dbPath);
  const project = makeStoreDir();
  await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
  const session = newSession(store, project);
  const upstream = createFakeGateway(capabilitiesFor(100_000, { structuredOutput: 'json_schema' }));
  const stored = new Map<string, StoredIdempotency>();
  const registry = createIdempotencyRegistry({
    clock,
    config: GATEWAY_CONFIG_DEFAULTS,
    store: { getIdempotency: async (key: string) => stored.get(key), deleteIdempotency: async (key: string) => void stored.delete(key) },
  } as unknown as Services);
  const refusals: string[] = [];
  const replays: string[] = [];
  const gateway = {
    capabilities: upstream.capabilities,
    countTokens: upstream.countTokens,
    quote: upstream.quote,
    stream: (body: CreateResponseBody, options: GatewayCallOptions) =>
      (async function* () {
        const key = options.idempotencyKey;
        const digest = digestOf(body);
        let found: Awaited<ReturnType<typeof registry.lookup>>;
        try {
          found = await registry.lookup(key, digest, options.signal);
        } catch (error) {
          refusals.push((error as { code?: string }).code ?? String(error));
          throw error;
        }
        if (found.kind === 'stored') {
          replays.push(key);
          yield* found.frames;
          return;
        }
        const frames: StreamEvent[] = [];
        for await (const event of upstream.stream(body, options)) {
          frames.push(event);
          yield event;
        }
        if (isStoredTerminal(frames)) stored.set(key, { digest, storedAtMs: clock.now(), frames });
      })(),
  };
  const memory = { maxTokens: undefined as number | undefined };
  const settings = {
    trusted: () => true,
    verification: async () => ({ commands: [...CHECK_COMMANDS], conditions: [...CHECK_COMMANDS], manifests: [...DEFAULT_VERIFICATION_MANIFESTS] }),
    memory: async () => ({ reflection: { enabled: true, ...(memory.maxTokens === undefined ? {} : { maxTokens: memory.maxTokens }) }, forgetAfterDays: 90 }),
  };
  const reflector = exported<(options: unknown) => Reflector>('createReflector')({
    store,
    gateway,
    settings,
    clock,
    isIdle: () => true,
    evidenceRun: () => async () => ({ exitCode: null }),
    maxAttempts: 3,
    attemptTimeoutMs: 600_000,
    timers: createFakeTimers(clock),
    random: () => 0.5,
  });
  const api = store as unknown as ReflectionApi;
  const failCompleteOnce = (): void => {
    const original = api.reflection.complete.bind(api.reflection);
    let failures = 1;
    api.reflection.complete = (completion) => {
      if (failures-- > 0) throw new Error('the store failed after the model call');
      return original(completion);
    };
  };
  const verifiedRun = async () => {
    const run = await enqueue(store, session.id, 'fix the bug');
    await finishClaimed(store, [
      ...fileTool('w1', 'Write', { path: path.join(project, 'src/a.ts'), sha256: SHA, access: 'write' }),
      ...checked('npm test', 0, 'ok'),
    ]);
    return run;
  };
  return { clock, api, upstream, refusals, replays, memory, reflector, failCompleteOnce, verifiedRun };
};

type Env = Awaited<ReturnType<typeof setup>>;

const failFirstAttemptAfterTheCall = async (env: Env): Promise<string> => {
  const run = await env.verifiedRun();
  env.upstream.script.push(textStep(EMPTY_REPLY), textStep(EMPTY_REPLY));
  env.failCompleteOnce();
  await expect(env.reflector.runOne(SIGNAL)).rejects.toThrow('the store failed after the model call');
  expect(env.upstream.streams).toHaveLength(1);
  expect(env.api.reflection.get(run.id)).toMatchObject({ state: 'running', attempts: 1 });
  return run.id;
};

const retry = async (env: Env): Promise<void> => {
  env.clock.advance(RETRY_DUE_MS);
  expect(await env.reflector.runOne(SIGNAL)).toBe('ran');
};

describe('the retry identity of a reflection request', () => {
  it('sends a retry whose max_output_tokens changed with memory.reflection.maxTokens as a new request, and finishes the job', async () => {
    const env = await setup();
    const runId = await failFirstAttemptAfterTheCall(env);
    env.memory.maxTokens = 300;
    await retry(env);
    expect(env.refusals).toEqual([]);
    expect(env.replays).toEqual([]);
    expect(env.upstream.streams.map((call) => call.body.max_output_tokens)).toEqual([4096, 300]);
    expect(env.upstream.streams[1]?.idempotencyKey).not.toBe(env.upstream.streams[0]?.idempotencyKey);
    expect(env.api.reflection.get(runId)).toMatchObject({ state: 'done', attempts: 2, lastError: 'the model proposed no candidates' });
  });

  it('answers a retry with the identical body from the earlier call, with no second upstream call', async () => {
    const env = await setup();
    const runId = await failFirstAttemptAfterTheCall(env);
    await retry(env);
    expect(env.refusals).toEqual([]);
    expect(env.upstream.streams).toHaveLength(1);
    expect(env.replays).toEqual([env.upstream.streams[0]?.idempotencyKey]);
    expect(env.api.reflection.get(runId)).toMatchObject({ state: 'done', attempts: 2, lastError: 'the model proposed no candidates' });
  });

  it('keys the call by the run and the digest of the request body, as the summary request is keyed', async () => {
    const env = await setup();
    const run = await env.verifiedRun();
    env.upstream.script.push(textStep(EMPTY_REPLY));
    expect(await env.reflector.runOne(SIGNAL)).toBe('ran');
    const [call] = env.upstream.streams;
    if (call === undefined) throw new Error('expected one reflection call');
    expect(call.idempotencyKey).toBe(sha256Hex(canonicalJson([run.id, 'reflect', sha256Hex(canonicalJson(call.body))])));
    expect(call.idempotencyKey).not.toBe(sha256Hex(canonicalJson([run.id, 'reflect'])));
  });

  it('sends a retry whose body changed with the capabilities of the model as a new request, and finishes the job', async () => {
    const env = await setup();
    const runId = await failFirstAttemptAfterTheCall(env);
    env.upstream.capabilitiesValue = capabilitiesFor(8192, { structuredOutput: 'json_schema' });
    await retry(env);
    expect(env.refusals).toEqual([]);
    expect(env.replays).toEqual([]);
    expect(env.upstream.streams.map((call) => call.body.max_output_tokens)).toEqual([4096, 492]);
    expect(env.upstream.streams[1]?.idempotencyKey).not.toBe(env.upstream.streams[0]?.idempotencyKey);
    expect(env.api.reflection.get(runId)).toMatchObject({ state: 'done', attempts: 2, lastError: 'the model proposed no candidates' });
  });
});
