import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, textStep } from './scripts.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const WINDOW = 40_000;
const BLOB_BYTES = 50 * 1024 * 1024;
const SUMMARY = 'GOAL:\ng\nSTATE:\n`src/only/in-blob.ts`\nDONE:\nd\nTODO:\nt\nDECISIONS:\nx\nGUARDRAILS:\ny';

type FidelityRequest = { runId: string; throughEventSeq: number; cwd: string; tokens: { token: string; claim: string }[] };

const responded = (step: number, output: unknown[]): RunEventPayload => ({ type: 'model.responded', step, attempt: 1, response: { status: 'completed', output, usage: USAGE } });

const journal = (handle: string): RunEventPayload[] => [
  responded(1, [{ type: 'function_call', id: 'fc_c1', call_id: 'c1', name: 'Read', arguments: '{"file_path":"/proj/big.log"}' }]),
  { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Read', kind: 'other', title: 'Read', rawInput: { file_path: '/proj/big.log' } },
  { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'head [truncated]', handle },
  responded(2, [assistantMessage('m2', `long ${'x'.repeat(120_000)}`)]),
  { type: 'user.message', text: 'question two' },
  responded(3, [assistantMessage('m3', 'answer two')]),
  { type: 'user.message', text: 'question three' },
  responded(4, [assistantMessage('m4', 'answer three')]),
  { type: 'user.message', text: 'question four' },
];

const wrapped = (env: Env) => {
  const requests: FidelityRequest[] = [];
  const reads = { count: 0 };
  const store = {
    ...env.store,
    journalFacts: {
      ...env.store.journalFacts,
      fidelity: async (request: FidelityRequest) => {
        requests.push(structuredClone(request));
        return { lastSeq: request.throughEventSeq, attested: request.tokens.map((entry) => entry.token), unreadable: [], checkedThrough: request.throughEventSeq, verdicts: [] };
      },
    },
  } as unknown as RuntimeStore;
  const blobs = new Proxy(env.store.blobs, {
    get: (target, key, receiver) => {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (key !== 'read' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
      return (...args: unknown[]) => {
        reads.count += 1;
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store, blobs, requests, reads };
};

describe('the loop reads no blob and builds no region for the fidelity check', () => {
  it('asks the journal thread with the tokens only and reads the 50 MB blob zero times on the loop', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
    const run = await env.enqueue('question one');
    const { handle } = await env.store.blobs.put(`${'y'.repeat(BLOB_BYTES)} src/only/in-blob.ts`, { mediaType: 'text/plain', runId: run.id });
    await env.seed(run.id, journal(handle), 'release');
    env.gateway.compactSummaries.push(SUMMARY);
    env.gateway.script.push(textStep('Done.'));
    const { store, blobs, requests, reads } = wrapped(env);

    expect(await env.runOnce(env.worker('worker-1', { store, blobs } as never))).toBe('yielded');

    const compacted = env.ofType(run.id, 'context.compacted');
    expect(compacted).toHaveLength(1);
    expect(compacted[0]!.replacedThroughSeq).toBeGreaterThanOrEqual(3);
    expect(reads.count).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ runId: run.id, cwd: expect.any(String), throughEventSeq: expect.any(Number) });
    expect(requests[0]?.tokens).toEqual([{ token: 'src/only/in-blob.ts', claim: 'executed' }]);
    expect(JSON.stringify(requests[0]).length).toBeLessThan(SUMMARY.length + 1024);
    expect(env.ofType(run.id, 'context.compacted').at(-1)).toMatchObject({ source: 'model', fidelity: { fabricated: [] } });
  });
});
