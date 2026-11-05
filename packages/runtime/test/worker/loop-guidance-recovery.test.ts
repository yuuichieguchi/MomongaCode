import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import type { Claim, RuntimeStore } from '@momonga/store';
import { fixtureCompactionContent } from '@momonga/testkit';
import { LEASE_MS, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import type { ScriptStep } from './fake-gateway.ts';
import { assistantMessage, callsStep, textStep } from './scripts.ts';

type Item = { type: string; role?: string; content?: unknown };

const SAME = 'kx7same';

const echo = (callId: string, value: string) => callsStep([{ callId, name: 'Echo', args: { value } }]);

const inputOf = (body: unknown): Item[] => (body as { input: Item[] }).input;

const textOf = (item: Item | undefined): string => {
  if (item === undefined) return '';
  return typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
};

const isGuidance = (item: Item): boolean => item.type === 'message' && item.role === 'user' && textOf(item).includes('Echo') && textOf(item).includes(SAME);

const guided = (body: unknown): boolean => inputOf(body).some(isGuidance);

const guidedEnv = async (): Promise<Env> => {
  const env = await makeEnv();
  env.settings.contextValue = { ...env.settings.contextValue, loopGuidance: true };
  return env;
};

const recordingStore = (store: RuntimeStore, onAppend: (types: string[]) => 'write' | 'crash'): RuntimeStore => ({
  ...store,
  append: (claim: Claim, payloads: readonly RunEventPayload[]) => {
    if (payloads.length === 0) return store.append(claim, payloads);
    if (onAppend(payloads.map((payload) => payload.type)) === 'crash') return { kind: 'lease_lost' };
    return store.append(claim, payloads);
  },
});

describe('loop.warned is one fact with the calls of the same response (review H1)', () => {
  it('appends loop.warned in the same append as the tool.call events of the warned response', async () => {
    const env = await guidedEnv();
    const appends: string[][] = [];
    env.gateway.script.push(echo('c1', SAME), echo('c2', SAME), echo('c3', SAME), textStep('never sent'));
    const run = env.enqueue('Loop', { limits: { loopThreshold: 2 } });
    const recording = recordingStore(env.store, (types) => {
      appends.push(types);
      return 'write';
    });

    await env.runOnce(env.worker('w1', { store: recording }));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'loop' });
    const warnedAppends = appends.filter((types) => types.includes('loop.warned'));
    expect(warnedAppends).toHaveLength(1);
    expect(warnedAppends[0]).toContain('tool.call');
  });

  it('sends the guidance before any stop when the claim dies right after the warning is recorded', async () => {
    const env = await guidedEnv();
    let warnedSeen = false;
    let crashed = false;
    env.gateway.script.push(echo('c1', SAME), echo('c2', SAME), echo('c3', SAME), textStep('never sent'));
    const run = env.enqueue('Loop', { limits: { loopThreshold: 2 } });
    const crashing = recordingStore(env.store, (types) => {
      if (crashed) return 'write';
      if (types.includes('loop.warned')) warnedSeen = true;
      if (warnedSeen && types.includes('tool.call')) {
        crashed = true;
        return 'crash';
      }
      return 'write';
    });

    await env.runOnce(env.worker('w1', { store: crashing }));
    expect(crashed).toBe(true);
    env.clock.advance(LEASE_MS + 1);
    await env.runOnce(env.worker('w2'));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'loop' });
    expect(env.ofType(run.id, 'loop.warned')).toHaveLength(1);
    const guidedRequests = env.ofType(run.id, 'model.requested').filter((request) => guided(request.body));
    expect(guidedRequests).toHaveLength(1);
    expect(guidedRequests[0]?.step).toBe(3);
    const stops = env.ofType(run.id, 'notice').filter((notice) => notice.code === 'tool_loop_detected');
    expect(stops).toHaveLength(1);
    expect(guidedRequests[0]!.seq).toBeLessThan(stops[0]!.seq);
    expect(env.ofType(run.id, 'model.responded').some((response) => response.seq > guidedRequests[0]!.seq)).toBe(true);
  });
});

const SUMMARY_TEXT = 'We fixed the parser bug';
const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };

const invalidCompaction = (): GatewayRequestError =>
  new GatewayRequestError({ status: 400, type: 'invalid_request', code: 'invalid_compaction', message: 'the compaction item could not be verified' });

describe('the guidance stays pending until a response follows the warning (review H2)', () => {
  it('carries the guidance in the request rebuilt after compaction_rejected, and drops it once the model answered it', async () => {
    const env = await guidedEnv();
    const run = env.enqueue('question one', { limits: { loopThreshold: 2 } });
    env.seed(
      run.id,
      [
        { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [assistantMessage('msg_1', 'answer one')], usage: USAGE } },
        { type: 'user.message', text: 'question two' },
        { type: 'context.compacted', item: { type: 'compaction', id: 'cmp_seed', encrypted_content: fixtureCompactionContent(SUMMARY_TEXT) }, summary: SUMMARY_TEXT, replacedThroughSeq: 2 },
      ],
      'release',
    );
    const rejected: ScriptStep = { events: [], error: invalidCompaction() };
    env.gateway.script.push(echo('c1', SAME), echo('c2', SAME), rejected, echo('d1', 'w2other'), textStep('Done.'));

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [rejection, ...moreRejections] = env.ofType(run.id, 'context.compaction_rejected');
    expect(moreRejections).toEqual([]);
    const requests = env.ofType(run.id, 'model.requested');
    expect(requests).toHaveLength(5);
    const abandoned = requests[2]!;
    const rebuilt = requests[3]!;
    expect(abandoned.seq).toBeLessThan(rejection!.seq);
    expect(rebuilt.seq).toBeGreaterThan(rejection!.seq);
    expect(requests.map((request) => guided(request.body))).toEqual([false, false, true, true, false]);
    expect(isGuidance(inputOf(rebuilt.body).at(-1)!)).toBe(true);
    expect(inputOf(rebuilt.body).some((item) => item.type === 'compaction')).toBe(false);
  });
});
