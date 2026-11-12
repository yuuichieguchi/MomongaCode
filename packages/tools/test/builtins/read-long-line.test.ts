import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createTempDir } from '@momonga/testkit';
import { nodeFileSystem, sha256Hex } from '@momonga/foundation';
import { scanLines } from '../../src/builtins/files.ts';
import { MAX_LINE_CHARS } from '../../src/builtins/format.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const LONG_LINE_BYTES = 50 * 1024 * 1024;

describe('a line longer than the shown line is not held whole', () => {
  it('gives the reader only the shown part and one more character, and hashes the whole file', async () => {
    const folder = createTempDir();
    const file = path.join(folder, 'one-line.txt');
    const content = Buffer.alloc(LONG_LINE_BYTES, 0x61);
    fs.writeFileSync(file, content);
    const lengths: number[] = [];

    const scan = await scanLines(nodeFileSystem, file, (line) => lengths.push(line.length), new AbortController().signal).finally(() => fs.rmSync(folder, { recursive: true, force: true }));

    expect(lengths).toEqual([MAX_LINE_CHARS + 1]);
    expect(scan).toEqual({ sha256: sha256Hex(content), totalLines: 1 });
  });
});
