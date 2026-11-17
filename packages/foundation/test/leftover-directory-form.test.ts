import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimNewEntrySync, sweepLeftovers } from '@momonga/foundation';
import { testKernelLock, withTempDir } from '@momonga/testkit';

const workSources = (directory: string) => [{ directory, isLeftover: (name: string) => name.startsWith('work-source-') }];

describe('a leftover directory is claimed by the lock form of its folder, as a file is', () => {
  it('removes a dead directory entry through its own claim, whatever the lock mechanism is', async (context) => {
    const root = withTempDir(context);
    const entry = path.join(root, 'work-source-1');
    const held = claimNewEntrySync(testKernelLock(), entry, 'sidecar');
    fs.mkdirSync(entry);
    fs.writeFileSync(path.join(entry, 'file'), 'content');
    held.release();
    const swept = await sweepLeftovers({ directories: workSources(root), lock: testKernelLock() });
    expect(swept).toEqual({ removed: [entry], kept: [] });
    expect(fs.existsSync(entry)).toBe(false);
  });

  it('keeps a directory entry with no sidecar, because no claim can prove that nothing uses it', async (context) => {
    const root = withTempDir(context);
    const entry = path.join(root, 'work-source-2');
    fs.mkdirSync(entry);
    fs.writeFileSync(path.join(entry, 'file'), 'content');
    const swept = await sweepLeftovers({ directories: workSources(root), lock: testKernelLock() });
    expect(swept).toEqual({ removed: [], kept: [entry] });
    expect(fs.existsSync(entry)).toBe(true);
  });
});
