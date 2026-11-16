import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sweepLeftovers } from '@momonga/foundation';
import { createTempDir, testKernelLock } from '@momonga/testkit';

describe('a leftover directory is claimed by the lock form of its folder, as a file is', () => {
  it('removes a dead directory entry through its own claim, whatever the lock mechanism is', async () => {
    const root = createTempDir();
    const entry = path.join(root, 'work-source-1');
    fs.mkdirSync(entry);
    fs.writeFileSync(path.join(entry, 'file'), 'content');
    const swept = await sweepLeftovers({ directories: [{ directory: root, isLeftover: (name) => name.startsWith('work-source-') }], lock: testKernelLock() });
    expect(swept).toEqual({ removed: [entry], kept: [] });
    expect(fs.existsSync(entry)).toBe(false);
  });
});
