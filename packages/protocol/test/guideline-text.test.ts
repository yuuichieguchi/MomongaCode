import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { GUIDELINE_TEXT_PATTERN, RUN_API_SCHEMAS, hasForbiddenGuidelineCharacter } from '@momonga/protocol';

const BIDIRECTIONAL_CONTROLS = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

const codePointCases = BIDIRECTIONAL_CONTROLS.map((codePoint) => [`U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`, String.fromCodePoint(codePoint)] as const);

describe('guideline text and bidirectional controls', () => {
  it.each(codePointCases)('refuses %s in the predicate', (_label, character) => {
    expect(hasForbiddenGuidelineCharacter(`keep${character}names`)).toBe(true);
  });

  it.each(codePointCases)('refuses %s in the pattern under strict Ajv', (_label, character) => {
    const ajv = new Ajv2020.default({ strict: true });
    const validate = ajv.compile({ type: 'string', minLength: 1, pattern: GUIDELINE_TEXT_PATTERN });
    expect(validate(`keep${character}names`)).toBe(false);
    expect(validate('keep names')).toBe(true);
  });

  it.each(codePointCases)('refuses %s in the AdoptGuidelineRequest schema', (_label, character) => {
    const ajv = new Ajv2020.default({ strict: true });
    const validate = ajv.compile(RUN_API_SCHEMAS.AdoptGuidelineRequest);
    expect(validate({ text: `keep${character}names`, parent: null, report: {} })).toBe(false);
    expect(validate({ text: 'keep names', parent: null, report: {} })).toBe(true);
  });

  it('keeps ordinary text, newline, tab and non-Latin letters', () => {
    expect(hasForbiddenGuidelineCharacter('keep\n\tnames あ مرحبا')).toBe(false);
  });
});
