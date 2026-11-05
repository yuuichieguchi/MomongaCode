import { describe, expect, it } from 'vitest';
import { BUILTIN_DIALECTS } from '@momonga/protocol';
import { renderSchema, SchemaRenderError } from '../src/dialect/render.ts';
import { DialectDefinitionError, definitionOf } from '../src/dialect/resolve.ts';
import { RESPONSE_FORMAT, builtin, failureOf, toolSite, userRules } from './dialect-support.ts';

const TOOL = 'search';

const explicitKeys = (schema: unknown) => renderSchema(schema, toolSite(TOOL), builtin('explicit-keys'));

describe('explicit-keys renders the keys fm was measured to need', () => {
  it('orders and closes a tool root and types an untyped enum from its values', () => {
    const rendered = explicitKeys({
      type: 'object',
      properties: { path: { type: 'string' }, mode: { enum: ['r', 'w'] } },
      required: ['path'],
    });
    expect(rendered.schema).toEqual({
      type: 'object',
      properties: { path: { type: 'string' }, mode: { enum: ['r', 'w'], type: 'string' } },
      required: ['path'],
      'x-order': ['path', 'mode'],
      additionalProperties: false,
    });
    expect(rendered.wraps).toEqual([]);
    expect(rendered.narrowings).toEqual([]);
  });

  it('turns parameters {} into an object, not a string', () => {
    expect(explicitKeys({}).schema).toEqual({ type: 'object', properties: {}, 'x-order': [], additionalProperties: false });
  });

  it.each([undefined, null])('turns absent parameters (%s) into an empty object', (parameters) => {
    expect(explicitKeys(parameters).schema).toEqual({ type: 'object', properties: {}, 'x-order': [], additionalProperties: false });
  });

  it('titles a union and keeps a null branch, and opens the object branch below it', () => {
    const rendered = explicitKeys({
      type: 'object',
      properties: {
        enforcement: { anyOf: [{ type: 'null' }, { type: 'object', properties: { level: { type: 'string' } }, required: ['level'] }] },
      },
    });
    expect(rendered.schema).toEqual({
      type: 'object',
      properties: {
        enforcement: {
          title: 'root_enforcement',
          anyOf: [
            { type: 'null' },
            { type: 'object', properties: { level: { type: 'string' } }, required: ['level'], title: 'root_enforcement_1', 'x-order': ['level'], additionalProperties: true },
          ],
        },
      },
      'x-order': ['enforcement'],
      additionalProperties: false,
    });
  });

  it('titles every object below a union, not only direct branches (row 1)', () => {
    const rendered = renderSchema(
      {
        anyOf: [
          { type: 'object', properties: { kind: { const: 'a' }, args: { type: 'object', properties: { x: { type: 'integer' } } } }, required: ['kind'] },
          { type: 'string' },
        ],
      },
      RESPONSE_FORMAT,
      builtin('explicit-keys'),
    );
    expect(rendered.schema).toEqual({
      title: 'root',
      anyOf: [
        {
          type: 'object',
          properties: {
            kind: { const: 'a' },
            args: { type: 'object', properties: { x: { type: 'integer' } }, title: 'root_0_args', 'x-order': ['x'], additionalProperties: true, required: [] },
          },
          required: ['kind'],
          title: 'root_0',
          'x-order': ['kind', 'args'],
          additionalProperties: true,
        },
        { type: 'string' },
      ],
    });
  });

  it('inlines references, splits type arrays and mixed enums into titled unions', () => {
    const rendered = explicitKeys({
      type: 'object',
      properties: { n: { type: ['string', 'null'] }, m: { enum: ['a', 1, null] }, r: { $ref: '#/$defs/d' } },
      $defs: { d: { type: 'integer', minimum: 0 } },
    });
    expect(rendered.schema).toEqual({
      type: 'object',
      properties: {
        n: { title: 'root_n', anyOf: [{ type: 'string' }, { type: 'null' }] },
        m: { title: 'root_m', anyOf: [{ type: 'string', enum: ['a'] }, { type: 'integer', enum: [1] }, { type: 'null', enum: [null] }] },
        r: { type: 'integer', minimum: 0 },
      },
      'x-order': ['n', 'm', 'r'],
      additionalProperties: false,
    });
  });

  it('never mutates the original and renders the same result twice', () => {
    const original = { type: 'object', properties: { o: { type: 'object' }, e: { enum: ['a', 1] } }, $defs: { d: { type: 'string' } } };
    const copy = structuredClone(original);
    const first = explicitKeys(original);
    const second = explicitKeys(original);
    expect(original).toEqual(copy);
    expect(second.schema).toEqual(first.schema);
  });
});

describe('the narrowings a render reports (decision a)', () => {
  const freeForm = {
    type: 'object',
    properties: {
      options: { type: 'object' },
      tags: { type: 'object', properties: { k: { type: 'string' } }, additionalProperties: { type: 'number' } },
      anything: {},
    },
  };

  it('reports the free-form object, the dictionary and the untyped node under explicit-keys, with their paths', () => {
    const rendered = explicitKeys(freeForm);
    expect(rendered.schema).toEqual({
      type: 'object',
      properties: {
        options: { type: 'object', properties: {}, 'x-order': [], additionalProperties: false },
        tags: { type: 'object', properties: { k: { type: 'string' } }, 'x-order': ['k'], additionalProperties: false },
        anything: { type: 'string' },
      },
      'x-order': ['options', 'tags', 'anything'],
      additionalProperties: false,
    });
    expect([...rendered.narrowings].sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      { tool: TOOL, path: '/properties/anything' },
      { tool: TOOL, path: '/properties/options' },
      { tool: TOOL, path: '/properties/tags' },
    ]);
  });

  it('reports none under json-schema-2020-12 and leaves the schema unchanged', () => {
    const rendered = renderSchema(freeForm, toolSite(TOOL), builtin('json-schema-2020-12'));
    expect(rendered.schema).toEqual(freeForm);
    expect(rendered.narrowings).toEqual([]);
  });

  it('reports none when the same parameters declare their properties and types', () => {
    const declared = {
      type: 'object',
      properties: {
        options: { type: 'object', properties: { a: { type: 'string' } } },
        tags: { type: 'object', properties: { k: { type: 'string' } } },
        anything: { type: 'string' },
      },
    };
    expect(explicitKeys(declared).narrowings).toEqual([]);
  });
});

describe('the early construct check (decision e (iii))', () => {
  const withSupport = (support: { ref: string; typeArray: string; mixedEnum: string }) =>
    builtin('json-schema-2020-12', { constructSupport: support as never });

  it('fails a tool whose $ref is recorded refused, naming the tool and the path', () => {
    const failure = failureOf(() =>
      renderSchema(
        { type: 'object', properties: { r: { $ref: '#/$defs/d' } }, $defs: { d: { type: 'string' } } },
        toolSite(TOOL),
        withSupport({ ref: 'refused', typeArray: 'accepted', mixedEnum: 'accepted' }),
      ),
    );
    expect(failure).toEqual({ reason: 'construct', tool: TOOL, path: '/properties/r', code: 'unsupported_tool_schema' });
  });

  it('fails a type array recorded unrenderable and a mixed enum recorded refused', () => {
    const support = withSupport({ ref: 'accepted', typeArray: 'unrenderable', mixedEnum: 'refused' });
    expect(failureOf(() => renderSchema({ type: 'object', properties: { n: { type: ['string', 'null'] } } }, toolSite(TOOL), support))).toEqual({
      reason: 'construct',
      tool: TOOL,
      path: '/properties/n',
      code: 'unsupported_tool_schema',
    });
    expect(failureOf(() => renderSchema({ type: 'object', properties: { m: { enum: ['a', 1] } } }, toolSite(TOOL), support))).toEqual({
      reason: 'construct',
      tool: TOOL,
      path: '/properties/m',
      code: 'unsupported_tool_schema',
    });
  });

  it('checks the original parameters before the dialect renders them', () => {
    const failure = failureOf(() =>
      renderSchema(
        { type: 'object', properties: { r: { $ref: '#/$defs/d' } }, $defs: { d: { type: 'string' } } },
        toolSite(TOOL),
        builtin('explicit-keys', { constructSupport: { ref: 'refused', typeArray: 'accepted', mixedEnum: 'accepted' } }),
      ),
    );
    expect(failure.reason).toBe('construct');
  });

  it('passes a single-typed enum and accepted constructs', () => {
    const support = withSupport({ ref: 'accepted', typeArray: 'accepted', mixedEnum: 'refused' });
    const schema = { type: 'object', properties: { m: { enum: ['a', 'b'] }, r: { $ref: '#/$defs/d' } }, $defs: { d: { type: 'string' } } };
    expect(renderSchema(schema, toolSite(TOOL), support).schema).toEqual(schema);
  });

  it('checks nothing without a construct table', () => {
    const schema = { type: 'object', properties: { r: { $ref: '#/$defs/d' }, n: { type: ['string', 'null'] } }, $defs: { d: { type: 'string' } } };
    expect(renderSchema(schema, toolSite(TOOL), builtin('json-schema-2020-12')).schema).toEqual(schema);
  });
});

describe('the stated failure reasons', () => {
  it('fails with reject on a key strict-closed lists, naming the tool and the node', () => {
    const failure = failureOf(() =>
      renderSchema({ type: 'object', properties: { a: { oneOf: [{ type: 'string' }, { type: 'integer' }] } } }, toolSite(TOOL), builtin('strict-closed')),
    );
    expect(failure).toEqual({ reason: 'reject', tool: TOOL, path: '/properties/a', code: 'unsupported_tool_schema' });
  });

  it('fails with loop on a looping reference instead of cutting it', () => {
    const failure = failureOf(() =>
      explicitKeys({
        type: 'object',
        properties: { n: { $ref: '#/$defs/d' } },
        $defs: { d: { type: 'object', properties: { next: { $ref: '#/$defs/d' } } } },
      }),
    );
    expect(failure.reason).toBe('loop');
    expect(failure.tool).toBe(TOOL);
  });

  it('fails with polarity when fill-type would change a node under not', () => {
    const failure = failureOf(() =>
      renderSchema({ type: 'object', properties: { a: { type: 'integer', not: {} } } }, toolSite(TOOL), userRules([
        { select: [{ kinds: ['untyped'] }], op: 'fill-type', fallback: 'string' },
      ])),
    );
    expect(failure).toEqual({ reason: 'polarity', tool: TOOL, path: '/properties/a/not', code: 'unsupported_tool_schema' });
  });

  it('fails with polarity when fill-type would change an if condition', () => {
    const failure = failureOf(() =>
      renderSchema({ type: 'string', if: {}, then: { minLength: 1 } }, RESPONSE_FORMAT, userRules([
        { select: [{ kinds: ['untyped'] }], op: 'fill-type', fallback: 'string' },
      ])),
    );
    expect(failure.reason).toBe('polarity');
    expect(failure.path).toBe('/if');
  });

  it('fails with polarity when an N rule would close an object in a oneOf branch', () => {
    const failure = failureOf(() =>
      renderSchema({ oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'string' }] }, RESPONSE_FORMAT, userRules([
        { select: [{ kinds: ['object-with-properties'] }], op: 'ensure-key', key: 'additionalProperties', value: false, overwrite: 'never' },
      ])),
    );
    expect(failure.reason).toBe('polarity');
    expect(failure.path).toBe('/oneOf/0');
  });

  it('fails with polarity when drop would remove a key inside a oneOf branch', () => {
    const failure = failureOf(() =>
      renderSchema({ oneOf: [{ type: 'string', minLength: 2 }, { type: 'integer' }] }, RESPONSE_FORMAT, userRules([
        { select: [{ kinds: ['any'] }], op: 'drop', keys: ['minLength'] },
      ])),
    );
    expect(failure.reason).toBe('polarity');
    expect(failure.path).toBe('/oneOf/0');
  });

  it('fails with polarity on the oneOf seed {type: array, oneOf: [true, {}]} under fill-type', () => {
    const failure = failureOf(() =>
      renderSchema({ type: 'array', oneOf: [true, {}] }, RESPONSE_FORMAT, userRules([
        { select: [{ kinds: ['untyped'] }], op: 'fill-type', fallback: 'number' },
      ])),
    );
    expect(failure.reason).toBe('polarity');
  });

  it('is not an error when a rule selects a node at a negative position and leaves it unchanged', () => {
    const schema = { type: 'integer', not: { type: 'string' } };
    const rendered = renderSchema(schema, RESPONSE_FORMAT, userRules([{ select: [{ kinds: ['untyped'] }], op: 'fill-type', fallback: 'string' }]));
    expect(rendered.schema).toEqual(schema);
  });

  it('fails with dependency when additionalProperties true would meet unevaluatedProperties false on the node', () => {
    const failure = failureOf(() =>
      renderSchema({ type: 'object', properties: { a: { type: 'string' } }, unevaluatedProperties: false }, RESPONSE_FORMAT, userRules([
        { select: [{ kinds: ['object-with-properties'] }], op: 'ensure-key', key: 'additionalProperties', value: true },
      ])),
    );
    expect(failure).toEqual({ reason: 'dependency', tool: undefined, path: '', code: 'unsupported_tool_schema' });
  });

  it('fails with dependency when additionalProperties true would be added to an allOf element of a parent with unevaluatedProperties false', () => {
    const failure = failureOf(() =>
      renderSchema({ allOf: [{ type: 'object', properties: { a: { type: 'string' } } }], unevaluatedProperties: false }, RESPONSE_FORMAT, userRules([
        { select: [{ kinds: ['object-with-properties'] }], op: 'ensure-key', key: 'additionalProperties', value: true },
      ])),
    );
    expect(failure.reason).toBe('dependency');
    expect(failure.path).toBe('/allOf/0');
  });

  it('fails with dependency when declare-required would add an evaluated property beside unevaluatedProperties false', () => {
    const failure = failureOf(() =>
      renderSchema({ required: ['a'], unevaluatedProperties: false }, RESPONSE_FORMAT, userRules([{ select: [{ kinds: ['any'] }], op: 'declare-required' }])),
    );
    expect(failure.reason).toBe('dependency');
  });

  it('fails with dependency when inline-refs would let a bare minContains see the target contains', () => {
    const failure = failureOf(() =>
      renderSchema(
        { properties: { r: { $ref: '#/$defs/d0', minContains: 0 } }, $defs: { d0: { contains: {} } } },
        RESPONSE_FORMAT,
        userRules([{ select: [{ kinds: ['root'] }], op: 'inline-refs' }]),
      ),
    );
    expect(failure.reason).toBe('dependency');
    expect(failure.path).toBe('/properties/r');
  });

  it('fails with ref-sibling when a $ref sibling shares a key with the target', () => {
    const failure = failureOf(() =>
      renderSchema(
        { type: 'object', properties: { r: { $ref: '#/$defs/d', minimum: 1 } }, $defs: { d: { type: 'integer', minimum: 0 } } },
        toolSite(TOOL),
        userRules([{ select: [{ kinds: ['tool-parameters'] }], op: 'inline-refs' }]),
      ),
    );
    expect(failure).toEqual({ reason: 'ref-sibling', tool: TOOL, path: '/properties/r', code: 'unsupported_tool_schema' });
  });

  it('fails with ref-sibling when the target closes properties the sibling declares', () => {
    const failure = failureOf(() =>
      renderSchema(
        { properties: { r: { $ref: '#/$defs/t', properties: { b: {} } } }, $defs: { t: { additionalProperties: false } } },
        RESPONSE_FORMAT,
        userRules([{ select: [{ kinds: ['root'] }], op: 'inline-refs' }]),
      ),
    );
    expect(['ref-sibling', 'dependency']).toContain(failure.reason);
  });

  it('fails with written-key when a rule writes a key that a $ref pointer passes through', () => {
    const failure = failureOf(() =>
      renderSchema(
        { type: 'object', properties: { a: { $ref: '#/$defs/title' } }, $defs: { title: { type: 'string' } } },
        RESPONSE_FORMAT,
        userRules([{ select: [{ kinds: ['object-with-properties'] }], op: 'label', key: 'title' }]),
      ),
    );
    expect(failure).toEqual({ reason: 'written-key', tool: undefined, path: '', code: 'unsupported_tool_schema' });
  });

  it.each([
    ['const-as-enum with a const outside the enum', { const: 'x', enum: ['a'] }, 'const-as-enum'],
    ['split-enum with no value of the node type', { type: 'integer', enum: ['a'] }, 'split-enum'],
    ['split-type-array with every branch emptied', { type: ['integer', 'boolean'], enum: ['a'] }, 'split-type-array'],
  ])('fails with unsatisfiable for %s', (_name, schema, op) => {
    const failure = failureOf(() => renderSchema(schema, RESPONSE_FORMAT, userRules([{ select: [{ kinds: ['any'] }], op }])));
    expect(failure).toEqual({ reason: 'unsatisfiable', tool: undefined, path: '', code: 'unsupported_tool_schema' });
  });

  it('is an UnsupportedInputError with the unsupported_tool_schema code', async () => {
    const { UnsupportedInputError } = await import('../src/adapters/shared/failures.ts');
    try {
      renderSchema({ oneOf: [] }, toolSite(TOOL), builtin('strict-closed'));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaRenderError);
      expect(error).toBeInstanceOf(UnsupportedInputError);
      expect((error as SchemaRenderError).message).toContain(TOOL);
    }
  });
});

describe('each primitive on its seed cases', () => {
  const one = (op: Record<string, unknown>, schema: unknown, site: Parameters<typeof renderSchema>[1] = RESPONSE_FORMAT) =>
    renderSchema(schema, site, userRules([{ select: [{ kinds: ['any'] }], ...op }])).schema;

  it('drop removes the keys and the dependents of what it drops', () => {
    expect(one({ op: 'drop', keys: ['properties'] }, { type: 'object', properties: { a: {} }, additionalProperties: false })).toEqual({ type: 'object' });
    expect(one({ op: 'drop', keys: ['contains'] }, { type: 'array', contains: { type: 'string' }, minContains: 1, maxContains: 2 })).toEqual({ type: 'array' });
    expect(one({ op: 'drop', keys: ['prefixItems'] }, { type: 'array', prefixItems: [{ type: 'string' }], items: false })).toEqual({ type: 'array' });
    expect(one({ op: 'drop', keys: ['pattern'] }, { type: 'object', properties: { a: { type: 'string', pattern: '^a' } } })).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
  });

  it('fill-type takes the type from values, then from structure, then the fallback, and leaves a typed node alone', () => {
    const fill = (schema: unknown) => one({ op: 'fill-type', fallback: 'boolean' }, schema);
    expect(fill({ const: 3 })).toEqual({ const: 3, type: 'integer' });
    expect(fill({ enum: [1, 1.5] })).toEqual({ enum: [1, 1.5], type: 'number' });
    expect(fill({ properties: { a: { type: 'string' } } })).toEqual({ properties: { a: { type: 'string' } }, type: 'object' });
    expect(fill({ items: { type: 'string' } })).toEqual({ items: { type: 'string' }, type: 'array' });
    expect(fill({ description: 'd' })).toEqual({ description: 'd', type: 'boolean' });
    expect(fill({ type: 'string' })).toEqual({ type: 'string' });
  });

  it('split-enum drops values the type excludes and makes no null branch', () => {
    expect(one({ op: 'split-enum' }, { type: 'string', enum: ['a', null] })).toEqual({ type: 'string', enum: ['a'] });
  });

  it('split-enum keeps each vocabulary with its type and copies the rest to every branch', () => {
    expect(one({ op: 'split-enum' }, { enum: ['a', 2], minLength: 1, minimum: 0, description: 'd', not: { const: 'b' } })).toEqual({
      description: 'd',
      anyOf: [
        { type: 'string', enum: ['a'], minLength: 1, description: 'd', not: { const: 'b' } },
        { type: 'integer', enum: [2], minimum: 0, description: 'd', not: { const: 'b' } },
      ],
    });
  });

  it('split-type-array gives each branch its vocabulary only, filters values and drops an emptied branch', () => {
    expect(one({ op: 'split-type-array' }, { type: ['object', 'null'], properties: { a: { type: 'string' } }, title: 'T' })).toEqual({
      title: 'T',
      anyOf: [{ type: 'object', properties: { a: { type: 'string' } }, title: 'T' }, { type: 'null', title: 'T' }],
    });
    expect(one({ op: 'split-type-array' }, { type: ['string', 'null'], enum: ['a'] })).toEqual({ anyOf: [{ type: 'string', enum: ['a'] }] });
  });

  it('const-as-enum writes a one-value enum', () => {
    expect(one({ op: 'const-as-enum' }, { const: 'a' })).toEqual({ enum: ['a'] });
    expect(one({ op: 'const-as-enum' }, { const: 'a', enum: ['a', 'b'] })).toEqual({ enum: ['a'] });
  });

  it('ensure-key sets a key only when absent, and additionalProperties false follows its overwrite', () => {
    expect(one({ op: 'ensure-key', key: 'required', value: [] }, { type: 'object', required: ['a'] })).toEqual({ type: 'object', required: ['a'] });
    expect(one({ op: 'ensure-key', key: 'properties', value: {} }, { type: 'object' })).toEqual({ type: 'object', properties: {} });
    const closed = (overwrite: string, additionalProperties: unknown) =>
      one({ op: 'ensure-key', key: 'additionalProperties', value: false, overwrite }, { type: 'object', additionalProperties });
    expect(closed('never', { type: 'string' })).toEqual({ type: 'object', additionalProperties: { type: 'string' } });
    expect(closed('non-boolean', { type: 'string' })).toEqual({ type: 'object', additionalProperties: false });
    expect(closed('non-boolean', true)).toEqual({ type: 'object', additionalProperties: true });
    expect(closed('always', true)).toEqual({ type: 'object', additionalProperties: false });
  });

  it('label writes a path label when absent and keeps an existing one', () => {
    expect(one({ op: 'label', key: 'title' }, { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } })).toEqual({
      type: 'object',
      title: 'root',
      properties: { a: { type: 'object', title: 'root_a', properties: { b: { type: 'string', title: 'root_a_b' } } } },
    });
    expect(one({ op: 'label', key: 'title' }, { title: 'mine' })).toEqual({ title: 'mine' });
  });

  it('property-order writes the property names in declaration order', () => {
    const ordered = renderSchema({ properties: { b: {}, a: {} } }, RESPONSE_FORMAT, userRules([
      { select: [{ kinds: ['object-with-properties'] }], op: 'property-order', key: 'propertyOrdering' },
    ]));
    expect(ordered.schema).toEqual({ properties: { b: {}, a: {} }, propertyOrdering: ['b', 'a'] });
  });

  it('require-all adds every property and keeps names that are not properties', () => {
    const requireAll = (schema: unknown) =>
      renderSchema(schema, RESPONSE_FORMAT, userRules([{ select: [{ kinds: ['object-with-properties'] }], op: 'require-all' }])).schema;
    expect(requireAll({ properties: {}, required: ['x'] })).toEqual({ properties: {}, required: ['x'] });
    expect(requireAll({ properties: { a: {}, b: {} }, required: ['x'] })).toEqual({ properties: { a: {}, b: {} }, required: ['x', 'a', 'b'] });
  });

  it('declare-required declares a required name with the schema the original applies to it', () => {
    expect(one({ op: 'declare-required' }, { required: ['a'], additionalProperties: false })).toEqual({ required: ['a'], additionalProperties: false, properties: { a: false } });
    expect(one({ op: 'declare-required' }, { required: ['a'], additionalProperties: { type: 'string' } })).toEqual({
      required: ['a'],
      additionalProperties: { type: 'string' },
      properties: { a: { type: 'string' } },
    });
    expect(one({ op: 'declare-required' }, { required: ['a'], patternProperties: { '^a': { type: 'string' } }, additionalProperties: false })).toEqual({
      required: ['a'],
      patternProperties: { '^a': { type: 'string' } },
      additionalProperties: false,
      properties: { a: {} },
    });
  });

  it('inline-refs merges annotation siblings and removes $defs', () => {
    const rendered = renderSchema(
      { type: 'object', properties: { r: { $ref: '#/$defs/d', description: 'x' } }, $defs: { d: { type: 'integer', minimum: 0 } } },
      RESPONSE_FORMAT,
      userRules([{ select: [{ kinds: ['root'] }], op: 'inline-refs' }]),
    );
    expect(rendered.schema).toEqual({ type: 'object', properties: { r: { type: 'integer', minimum: 0, description: 'x' } } });
  });

  it('empty-parameters writes an empty object only for absent parameters', () => {
    const empty = (schema: unknown) =>
      renderSchema(schema, toolSite(TOOL), userRules([{ select: [{ kinds: ['tool-parameters'] }], op: 'empty-parameters' }])).schema;
    expect(empty(undefined)).toEqual({ type: 'object', properties: {} });
    expect(empty(null)).toEqual({ type: 'object', properties: {} });
    expect(empty({ type: 'object' })).toEqual({ type: 'object' });
  });

  it('runs rules in list order, each seeing the node as the earlier rules left it', () => {
    const rendered = renderSchema({ type: 'object' }, RESPONSE_FORMAT, userRules([
      { select: [{ kinds: ['object-with-properties'] }], op: 'property-order', key: 'x-order' },
      { select: [{ kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'properties', value: {} },
      { select: [{ kinds: ['object-with-properties'] }], op: 'ensure-key', key: 'x-seen', value: true },
    ]));
    expect(rendered.schema).toEqual({ type: 'object', properties: {}, 'x-seen': true });
  });

  it('selects with within only below the named keyword and through the named descent', () => {
    const rules = userRules([
      { select: [{ kinds: ['type-string'], within: { below: ['anyOf'], through: ['properties'] } }], op: 'ensure-key', key: 'x-marked', value: true },
    ]);
    const rendered = renderSchema(
      { type: 'object', properties: { s: { type: 'string' }, u: { anyOf: [{ type: 'string' }, { type: 'object', properties: { t: { type: 'string' } }, items: { type: 'string' } }] } } },
      RESPONSE_FORMAT,
      rules,
    );
    expect(rendered.schema).toEqual({
      type: 'object',
      properties: {
        s: { type: 'string' },
        u: { anyOf: [{ type: 'string', 'x-marked': true }, { type: 'object', properties: { t: { type: 'string', 'x-marked': true } }, items: { type: 'string' } }] },
      },
    });
  });
});

describe('user-declared dialects', () => {
  const orderedSubset = {
    extends: 'inlined-subset',
    rules: [{ select: [{ kinds: ['object-with-properties'] }], op: 'property-order', key: 'propertyOrdering' }],
  };

  it('resolves a built-in id to its definition', () => {
    expect(definitionOf('explicit-keys', {})).toEqual(BUILTIN_DIALECTS['explicit-keys']);
  });

  it('prepends the rules of the built-in a user dialect extends', () => {
    expect(definitionOf('ordered-subset', { 'ordered-subset': orderedSubset as never })).toEqual({
      rules: [...BUILTIN_DIALECTS['inlined-subset'].rules, ...orderedSubset.rules],
    });
  });

  it('renders a user dialect with no code', () => {
    const resolved = { id: 'ordered-subset', definition: definitionOf('ordered-subset', { 'ordered-subset': orderedSubset as never }) };
    const rendered = renderSchema({ type: 'object', properties: { b: { type: 'string' }, a: { type: 'integer' } }, required: ['a'] }, toolSite(TOOL), resolved);
    expect(rendered.schema).toEqual({ type: 'object', properties: { b: { type: 'string' }, a: { type: 'integer' } }, required: ['a'], propertyOrdering: ['b', 'a'] });
  });

  it.each([
    ['an unknown id', 'nowhere', {}],
    ['a user id that is a built-in id', 'explicit-keys', { 'explicit-keys': { rules: [] } }],
    ['extends naming another user dialect', 'child', { child: { extends: 'parent', rules: [] }, parent: { rules: [] } }],
    ['a definition the schema rejects', 'unsound', { unsound: { rules: [{ select: [{ kinds: ['any'] }], op: 'ensure-key', key: 'required', value: ['a'] }] } }],
  ])('refuses %s, naming the id', (_name, id, dialects) => {
    let caught: unknown;
    try {
      definitionOf(id, dialects as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DialectDefinitionError);
    expect((caught as Error).message).toContain(id);
  });
});
