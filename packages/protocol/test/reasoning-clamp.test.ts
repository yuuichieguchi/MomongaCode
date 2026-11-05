import { describe, expect, it } from 'vitest';
import { acceptedReasoningEfforts, clampReasoningEffort } from '@momonga/protocol';
import type { ReasoningCapability } from '@momonga/protocol';

describe('one clamping rule for every reasoning control', () => {
  it('sends a level the target accepts unchanged', () => {
    expect(clampReasoningEffort('high', ['low', 'medium', 'high'])).toBe('high');
  });

  it('moves a level the target does not accept to the nearest accepted level below it', () => {
    expect(clampReasoningEffort('medium', ['low', 'high'])).toBe('low');
  });

  it('moves a level above the highest accepted one down to the highest', () => {
    expect(clampReasoningEffort('xhigh', ['low', 'medium', 'high'])).toBe('high');
  });

  it('does not depend on the order the accepted levels are declared in', () => {
    expect(clampReasoningEffort('medium', ['high', 'low'])).toBe('low');
  });
});

describe('the levels each reasoning control accepts', () => {
  it('a reasoning_effort control accepts its lowest level and every level above it', () => {
    expect(acceptedReasoningEfforts({ control: 'reasoning_effort', lowest: 'low' })).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('a target whose reasoning cannot be controlled accepts no level', () => {
    expect(acceptedReasoningEfforts({ control: 'none' })).toEqual([]);
  });

  it('an adaptive thinking form accepts the levels it declares, in effort order', () => {
    const adaptive: ReasoningCapability = { control: 'thinking', form: 'adaptive', efforts: ['high', 'low'] };
    expect(acceptedReasoningEfforts(adaptive)).toEqual(['low', 'high']);
  });

  it('a budget thinking form accepts the levels it declares a budget for, in effort order', () => {
    const budget: ReasoningCapability = { control: 'thinking', form: 'budget', budgets: { high: 8000, low: 2048 } };
    expect(acceptedReasoningEfforts(budget)).toEqual(['low', 'high']);
  });
});
