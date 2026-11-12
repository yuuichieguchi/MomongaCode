import { describe, expect, it } from 'vitest';
import { WORDS, usdOfNano } from '@momonga/protocol';
import type { AdapterRequest } from '@momonga/protocol';
import { missingApiKeyError } from '../../src/core/errors.ts';
import { withoutImages } from '../../src/core/image-tokens.ts';
import { outputBoundWithinCostCeiling } from '../../src/core/quote.ts';
import { resolveToolChoice } from '../../src/core/tool-choice.ts';

const messageOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the call did not refuse');
};

describe('refusals from the gateway name the cause and the way forward', () => {
  it('a missing key variable says the daemon holds its start environment and how to start it again', () => {
    const message = missingApiKeyError('EXAMPLE_API_KEY').body.message;
    expect(message).toContain('EXAMPLE_API_KEY');
    expect(message).toContain('daemon');
    expect(message).toContain(`${WORDS.command} daemon stop`);
    expect(message).not.toContain('gateway process');
  });

  it('the cost ceiling refusal shows money in USD', () => {
    const message = messageOf(() =>
      outputBoundWithinCostCeiling(
        { ceilingNano: 1_500_000, inputBound: 1000, visible: 100, effort: undefined, smallestAnswer: 1 },
        { billing: 'metered', provider: 'example', model: 'unpriced-model', display: 'example/unpriced-model' } as never,
        { maxOutputTokens: 1000, outputBoundField: 'max_output_tokens' } as never,
        undefined,
        0,
      ),
    );
    expect(message).toContain(`${usdOfNano(1_500_000)} USD`);
    expect(message).not.toContain('nano-USD');
  });

  it('the tool choice and image refusals use the product vocabulary', () => {
    const request: AdapterRequest = {
      model: 'm',
      input: [],
      tools: [
        { type: 'function', name: 'a' },
        { type: 'function', name: 'b' },
      ],
      tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'a' }] } as never,
    };
    const choice = messageOf(() => resolveToolChoice(request, undefined, 'example/model', { forms: [], expressesRequired: true }));
    expect(choice).not.toMatch(/\btargets?\b/);
    const image = messageOf(() => withoutImages({ type: 'input_image', image_url: 'data:image/png;base64,AA==' }, undefined));
    expect(image).not.toMatch(/\btargets?\b/);
  });
});
