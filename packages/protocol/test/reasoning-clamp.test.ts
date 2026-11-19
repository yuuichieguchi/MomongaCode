import { describe, expect, it } from 'vitest';
import { acceptedReasoningEfforts, clampReasoningEffort, sentReasoningEffort, STANDARD_REASONING_EFFORT } from '@momonga/protocol';
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

  it('lifts a level below every accepted one to the lowest accepted level', () => {
    expect(clampReasoningEffort('minimal', ['low', 'medium', 'high'])).toBe('low');
  });

  it('lifts none to the lowest accepted ladder level when none is not accepted', () => {
    expect(clampReasoningEffort('none', ['low', 'medium', 'high'])).toBe('low');
  });

  it('never clamps a ladder level to none, which means thinking off', () => {
    expect(clampReasoningEffort('minimal', ['none', 'low', 'medium'])).toBe('low');
  });

  it('keeps none when the target accepts none', () => {
    expect(clampReasoningEffort('none', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])).toBe('none');
  });
});

describe('the levels each reasoning control accepts', () => {
  it('a reasoning_effort control accepts its lowest level and every level above it', () => {
    expect(acceptedReasoningEfforts({ control: 'reasoning_effort', lowest: 'low' })).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('a reasoning_effort control whose lowest level is none keeps accepting none', () => {
    expect(acceptedReasoningEfforts({ control: 'reasoning_effort', lowest: 'none' })).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  });

  it('a thinking form accepts none only when it declares how to turn thinking off', () => {
    expect(acceptedReasoningEfforts({ control: 'thinking', form: 'adaptive', efforts: ['low', 'high'], off: 'disabled' })).toEqual(['none', 'low', 'high']);
    expect(acceptedReasoningEfforts({ control: 'thinking', form: 'budget', budgets: { low: 2048 }, off: 'between_tools' })).toEqual(['none', 'low']);
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

describe('the effort a request carries for the chosen effort', () => {
  it('sends the standard level clamped to the model when no effort is chosen', () => {
    expect(sentReasoningEffort({ control: 'reasoning_effort', lowest: 'low' }, undefined)).toBe(STANDARD_REASONING_EFFORT);
    expect(sentReasoningEffort({ control: 'thinking', form: 'budget', budgets: { high: 8000 } }, undefined)).toBe('high');
    expect(sentReasoningEffort({ control: 'none' }, undefined)).toBeUndefined();
  });

  it('sends nothing to a model that declares no reasoning control or no ladder level', () => {
    expect(sentReasoningEffort(undefined, 'high')).toBeUndefined();
    expect(sentReasoningEffort({ control: 'none' }, 'high')).toBeUndefined();
    expect(sentReasoningEffort({ control: 'thinking', form: 'adaptive', efforts: [], off: 'disabled' }, 'high')).toBeUndefined();
  });

  it('sends the chosen effort clamped to the levels the model declares', () => {
    expect(sentReasoningEffort({ control: 'reasoning_effort', lowest: 'low' }, 'minimal')).toBe('low');
    expect(sentReasoningEffort({ control: 'thinking', form: 'adaptive', efforts: ['low', 'medium', 'high'] }, 'xhigh')).toBe('high');
    expect(sentReasoningEffort({ control: 'reasoning_effort', lowest: 'none' }, 'medium')).toBe('medium');
  });
});
