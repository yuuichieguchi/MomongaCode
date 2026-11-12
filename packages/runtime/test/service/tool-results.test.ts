import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { TOOL_RESULT_PAGE_BYTES } from '@momonga/protocol';
import { expectError, expectSchema, startService } from './helpers.ts';

const asPayload = (value: Record<string, unknown>): RunEventPayload => value as unknown as RunEventPayload;

const callEvents = (callId: string, ended: Record<string, unknown>): RunEventPayload[] => [
  asPayload({ type: 'tool.call', callId, providerCallId: callId, name: 'Bash', kind: 'execute', sideEffect: 'exec', title: 'Bash', rawInput: { command: 'cat big' } }),
  asPayload({ type: 'tool.started', callId, idemKey: `key-${callId}`, basis: 'rule' }),
  asPayload({ type: 'tool.completed', callId, ...ended }),
];

const startedRun = async () => {
  const env = await startService();
  const session = await env.createSession();
  const run = await env.createRun(session.id);
  const claim = env.claimRun(run.id);
  env.append(claim, [asPayload({ type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'manual' })]);
  return { env, run, claim };
};

describe('GET /v1/runs/{id}/tool-results/{callId}', () => {
  it('answers a page of the stored output of a call whose output was kept whole in its event', async () => {
    const { env, run, claim } = await startedRun();
    env.append(claim, callEvents('call_1', { status: 'completed', output: 'first\nsecond\n' }));

    const response = await env.http('GET', `/v1/runs/${run.id}/tool-results/call_1?offset=0`);

    expect(response.status).toBe(200);
    expectSchema('ToolResultPage', response.json);
    expect(response.json).toEqual({ text: 'first\nsecond\n', offset: 0, next: null, totalBytes: 13 });
  });

  it('reads the full output from the stored blob when the event holds only the fitted cut', async () => {
    const { env, run, claim } = await startedRun();
    const full = `${'line of the full output\n'.repeat(Math.ceil((TOOL_RESULT_PAGE_BYTES * 2) / 24))}`;
    const { handle } = await env.store.blobs.put(full, { mediaType: 'text/plain', runId: run.id });
    env.append(claim, callEvents('call_2', { status: 'completed', output: 'cut', truncated: true, handle }));

    const pages: string[] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      const response = await env.http('GET', `/v1/runs/${run.id}/tool-results/call_2?offset=${offset}`);
      expect(response.status).toBe(200);
      expectSchema('ToolResultPage', response.json);
      expect(Buffer.byteLength(response.json.text)).toBeLessThanOrEqual(TOOL_RESULT_PAGE_BYTES);
      pages.push(response.json.text);
      offset = response.json.next;
    }

    expect(pages.join('')).toBe(full);
  });

  it('is 404 for a call that has no ended result in the run', async () => {
    const { env, run } = await startedRun();

    expectError(await env.http('GET', `/v1/runs/${run.id}/tool-results/missing?offset=0`), 404, 'not_found');
  });
});
