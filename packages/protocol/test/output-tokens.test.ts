import { describe, expect, it } from 'vitest';
import { outputTokensFor } from '@momonga/protocol';
import type { ReasoningCapability } from '@momonga/protocol';

const BUDGET: ReasoningCapability = { control: 'thinking', form: 'budget', budgets: { low: 16000, high: 30000 } };
const ADAPTIVE: ReasoningCapability = { control: 'thinking', form: 'adaptive', efforts: ['low', 'high'] };

const capabilities = (reasoning: ReasoningCapability | undefined, maxOutputTokens = 64000) => ({
  contextWindow: 200000,
  maxOutputTokens,
  ...(reasoning === undefined ? {} : { reasoning }),
});

describe('the output tokens a request may spend, visible plus reasoning', () => {
  it('adds the budget of the lifted lowest level to the visible cap of a budget-form request for none', () => {
    expect(outputTokensFor(capabilities(BUDGET), 'none', 8000)).toBe(24000);
  });

  it('adds the declared budget of the requested level', () => {
    expect(outputTokensFor(capabilities(BUDGET), 'high', 8000)).toBe(38000);
  });

  it('never exceeds the model output maximum', () => {
    expect(outputTokensFor(capabilities(BUDGET, 20000), 'high', 8000)).toBe(20000);
  });

  it('is the model output maximum when no visible cap is asked for', () => {
    expect(outputTokensFor(capabilities(BUDGET), 'low', undefined)).toBe(64000);
  });

  it('is the visible cap for the adaptive form, which takes no budget', () => {
    expect(outputTokensFor(capabilities(ADAPTIVE), 'high', 8000)).toBe(8000);
  });

  it('is the visible cap when the request asks for no effort', () => {
    expect(outputTokensFor(capabilities(BUDGET), undefined, 8000)).toBe(8000);
  });

  it('is the visible cap when the target declares no reasoning', () => {
    expect(outputTokensFor(capabilities(undefined), 'high', 8000)).toBe(8000);
  });

  it('adds the measured headroom of a target that cannot control reasoning when an effort is asked for', () => {
    expect(outputTokensFor(capabilities({ control: 'none', headroomTokens: 400 }), 'none', 64)).toBe(464);
  });

  it('adds measured headroom only up to the model output maximum', () => {
    expect(outputTokensFor(capabilities({ control: 'none', headroomTokens: 500 }, 300), 'none', 100)).toBe(300);
  });

  it.for([
    ['budget', BUDGET],
    ['headroom', { control: 'none', headroomTokens: 500 } as ReasoningCapability],
  ] as const)('never lowers a requested visible cap above the model output maximum (%s)', ([, reasoning]) => {
    expect(outputTokensFor(capabilities(reasoning, 20000), 'low', 25000)).toBe(25000);
  });
});
