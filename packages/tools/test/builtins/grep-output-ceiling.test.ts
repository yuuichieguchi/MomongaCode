import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { CAPTURE_MAX_BYTES } from '../../src/capture.ts';
import { makeBuiltins, resultOf } from './fixtures.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const LINE = `${'match '.repeat(30)}\n`;

describe('Grep stops reading ripgrep at its output ceiling', () => {
  it('returns the complete records read before the ceiling and says the matches are partial', async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const linesPerFile = Math.ceil(CAPTURE_MAX_BYTES / LINE.length / 4) + 1;
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) tools.write(`${name}.txt`, LINE.repeat(linesPerFile));

    const result = resultOf(await tools.run('Grep', { pattern: 'match', output_mode: 'content', head_limit: 0 }));

    expect(result.output).toContain(`Search output passed ${CAPTURE_MAX_BYTES} bytes; the matches above are partial. Try a narrower path or pattern.`);
    expect(result.status).toBe('completed');
  });
});
