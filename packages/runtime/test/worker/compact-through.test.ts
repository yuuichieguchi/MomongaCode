import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { CompactRequest, CompactResource, InputItem, RunEventPayload, RunState } from '@momonga/protocol';
import { initialRunState } from '@momonga/store';
import { fixtureCompactionContent } from '@momonga/testkit';
import type { ClaimContext } from '../../src/worker/claim-context.ts';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { compactThrough } from '../../src/worker/context-step.ts';
import { capabilitiesFor } from './harness.ts';

const TASK: InputItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do the work.' }] };

const BLOB = 'f'.repeat(64);

const withBlob: RunState['history'] = [
  { seq: 1, item: TASK },
  { seq: 2, item: { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }, callId: 'c1' },
  { seq: 3, item: { type: 'function_call_output', call_id: 'c1', output: 'head [truncated]' }, callId: 'c1', handle: BLOB },
];

type FidelityAsked = { runId: string; throughEventSeq: number; cwd: string; tokens: { token: string; claim: string }[] };

type ContextOptions = {
  failAppendOnce?: boolean;
  summaryText?: string;
  history?: RunState['history'];
  failCompaction?: boolean;
  notes?: RunState['notes'];
  attested?: (tokens: string[]) => string[];
  unreadable?: { handle: string; reason: string }[];
};

const contextFor = (options: ContextOptions = {}) => {
  const appended: RunEventPayload[] = [];
  const batches: RunEventPayload[][] = [];
  const requests: { request: CompactRequest; idempotencyKey: string }[] = [];
  const produced = new Map<string, CompactResource>();
  const blobReads = { count: 0 };
  const asked: FidelityAsked[] = [];
  let appendFailures = options.failAppendOnce === true ? 1 : 0;
  let tick = 0;
  const ctx = {
    options: {
      clock: { now: () => (tick += 40) },
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
        compact: async (request: CompactRequest, callOptions: { idempotencyKey: string }) => {
          requests.push({ request: structuredClone(request), idempotencyKey: callOptions.idempotencyKey });
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
            momonga: { target: 'primary' },
          };
          produced.set(callOptions.idempotencyKey, resource);
          return resource;
        },
      },
    },
    run: { id: 'run_compact', sessionId: 'session_compact', deadlineAt: 2_000_000_000_000 },
    alias: 'fm',
    roles: {},
    capabilities: capabilitiesFor(40_000),
    verificationCommands: [],
    readers: () => ({}),
    systemPrompt: 'You are the compact-through test agent.',
    journal: {
      state: {
        ...initialRunState({ runId: 'run_compact', sessionId: 'session_compact' }),
        taskSeq: 1,
        ...(options.notes === undefined ? {} : { notes: options.notes }),
        ...(options.history === undefined ? {} : { history: options.history, nextItemSeq: options.history.length + 1 }),
      } as RunState,
      append: (payloads: readonly RunEventPayload[]) => {
        if (appendFailures > 0) {
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
  return { ctx, appended, batches, requests, produced, blobReads, asked };
};

const keyOf = (request: CompactRequest): string => sha256Hex(canonicalJson(['run_compact', 'compact', sha256Hex(canonicalJson(request))]));

describe('compactThrough', () => {
  const input: InputItem[] = [TASK, { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'ok' }];
  const pinnedText = 'You are the compact-through test agent.';

  it('sends the rendered input verbatim with the cap and retains_user_request, no instructions, under the whole-body key', async () => {
    const { ctx, appended, requests } = contextFor();

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, notices: [] });

    expect(requests).toHaveLength(1);
    const [sent] = requests;
    expect(sent?.request).toEqual({ model: 'fm', input, momonga: { max_summary_tokens: 240, retains_user_request: true } });
    expect('instructions' in (sent?.request ?? {})).toBe(false);
    expect(sent?.idempotencyKey).toBe(keyOf(sent?.request as CompactRequest));
    expect(appended).toEqual([
      expect.objectContaining({ type: 'usage.charged', purpose: 'compaction' }),
      expect.objectContaining({ type: 'context.compacted', replacedThroughSeq: 3, summary: 'S1', source: 'model' }),
    ]);
  });

  it('records the measured duration of the compaction call on its charge', async () => {
    const { ctx, appended } = contextFor();

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, notices: [] });

    expect(appended[0]).toMatchObject({ type: 'usage.charged', purpose: 'compaction', timing: { durationMs: 40 }, responseId: 'compaction_1' });
  });

  it('derives a new key when only the cap differs', async () => {
    const { ctx, requests } = contextFor();

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, notices: [] });
    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 241, pinnedText, notices: [] });

    expect(requests.map((entry) => entry.request.momonga?.max_summary_tokens)).toEqual([240, 241]);
    expect(requests[0]?.idempotencyKey).not.toBe(requests[1]?.idempotencyKey);
    expect(requests[1]?.idempotencyKey).toBe(keyOf(requests[1]?.request as CompactRequest));
  });

  it('accepts a summary whose tokens the record attests, and sends the thread the claims only', async () => {
    const handle = 'ab12'.repeat(16);
    const { ctx, appended, asked } = contextFor({ summaryText: `STATE:\n${handle}` });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, notices: [] });

    expect(asked).toEqual([{ runId: 'run_compact', throughEventSeq: expect.any(Number), cwd: '/proj', tokens: [{ token: handle, claim: 'executed' }] }]);
    expect(appended.at(-1)).toMatchObject({ type: 'context.compacted', source: 'model', fidelity: { fabricated: [] } });
  });

  it('replaces a summary whose token the record does not attest', async () => {
    const { ctx, appended } = contextFor({ summaryText: `STATE:\n${'cd34'.repeat(16)}`, attested: () => [] });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, notices: [] });

    expect(appended.at(-1)).toMatchObject({ type: 'context.compacted', source: 'deterministic', fidelity: { fabricated: ['cd34'.repeat(16)] } });
  });

  it('goes on when the thread could not read a recorded blob, leaves the token it held unattested, and says so', async () => {
    const { ctx, appended } = contextFor({
      summaryText: `STATE:\n\`src/only/in-blob.ts\``,
      history: withBlob,
      attested: () => [],
      unreadable: [{ handle: BLOB, reason: `unknown blob ${BLOB}` }],
    });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, notices: [] });

    expect(appended.at(-1)).toMatchObject({ type: 'context.compacted', source: 'deterministic', fidelity: { fabricated: ['src/only/in-blob.ts'] } });
    const notice = appended.find((payload) => payload.type === 'notice');
    expect(notice).toMatchObject({ level: 'warning', message: expect.stringContaining(BLOB) });
  });

  it('reads no blob on the loop even when the replaced range holds a handled output', async () => {
    const { ctx, blobReads } = contextFor({ summaryText: 'STATE:\nnothing to name', history: withBlob });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, notices: [] });

    expect(blobReads.count).toBe(0);
  });

  it('keeps a model summary whose tokens are all attested, and still says the blob was unreadable', async () => {
    const { ctx, appended } = contextFor({ summaryText: 'STATE:\nnothing to name', history: withBlob, unreadable: [{ handle: BLOB, reason: `unknown blob ${BLOB}` }] });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, notices: [] });

    expect(appended.at(-1)).toMatchObject({ type: 'context.compacted', source: 'model' });
    expect(appended.some((payload) => payload.type === 'notice' && payload.message.includes(BLOB))).toBe(true);
  });

  it('asks again under the same key after the claim ended between the reply and the journal append, and the model writes no second summary', async () => {
    const { ctx, appended, requests, produced } = contextFor({ failAppendOnce: true });
    const plan = { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, notices: [] };

    await expect(compactThrough(ctx, plan)).rejects.toThrow('the claim ended before the compaction was recorded');
    await compactThrough(ctx, plan);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.idempotencyKey).toBe(requests[0]?.idempotencyKey);
    expect(produced.size).toBe(1);
    expect(appended.filter((payload) => payload.type === 'context.compacted')).toEqual([expect.objectContaining({ summary: 'S1', source: 'model' })]);
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

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, notices: [stepsNotice(0, 4, 1)] });

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((payload) => payload.type)).toEqual(expect.arrayContaining(['context.compacted', 'notice']));
    expect(noticesIn(batches[0] ?? [])).toEqual([expect.objectContaining({ code: 'recent_steps_shrunk', reduction: { turn: 0, from: 4, to: 1 } })]);
  });

  it('writes the notice in the batch that holds context.compacted when the summary call failed', async () => {
    const { ctx, batches } = contextFor({ failCompaction: true });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, notices: [stepsNotice(0, 4, 1)] });

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((payload) => payload.type)).toContain('context.compacted');
    expect(noticesIn(batches[0] ?? []).map((payload) => (payload.type === 'notice' ? payload.code : ''))).toEqual(['compaction_failed', 'recent_steps_shrunk']);
  });

  it('announces a reduction in a later turn although the text is the same as an earlier one', async () => {
    const earlier = { level: 'warning' as const, ...stepsNotice(1, 3, 1), };
    const { ctx, appended } = contextFor({ notes: [earlier] });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, notices: [stepsNotice(4, 3, 1)] });

    expect(noticesIn(appended)).toEqual([expect.objectContaining({ code: 'recent_steps_shrunk', reduction: { turn: 4, from: 3, to: 1 } })]);
  });

  it('announces a further drop in the same turn', async () => {
    const earlier = { level: 'warning' as const, ...stepsNotice(2, 4, 2) };
    const { ctx, appended } = contextFor({ notes: [earlier] });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, notices: [stepsNotice(2, 4, 1)] });

    expect(noticesIn(appended)).toEqual([expect.objectContaining({ reduction: { turn: 2, from: 4, to: 1 } })]);
  });

  it('does not announce the reduction a build of the same turn already announced', async () => {
    const earlier = { level: 'warning' as const, ...stepsNotice(2, 4, 1) };
    const { ctx, appended } = contextFor({ notes: [earlier] });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText, notices: [stepsNotice(2, 4, 1)] });

    expect(noticesIn(appended)).toEqual([]);
  });
});
