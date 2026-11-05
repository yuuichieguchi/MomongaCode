import { describe, expect, it } from 'vitest';
import { FIXTURE_EXTRA_TOOLS_ENV } from '@momonga/testkit';
import type { ToolSet } from '@momonga/tools';
import { callRecords, entry, makeExecutor, makePool, makeRecordFile, modernConfig } from './mcp-harness.ts';

const THROWING = 'mcp__modern__validator_throws';
const IF_ANNOTATIONS = 'mcp__modern__if_annotations';
const RAW_ENGINE_ERROR = /is not defined|Cannot set properties of undefined/;

const extraToolSet = async (): Promise<{ set: ToolSet; recordFile: string }> => {
  const recordFile = makeRecordFile();
  const config = modernConfig(recordFile, { [FIXTURE_EXTRA_TOOLS_ENV]: 'validator_throws,if_annotations' });
  return { set: await makePool([entry('modern', config)]).snapshot(), recordFile };
};

describe('validating MCP tool arguments with a third-party 2020-12 schema', () => {
  it('settles the call to an outcome when the compiled validator throws while validating', async () => {
    const { set } = await extraToolSet();
    expect(set.get(THROWING)).toBeDefined();
    expect(set.notices.filter((notice) => notice.includes(THROWING))).toEqual([]);
    const settled = makeExecutor().run(set, THROWING, {});
    await expect(settled).resolves.toMatchObject({ kind: 'result' });
    const outcome = await settled;
    expect(outcome?.kind === 'result' ? outcome.result.output : '').not.toMatch(RAW_ENGINE_ERROR);
  });

  it('passes arguments to the server when the if subschema evaluates every property', async () => {
    const { set, recordFile } = await extraToolSet();
    const result = await makeExecutor().resultOf(set, IF_ANNOTATIONS, { a: null });
    expect(result.output).toBe('if_annotations');
    expect(result.status).toBe('completed');
    expect(callRecords(recordFile, 'if_annotations')).toHaveLength(1);
  });
});
