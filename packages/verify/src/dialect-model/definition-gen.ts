import { defineProductSchema, type ProductValidator } from '@momonga/foundation';
import { BUILTINS, DEFINITION_SCHEMA, DESCENT, DESCENT_POSITIVE, KINDS, OPS, type Clause, type Definition, type Op, type Rule } from './definition.ts';
import type { Json } from './json.ts';
import type { Rng } from './prng.ts';

const validateDefinition: ProductValidator<Definition> = defineProductSchema('verify/dialect-definition', DEFINITION_SCHEMA);

export const isValidDefinition = (candidate: unknown): boolean => validateDefinition(candidate).valid;

export const DROP_KEYS = [
  '$schema', 'pattern', 'minLength', 'maxLength', 'format', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else',
  'items', 'prefixItems', 'contains', 'minContains', 'maxContains', 'properties', 'additionalProperties', 'patternProperties',
  'required', 'minimum', 'maximum', 'multipleOf', 'uniqueItems', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
  'dependentRequired', 'dependentSchemas', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems', 'type', 'title', '$ref',
  '$defs', 'definitions', 'default',
];

const REJECT_KEYS = ['$ref', 'oneOf', 'allOf', 'patternProperties', 'not', 'if', 'unevaluatedProperties', 'contains', 'pattern', 'dependentSchemas'];

const POSITIVE_OPS: readonly Op[] = ['drop', 'fill-type', 'require-all', 'empty-parameters', 'ensure-key'];

const genKinds = (rng: Rng): Clause['kinds'] => {
  const count = rng.chance(0.75) ? 1 : 2;
  return rng.shuffle(KINDS).slice(0, count);
};

const genClause = (rng: Rng, positive: boolean): Clause => {
  const clause: Clause = { kinds: genKinds(rng) };
  if (rng.chance(0.3)) {
    const pool = positive ? DESCENT_POSITIVE : DESCENT;
    clause.within = {
      below: rng.shuffle(pool).slice(0, rng.range(1, 2)),
      through: rng.shuffle(pool).slice(0, rng.range(1, 4)),
    };
  }
  return clause;
};

export const genSelect = (rng: Rng, op: Op): Clause[] => {
  const positive = POSITIVE_OPS.includes(op);
  if (op === 'empty-parameters' && rng.chance(0.7)) return [{ kinds: ['tool-parameters'] }];
  if (op === 'inline-refs' && rng.chance(0.5)) return rng.pick<Clause[]>([[{ kinds: ['root'] }], [{ kinds: ['tool-parameters'] }], [{ kinds: ['root'] }, { kinds: ['tool-parameters'] }]]);
  if (rng.chance(0.45)) return [{ kinds: ['any'] }];
  return Array.from({ length: rng.range(1, 2) }, () => genClause(rng, positive));
};

export const genRule = (rng: Rng, op: Op): Rule => {
  const select = genSelect(rng, op);
  switch (op) {
    case 'drop':
      return { select, op, keys: rng.shuffle(DROP_KEYS).slice(0, rng.range(1, 3)) };
    case 'reject':
      return { select, op, keys: rng.shuffle(REJECT_KEYS).slice(0, rng.range(1, 3)) };
    case 'fill-type':
      return { select, op, fallback: rng.pick(['string', 'number', 'integer', 'boolean', 'object', 'array'] as const) };
    case 'label':
      return { select, op, key: rng.pick(['title', 'x-label']) };
    case 'property-order':
      return { select, op, key: rng.pick(['x-order', 'propertyOrdering']) };
    case 'ensure-key': {
      const variant = rng.int(8);
      if (variant === 0) return { select, op, key: rng.pick(['x-note', 'x-order']), value: rng.pick<Json>([[], 'n', 1, { q: 1 }]) };
      if (variant === 1) return { select, op, key: 'required', value: [] };
      if (variant === 2) return { select, op, key: 'properties', value: {} };
      if (variant === 3) return { select, op, key: 'additionalProperties', value: true };
      if (variant === 4) return { select, op, key: 'additionalProperties', value: false };
      return { select, op, key: 'additionalProperties', value: false, overwrite: rng.pick(['never', 'non-boolean', 'always'] as const) };
    }
    case 'split-enum':
    case 'split-type-array':
    case 'const-as-enum':
    case 'declare-required':
    case 'inline-refs':
    case 'require-all':
    case 'empty-parameters':
      return { select, op };
  }
};

export const genDefinition = (rng: Rng): Definition => {
  const rules = Array.from({ length: rng.range(1, 4) }, () => genRule(rng, rng.pick(OPS)));
  const definition: Definition = rng.chance(0.2) ? { extends: rng.pick(Object.keys(BUILTINS)), rules } : { rules };
  if (!isValidDefinition(definition)) throw new Error(`generated an invalid definition: ${JSON.stringify(definition)}`);
  return definition;
};

export const singleRuleDefinition = (rng: Rng, op: Op): Definition => {
  const definition: Definition = { rules: [genRule(rng, op)] };
  if (!isValidDefinition(definition)) throw new Error(`generated an invalid rule: ${JSON.stringify(definition)}`);
  return definition;
};
