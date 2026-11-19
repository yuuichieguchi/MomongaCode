import { describe, expect, it } from 'vitest';
import { PinnedBoundError, budgetFor, buildContext, createTokenMeter } from '@momonga/context';
import type { BuildContextPorts, HistoryItem, MeterCount, TokenMeter } from '@momonga/context';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import type { ErrorShape } from '@momonga/protocol';
import { MODEL, capabilitiesFor, fakeBlobs, fakeReader, inputFor, output, shapeCounter, sourcesWith } from './helpers.ts';

const W8192 = capabilitiesFor(8192, { maxOutputTokens: 1024, tokenCounting: 'estimated' });
const inputBudget = budgetFor(W8192, 0, 0).I;

const argsSteps = (chars: readonly number[]): HistoryItem[] =>
  chars.flatMap((size, index) => [
    { seq: 2 * index + 1, item: { type: 'function_call', id: `h${2 * index + 1}`, call_id: `c${index}`, name: 'Peek', arguments: `{"p":"${'x'.repeat(size)}"}` } },
    output(2 * index + 2, `c${index}`, 'ok'),
  ]);

const withBounds = (historyShape: ErrorShape, bounds: Pick<MeterCount, 'underAt' | 'freshUnderAt'>, partsToo = false): TokenMeter => {
  const inner = createTokenMeter({ counter: shapeCounter((request) => (Array.isArray(request.input) && request.input.length > 2 ? historyShape : ESTIMATED_ERROR_SHAPE)), model: MODEL, capabilities: W8192 });
  return {
    ...inner,
    count: async (request) => {
      const counted = await inner.count(request);
      return request.input.length > 2 || (partsToo && (request.frozen?.length ?? 0) > 2) ? { ...counted, ...bounds } : counted;
    },
  };
};

const portsWith = (meter: TokenMeter): BuildContextPorts => ({ meter, blobs: fakeBlobs(), instructions: fakeReader() });

describe('which bound each reader of the build takes', () => {
  it('fits the input by the bound of its own count, not by the fresh bound', async () => {
    const meter = withBounds({ ratio: 0.3, minimum: inputBudget + 1 }, { underAt: () => 0, freshUnderAt: () => inputBudget + 1 }, true);
    const built = await buildContext(inputFor(W8192, { sources: sourcesWith({ history: argsSteps([400, 400]) }), level: 0 }), portsWith(meter));
    expect(built.inputTokens).toBeGreaterThan(0);
  });

  it('sizes the forced deficit with the fresh bound and reports the bound of the count at zero', async () => {
    const meter = withBounds(ESTIMATED_ERROR_SHAPE, { underAt: () => inputBudget, freshUnderAt: () => inputBudget - 10 });
    const error = await buildContext(
      inputFor(W8192, { sources: sourcesWith({ history: argsSteps([400, 400, 400, 400, 400, 400]) }), level: 0 }),
      portsWith(meter),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PinnedBoundError);
    const failure = error as PinnedBoundError;
    expect(failure.maxInput).toBe(10);
    expect(failure.boundAtZero).toBe(inputBudget);
  });
});
