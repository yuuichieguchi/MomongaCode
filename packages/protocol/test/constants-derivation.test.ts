import { describe, expect, it } from 'vitest';
import * as reliability from '../src/reliability.ts';
import { COST_UNIT_DIGITS, MAX_TRACE_CONTENT_PAGE, RELIABILITY_DERIVATIONS, TRACE_CONTENT_PAGE_OPTION } from '../src/reliability.ts';
import { NANO_PER_USD, PRICE_UNITS_PER_NANO } from '../src/budget.ts';

const scalarConstants = Object.entries(reliability)
  .filter(([, value]) => typeof value === 'number' || typeof value === 'string')
  .map(([name]) => name)
  .sort();

const COMMAND_CHOICES = ['permissions review --sample needs --seed', 'trace --content --json'];

const MINIMUM_WORDS = 6;

describe('the derivations of the reliability constants', () => {
  it('has one entry for every exported constant that is a number or a text', () => {
    expect(scalarConstants.length).toBeGreaterThan(0);
    expect(scalarConstants.filter((name) => !(name in RELIABILITY_DERIVATIONS))).toEqual([]);
  });

  it('has the two command choices that had no written reason', () => {
    expect(COMMAND_CHOICES.filter((name) => !(name in RELIABILITY_DERIVATIONS))).toEqual([]);
  });

  it('has no entry for a name that is neither', () => {
    const known = new Set([...scalarConstants, ...COMMAND_CHOICES]);
    expect(Object.keys(RELIABILITY_DERIVATIONS).filter((name) => !known.has(name))).toEqual([]);
  });

  it('gives every entry a sentence, not a word', () => {
    const short = Object.entries<string>(RELIABILITY_DERIVATIONS).filter(([, text]) => text.trim().split(/\s+/).length < MINIMUM_WORDS);
    expect(short).toEqual([]);
  });

  it('COST_UNIT_DIGITS is the derived number: the decimal places of one US dollar in units of the price table', () => {
    expect(10n ** BigInt(COST_UNIT_DIGITS)).toBe(BigInt(NANO_PER_USD) * PRICE_UNITS_PER_NANO);
  });

  it('the page size of the trace content, which has no derivation, is an option whose default and bounds are stated', () => {
    expect(TRACE_CONTENT_PAGE_OPTION).toEqual({ flag: '--page-size', minimum: 1, maximum: MAX_TRACE_CONTENT_PAGE, default: MAX_TRACE_CONTENT_PAGE });
    expect(RELIABILITY_DERIVATIONS.MAX_TRACE_CONTENT_PAGE).toContain(TRACE_CONTENT_PAGE_OPTION.flag);
  });
});
