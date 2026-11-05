import { describe, expect, it } from 'vitest';
import { BUILTINS } from '../src/dialect-model/definition.ts';
import { isValidDefinition } from '../src/dialect-model/definition-gen.ts';
import { render } from '../src/dialect-model/render.ts';
import { runSeed, SEEDS } from '../src/dialect-model/seeds.ts';
import { runSubject, SUBJECTS } from '../src/dialect-model/subjects.ts';

const SCHEMAS_PER_SUBJECT = Number(process.env['DIALECT_MODEL_SCHEMAS'] ?? '300');
const GATE_TIMEOUT_MS = 60 * 60 * 1000;

const rule = (extra: Record<string, unknown>): unknown => ({ rules: [{ select: [{ kinds: ['any'] }], ...extra }] });

describe('dialect model: the definition schema', () => {
  it('accepts the four built-in definitions', () => {
    for (const [id, definition] of Object.entries(BUILTINS)) expect(isValidDefinition(definition), id).toBe(true);
  });

  it('rejects the unsound ensure-key pairs and class N and W rules that descend through not or if', () => {
    expect(isValidDefinition(rule({ op: 'ensure-key', key: 'additionalProperties', value: true, overwrite: 'always' }))).toBe(false);
    expect(isValidDefinition(rule({ op: 'ensure-key', key: 'required', value: ['a'] }))).toBe(false);
    expect(isValidDefinition(rule({ op: 'ensure-key', key: 'minimum', value: 1 }))).toBe(false);
    const through = (op: string, extra: Record<string, unknown>): unknown => ({
      rules: [{ select: [{ kinds: ['any'], within: { below: ['not'], through: ['properties'] } }], op, ...extra }],
    });
    expect(isValidDefinition(through('fill-type', { fallback: 'string' }))).toBe(false);
    expect(isValidDefinition(through('split-enum', {}))).toBe(true);
  });
});

describe('dialect model: seed counterexamples', () => {
  it.each(SEEDS.map((seed) => [seed.name, seed] as const))('%s', (_name, seed) => {
    const outcome = runSeed(seed);
    expect(outcome.failure, outcome.summary).toBeNull();
    expect(outcome.assertion).toBeNull();
  });
});

describe('dialect model: the renderer', () => {
  it('leaves its input unchanged and renders deterministically', () => {
    const input = { type: ['string', 'null'], enum: ['a'], properties: { a: { enum: [1, 'x'] } } };
    const copy = structuredClone(input);
    const first = render(input, BUILTINS['explicit-keys']!, 'response-format');
    const second = render(input, BUILTINS['explicit-keys']!, 'response-format');
    expect(input).toEqual(copy);
    expect(first).toEqual(second);
  });

  it('fails a polarity violation instead of skipping it', () => {
    const result = render({ not: {} }, { rules: [{ select: [{ kinds: ['any'] }], op: 'fill-type', fallback: 'string' }] }, 'response-format');
    expect(result.ok).toBe(false);
  });
});

describe('dialect model: property test', () => {
  it.each(SUBJECTS.map((spec) => [spec.name, spec] as const))(
    '%s has no counterexample',
    (_name, spec) => {
      const report = runSubject(spec, SCHEMAS_PER_SUBJECT, 20261105, () => undefined);
      expect({ schemas: report.stats.schemas, counterexamples: report.counterexamples, clusters: report.clusters }).toEqual({
        schemas: SCHEMAS_PER_SUBJECT,
        counterexamples: 0,
        clusters: [],
      });
    },
    GATE_TIMEOUT_MS,
  );
});
