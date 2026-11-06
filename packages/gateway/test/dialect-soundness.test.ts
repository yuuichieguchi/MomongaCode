import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { BUILTIN_DIALECTS, DIALECT_DEFINITION_SCHEMA } from '@momonga/protocol';
import type { DialectDefinition } from '@momonga/protocol';
import { SchemaRenderError, renderSchema } from '../src/dialect/render.ts';
import type { ResolvedDialect } from '../src/dialect/render.ts';
import { invertReply } from '../src/dialect/unwrap.ts';
import {
  RESPONSE_FORMAT,
  STATED_REASONS,
  instancesOf,
  mutationsOf,
  nodeAt,
  pad,
  responseFormatOf,
  seeded,
  strictToolParametersOf,
  toolParametersOf,
  toolSite,
  validatorOf,
  withNulls,
} from './dialect-support.ts';
import type { Rng } from './dialect-support.ts';

const CASES = Number(process.env['MOMONGA_DIALECT_GATE_CASES'] ?? 400);
const PROPERTY_TIMEOUT_MS = 600_000;
const TOOL = 'gen';

type Klass = 'P' | 'N' | 'W' | 'R';

const ANY = [{ kinds: ['any'] }];
const OBJECTS = [{ kinds: ['object-with-properties'] }, { kinds: ['object-without-properties'] }];

const PRIMITIVES: { name: string; klass: Klass; rule: Record<string, unknown> }[] = [
  { name: 'split-enum', klass: 'P', rule: { select: ANY, op: 'split-enum' } },
  { name: 'split-type-array', klass: 'P', rule: { select: ANY, op: 'split-type-array' } },
  { name: 'const-as-enum', klass: 'P', rule: { select: ANY, op: 'const-as-enum' } },
  { name: 'declare-required', klass: 'P', rule: { select: ANY, op: 'declare-required' } },
  { name: 'inline-refs', klass: 'P', rule: { select: [{ kinds: ['root'] }, { kinds: ['tool-parameters'] }], op: 'inline-refs' } },
  { name: 'label', klass: 'P', rule: { select: ANY, op: 'label', key: 'title' } },
  { name: 'property-order', klass: 'P', rule: { select: ANY, op: 'property-order', key: 'x-order' } },
  { name: 'ensure-key annotation', klass: 'P', rule: { select: ANY, op: 'ensure-key', key: 'x-mark', value: 1 } },
  { name: 'ensure-key required []', klass: 'P', rule: { select: OBJECTS, op: 'ensure-key', key: 'required', value: [] } },
  { name: 'ensure-key properties {}', klass: 'P', rule: { select: OBJECTS, op: 'ensure-key', key: 'properties', value: {} } },
  { name: 'ensure-key additionalProperties true', klass: 'P', rule: { select: OBJECTS, op: 'ensure-key', key: 'additionalProperties', value: true } },
  { name: 'fill-type', klass: 'N', rule: { select: [{ kinds: ['untyped'] }, { kinds: ['const'] }], op: 'fill-type', fallback: 'string' } },
  { name: 'require-all', klass: 'N', rule: { select: OBJECTS, op: 'require-all' } },
  { name: 'empty-parameters', klass: 'N', rule: { select: [{ kinds: ['tool-parameters'] }], op: 'empty-parameters' } },
  { name: 'ensure-key additionalProperties false', klass: 'N', rule: { select: OBJECTS, op: 'ensure-key', key: 'additionalProperties', value: false, overwrite: 'non-boolean' } },
];

const withoutDropAndWrap = (definition: DialectDefinition): DialectDefinition => ({
  rules: definition.rules.filter((rule) => rule.op !== 'drop' && rule.op !== 'nullable-optional'),
});

const resolvedOf = (id: string, rules: readonly unknown[]): ResolvedDialect => ({ id, definition: { rules } as DialectDefinition });

type Outcome = { kind: 'rendered'; schema: unknown; wraps: readonly { tool: string; wrapped: unknown[] }[] } | { kind: 'failed'; reason: string; path: string };

const render = (schema: unknown, site: Parameters<typeof renderSchema>[1], resolved: ResolvedDialect): Outcome => {
  try {
    const rendered = renderSchema(schema, site, resolved);
    return { kind: 'rendered', schema: rendered.schema, wraps: rendered.wraps };
  } catch (error) {
    if (error instanceof SchemaRenderError) return { kind: 'failed', reason: error.reason, path: error.path };
    throw error;
  }
};

const pool = (rng: Rng, original: unknown, rendered: unknown): unknown[] => {
  const base = [...instancesOf(rng, rendered, 6), ...instancesOf(rng, original, 6)];
  return [...base, ...base.flatMap((instance) => mutationsOf(rng, instance))];
};

const siteFor = (rng: Rng): { site: Parameters<typeof renderSchema>[1]; schema: unknown } =>
  rng.chance(0.5) ? { site: toolSite(TOOL), schema: toolParametersOf(rng) } : { site: RESPONSE_FORMAT, schema: responseFormatOf(rng) };

type Tally = { rendered: number; failed: number; uncompiled: number };

const checkUnsatisfiable = (rng: Rng, original: unknown, path: string): void => {
  const node = nodeAt(original, path);
  const root = typeof original === 'object' && original !== null && !Array.isArray(original) ? (original as Record<string, unknown>) : {};
  const attached = typeof node === 'object' && node !== null && !Array.isArray(node) ? { ...node, $defs: root['$defs'] } : node;
  const validate = validatorOf(attached);
  if (validate === undefined) return;
  for (const instance of [...instancesOf(rng, node, 20), null, 0, 1, 'a', true, {}, []]) expect(validate(instance)).toBe(false);
};

const checkClass = (rng: Rng, klass: Klass, schema: unknown, site: Parameters<typeof renderSchema>[1], resolved: ResolvedDialect, tally: Tally): void => {
  const copy = structuredClone(schema);
  const outcome = render(schema, site, resolved);
  expect(schema).toEqual(copy);
  if (outcome.kind === 'failed') {
    expect(STATED_REASONS).toContain(outcome.reason);
    if (outcome.reason === 'unsatisfiable') checkUnsatisfiable(rng, schema, outcome.path);
    tally.failed += 1;
    return;
  }
  const again = render(schema, site, resolved);
  expect(again).toEqual(outcome);
  const originalSchema = schema === undefined || schema === null ? true : schema;
  const validOriginal = validatorOf(originalSchema);
  const validRendered = validatorOf(outcome.schema);
  if (validOriginal === undefined || validRendered === undefined) {
    tally.uncompiled += 1;
    return;
  }
  tally.rendered += 1;
  for (const instance of pool(rng, originalSchema, outcome.schema)) {
    const inRendered = validRendered(instance);
    const inOriginal = validOriginal(instance);
    if (klass === 'N' || klass === 'P') {
      if (inRendered) expect({ instance, original: schema, rendered: outcome.schema, inOriginal }).toMatchObject({ inOriginal: true });
    }
    if (klass === 'P' || klass === 'W') {
      if (inOriginal) expect({ instance, original: schema, rendered: outcome.schema, inRendered }).toMatchObject({ inRendered: true });
    }
  }
};

describe('soundness of classes N and P (drop disabled)', () => {
  it.each(PRIMITIVES)('$name alone keeps its class $klass', ({ name, klass, rule }) => {
    const rng = seeded(0x5eed + name.length * 7919);
    const tally: Tally = { rendered: 0, failed: 0, uncompiled: 0 };
    for (let index = 0; index < CASES; index += 1) {
      const { site, schema } = siteFor(rng);
      checkClass(rng, klass, schema, site, resolvedOf(`only-${name.replaceAll(' ', '-')}`, [rule]), tally);
    }
    expect(tally.rendered).toBeGreaterThan(CASES / 4);
  }, PROPERTY_TIMEOUT_MS);

  it.each(Object.keys(BUILTIN_DIALECTS))('the built-in %s without drop and nullable-optional narrows or preserves', (id) => {
    const rng = seeded(0xb11 + id.length);
    const tally: Tally = { rendered: 0, failed: 0, uncompiled: 0 };
    const definition = withoutDropAndWrap(BUILTIN_DIALECTS[id as keyof typeof BUILTIN_DIALECTS]);
    for (let index = 0; index < CASES; index += 1) {
      const { site, schema } = siteFor(rng);
      checkClass(rng, 'N', schema, site, { id, definition }, tally);
    }
    expect(tally.rendered).toBeGreaterThan(0);
  }, PROPERTY_TIMEOUT_MS);

  it('random valid user definitions without drop and nullable-optional narrow or preserve', () => {
    const rng = seeded(0xdef1);
    const validate = new Ajv2020.default({ strict: false }).compile(DIALECT_DEFINITION_SCHEMA as object);
    const tally: Tally = { rendered: 0, failed: 0, uncompiled: 0 };
    const kinds = ['any', 'root', 'tool-parameters', 'object-with-properties', 'object-without-properties', 'any-of', 'any-of-branch', 'enum', 'const', 'untyped', 'array', 'type-string', 'type-null'];
    const descents = ['properties', 'items', 'anyOf', 'allOf', 'then', 'else', 'additionalProperties'];
    let accepted = 0;
    for (let index = 0; index < CASES; index += 1) {
      const rules = Array.from({ length: rng.int(1, 4) }, () => {
        const template = rng.pick(PRIMITIVES.filter((primitive) => primitive.name !== 'empty-parameters')).rule;
        const clause: Record<string, unknown> = { kinds: [rng.pick(kinds)] };
        if (rng.chance(0.3)) clause['within'] = { below: [rng.pick(descents)], through: [rng.pick(descents), 'properties'].filter((value, at, all) => all.indexOf(value) === at) };
        return { ...template, select: template['op'] === 'inline-refs' ? template['select'] : [clause] };
      });
      const definition = { rules };
      if (!validate(definition)) continue;
      accepted += 1;
      const { site, schema } = siteFor(rng);
      checkClass(rng, 'N', schema, site, resolvedOf('random-user', rules), tally);
    }
    expect(accepted).toBeGreaterThan(CASES / 2);
  }, PROPERTY_TIMEOUT_MS);
});

describe('soundness of class W (only drop)', () => {
  it('a drop at positive positions only widens, and removes the listed keys', () => {
    const rng = seeded(0xd209);
    const tally: Tally = { rendered: 0, failed: 0, uncompiled: 0 };
    const droppable = ['pattern', 'minLength', 'minimum', 'properties', 'patternProperties', 'items', 'prefixItems', 'contains', 'additionalProperties', 'type', 'enum', 'const', 'anyOf', 'required'];
    for (let index = 0; index < CASES; index += 1) {
      const keys = [...new Set([rng.pick(droppable), rng.pick(droppable)])];
      const { site, schema } = siteFor(rng);
      const resolved = resolvedOf('only-drop', [{ select: ANY, op: 'drop', keys }]);
      checkClass(rng, 'W', schema, site, resolved, tally);
      const outcome = render(schema, site, resolved);
      if (outcome.kind === 'rendered') {
        const text = JSON.stringify(outcome.schema) ?? '';
        for (const key of keys) expect(text.includes(`"${key}":`)).toBe(false);
      } else {
        expect(['polarity', 'written-key', 'dependency']).toContain(outcome.reason);
      }
    }
    expect(tally.rendered).toBeGreaterThan(CASES / 4);
  }, PROPERTY_TIMEOUT_MS);
});

describe('soundness of class R (nullable-optional with the production invertReply)', () => {
  const wrapOnly = resolvedOf('wrap-only', [{ select: [{ kinds: ['tool-parameters'] }], op: 'nullable-optional' }]);
  const wrapThenRequire = resolvedOf('wrap-then-require', [
    { select: [{ kinds: ['tool-parameters'] }], op: 'nullable-optional' },
    { select: [{ kinds: ['object-with-properties'] }], op: 'require-all' },
  ]);

  const invert = (record: { tool: string; wrapped: unknown[] } | undefined, instance: unknown): unknown =>
    record === undefined ? instance : JSON.parse(invertReply(record as never, JSON.stringify(instance)));

  it.each([
    ['nullable-optional then require-all', wrapThenRequire],
    ['strict-closed', { id: 'strict-closed', definition: BUILTIN_DIALECTS['strict-closed'] } as ResolvedDialect],
  ])('(1) under %s every rendered-valid instance inverts to an original-valid one', (_name, resolved) => {
    const rng = seeded(0x4e1);
    let rendered = 0;
    for (let index = 0; index < CASES; index += 1) {
      const parameters = strictToolParametersOf(rng);
      const outcome = render(parameters, toolSite(TOOL), resolved);
      if (outcome.kind === 'failed') {
        expect(['inverse-ambiguous', 'dependency']).toContain(outcome.reason);
        continue;
      }
      rendered += 1;
      const record = outcome.wraps.find((entry) => entry.tool === TOOL);
      const validOriginal = validatorOf(parameters)!;
      const validRendered = validatorOf(outcome.schema)!;
      const drawn = instancesOf(rng, outcome.schema, 8);
      for (const instance of [...drawn, ...drawn.flatMap(withNulls), ...drawn.flatMap((value) => mutationsOf(rng, value))]) {
        if (!validRendered(instance)) continue;
        const inverted = invert(record, instance);
        expect({ instance, inverted, parameters, valid: validOriginal(inverted) }).toMatchObject({ valid: true });
      }
    }
    expect(rendered).toBeGreaterThan(CASES / 2);
  }, PROPERTY_TIMEOUT_MS);

  it('(2) every original-valid instance pads to a rendered-valid one and inverts back to itself', () => {
    const rng = seeded(0x4e2);
    let checked = 0;
    for (let index = 0; index < CASES; index += 1) {
      const parameters = strictToolParametersOf(rng);
      const outcome = render(parameters, toolSite(TOOL), wrapOnly);
      if (outcome.kind === 'failed') {
        expect(['inverse-ambiguous', 'dependency']).toContain(outcome.reason);
        continue;
      }
      const record = outcome.wraps.find((entry) => entry.tool === TOOL) as never;
      const validOriginal = validatorOf(parameters)!;
      const validRendered = validatorOf(outcome.schema)!;
      const drawn = instancesOf(rng, parameters, 8);
      for (const instance of [...drawn, ...drawn.flatMap((value) => mutationsOf(rng, value))]) {
        if (!validOriginal(instance)) continue;
        checked += 1;
        const padded = pad(record, instance);
        expect({ instance, padded, parameters, valid: validRendered(padded) }).toMatchObject({ valid: true });
        expect(invert(record, padded)).toEqual(instance);
      }
    }
    expect(checked).toBeGreaterThan(CASES);
  }, PROPERTY_TIMEOUT_MS);

  it('never wraps a property whose original schema admits null', () => {
    const rng = seeded(0x4e3);
    for (let index = 0; index < CASES; index += 1) {
      const parameters = strictToolParametersOf(rng);
      const outcome = render(parameters, toolSite(TOOL), wrapOnly);
      if (outcome.kind === 'failed') continue;
      const record = outcome.wraps.find((entry) => entry.tool === TOOL) as { wrapped: { at: ({ property: string } | { items: true })[]; property: string }[] } | undefined;
      for (const { at, property } of record?.wrapped ?? []) {
        let node: unknown = parameters;
        for (const segment of at) {
          const current = node as Record<string, unknown>;
          node = 'items' in segment ? current['items'] : (current['properties'] as Record<string, unknown>)[segment.property];
        }
        const schema = ((node as Record<string, unknown>)['properties'] as Record<string, unknown>)[property];
        const admitsNull = validatorOf(schema)!(null);
        expect({ at, property, schema, admitsNull }).toMatchObject({ admitsNull: false });
      }
    }
  }, PROPERTY_TIMEOUT_MS);
});
