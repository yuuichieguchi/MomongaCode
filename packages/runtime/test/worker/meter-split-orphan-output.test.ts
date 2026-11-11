import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import type { CountTokensRequest, InputItem } from '@momonga/protocol';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';
import { bigStep, gatewayError, inputOf, withinTurnWorker } from './within-turn-support.ts';

const orphanOutputOf = (input: readonly InputItem[]): string | undefined => {
  const called = new Set<string>();
  for (const item of input) {
    if (item.type === 'function_call') called.add(item.call_id);
    if (item.type === 'function_call_output' && !called.has(item.call_id)) return item.call_id;
  }
  return undefined;
};

const isTailOf = (tail: readonly InputItem[], whole: readonly InputItem[]): boolean =>
  tail.length > 0 && tail.length < whole.length && canonicalJson(whole.slice(whole.length - tail.length)) === canonicalJson(tail);

describe('a count after an in-turn eviction on a target that renders outputs by their call', () => {
  it('completes the run instead of failing on a split suffix that starts with the evicted output', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(4000) });
    const rejected: Array<{ orphan: string; lenient: boolean; input: InputItem[] }> = [];
    env.gateway.countHook = async (request: CountTokensRequest) => {
      if (typeof request.input === 'string' || request.momonga?.lenient_items !== undefined) return;
      const orphan = orphanOutputOf(request.input);
      if (orphan === undefined) return;
      rejected.push({ orphan, lenient: false, input: [...request.input] });
      throw gatewayError(400, 'invalid_request', 'unknown_call_id');
    };
    env.gateway.script.push(...[...'abcdefgh'].map((letter, index) => bigStep(`k${index}`, { letter, size: 1800, pad: '' })), textStep('done'));
    const run = await env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    const requested = env.ofType(run.id, 'model.requested').map((event) => inputOf(event.body as { input?: unknown }));
    expect({
      status: env.run(run.id).status,
      rejected: rejected.map(({ orphan, lenient, input }) => ({
        orphan,
        lenient,
        requestsBefore: requested.length,
        tailOfAReportedRequest: requested.some((whole) => isTailOf(input, whole)),
        firstItemType: input[0]?.type,
      })),
    }).toEqual({ status: 'COMPLETED', rejected: [] });
  });
});
