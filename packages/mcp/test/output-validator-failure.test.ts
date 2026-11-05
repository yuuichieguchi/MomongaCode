import { describe, expect, it, vi } from 'vitest';
import { ENGINE_FAILURE_MESSAGE, FIXTURE_EXTRA_TOOLS_ENV } from '@momonga/testkit';
import { callRecords, entry, makeExecutor, makePool, makeRecordFile, modernConfig } from './mcp-harness.ts';

vi.mock('../../foundation/src/untrusted-engine.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../foundation/src/untrusted-engine.ts')>();
  const { injectEngineFailure } = await import('../../testkit/src/engine-failure.ts');
  return { ...original, ataEngine: injectEngineFailure(original.ataEngine) };
});

const THROWING_OUTPUT = 'mcp__modern__output_validator_throws';
const SAME_RUN = { runId: 'run-output-validator-failure' };
const ENGINE_MESSAGE = ENGINE_FAILURE_MESSAGE;

describe('checking MCP structured output with a third-party 2020-12 output schema', () => {
  it('returns a tool error saying the output could not be checked and makes the tool unavailable when the output validator throws', async () => {
    const recordFile = makeRecordFile();
    const pool = makePool([entry('modern', modernConfig(recordFile, { [FIXTURE_EXTRA_TOOLS_ENV]: 'output_validator_throws' }))]);
    const set = await pool.snapshot();
    expect(set.get(THROWING_OUTPUT)).toBeDefined();
    const warnings: string[] = [];
    const executor = makeExecutor(undefined, (message) => warnings.push(message));

    const first = await executor.resultOf(set, THROWING_OUTPUT, {}, SAME_RUN);
    expect(first.status).toBe('failed');
    expect(first.output).toMatch(/output could not be checked/i);
    expect(first.output).toContain(THROWING_OUTPUT);
    expect(first.output).not.toContain('unchecked');
    expect(JSON.stringify(first)).not.toContain('unchecked');
    expect(callRecords(recordFile, 'output_validator_throws')).toHaveLength(1);

    const notices = warnings.filter((message) => message.includes(THROWING_OUTPUT));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('modern');
    expect(notices[0]).toContain(ENGINE_MESSAGE);

    const second = await executor.resultOf(set, THROWING_OUTPUT, {}, SAME_RUN);
    expect(second.status).toBe('failed');
    expect(second.output).toMatch(/unavailable/i);
    expect(second.output).toContain(THROWING_OUTPUT);
    expect(callRecords(recordFile, 'output_validator_throws')).toHaveLength(1);
  });
});
