import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import { createTokenMeter } from '@momonga/context';
import type { CountTokensRequest, FunctionTool, InputItem, RunEventPayload, RunState } from '@momonga/protocol';
import { initialRunState } from '@momonga/store';
import type { ClaimContext } from '../../src/worker/claim-context.ts';
import { buildNext } from '../../src/worker/context-step.ts';
import { WRAPUP_INSTRUCTIONS_VERSION, wrapUpInstructionFor } from '../../src/worker/wrap-up.ts';
import { capabilitiesFor } from './harness.ts';

const SYSTEM_PROMPT = 'You are the wrap-up test agent.';
const TASK_TEXT = 'Do the work.';
const ECHO_TOOL: FunctionTool = { type: 'function', name: 'Echo', description: 'Echo a value', parameters: { type: 'object', properties: {} } };

const tokensOf = (value: unknown): number => Math.ceil(canonicalJson(value).length / 4);

const stateWithHistory = (): RunState => ({
  ...initialRunState({ runId: 'run_wrap', sessionId: 'session_wrap' }),
  step: 1,
  taskSeq: 1,
  history: [
    { seq: 1, item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: TASK_TEXT }] } },
    { seq: 2, item: { type: 'function_call', call_id: 'call_w_1', name: 'Echo', arguments: '{"value":"x"}' }, callId: 'call_w_1' },
    { seq: 3, item: { type: 'function_call_output', call_id: 'call_w_1', output: 'echo:x' }, callId: 'call_w_1' },
  ],
} as RunState);

const contextFor = (state: RunState) => {
  const appended: RunEventPayload[] = [];
  const counts: CountTokensRequest[] = [];
  const capabilities = capabilitiesFor(200_000);
  const ctx = {
    options: {
      home: '/home/wrap',
      store: {
        getSession: () => ({ id: 'session_wrap', cwd: '/project/wrap' }),
        readRunEvents: () => [{ type: 'user.message', text: TASK_TEXT }],
        governing: { list: () => [] },
        sessionTouched: { newest: () => [], after: () => [] },
      },
      clock: { now: () => 0 },
      tools: { sessionState: () => ({ cwd: '/project/wrap' }) },
      settings: { trusted: () => true },
      blobs: { handleFor: () => 'blob-1', put: async () => ({ handle: 'blob-1' }) },
      instructionReader: { read: async () => undefined, exists: async () => false, realpath: async (target: string) => target },
    },
    run: { id: 'run_wrap', sessionId: 'session_wrap' },
    alias: 'fm',
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
      finish: () => 'done',
      yieldTo: () => 'done',
      cancel: () => 'done',
      yieldLease: () => 'done',
    },
    meter: createTokenMeter({
      counter: {
        count: async (request) => {
          counts.push(request);
          const input = typeof request.input === 'string' ? Math.ceil(request.input.length / 4) : request.input.reduce((sum, item) => sum + tokensOf(item), 0);
          const tools = (request.tools ?? []).reduce((sum, tool) => sum + tokensOf(tool), 0);
          return { input_tokens: input + tools, method: 'exact', error_bound: 0, error_shape: { ratio: 0, minimum: 0 } };
        },
      },
      model: 'fm',
      capabilities,
    }),
    pinnedDigest: { value: undefined as string | undefined },
    token: { cachePrefix: false, conciseDescriptions: false, loopGuidance: false, observedCapacity: false, outputFormatters: [], deferred: undefined },
  } as unknown as ClaimContext;
  return { ctx, appended, counts };
};

const builtOf = async (ctx: ClaimContext, options?: Parameters<typeof buildNext>[1]) => {
  const outcome = await buildNext(ctx, options);
  if (outcome.kind !== 'built') throw new Error(`expected a build, received ${outcome.kind}`);
  return outcome.built;
};

describe('wrap-up instruction texts', () => {
  it('are versioned at 1', () => {
    expect(WRAPUP_INSTRUCTIONS_VERSION).toBe(1);
  });

  it.for([
    ['max_steps', 'You have reached the max_steps limit. Summarize what you accomplished, what remains, and any state the user must know. Do not call tools.'],
    ['budget', 'You have reached the budget limit. Summarize what you accomplished, what remains, and any state the user must know. Do not call tools.'],
    ['context', "The conversation no longer fits the model's context window. Summarize what you accomplished, what remains, and any state the user must know. Do not call tools."],
  ] as const)('keeps the fixed %s text', ([reason, text]) => {
    expect(wrapUpInstructionFor(reason)).toBe(text);
  });
});

describe('buildNext in wrap-up mode', () => {
  it('builds without tools and ends the input with the counted user-role instruction', async () => {
    const { ctx, counts } = contextFor(stateWithHistory());

    const built = await builtOf(ctx, { wrapUp: 'max_steps' });

    const instruction: InputItem = { type: 'message', role: 'user', content: wrapUpInstructionFor('max_steps') };
    expect(built.tools).toEqual([]);
    expect(built.input.at(-1)).toEqual(instruction);
    expect(built.input.filter((item) => item.type === 'message' && item.role === 'developer')).toEqual([]);
    const counted = counts.filter((request) => Array.isArray(request.input) && request.input.length > 0 && canonicalJson(request.input.at(-1)) === canonicalJson(instruction));
    expect(counted.length).toBeGreaterThan(0);
    expect(counts.some((request) => canonicalJson(request.input) === canonicalJson(built.input))).toBe(true);
    for (const request of counts) expect(request.tools ?? []).toEqual([]);
  });

  it('never seeds the pinned digest from a wrap-up build when it is the first build of the claim', async () => {
    const { ctx } = contextFor(stateWithHistory());

    await builtOf(ctx, { wrapUp: 'max_steps' });

    expect(ctx.pinnedDigest.value).toBeUndefined();
  });

  it('seeds the pinned digest from a normal build and compares it in a later wrap-up build', async () => {
    const { ctx } = contextFor(stateWithHistory());

    const normal = await builtOf(ctx);
    expect(ctx.pinnedDigest.value).toBe(normal.pinnedDigest);

    const wrapUp = await builtOf(ctx, { wrapUp: 'budget' });
    expect(wrapUp.pinnedDigest).toBe(normal.pinnedDigest);
    expect(ctx.pinnedDigest.value).toBe(normal.pinnedDigest);
  });

  it('yields the claim to QUEUED with the attempt refunded when a pinned item changed since the seeding build', async () => {
    const { ctx } = contextFor(stateWithHistory());
    const yields: unknown[][] = [];
    (ctx as unknown as { terminals: { yieldTo: (...args: unknown[]) => string } }).terminals.yieldTo = (...args: unknown[]) => {
      yields.push(args);
      return 'done';
    };
    await builtOf(ctx);
    (ctx as { systemPrompt: string }).systemPrompt = `${SYSTEM_PROMPT} changed`;

    const outcome = await buildNext(ctx, { wrapUp: 'max_steps' }).catch((caught: unknown) => caught);

    expect(outcome).toEqual({ kind: 'done' });
    expect(yields).toEqual([['QUEUED', expect.any(Number), { refundAttempt: true }]]);
  });
});
