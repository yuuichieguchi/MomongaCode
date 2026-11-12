import { describe, expect, it } from 'vitest';
import type { DialectRule } from '@momonga/protocol';
import { isNarrowing } from '../../src/dialect/candidates.ts';
import { renderSchema } from '../../src/dialect/render.ts';
import { toolSite, userRules } from '../dialect-support.ts';

const TOOL = 'edit';

type Case = { rule: DialectRule; parameters: unknown; path: string };

const CASES: readonly Case[] = [
  { rule: { select: [{ kinds: ['untyped'] }], op: 'fill-type', fallback: 'string' }, parameters: { type: 'object', properties: { a: {} } }, path: '/properties/a' },
  { rule: { select: [{ kinds: ['object-with-properties'] }], op: 'require-all' }, parameters: { type: 'object', properties: { a: { type: ['string', 'null'] } } }, path: '' },
  {
    rule: { select: [{ kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'additionalProperties', value: false },
    parameters: { type: 'object', properties: { a: { type: 'object' } } },
    path: '/properties/a',
  },
  {
    rule: { select: [{ kinds: ['object-with-properties'] }], op: 'ensure-key', key: 'additionalProperties', value: false, overwrite: 'always' },
    parameters: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
    path: '',
  },
  {
    rule: { select: [{ kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'properties', value: {} },
    parameters: { type: 'object', properties: { a: { type: 'object' } } },
    path: '/properties/a',
  },
];

describe('every narrowing operation records a schema narrowing from the one list', () => {
  for (const { rule, parameters, path } of CASES) {
    it(`${rule.op}${rule.op === 'ensure-key' ? ` ${rule.key}` : ''} narrows and is recorded at "${path}"`, () => {
      expect(isNarrowing(rule)).toBe(true);
      const rendered = renderSchema(parameters, toolSite(TOOL), userRules([rule]));
      expect(rendered.narrowings).toContainEqual({ tool: TOOL, path });
    });
  }

  it('an operation outside the list records nothing', () => {
    const rule: DialectRule = { select: [{ kinds: ['any'] }], op: 'drop', keys: ['maxLength'] };
    expect(isNarrowing(rule)).toBe(false);
    expect(renderSchema({ type: 'object', properties: { a: { type: 'string', maxLength: 3 } } }, toolSite(TOOL), userRules([rule])).narrowings).toEqual([]);
  });

  it('require-all records nothing for a property whose wrapper keeps its absence readable', () => {
    const rules = userRules([
      { select: [{ kinds: ['tool-parameters'] }], op: 'nullable-optional' },
      { select: [{ kinds: ['object-with-properties'] }], op: 'require-all' },
    ]);
    expect(renderSchema({ type: 'object', properties: { a: { type: 'string' } } }, toolSite(TOOL), rules).narrowings).toEqual([]);
  });
});
