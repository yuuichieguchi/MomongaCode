import { describe, expect, it } from 'vitest';
import { BUILTINS, type Definition } from './support/dialect-model/definition.ts';
import { isValidDefinition } from './support/dialect-model/definition-gen.ts';
import { instanceCandidates } from './support/dialect-model/harness.ts';
import type { Json } from './support/dialect-model/json.ts';
import { render } from './support/dialect-model/render.ts';
import { runSeed, SEEDS } from './support/dialect-model/seeds.ts';
import { runSubject, SUBJECTS } from './support/dialect-model/subjects.ts';

const SCHEMAS_PER_SUBJECT = Number(process.env['DIALECT_MODEL_SCHEMAS'] ?? '300');
const GATE_TIMEOUT_MS = 60 * 60 * 1000;

const explicitKeys = (): Definition => {
  const definition = BUILTINS['explicit-keys'];
  if (definition === undefined) throw new Error('explicit-keys is not defined');
  return definition;
};

const rule = (extra: Record<string, unknown>): unknown => ({ rules: [{ select: [{ kinds: ['any'] }], ...extra }] });

describe('dialect model: the definition schema', () => {
  it('accepts the four built-in definitions', async () => {
    for (const [id, definition] of Object.entries(BUILTINS)) expect(isValidDefinition(definition), id).toBe(true);
  });

  it('rejects the unsound ensure-key pairs and class N and W rules that descend through not or if', async () => {
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
  it.each(SEEDS.map((seed) => [seed.name, seed] as const))('%s', async (_name, seed) => {
    const outcome = await runSeed(seed);
    expect(outcome.failure, outcome.summary).toBeNull();
    expect(outcome.assertion).toBeNull();
  });
});

describe('dialect model: the renderer', () => {
  it('leaves its input unchanged and renders deterministically', async () => {
    const input = { type: ['string', 'null'], enum: ['a'], properties: { a: { enum: [1, 'x'] } } };
    const copy = structuredClone(input);
    const first = render(input, explicitKeys(), 'response-format');
    const second = render(input, explicitKeys(), 'response-format');
    expect(input).toEqual(copy);
    expect(first).toEqual(second);
  });

  it('fails a polarity violation instead of skipping it', async () => {
    const result = render({ not: {} }, { rules: [{ select: [{ kinds: ['any'] }], op: 'fill-type', fallback: 'string' }] }, 'response-format');
    expect(result.ok).toBe(false);
  });
});

describe('dialect model: the instance shrinker', () => {
  const descentCycle = (start: Json): string[] | null => {
    const finished = new Set<string>();
    const visit = (value: Json, path: string[]): string[] | null => {
      const key = JSON.stringify(value);
      if (path.includes(key)) return [...path, key];
      if (finished.has(key)) return null;
      for (const candidate of instanceCandidates(value)) {
        const cycle = visit(candidate, [...path, key]);
        if (cycle !== null) return cycle;
      }
      finished.add(key);
      return null;
    };
    return visit(start, []);
  };

  it.each([0, 1, 2, -1, 2.5, '', 'x', true, false, null, [0, 1], { a: 1, b: 'x' }, [[1], { a: 0 }]].map((value) => [JSON.stringify(value), value] as const))(
    'never returns to an instance it shrank from, starting at %s',
    (_name, value) => {
      expect(descentCycle(value)).toBeNull();
    },
  );
});

describe('dialect model: property test', () => {
  it.each(SUBJECTS.map((spec) => [spec.name, spec] as const))(
    '%s has no counterexample',
    async (_name, spec) => {
      const report = await runSubject(spec, SCHEMAS_PER_SUBJECT, 20261105, () => undefined);
      expect({ schemas: report.stats.schemas, counterexamples: report.counterexamples, clusters: report.clusters }).toEqual({
        schemas: SCHEMAS_PER_SUBJECT,
        counterexamples: 0,
        clusters: [],
      });
    },
    GATE_TIMEOUT_MS,
  );
});
