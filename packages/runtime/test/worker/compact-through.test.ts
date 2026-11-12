import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { LOWEST_REASONING_EFFORT, admitRequest, marginFloorFor, outputTokensFor } from '@momonga/protocol';
import type { Capabilities, CompactRequest, CompactResource, InputItem, RunEventPayload, RunState } from '@momonga/protocol';
import { initialRunState } from '@momonga/store';
import { fixtureCompactionContent } from '@momonga/testkit';
import type { ClaimContext } from '../../src/worker/claim-context.ts';
import type { BudgetAccount } from '../../src/worker/admitted-request.ts';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { compactThrough } from '../../src/worker/context-step.ts';
import { capabilitiesFor } from './harness.ts';
import { unlimitedBudget } from './unlimited-budget.ts';
import { TEST_FENCE } from '@momonga/testkit';

const TASK: InputItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do the work.' }] };

const BLOB = 'f'.repeat(64);

const withBlob: RunState['history'] = [
  { seq: 1, item: TASK },
  { seq: 2, item: { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }, callId: 'c1' },
  { seq: 3, item: { type: 'function_call_output', call_id: 'c1', output: 'head [truncated]' }, callId: 'c1', handle: BLOB },
];

type FidelityAsked = { runId: string; throughEventSeq: number; cwd: string; tokens: { token: string; claim: string }[] };

type ContextOptions = {
  roles?: { compaction?: string };
  roleCapabilities?: Capabilities;
  budget?: BudgetAccount;
  failAppendOnce?: boolean;
  summaryText?: string;
  history?: RunState['history'];
  failCompaction?: boolean;
  notes?: RunState['notes'];
  attested?: (tokens: string[]) => string[];
  unreadable?: { handle: string; reason: string }[];
  step?: number;
};

const PLAN_TOKENS = { input: 9000, replaced: 7000, workingStateGrowth: 30, request: 7500 };
const PLAN_REBUILT = { before: [], after: [], tools: [] };
const SUMMARY_ITEM_TOKENS = 70;
const COUNTS = { tokensBefore: 9000, tokensAfter: 2100 };

const COMPACTING = { type: 'context.compacting', step: 0, attempt: 1 } as const;

const announcesTheCall = (payloads: readonly RunEventPayload[]): boolean => payloads.every((payload) => payload.type === 'context.compacting');

const contextFor = (options: ContextOptions = {}) => {
  const appended: RunEventPayload[] = [];
  const batches: RunEventPayload[][] = [];
  const requests: { request: CompactRequest; idempotencyKey: string }[] = [];
  const produced = new Map<string, CompactResource>();
  const blobReads = { count: 0 };
  const asked: FidelityAsked[] = [];
  const appendedAtRequest: RunEventPayload[][] = [];
  let appendFailures = options.failAppendOnce === true ? 1 : 0;
  let tick = 0;
  const clockReads = { count: 0 };
  const monotonicReads = { count: 0 };
  let monotonicTick = 0;
  const capabilityRequests: string[] = [];
  const ctx = {
    options: {
      clock: {
        now: () => {
          clockReads.count += 1;
          return (tick += 40);
        },
      },
      timers: {
        setTimeout: () => undefined,
        clearTimeout: () => undefined,
        monotonicMs: () => {
          monotonicReads.count += 1;
          return (monotonicTick += 40);
        },
      },
      blobs: {
        read: async (handle: string) => {
          blobReads.count += 1;
          throw Object.assign(new Error(`unknown blob ${handle}`), { code: 'BLOB_NOT_FOUND' });
        },
      },
      store: {
        getSession: () => ({ id: 'session_compact', cwd: '/proj' }),
        recordFidelityVerdicts: () => undefined,
        journalFacts: {
          fidelity: async (request: FidelityAsked) => {
            asked.push(structuredClone(request));
            const tokens = request.tokens.map((entry) => entry.token);
            return { lastSeq: request.throughEventSeq, attested: (options.attested ?? ((all: string[]) => all))(tokens), unreadable: options.unreadable ?? [], checkedThrough: request.throughEventSeq, verdicts: [] };
          },
        },
      },
      gateway: {
        capabilities: async (model: string) => {
          capabilityRequests.push(model);
          if (options.roleCapabilities === undefined) throw new Error(`no capabilities are scripted for ${model}`);
          return options.roleCapabilities;
        },
        compact: async (request: CompactRequest, callOptions: { idempotencyKey: string }) => {
          requests.push({ request: structuredClone(request), idempotencyKey: callOptions.idempotencyKey });
          appendedAtRequest.push([...appended]);
          if (options.failCompaction === true) throw new GatewayRequestError({ status: 400, type: 'invalid_request', code: 'context_length_exceeded', message: 'too long' });
          const known = produced.get(callOptions.idempotencyKey);
          if (known !== undefined) return known;
          const resource: CompactResource = {
            id: 'compaction_1',
            object: 'response.compaction',
            output: [{ type: 'compaction', id: `cmp_${produced.size + 1}`, encrypted_content: fixtureCompactionContent(options.summaryText ?? `S${produced.size + 1}`) }],
            created_at: 1,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
            momonga: { target: 'remote' },
          };
          produced.set(callOptions.idempotencyKey, resource);
          return resource;
        },
      },
    },
    run: { id: 'run_compact', sessionId: 'session_compact', deadlineAt: 2_000_000_000_000 },
    budget: options.budget ?? unlimitedBudget(),
    model: 'fm',
    display: (model: string) => model,
    meter: { countItem: async () => SUMMARY_ITEM_TOKENS, count: async () => ({ inputTokens: COUNTS.tokensAfter }) },
    roles: options.roles ?? {},
    capabilities: capabilitiesFor(40_000),
    verificationCommands: [],
    readers: () => ({}),
    systemPrompt: 'You are the compact-through test agent.',
    journal: {
      state: {
        ...initialRunState({ runId: 'run_compact', sessionId: 'session_compact', fence: TEST_FENCE }),
        taskSeq: 1,
        ...(options.step === undefined ? {} : { step: options.step }),
        ...(options.notes === undefined ? {} : { notes: options.notes }),
        ...(options.history === undefined ? {} : { history: options.history, nextItemSeq: options.history.length + 1 }),
      } as RunState,
      append: (payloads: readonly RunEventPayload[]) => {
        if (appendFailures > 0 && !announcesTheCall(payloads)) {
          appendFailures -= 1;
          throw new Error('the claim ended before the compaction was recorded');
        }
        appended.push(...payloads);
        batches.push([...payloads]);
      },
    },
    control: {
      signal: new AbortController().signal,
      inFlight: {},
      recordingRaised: <T>(promise: Promise<T>) => promise,
    },
    agentSpan: { traceparent: undefined },
  } as unknown as ClaimContext;
  return { ctx, appended, batches, requests, produced, blobReads, asked, appendedAtRequest, clockReads, monotonicReads, capabilityRequests };
};

const keyOf = (request: CompactRequest): string => sha256Hex(canonicalJson(['run_compact', 'compact', sha256Hex(canonicalJson(request))]));

describe('compactThrough', () => {
  const input: InputItem[] = [TASK, { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'ok' }];
  const pinnedText = 'You are the compact-through test agent.';

  it('records the token counts before and after from the plan and the count of the summary item', async () => {
    const { ctx, appended } = contextFor();
    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] });
    expect(appended.find((payload) => payload.type === 'context.compacted')).toMatchObject(COUNTS);
  });

  it('records the token counts on the deterministic summary too', async () => {
    const { ctx, appended } = contextFor({ failCompaction: true });
    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] });
    expect(appended.find((payload) => payload.type === 'context.compacted')).toMatchObject({ source: 'deterministic', ...COUNTS });
  });

  it('sends the focus text as momonga.instructions and leaves the request as it is without one', async () => {
    const { ctx, requests } = contextFor();
    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [], focus: 'keep the parser decisions' });
    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 241, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] });
    expect(requests[0]?.request.momonga).toEqual({ max_summary_tokens: 240, retains_user_request: true, exact_model: true, fence: TEST_FENCE, instructions: 'keep the parser decisions' });
    expect(requests[1]?.request.momonga).toEqual({ max_summary_tokens: 241, retains_user_request: true, exact_model: true, fence: TEST_FENCE });
  });

  it('sends the rendered input verbatim with the cap and retains_user_request, no instructions, under the whole-body key', async () => {
    const { ctx, appended, requests } = contextFor();

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] });

    expect(requests).toHaveLength(1);
    const [sent] = requests;
    expect(sent?.request).toEqual({ model: 'fm', input, momonga: { max_summary_tokens: 240, retains_user_request: true, exact_model: true, fence: TEST_FENCE } });
    expect('instructions' in (sent?.request ?? {})).toBe(false);
    expect(sent?.idempotencyKey).toBe(keyOf(sent?.request as CompactRequest));
    expect(appended).toEqual([
      COMPACTING,
      expect.objectContaining({ type: 'usage.charged', purpose: 'compaction' }),
      expect.objectContaining({ type: 'context.compacted', replacedThroughSeq: 3, summary: 'S1', source: 'model' }),
    ]);
  });

  it('records the duration of the compaction call measured on the monotonic clock on its charge', async () => {
    const { ctx, appended, monotonicReads } = contextFor();

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] });

    expect(appended[1]).toMatchObject({ type: 'usage.charged', purpose: 'compaction', timing: { durationMs: 40 }, responseId: 'compaction_1' });
    expect(monotonicReads.count).toBe(2);
  });

  it('derives a new key when only the cap differs', async () => {
    const { ctx, requests } = contextFor();

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] });
    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 241, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] });

    expect(requests.map((entry) => entry.request.momonga?.max_summary_tokens)).toEqual([240, 241]);
    expect(requests[0]?.idempotencyKey).not.toBe(requests[1]?.idempotencyKey);
    expect(requests[1]?.idempotencyKey).toBe(keyOf(requests[1]?.request as CompactRequest));
  });

  it('accepts a summary whose tokens the record attests, and sends the thread the claims only', async () => {
    const handle = 'ab12'.repeat(16);
    const { ctx, appended, asked } = contextFor({ summaryText: `STATE:\n${handle}` });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] });

    expect(asked).toEqual([{ runId: 'run_compact', throughEventSeq: expect.any(Number), cwd: '/proj', tokens: [{ token: handle, claim: 'executed' }] }]);
    expect(appended.at(-1)).toMatchObject({ type: 'context.compacted', source: 'model', fidelity: { fabricated: [] } });
  });

  it('replaces a summary whose token the record does not attest', async () => {
    const { ctx, appended } = contextFor({ summaryText: `STATE:\n${'cd34'.repeat(16)}`, attested: () => [] });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] });

    expect(appended.at(-1)).toMatchObject({ type: 'context.compacted', source: 'deterministic', fidelity: { fabricated: ['cd34'.repeat(16)] } });
  });

  it('goes on when the thread could not read a recorded blob, leaves the token it held unattested, and says so', async () => {
    const { ctx, appended } = contextFor({
      summaryText: `STATE:\n\`src/only/in-blob.ts\``,
      history: withBlob,
      attested: () => [],
      unreadable: [{ handle: BLOB, reason: `unknown blob ${BLOB}` }],
    });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] });

    expect(appended.at(-1)).toMatchObject({ type: 'context.compacted', source: 'deterministic', fidelity: { fabricated: ['src/only/in-blob.ts'] } });
    const notice = appended.find((payload) => payload.type === 'notice');
    expect(notice).toMatchObject({ level: 'warning', message: expect.stringContaining(BLOB) });
  });

  it('reads no blob on the loop even when the replaced range holds a handled output', async () => {
    const { ctx, blobReads } = contextFor({ summaryText: 'STATE:\nnothing to name', history: withBlob });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] });

    expect(blobReads.count).toBe(0);
  });

  it('keeps a model summary whose tokens are all attested, and still says the blob was unreadable', async () => {
    const { ctx, appended } = contextFor({ summaryText: 'STATE:\nnothing to name', history: withBlob, unreadable: [{ handle: BLOB, reason: `unknown blob ${BLOB}` }] });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] });

    expect(appended.at(-1)).toMatchObject({ type: 'context.compacted', source: 'model' });
    expect(appended.some((payload) => payload.type === 'notice' && payload.message.includes(BLOB))).toBe(true);
  });

  it('asks again under the same key after the claim ended between the reply and the journal append, and the model writes no second summary', async () => {
    const { ctx, appended, requests, produced } = contextFor({ failAppendOnce: true });
    const plan = { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] };

    await expect(compactThrough(ctx, plan)).rejects.toThrow('the claim ended before the compaction was recorded');
    await compactThrough(ctx, plan);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.idempotencyKey).toBe(requests[0]?.idempotencyKey);
    expect(produced.size).toBe(1);
    expect(appended.filter((payload) => payload.type === 'context.compacted')).toEqual([expect.objectContaining({ summary: 'S1', source: 'model' })]);
  });
});

type Ask = Parameters<typeof admitRequest>[0];

const NOTHING_SPENT = { totalTokens: 0, costNano: 0, unpricedCalls: 0, reservedTokens: 0, reservedNano: 0 };

const recordingBudget = (priceUnits: string[] = []) => {
  const asks: Ask[] = [];
  const priced = priceUnits.length > 0;
  const account: BudgetAccount = {
    limits: { maxTotalTokens: Number.MAX_SAFE_INTEGER, ...(priced ? { maxCostNano: Number.MAX_SAFE_INTEGER } : {}) },
    quote: async (model) => {
      const units = priceUnits.shift();
      return units === undefined ? { model, priced: false } : { model, priced: true, inUnits: units, outUnits: units, priceVersions: [`v${units}`] };
    },
    spend: () => NOTHING_SPENT,
    ledger: {
      admitModelRequest: (ask) => {
        asks.push(ask);
        return admitRequest(ask, NOTHING_SPENT);
      },
    },
    tail: Promise.resolve(),
  };
  return { account, asks };
};

describe('a compaction request sized for the model that receives it', () => {
  const input: InputItem[] = [TASK, { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'ok' }];
  const pinnedText = 'You are the compact-through test agent.';
  const plan = { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] };

  it('is admitted at the size of the request the plan gives, not at the size of the whole input', async () => {
    const { account, asks } = recordingBudget();
    const { ctx } = contextFor({ budget: account });

    await compactThrough(ctx, plan);

    expect(asks.map((ask) => ask.inputUpper)).toEqual([PLAN_TOKENS.request + marginFloorFor(40_000)]);
  });

  it('reads the capabilities of the role model once in a claim and sizes the output and the margin by them', async () => {
    const roleCapabilities = capabilitiesFor(8000, { maxOutputTokens: 200 });
    const { account, asks } = recordingBudget();
    const { ctx, requests, capabilityRequests } = contextFor({ budget: account, roles: { compaction: 'cheap' }, roleCapabilities });

    await compactThrough(ctx, plan);
    await compactThrough(ctx, { ...plan, summaryTokenCap: 239 });

    expect(capabilityRequests).toEqual(['cheap']);
    expect(requests.map((entry) => entry.request.model)).toEqual(['cheap', 'cheap']);
    expect(asks[0]).toMatchObject({ inputUpper: PLAN_TOKENS.request + marginFloorFor(8000), outputWanted: outputTokensFor(roleCapabilities, LOWEST_REASONING_EFFORT, 240) });
  });

  it('keeps the key when only the reservation differs, so a retry after a crash meets the request already paid for', async () => {
    const { account } = recordingBudget(['1000000000', '2000000000']);
    const { ctx, requests, produced } = contextFor({ budget: account, failAppendOnce: true });

    await expect(compactThrough(ctx, plan)).rejects.toThrow('the claim ended before the compaction was recorded');
    await compactThrough(ctx, plan);

    const ceilings = requests.map((entry) => entry.request.momonga?.max_cost_nano);
    expect(ceilings.every((ceiling) => typeof ceiling === 'number')).toBe(true);
    expect(ceilings[0]).not.toBe(ceilings[1]);
    expect(requests[1]?.idempotencyKey).toBe(requests[0]?.idempotencyKey);
    expect(requests[0]?.idempotencyKey).toBe(keyOf({ model: 'fm', input, momonga: { max_summary_tokens: 240, retains_user_request: true, exact_model: true, fence: TEST_FENCE } }));
    expect(produced.size).toBe(1);
  });
});

describe('context.compacting: the event that backs the wait for a compaction (design-screens 6.1.1)', () => {
  const input: InputItem[] = [TASK, { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'ok' }];
  const pinnedText = 'You are the compact-through test agent.';
  const plan = { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [] };

  it('is in the journal, alone in its batch, when the gateway is asked for the summary', async () => {
    const { ctx, batches, appendedAtRequest } = contextFor();

    await compactThrough(ctx, plan);

    expect(appendedAtRequest).toEqual([[COMPACTING]]);
    expect(batches[0]).toEqual([COMPACTING]);
  });

  it('carries the step of the run at that moment and attempt 1, and nothing else', async () => {
    const { ctx, appended } = contextFor({ step: 4 });

    await compactThrough(ctx, plan);

    expect(appended[0]).toEqual({ type: 'context.compacting', step: 4, attempt: 1 });
  });

  it('is followed by context.compacted when the model summary is used', async () => {
    const { ctx, appended } = contextFor();

    await compactThrough(ctx, plan);

    expect(appended.map((payload) => payload.type)).toEqual(['context.compacting', 'usage.charged', 'context.compacted']);
  });

  it('is followed by context.compacted when the summary call failed and the deterministic summary is used', async () => {
    const { ctx, appended } = contextFor({ failCompaction: true });

    await compactThrough(ctx, plan);

    expect(appended.map((payload) => payload.type)).toEqual(['context.compacting', 'notice', 'context.compacted']);
    expect(appended.at(-1)).toMatchObject({ source: 'deterministic' });
  });

  it('is written once per call of the gateway', async () => {
    const { ctx, appended, requests } = contextFor();

    await compactThrough(ctx, plan);
    await compactThrough(ctx, { ...plan, summaryTokenCap: 241 });

    expect(requests).toHaveLength(2);
    expect(appended.filter((payload) => payload.type === 'context.compacting')).toEqual([COMPACTING, COMPACTING]);
  });
});

describe('the protection-reduction notices of a compaction', () => {
  const input: InputItem[] = [TASK, { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'ok' }];
  const pinnedText = 'You are the compact-through test agent.';
  const stepsNotice = (turn: number, from: number, to: number) => ({
    code: 'recent_steps_shrunk' as const,
    message: `recent steps of the current turn were reduced from ${from} to ${to} because the context budget was exceeded`,
    reduction: { turn, from, to },
  });
  const noticesIn = (payloads: readonly RunEventPayload[]) => payloads.filter((payload) => payload.type === 'notice');

  it('writes the notice in the batch that holds context.compacted when the model summary is used', async () => {
    const { ctx, batches } = contextFor();

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [stepsNotice(0, 4, 1)] });

    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual([COMPACTING]);
    expect(batches[1]?.map((payload) => payload.type)).toEqual(expect.arrayContaining(['context.compacted', 'notice']));
    expect(noticesIn(batches[1] ?? [])).toEqual([expect.objectContaining({ code: 'recent_steps_shrunk', reduction: { turn: 0, from: 4, to: 1 } })]);
  });

  it('writes the notice in the batch that holds context.compacted when the summary call failed', async () => {
    const { ctx, batches } = contextFor({ failCompaction: true });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [stepsNotice(0, 4, 1)] });

    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual([COMPACTING]);
    expect(batches[1]?.map((payload) => payload.type)).toContain('context.compacted');
    expect(noticesIn(batches[1] ?? []).map((payload) => (payload.type === 'notice' ? payload.code : ''))).toEqual(['compaction_failed', 'recent_steps_shrunk']);
  });

  it('announces a reduction in a later turn although the text is the same as an earlier one', async () => {
    const earlier = { level: 'warning' as const, ...stepsNotice(1, 3, 1), };
    const { ctx, appended } = contextFor({ notes: [earlier] });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [stepsNotice(4, 3, 1)] });

    expect(noticesIn(appended)).toEqual([expect.objectContaining({ code: 'recent_steps_shrunk', reduction: { turn: 4, from: 3, to: 1 } })]);
  });

  it('announces a further drop in the same turn', async () => {
    const earlier = { level: 'warning' as const, ...stepsNotice(2, 4, 2) };
    const { ctx, appended } = contextFor({ notes: [earlier] });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [stepsNotice(2, 4, 1)] });

    expect(noticesIn(appended)).toEqual([expect.objectContaining({ reduction: { turn: 2, from: 4, to: 1 } })]);
  });

  it('does not announce the reduction a build of the same turn already announced', async () => {
    const earlier = { level: 'warning' as const, ...stepsNotice(2, 4, 1) };
    const { ctx, appended } = contextFor({ notes: [earlier] });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, tokens: PLAN_TOKENS, rebuilt: PLAN_REBUILT, notices: [stepsNotice(2, 4, 1)] });

    expect(noticesIn(appended)).toEqual([]);
  });
});
