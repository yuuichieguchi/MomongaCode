import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { ataEngine, createUntrustedBoundary } from '@momonga/foundation';
import { OPEN_RESPONSES_OPENAPI, OPEN_RESPONSES_SCHEMA_REGISTRY } from '@momonga/protocol';

const LEGACY_ID = 'https://momonga.invalid/open-responses/2026-04-24/openapi.json';
const LEGACY_PREFIX = '#/components/schemas/';

type Spec = { components: { schemas: Record<string, unknown> } };
type Registry = { $id: string; $defs: Record<string, unknown> } & Record<string, unknown>;

const spec = OPEN_RESPONSES_OPENAPI as unknown as Spec;
const registry = (): Registry => OPEN_RESPONSES_SCHEMA_REGISTRY as unknown as Registry;
const componentNames = Object.keys(spec.components.schemas).sort();

const legacyValidator = (() => {
  const ajv = new Ajv2020.default({ strict: false, allErrors: true });
  ajv.addSchema({ $id: LEGACY_ID, components: spec.components });
  return (component: string) => {
    const validate = ajv.getSchema(`${LEGACY_ID}${LEGACY_PREFIX}${component}`);
    if (validate === undefined) throw new Error(`no legacy validator for ${component}`);
    return (value: unknown): boolean => validate(value) === true;
  };
})();

const registryValidator = (() => {
  let boundary: ReturnType<typeof createUntrustedBoundary> | undefined;
  return (component: string) => {
    const current = registry();
    boundary ??= createUntrustedBoundary({ remotes: new Map([[current.$id, current]]), engine: ataEngine });
    const validate = boundary.compile({ $ref: `${current.$id}#/$defs/${component}` });
    return (value: unknown): boolean => validate(value).valid;
  };
})();

const GENERIC_PROBES: readonly unknown[] = [null, 0, -1, 1.5, '', 'x', true, [], {}, { type: 'x' }, [null], { id: 'a', type: 'message' }];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const pathsOf = (value: unknown, at: (string | number)[] = []): (string | number)[][] => {
  const own = [at];
  if (Array.isArray(value)) return [...own, ...value.flatMap((child, index) => pathsOf(child, [...at, index]))];
  if (isRecord(value)) return [...own, ...Object.entries(value).flatMap(([key, child]) => pathsOf(child, [...at, key]))];
  return own;
};

const DELETE = Symbol('delete');

const withAt =(base: unknown, at: readonly (string | number)[], replacement: unknown | typeof DELETE): unknown => {
  if (at.length === 0) return replacement === DELETE ? undefined : clone(replacement);
  const copy = clone(base) as Record<string | number, unknown>;
  let parent: Record<string | number, unknown> = copy;
  for (const key of at.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  const last = at[at.length - 1] as string | number;
  if (replacement === DELETE) {
    if (Array.isArray(parent)) parent.splice(Number(last), 1);
    else delete parent[last];
  } else parent[last] = clone(replacement);
  return copy;
};

const nearMisses = (base: unknown): unknown[] =>
  pathsOf(base).flatMap((at) => [DELETE, null, 0, -1, 'x', '', true, [], {}, 1e21].map((replacement) => withAt(base, at, replacement))).filter((value) => value !== undefined);

const CREATE_BASES: readonly Record<string, unknown>[] = [
  { model: 'm', input: 'hi' },
  { model: 'm', input: [{ type: 'message', role: 'user', content: 'hello' }], max_output_tokens: 64, reasoning: { effort: 'low' } },
  {
    model: 'm',
    input: [
      { type: 'message', role: 'system', content: 'be terse' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'contents' },
    ],
    tools: [{ type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, strict: true }],
    tool_choice: 'auto',
    stream: true,
    store: false,
  },
];

const COMPACT_BASES: readonly Record<string, unknown>[] = [{ model: 'm', input: 'hi' }, { model: 'm', input: [{ type: 'message', role: 'user', content: 'hello' }] }];

const disagreements = (component: string, instances: readonly unknown[]): string[] => {
  const legacy = legacyValidator(component);
  const candidate = registryValidator(component);
  return instances.flatMap((instance) => {
    const expected = legacy(instance);
    return candidate(instance) === expected ? [] : [`${component} ${JSON.stringify(instance).slice(0, 160)}: legacy ${String(expected)}`];
  });
};

describe('the Open Responses components as a standard $defs registry', () => {
  it('is a 2020-12 document with an $id and a $defs entry for every component, and no components object', () => {
    const current = registry();
    expect(typeof current.$id).toBe('string');
    expect(current['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(current['components']).toBeUndefined();
    expect(Object.keys(current.$defs).sort()).toEqual(componentNames);
  });

  it('points every internal reference at $defs, never at #/components/schemas', () => {
    const text = JSON.stringify(registry());
    expect(text).not.toContain('#/components/');
    expect(text).toContain('#/$defs/');
  });

  it('compiles an entry point for every component through the foundation boundary', () => {
    const failures = componentNames.flatMap((component) => {
      try {
        registryValidator(component);
        return [];
      } catch (error) {
        return [`${component}: ${error instanceof Error ? error.message : String(error)}`];
      }
    });
    expect(failures).toEqual([]);
  });

  it('gives the legacy getSchema verdict for every component on generic probes', () => {
    expect(componentNames.flatMap((component) => disagreements(component, GENERIC_PROBES))).toEqual([]);
  });

  it('gives the legacy verdict on near misses of valid request bodies', () => {
    const create = legacyValidator('CreateResponseBody');
    const compact = legacyValidator('CompactResponseMethodPublicBody');
    expect(CREATE_BASES.map(create)).toEqual(CREATE_BASES.map(() => true));
    expect(COMPACT_BASES.map(compact)).toEqual(COMPACT_BASES.map(() => true));
    const createInstances = [...CREATE_BASES, ...CREATE_BASES.flatMap(nearMisses)];
    const compactInstances = [...COMPACT_BASES, ...COMPACT_BASES.flatMap(nearMisses)];
    expect(createInstances.filter((instance) => !create(instance)).length).toBeGreaterThan(50);
    expect(disagreements('CreateResponseBody', createInstances)).toEqual([]);
    expect(disagreements('CompactResponseMethodPublicBody', compactInstances)).toEqual([]);
  });

  it('gives the legacy verdict on near misses of every input item, for the item union and each item component', () => {
    const items = CREATE_BASES.flatMap((base) => (Array.isArray(base['input']) ? (base['input'] as unknown[]) : []));
    const instances = [...items, ...items.flatMap(nearMisses)];
    expect(instances.filter((instance) => !legacyValidator('ItemParam')(instance)).length).toBeGreaterThan(20);
    expect(['ItemParam', 'ItemField', ...componentNames.filter((name) => name.endsWith('ItemParam'))].flatMap((component) => disagreements(component, instances))).toEqual([]);
  });
});
