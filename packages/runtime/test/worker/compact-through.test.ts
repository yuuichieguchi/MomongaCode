import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { CompactRequest, InputItem, RunEventPayload, RunState } from '@momonga/protocol';
import { initialRunState } from '@momonga/store';
import { fixtureCompactionContent } from '@momonga/testkit';
import type { ClaimContext } from '../../src/worker/claim-context.ts';
import { compactThrough } from '../../src/worker/context-step.ts';

const TASK: InputItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do the work.' }] };

const contextFor = () => {
  const appended: RunEventPayload[] = [];
  const requests: { request: CompactRequest; idempotencyKey: string }[] = [];
  const ctx = {
    options: {
      gateway: {
        compact: async (request: CompactRequest, options: { idempotencyKey: string }) => {
          requests.push({ request: structuredClone(request), idempotencyKey: options.idempotencyKey });
          return {
            id: 'compaction_1',
            object: 'response.compaction',
            output: [{ type: 'compaction', id: 'cmp_1', encrypted_content: fixtureCompactionContent('S') }],
            created_at: 1,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          };
        },
      },
    },
    run: { id: 'run_compact', deadlineAt: 2_000_000_000_000 },
    alias: 'fm',
    systemPrompt: 'You are the compact-through test agent.',
    journal: {
      state: { ...initialRunState({ runId: 'run_compact', sessionId: 'session_compact' }), taskSeq: 1 } as RunState,
      append: (payloads: readonly RunEventPayload[]) => {
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
  return { ctx, appended, requests };
};

const keyOf = (request: CompactRequest): string => sha256Hex(canonicalJson(['run_compact', 'compact', sha256Hex(canonicalJson(request))]));

describe('compactThrough', () => {
  const input: InputItem[] = [TASK, { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'ok' }];

  it('sends the rendered input verbatim with the cap and retains_user_request, no instructions, under the whole-body key', async () => {
    const { ctx, appended, requests } = contextFor();

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240 });

    expect(requests).toHaveLength(1);
    const [sent] = requests;
    expect(sent?.request).toEqual({ model: 'fm', input, momonga: { max_summary_tokens: 240, retains_user_request: true } });
    expect('instructions' in (sent?.request ?? {})).toBe(false);
    expect(sent?.idempotencyKey).toBe(keyOf(sent?.request as CompactRequest));
    expect(appended).toEqual([expect.objectContaining({ type: 'context.compacted', replacedThroughSeq: 3, summary: 'S' })]);
  });

  it('derives a new key when only the cap differs', async () => {
    const { ctx, requests } = contextFor();

    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 240 });
    await compactThrough(ctx, { throughSeq: 3, input, summaryTokenCap: 241 });

    expect(requests.map((entry) => entry.request.momonga?.max_summary_tokens)).toEqual([240, 241]);
    expect(requests[0]?.idempotencyKey).not.toBe(requests[1]?.idempotencyKey);
    expect(requests[1]?.idempotencyKey).toBe(keyOf(requests[1]?.request as CompactRequest));
  });
});
