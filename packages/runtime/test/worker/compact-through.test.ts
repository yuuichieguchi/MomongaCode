import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { CompactRequest, CompactResource, InputItem, RunEventPayload, RunState } from '@momonga/protocol';
import { initialRunState } from '@momonga/store';
import { fixtureCompactionContent } from '@momonga/testkit';
import type { ClaimContext } from '../../src/worker/claim-context.ts';
import { compactThrough } from '../../src/worker/context-step.ts';
import { capabilitiesFor } from './harness.ts';

const TASK: InputItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do the work.' }] };

const BLOB = 'f'.repeat(64);

const withBlob: RunState['history'] = [
  { seq: 1, item: TASK },
  { seq: 2, item: { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }, callId: 'c1' },
  { seq: 3, item: { type: 'function_call_output', call_id: 'c1', output: 'head [truncated]' }, callId: 'c1', handle: BLOB },
];

const contextFor = (options: { failAppendOnce?: boolean; summaryText?: string; history?: RunState['history'] } = {}) => {
  const appended: RunEventPayload[] = [];
  const requests: { request: CompactRequest; idempotencyKey: string }[] = [];
  const produced = new Map<string, CompactResource>();
  let appendFailures = options.failAppendOnce === true ? 1 : 0;
  const ctx = {
    options: {
      blobs: {
        read: async (handle: string) => {
          throw Object.assign(new Error(`unknown blob ${handle}`), { code: 'BLOB_NOT_FOUND' });
        },
      },
      gateway: {
        compact: async (request: CompactRequest, callOptions: { idempotencyKey: string }) => {
          requests.push({ request: structuredClone(request), idempotencyKey: callOptions.idempotencyKey });
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
          };
          produced.set(callOptions.idempotencyKey, resource);
          return resource;
        },
      },
    },
    run: { id: 'run_compact', deadlineAt: 2_000_000_000_000 },
    alias: 'fm',
    capabilities: capabilitiesFor(40_000),
    verificationCommands: [],
    systemPrompt: 'You are the compact-through test agent.',
    journal: {
      state: {
        ...initialRunState({ runId: 'run_compact', sessionId: 'session_compact' }),
        taskSeq: 1,
        ...(options.history === undefined ? {} : { history: options.history, nextItemSeq: options.history.length + 1 }),
      } as RunState,
      append: (payloads: readonly RunEventPayload[]) => {
        if (appendFailures > 0) {
          appendFailures -= 1;
          throw new Error('the claim ended before the compaction was recorded');
        }
        appended.push(...payloads);
      },
    },
    control: {
      signal: new AbortController().signal,
      inFlight: {},
      recordingRaised: <T>(promise: Promise<T>) => promise,
    },
    agentSpan: { traceparent: undefined },
  } as unknown as ClaimContext;
  return { ctx, appended, requests, produced };
};

const keyOf = (request: CompactRequest): string => sha256Hex(canonicalJson(['run_compact', 'compact', sha256Hex(canonicalJson(request))]));

describe('compactThrough', () => {
  const input: InputItem[] = [TASK, { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'ok' }];
  const pinnedText = 'You are the compact-through test agent.';

  it('sends the rendered input verbatim with the cap and retains_user_request, no instructions, under the whole-body key', async () => {
    const { ctx, appended, requests } = contextFor();

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText });

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

  it('derives a new key when only the cap differs', async () => {
    const { ctx, requests } = contextFor();

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText });
    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 241, pinnedText });

    expect(requests.map((entry) => entry.request.momonga?.max_summary_tokens)).toEqual([240, 241]);
    expect(requests[0]?.idempotencyKey).not.toBe(requests[1]?.idempotencyKey);
    expect(requests[1]?.idempotencyKey).toBe(keyOf(requests[1]?.request as CompactRequest));
  });

  it('accepts a summary that keeps a handle the model saw only in the rendered input', async () => {
    const handle = 'ab12'.repeat(16);
    const { ctx, appended } = contextFor({ summaryText: `STATE:\n${handle}` });
    const rendered: InputItem[] = [
      TASK,
      { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: `[tool output omitted: 900 tokens; stored as ${handle}; read it with ReadOutput]` },
    ];

    await compactThrough(ctx, { throughSeq: 3, input: rendered, summaryTokenCap: 240, pinnedText });

    expect(appended.at(-1)).toMatchObject({ type: 'context.compacted', source: 'model', fidelity: { fabricated: [] } });
  });

  it('replaces a summary that names a handle the model never saw', async () => {
    const { ctx, appended } = contextFor({ summaryText: `STATE:\n${'cd34'.repeat(16)}` });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText });

    expect(appended.at(-1)).toMatchObject({ type: 'context.compacted', source: 'deterministic', fidelity: { fabricated: ['cd34'.repeat(16)] } });
  });

  it('goes on when a recorded blob is unreadable, leaves the token it held unverifiable, and says so', async () => {
    const { ctx, appended } = contextFor({ summaryText: `STATE:\n\`src/only/in-blob.ts\``, history: withBlob });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText });

    expect(appended.at(-1)).toMatchObject({ type: 'context.compacted', source: 'deterministic', fidelity: { fabricated: ['src/only/in-blob.ts'] } });
    const notice = appended.find((payload) => payload.type === 'notice');
    expect(notice).toMatchObject({ level: 'warning', message: expect.stringContaining(BLOB) });
  });

  it('keeps a model summary whose tokens are all found in readable text, and still says the blob was unreadable', async () => {
    const { ctx, appended } = contextFor({ summaryText: 'STATE:\nnothing to name', history: withBlob });

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240, pinnedText });

    expect(appended.at(-1)).toMatchObject({ type: 'context.compacted', source: 'model' });
    expect(appended.some((payload) => payload.type === 'notice' && payload.message.includes(BLOB))).toBe(true);
  });

  it('asks again under the same key after the claim ended between the reply and the journal append, and the model writes no second summary', async () => {
    const { ctx, appended, requests, produced } = contextFor({ failAppendOnce: true });
    const plan = { throughSeq: 3, input, summaryTokenCap: 240, pinnedText };

    await expect(compactThrough(ctx, plan)).rejects.toThrow('the claim ended before the compaction was recorded');
    await compactThrough(ctx, plan);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.idempotencyKey).toBe(requests[0]?.idempotencyKey);
    expect(produced.size).toBe(1);
    expect(appended.filter((payload) => payload.type === 'context.compacted')).toEqual([expect.objectContaining({ summary: 'S1', source: 'model' })]);
  });
});
