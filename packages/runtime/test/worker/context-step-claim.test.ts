import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import { createTokenMeter } from '@momonga/context';
import type { FunctionTool, InputItem, RunEventPayload, RunState } from '@momonga/protocol';
import { initialRunState } from '@momonga/store';
import type { ClaimContext } from '../../src/worker/claim-context.ts';
import { buildNext } from '../../src/worker/context-step.ts';
import { capabilitiesFor } from './harness.ts';

const SYSTEM_PROMPT = 'You are the claim test agent.';
const TASK_TEXT = 'Do the work.';
const ECHO_TOOL: FunctionTool = { type: 'function', name: 'Echo', description: 'Echo a value', parameters: { type: 'object', properties: {} }, fitRank: 0 } as FunctionTool;

const tokensOf = (value: unknown): number => Math.ceil(canonicalJson(value).length / 4);

const stateWithHistory = (): RunState =>
  ({
    ...initialRunState({ runId: 'run_claim', sessionId: 'session_claim' }),
    step: 1,
    taskSeq: 1,
    history: [
      { seq: 1, item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: TASK_TEXT }] } },
      { seq: 2, item: { type: 'function_call', call_id: 'call_c_1', name: 'Echo', arguments: '{"value":"x"}' }, callId: 'call_c_1' },
      { seq: 3, item: { type: 'function_call_output', call_id: 'call_c_1', output: 'echo:x' }, callId: 'call_c_1' },
    ],
  }) as RunState;

type Yielded = { to: string; availableAt: number | undefined; options: unknown };

const contextFor = (state: RunState) => {
  const appended: RunEventPayload[] = [];
  const yields: Yielded[] = [];
  const finishes: unknown[][] = [];
  const capabilities = capabilitiesFor(200_000);
  const ctx = {
    options: {
      home: '/home/claim',
      store: {
        getSession: () => ({ id: 'session_claim', cwd: '/project/claim' }),
        readRunEvents: () => [{ type: 'user.message', text: TASK_TEXT }],
        governing: { list: () => [] },
        sessionTouched: { newest: () => [], after: () => [] },
      },
      clock: { now: () => 0 },
      tools: { sessionState: () => ({ cwd: '/project/claim' }) },
      settings: { trusted: () => true },
      blobs: { handleFor: () => 'blob-1', put: async () => ({ handle: 'blob-1' }) },
      instructionReaderFor: () => ({ read: async () => undefined, exists: async () => false, realpath: async (target: string) => target }),
    },
    run: { id: 'run_claim', sessionId: 'session_claim' },
    model: 'fm',
    roles: {},
    capabilities,
    calibration: { tokenCounting: capabilities.tokenCounting },
    systemPrompt: SYSTEM_PROMPT,
    functionTools: () => [ECHO_TOOL],
    readers: () => ({}),
    companions: () => ({ hostOf: {}, keepWithoutHost: false }),
    skills: { catalog: undefined },
    recalled: { prepare: async () => undefined, ranked: () => [], hasMore: () => false, matchCap: () => undefined, tools: [] },
    touched: { governing: { advance: async () => undefined, witnesses: () => [] }, probes: { advance: async () => undefined, witnesses: () => [] } },
    journal: {
      state,
      append: (payloads: readonly RunEventPayload[]) => {
        appended.push(...payloads);
      },
    },
    control: {
      signal: new AbortController().signal,
      failure: () => undefined,
      leaseLost: () => false,
      shuttingDown: () => false,
      cancelRequested: () => false,
      inFlight: {},
    },
    terminals: {
      finish: (...args: unknown[]) => {
        finishes.push(args);
        return 'done';
      },
      yieldTo: (to: string, availableAt?: number, options?: unknown) => {
        yields.push({ to, availableAt, options });
        return 'done';
      },
      cancel: () => 'done',
      yieldLease: () => 'done',
    },
    meter: createTokenMeter({
      counter: {
        count: async (request) => {
          const input = typeof request.input === 'string' ? Math.ceil(request.input.length / 4) : request.input.reduce((sum, item) => sum + tokensOf(item), 0);
          const tools = (request.tools ?? []).reduce((sum, tool) => sum + tokensOf(tool), 0);
          return { input_tokens: input + tools, method: 'exact', error_bound: 0, error_shape: { ratio: 0, minimum: 0 } };
        },
      },
      model: 'fm',
      capabilities,
    }),
    pinnedDigest: { value: undefined as string | undefined },
    autoCompact: true,
    token: { cachePrefix: false, conciseDescriptions: false, loopGuidance: false, observedCapacity: false, outputFormatters: [], deferred: undefined },
    toolSet: { tools: [] },
  } as unknown as ClaimContext;
  return { ctx, appended, yields, finishes };
};

describe('PrefixChangedError ends the claim with a refunded attempt (4.2, 0.2 #17)', () => {
  it('yields QUEUED with refundAttempt instead of throwing when a pinned item changed mid-claim', async () => {
    const { ctx, yields, finishes } = contextFor(stateWithHistory());
    const first = await buildNext(ctx);
    expect(first.kind).toBe('built');
    (ctx as { systemPrompt: string }).systemPrompt = `${SYSTEM_PROMPT} edited`;

    const outcome = await buildNext(ctx).catch((caught: unknown) => caught);

    expect(outcome).toEqual({ kind: 'done' });
    expect(yields).toEqual([{ to: 'QUEUED', availableAt: expect.any(Number), options: { refundAttempt: true } }]);
    expect(finishes).toEqual([]);
  });
});

describe('trailing input without removing the tools (4.3)', () => {
  it('appends the trailing items last and keeps the offered tools', async () => {
    const { ctx } = contextFor(stateWithHistory());
    const trailing: InputItem = { type: 'message', role: 'user', content: 'A trailing note.' };

    const outcome = await buildNext(ctx, { trailing: [trailing] } as Parameters<typeof buildNext>[1]);

    if (outcome.kind !== 'built') throw new Error(`expected a build, received ${outcome.kind}`);
    expect(outcome.built.tools.map((tool) => tool.name)).toEqual(['Echo']);
    expect(outcome.built.input.at(-1)).toEqual(trailing);
  });
});
