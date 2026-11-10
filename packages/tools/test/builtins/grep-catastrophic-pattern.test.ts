import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { HAS_RG, RG_PATH, makeBuiltins, resultOf } from './fixtures.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const LINE_LENGTH = 100_000;

describe.runIf(HAS_RG)('Grep with a pattern that makes a backtracking engine run for an exponential time', () => {
  it('answers through ripgrep, whose engine does not backtrack, on a long line that almost matches', async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    tools.write('long.txt', `${'a'.repeat(LINE_LENGTH)}b\n`);
    tools.write('short.txt', 'aaaa\n');
    const result = resultOf(await tools.run('Grep', { pattern: '(a+)+$', output_mode: 'count' }, { env: { PATH: RG_PATH, LANG: 'C' } }));
    expect(result).toMatchObject({ status: 'completed', output: 'short.txt:1' });
  });
});
