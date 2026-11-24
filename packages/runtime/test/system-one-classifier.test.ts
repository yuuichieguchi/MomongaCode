import { describe, expect, it } from 'vitest';
import { budgetFor } from '@momonga/context';
import { MIN_OUTPUT_RESERVE, outputReserveFor } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import { gatewayListingOf } from '../src/gateway-client.ts';

describe('choice-only classifier budget math (J28-B)', () => {
  const choiceCapabilities: Capabilities = {
    outputKind: 'choice',
    contextWindow: 262_144,
    maxOutputTokens: MIN_OUTPUT_RESERVE,
    toolCalling: 'none',
    structuredOutput: 'json_schema',
    streaming: false,
    stopSequences: false,
    outputBoundField: 'none',
    schemaDialect: 'openai-strict',
    tokenCounting: 'estimated',
    usageReported: true,
    imageInput: false,
    maxConcurrency: 4,
    source: 'config',
  };

  it('reserves 256 output tokens and allows up to 197,419 estimated input tokens for 262,144 window', () => {
    expect(outputReserveFor(choiceCapabilities)).toBe(256);
    const maxInput = 197_419;
    const errMax = Math.ceil((maxInput * 3) / 10);
    expect(maxInput).toBeLessThanOrEqual(budgetFor(choiceCapabilities, errMax, 0).I);
    const overInput = 197_420;
    const errOver = Math.ceil((overInput * 3) / 10);
    expect(overInput).toBeGreaterThan(budgetFor(choiceCapabilities, errOver, 0).I);
  });

  it('preserves outputKind on listing.views parsed by gatewayListingOf', () => {
    const listing = gatewayListingOf({
      object: 'list',
      start: null,
      roles: {},
      data: [
        {
          id: 'openrouter/typesafe/jev-1.14',
          object: 'model',
          provider: 'openrouter',
          ownName: 'typesafe/jev-1.14',
          naming: 'account',
          outputKind: 'choice',
          billing: 'metered',
          capabilities: choiceCapabilities,
          state: 'available',
          chain: [
            {
              model: 'openrouter/typesafe/jev-1.14',
              counter: 'c'.repeat(64),
              billing: 'metered',
              provider: 'openrouter',
              adapter: 'system-one',
              answers: 'model',
              upstream: 'typesafe/jev-1.14',
              capabilities: choiceCapabilities,
            },
          ],
        },
      ],
    });
    expect(listing.views[0]?.outputKind).toBe('choice');
  });
});
