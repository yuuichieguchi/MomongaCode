import type { DialectRule, DialectSelect, ProbeKeyword } from '@momonga/protocol';

export type KeywordSupport = Record<ProbeKeyword, boolean>;

export const FULL_KEYWORD_SUPPORT: KeywordSupport = {
  enum: true,
  anyOf: true,
  const: true,
  pattern: true,
  minimum: true,
  nested: true,
  additionalProperties: true,
};

const NESTED_OBJECTS: DialectSelect = [
  {
    kinds: ['object-with-properties'],
    within: {
      below: ['properties', 'items', 'anyOf', 'allOf', 'additionalProperties'],
      through: ['properties', 'items', 'anyOf', 'allOf', 'additionalProperties'],
    },
  },
];

export const keywordRules = (support: KeywordSupport): DialectRule[] => {
  const rules: DialectRule[] = [];
  if (!support.enum) {
    rules.push({ select: [{ kinds: ['enum'] }], op: 'fill-type', fallback: 'string' }, { select: [{ kinds: ['any'] }], op: 'drop', keys: ['enum'] });
  }
  if (!support.const) {
    rules.push({ select: [{ kinds: ['const'] }], op: 'fill-type', fallback: 'string' }, { select: [{ kinds: ['any'] }], op: 'drop', keys: ['const'] });
  }
  const dropped = (['pattern', 'minimum', 'additionalProperties', 'anyOf'] as const).filter((keyword) => !support[keyword]);
  if (dropped.length > 0) rules.push({ select: [{ kinds: ['any'] }], op: 'drop', keys: dropped });
  if (!support.nested) rules.push({ select: NESTED_OBJECTS, op: 'drop', keys: ['properties', 'patternProperties', 'required'] });
  return rules;
};
