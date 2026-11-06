import Ajv2020 from 'ajv/dist/2020.js';
import { validateUntrusted } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import type { CrossCheck } from '../src/dialect-model/harness.ts';
import type { Json, Schema } from '../src/dialect-model/json.ts';
import { isObject } from '../src/dialect-model/json.ts';
import { runSubject, SUBJECTS } from '../src/dialect-model/subjects.ts';

const SCHEMAS_PER_SUBJECT = Number(process.env['DIALECT_MODEL_SCHEMAS'] ?? '300');
const GATE_TIMEOUT_MS = 60 * 60 * 1000;
const RECYCLE_EVERY = 2500;

const SINGLE = ['items', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema'];
const LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const MAPS = ['properties', 'patternProperties', 'dependentSchemas', '$defs'];
const EVALUATING_PROPERTIES_AND_ITEMS = ['properties', 'patternProperties', 'additionalProperties', 'unevaluatedProperties', 'items', 'prefixItems', 'contains', 'unevaluatedItems'];
const EVALUATING_ITEMS = ['prefixItems', 'items', 'contains', 'unevaluatedItems'];

type Node = Record<string, Json>;

const nodesOf = (schema: Json | undefined): Node[] => {
  if (!isObject(schema)) return [];
  const children: Json[] = [];
  for (const key of SINGLE) if (key in schema) children.push(schema[key] as Json);
  for (const key of LISTS) if (Array.isArray(schema[key])) children.push(...(schema[key] as Json[]));
  for (const key of MAPS) if (isObject(schema[key])) children.push(...Object.values(schema[key] as Record<string, Json>));
  return [schema, ...children.flatMap(nodesOf)];
};

const arraysOf = (instance: Json): Json[][] => {
  if (Array.isArray(instance)) return [instance, ...instance.flatMap(arraysOf)];
  if (isObject(instance)) return Object.values(instance).flatMap(arraysOf);
  return [];
};

const hasAny = (nodes: readonly Node[], keywords: readonly string[]): boolean => nodes.some((node) => keywords.some((keyword) => keyword in node));

type AjvDefect = {
  readonly name: string;
  readonly ajvSource: string;
  readonly specification: string;
  readonly matches: (schema: Schema, instance: Json) => boolean;
  readonly witness: { readonly schema: Json; readonly instance: Json };
};

const AJV_DEFECTS: readonly AjvDefect[] = [
  {
    name: 'A: prefixItems validity gates contains on a short array',
    ajvSource: 'ajv 8 dist/vocabularies/applicator/items.js:28-38 (validateTuple)',
    specification: 'Draft 2020-12 Validation section 10.3.1.3 (contains) and 10.3.1.1 (prefixItems): contains is evaluated on its own; an array with no matching item fails it',
    matches: (schema, instance) => {
      const arrays = arraysOf(instance);
      return nodesOf(schema).some((node) => Array.isArray(node['prefixItems']) && 'contains' in node && arrays.some((array) => array.length < (node['prefixItems'] as Json[]).length));
    },
    witness: { schema: { prefixItems: [{ properties: {} }], contains: {} }, instance: [] },
  },
  {
    name: 'B: annotations of a failed if are merged',
    ajvSource: 'ajv 8 dist/vocabularies/applicator/if.js:46 and unevaluated/unevaluatedProperties.js:30',
    specification: 'Draft 2020-12 Core section 7.7.1.1 and Validation section 11: annotations of a subschema that fails validation are dropped',
    matches: (schema) => {
      const nodes = nodesOf(schema);
      return (
        nodes.some((node) => 'if' in node && hasAny(nodesOf(node['if']), EVALUATING_PROPERTIES_AND_ITEMS)) && hasAny(nodes, ['unevaluatedProperties', 'unevaluatedItems'])
      );
    },
    witness: { schema: { unevaluatedProperties: { enum: [] }, if: { unevaluatedProperties: false }, then: { type: 'number' } }, instance: { c: 0.5 } },
  },
  {
    name: 'C: contains marks every item evaluated',
    ajvSource: 'ajv 8 dist/vocabularies/applicator/contains.js:48 (it.items = true)',
    specification: 'Draft 2020-12 Validation section 10.3.1.3: contains annotates only the indexes that matched',
    matches: (schema, instance) => {
      const nodes = nodesOf(schema);
      return nodes.some((node) => 'contains' in node) && hasAny(nodes, ['unevaluatedItems']) && arraysOf(instance).some((array) => array.length > 0);
    },
    witness: { schema: { contains: { type: 'object' }, unevaluatedItems: { enum: [] } }, instance: [0, {}] },
  },
  {
    name: "D: a failed oneOf branch's evaluated items are kept",
    ajvSource: 'ajv 8 dist/vocabularies/applicator/oneOf.js:53 (mergeEvaluated)',
    specification: 'Draft 2020-12 Core section 7.7.1.1 and Validation section 10.2.1.3: annotations of a failing branch are dropped',
    matches: (schema, instance) => {
      const nodes = nodesOf(schema);
      return (
        nodes.some((node) => Array.isArray(node['oneOf']) && (node['oneOf'] as Json[]).some((branch) => hasAny(nodesOf(branch), EVALUATING_ITEMS))) &&
        hasAny(nodes, ['unevaluatedItems']) &&
        arraysOf(instance).some((array) => array.length > 0)
      );
    },
    witness: { schema: { unevaluatedItems: false, oneOf: [{ prefixItems: [{ type: 'boolean' }] }, {}] }, instance: [{}] },
  },
];

const newAjv = () => new Ajv2020.default({ strict: false, validateFormats: false });

class AjvCrossCheck implements CrossCheck {
  private ajv = newAjv();
  private compiled = 0;

  compile(schema: Json | undefined): ((value: Json) => boolean | null) | null {
    this.compiled += 1;
    if (this.compiled % RECYCLE_EVERY === 0) this.ajv = newAjv();
    try {
      const validate = this.ajv.compile((schema === undefined ? true : schema) as never);
      return (value) => {
        try {
          return validate(value) === true;
        } catch {
          return null;
        }
      };
    } catch {
      return null;
    }
  }

  explain(schema: Schema, instance: Json): string | undefined {
    return AJV_DEFECTS.find((defect) => defect.matches(schema, instance))?.name;
  }
}

describe('dialect model: the four documented Ajv defects are still Ajv defects', () => {
  it.each(AJV_DEFECTS.map((defect) => [defect.name, defect] as const))('%s', (_name, defect) => {
    const { schema, instance } = defect.witness;
    expect(validateUntrusted('ajv-defect-witness', schema as Record<string, unknown>, instance).valid).toBe(false);
    expect(newAjv().compile(schema as never)(instance)).toBe(true);
    expect(defect.matches(schema, instance)).toBe(true);
  });
});

describe('dialect model: the reference model agrees with Ajv, an engine the product does not use', () => {
  const crossCheck = new AjvCrossCheck();
  it.each(SUBJECTS.map((spec) => [spec.name, spec] as const))(
    '%s has no disagreement outside the four documented Ajv defects and no crash',
    (name, spec) => {
      const report = runSubject(spec, SCHEMAS_PER_SUBJECT, 20261105, () => undefined, undefined, crossCheck);
      const counts = { disagreements: report.stats.crossCheckDisagreements, crashes: report.stats.crossCheckCrashes };
      process.stdout.write(`ajvCrossCheck ${name} ${JSON.stringify({ ...counts, explained: report.stats.crossCheckExplained })}\n`);
      expect({ ...counts, samples: report.stats.crossCheckSamples }).toEqual({ disagreements: 0, crashes: 0, samples: [] });
      expect(Object.keys(report.stats.crossCheckExplained).filter((explained) => !AJV_DEFECTS.some((defect) => defect.name === explained))).toEqual([]);
    },
    GATE_TIMEOUT_MS,
  );
});
