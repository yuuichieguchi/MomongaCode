import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_EXTRA_TOOLS_ENV, overflowingInstance } from '@momonga/testkit';
import { untrustedSchemaFailure } from '@momonga/foundation';
import { schemaIdentity } from '@momonga/tools';
import type { ToolSet } from '@momonga/tools';
import { callRecords, entry, makeExecutor, makePool, makeRecordFile, modernConfig } from './mcp-harness.ts';

const validatorRuns = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../foundation/src/untrusted-schema.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../foundation/src/untrusted-schema.ts')>();
  const isThrowingSchema = (schema: Record<string, unknown>): boolean => typeof schema['additionalProperties'] === 'object' && schema['additionalProperties'] !== null && 'not' in schema['additionalProperties'];
  return {
    ...original,
    compileUntrustedSchema: (schema: Record<string, unknown>) => {
      const validate = original.compileUntrustedSchema(schema);
      if (!isThrowingSchema(schema)) return validate;
      return (data: unknown) => {
        validatorRuns.count += 1;
        return validate(data);
      };
    },
  };
});

const THROWING = 'mcp__modern__validator_throws';
const IF_ANNOTATIONS = 'mcp__modern__if_annotations';
const ENGINE_MESSAGE = 'Maximum call stack size exceeded';
const UNAVAILABLE = /unavailable/i;
const SAME_RUN = { runId: 'run-validator-failure' };

const extraTools = () => {
  const recordFile = makeRecordFile();
  const config = modernConfig(recordFile, { [FIXTURE_EXTRA_TOOLS_ENV]: 'validator_throws,if_annotations' });
  return { pool: makePool([entry('modern', config)]), recordFile };
};

const extraToolSet = async (): Promise<{ set: ToolSet; recordFile: string }> => {
  const { pool, recordFile } = extraTools();
  return { set: await pool.snapshot(), recordFile };
};

const outputOf = (outcome: unknown): string => {
  if (typeof outcome !== 'object' || outcome === null || (outcome as { kind?: unknown }).kind !== 'result') throw new Error(`expected a result, got ${JSON.stringify(outcome)}`);
  return (outcome as { result: { output: string } }).result.output;
};

describe('validating MCP tool arguments with a third-party 2020-12 schema', () => {
  it('makes the tool unavailable for the run and unregistered from the next snapshot when its validator throws while validating', async () => {
    const { pool, recordFile } = extraTools();
    const set = await pool.snapshot();
    const tool = set.get(THROWING);
    expect(tool).toBeDefined();
    expect(set.notices.filter((notice) => notice.includes(THROWING))).toEqual([]);
    const warnings: string[] = [];
    const executor = makeExecutor(undefined, (message) => warnings.push(message));

    const first = await executor.run(set, THROWING, overflowingInstance(), SAME_RUN);
    expect(first).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect(outputOf(first)).toMatch(UNAVAILABLE);
    expect(outputOf(first)).toContain(THROWING);
    expect(callRecords(recordFile, 'validator_throws')).toHaveLength(0);

    const notices = warnings.filter((message) => message.includes(THROWING));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('modern');
    expect(notices[0]).toContain(ENGINE_MESSAGE);

    const thrower = tool as { inputSchema: Record<string, unknown>; name: string; validatorIdentity?: string };
    expect(untrustedSchemaFailure(schemaIdentity(thrower), thrower.inputSchema)).toContain(ENGINE_MESSAGE);

    const runsAfterFirst = validatorRuns.count;
    expect(runsAfterFirst).toBe(1);
    const second = await executor.run(set, THROWING, overflowingInstance(), SAME_RUN);
    expect(second).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect(outputOf(second)).toBe(outputOf(first));
    expect(validatorRuns.count).toBe(runsAfterFirst);
    expect(callRecords(recordFile, 'validator_throws')).toHaveLength(0);
    expect(set.get(THROWING)).toBe(tool);

    const next = await pool.snapshot();
    expect(next.get(THROWING)).toBeUndefined();
    const skipped = next.notices.filter((notice) => notice.includes(THROWING));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('skipped');
    expect(skipped[0]).toContain(ENGINE_MESSAGE);
    expect(next.get(IF_ANNOTATIONS)).toBeDefined();
  });

  it('passes arguments to the server when the if subschema evaluates every property', async () => {
    const { set, recordFile } = await extraToolSet();
    const result = await makeExecutor().resultOf(set, IF_ANNOTATIONS, { a: null });
    expect(result.output).toBe('if_annotations');
    expect(result.status).toBe('completed');
    expect(callRecords(recordFile, 'if_annotations')).toHaveLength(1);
  });
});
