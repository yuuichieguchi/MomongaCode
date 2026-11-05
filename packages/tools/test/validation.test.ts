import { describe, expect, it } from 'vitest';
import { validateToolInput } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    old_string: { type: 'string' },
    replace_all: { type: 'boolean' },
    count: { type: 'integer', minimum: 1 },
    edits: {
      type: 'array',
      items: { type: 'object', properties: { mode: { type: 'string', enum: ['a', 'b'] } }, required: ['mode'], additionalProperties: false },
    },
  },
  required: ['old_string'],
  additionalProperties: false,
} as const;

const MANY_REQUIRED = Array.from({ length: 25 }, (_unused, index) => `p${String(index + 1).padStart(2, '0')}`);

const MANY_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(MANY_REQUIRED.map((name) => [name, { type: 'string' }])),
  required: MANY_REQUIRED,
  additionalProperties: false,
};

const runEdit = async (args: unknown) => {
  const harness = makeHarness();
  let executed = 0;
  const edit = makeTool('Edit', {
    inputSchema: EDIT_SCHEMA,
    execute: async () => {
      executed += 1;
      return { status: 'completed', output: 'edited' };
    },
  });
  const set = await toolSetOf(edit, makeTool('Many', { inputSchema: MANY_SCHEMA }));
  const [outcome] = await harness.executor.runBatch(harness.input(set, [call('c1', 'Edit', args)]));
  return { outcome, executed, harness };
};

const failedOutput = async (args: unknown): Promise<string> => {
  const { outcome, executed, harness } = await runEdit(args);
  expect(executed).toBe(0);
  expect(harness.idempotency.records.size).toBe(0);
  expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'failed' } });
  if (outcome?.kind !== 'result') throw new Error('expected a result outcome');
  return outcome.result.output;
};

describe('validation messages', () => {
  it('returns ok with the parsed value for valid object arguments', () => {
    expect(validateToolInput(makeTool('Edit', { inputSchema: EDIT_SCHEMA }), { old_string: 'x', edits: [{ mode: 'a' }] })).toEqual({
      ok: true,
      value: { old_string: 'x', edits: [{ mode: 'a' }] },
    });
  });

  it('parses valid JSON string arguments into the value', () => {
    expect(validateToolInput(makeTool('Edit', { inputSchema: EDIT_SCHEMA }), '{"old_string":"x","replace_all":true}')).toEqual({
      ok: true,
      value: { old_string: 'x', replace_all: true },
    });
  });

  it('returns the model-facing message for invalid input', () => {
    expect(validateToolInput(makeTool('Edit', { inputSchema: EDIT_SCHEMA }), { old_string: 'x', foo: 1 })).toEqual({
      ok: false,
      reason: 'invalid',
      message: 'Invalid input for Edit:\n- (root): unknown property "foo"',
    });
  });

  it('returns the JSON parse message for unparsable strings', () => {
    const result = validateToolInput(makeTool('Edit', { inputSchema: EDIT_SCHEMA }), '{"old_string":');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message.startsWith('Invalid JSON arguments for Edit: ')).toBe(true);
  });

  it('quotes the full received text after the parse message', () => {
    const received = `{"old_string":"${'x'.repeat(400)}\n"`;
    const result = validateToolInput(makeTool('Edit', { inputSchema: EDIT_SCHEMA }), received);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message.endsWith(`\nReceived: ${received}`)).toBe(true);
  });

  it('names a missing required property at the root', async () => {
    expect(await failedOutput({})).toBe('Invalid input for Edit:\n- old_string: required property is missing');
  });

  it('uses the Ajv message for a type error', async () => {
    expect(await failedOutput({ old_string: 'x', replace_all: 'yes' })).toBe('Invalid input for Edit:\n- replace_all: must be boolean');
  });

  it('names an unknown root property', async () => {
    expect(await failedOutput({ old_string: 'x', foo: 1 })).toBe('Invalid input for Edit:\n- (root): unknown property "foo"');
  });

  it('renders array indices and lists enum values', async () => {
    expect(await failedOutput({ old_string: 'x', edits: [{ mode: 'c' }] })).toBe('Invalid input for Edit:\n- edits[0].mode: must be one of: a, b');
  });

  it('names a missing nested required property in the path', async () => {
    expect(await failedOutput({ old_string: 'x', edits: [{ mode: 'a' }, {}] })).toBe(
      'Invalid input for Edit:\n- edits[1].mode: required property is missing',
    );
  });

  it('uses the Ajv message text for other keywords', async () => {
    expect(await failedOutput({ old_string: 'x', count: 0 })).toBe('Invalid input for Edit:\n- count: must be >= 1');
  });

  it('reports all errors at once', async () => {
    const output = await failedOutput({ replace_all: 'yes' });
    expect(output.split('\n')).toHaveLength(3);
    expect(output).toContain('- old_string: required property is missing');
    expect(output).toContain('- replace_all: must be boolean');
  });

  it('does not coerce types', async () => {
    expect(await failedOutput({ old_string: 'x', count: '2' })).toBe('Invalid input for Edit:\n- count: must be integer');
  });

  it('never echoes the offending value', async () => {
    const output = await failedOutput({ old_string: 'x', replace_all: 'not-a-boolean', edits: [{ mode: 'zzz-mode' }] });
    expect(output).not.toContain('not-a-boolean');
    expect(output).not.toContain('zzz-mode');
  });

  it('caps the list at 20 lines and counts the rest', async () => {
    const harness = makeHarness();
    const set = await toolSetOf(makeTool('Many', { inputSchema: MANY_SCHEMA }));
    const [outcome] = await harness.executor.runBatch(harness.input(set, [call('c1', 'Many', {})]));
    if (outcome?.kind !== 'result') throw new Error('expected a result outcome');
    const lines = outcome.result.output.split('\n');
    expect(lines[0]).toBe('Invalid input for Many:');
    expect(lines).toHaveLength(22);
    expect(lines.slice(1, 21).every((line) => /^- p\d{2}: required property is missing$/.test(line))).toBe(true);
    expect(lines[21]).toBe('- … 5 more errors');
  });

  it('reports unparsable JSON string arguments', async () => {
    const output = await failedOutput('{"old_string":');
    expect(output.startsWith('Invalid JSON arguments for Edit: ')).toBe(true);
    expect(output.length).toBeGreaterThan('Invalid JSON arguments for Edit: '.length);
  });

  it('parses JSON string arguments before validating', async () => {
    const { outcome, executed } = await runEdit('{"old_string":"x"}');
    expect(executed).toBe(1);
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'edited' } });
  });

  it('validates parsed JSON strings with the same messages', async () => {
    expect(await failedOutput('{"old_string":"x","foo":1}')).toBe('Invalid input for Edit:\n- (root): unknown property "foo"');
  });
});
