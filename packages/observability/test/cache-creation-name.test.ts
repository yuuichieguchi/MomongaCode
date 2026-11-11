import { describe, expect, it } from 'vitest';
import { billedUsageOf } from '@momonga/observability';
import type { SpanRecord } from '@momonga/observability';
import { MOMONGA_ATTRIBUTES, SPAN_ATTRIBUTE_RENAMES } from '@momonga/protocol';
import { harness } from './helpers.ts';
import { recordCalls } from './cache-read-fixtures.ts';

const STANDARD_NAME = 'gen_ai.usage.cache_creation.input_tokens';
const OLD_NAME = 'momonga.usage.cache_write_input_tokens';

const chatSpanOf = async (): Promise<SpanRecord> => {
  const h = harness();
  await recordCalls(h, 'run-a', [{ input: 300, cached: 120, cacheWrite: 30 }]);
  const span = h.store.spansForRun('run-a').find((candidate) => candidate.attributes['gen_ai.operation.name'] === 'chat');
  if (span === undefined) throw new Error('the fixture recorded no chat span');
  return span;
};

const storedWithOldName = (span: SpanRecord): SpanRecord => {
  const { [STANDARD_NAME]: written, ...rest } = span.attributes;
  if (written === undefined) throw new Error('the span carries no cache creation count under the standard name');
  return { ...span, attributes: { ...rest, [OLD_NAME]: written } };
};

describe('the cache write count of a chat span has the name the standard defines', () => {
  it('writes the standard name and no name of its own', async () => {
    const span = await chatSpanOf();

    expect(span.attributes[STANDARD_NAME]).toBe(30);
    expect(span.attributes).not.toHaveProperty(OLD_NAME);
  });

  it('keeps the old name only in the rename table of the span attributes', () => {
    expect(SPAN_ATTRIBUTE_RENAMES).toEqual({ [OLD_NAME]: STANDARD_NAME });
    expect(Object.values(MOMONGA_ATTRIBUTES)).not.toContain(OLD_NAME);
  });

  it('reads the same billed figure from a span stored with the old name', async () => {
    const span = await chatSpanOf();

    expect(billedUsageOf(storedWithOldName(span))).toEqual(billedUsageOf(span));
    expect(billedUsageOf(storedWithOldName(span)).cacheWriteInputTokens).toBe(30);
  });
});
