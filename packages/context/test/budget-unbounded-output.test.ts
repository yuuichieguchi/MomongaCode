import { describe, expect, it } from 'vitest';
import { budgetFor } from '@momonga/context';
import type { ChainCapabilities, Capabilities } from '@momonga/protocol';

const WINDOW_8K: Capabilities = {
  contextWindow: 8192,
  maxOutputTokens: 4096,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'exact',
  usageReported: true,
  maxConcurrency: 1,
  source: 'declared',
};

describe('the context budget reserves the whole output a route may emit when it carries no bound (P2 item 6, I-K5)', () => {
  it('reserves maxOutputTokens for a target whose outputBoundField is none (R 4096, I 3932), and the reserve share for a bounded one (R 2048, I 5980)', () => {
    expect(budgetFor({ ...WINDOW_8K, outputBoundField: 'max_output_tokens' }, 0)).toEqual({ W: 8192, R: 2048, margin: 164, I: 5980 });
    expect(budgetFor({ ...WINDOW_8K, outputBoundField: 'none' }, 0)).toEqual({ W: 8192, R: 4096, margin: 164, I: 3932 });
  });

  it('reserves the unboundedOutputTokens of a model whose merged bound is none, keeping the minimum window: R 6000, I 2028', () => {
    const model: ChainCapabilities = { ...WINDOW_8K, outputBoundField: 'none', unboundedOutputTokens: 6000 };
    expect(budgetFor(model as Capabilities, 0)).toEqual({ W: 8192, R: 6000, margin: 164, I: 2028 });
  });
});
