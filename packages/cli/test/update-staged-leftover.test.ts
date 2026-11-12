import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeUpdateFs } from '../src/update/node-ports.ts';
import type { StagedFile } from '../src/update/ports.ts';
import { createTempDir, testKernelLock } from '@momonga/testkit';

const created: string[] = [];
const open: StagedFile[] = [];

afterEach(async () => {
  for (const staged of open.splice(0)) await staged.close();
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const installDirectory = (): string => {
  const directory = createTempDir();
  created.push(directory);
  return directory;
};

describe('node-ports.ts:63,78,94-97: a staged download is created locked, and removeLeftovers keeps it while its writer lives', () => {
  it('holds the kernel lock of the staged file from the moment stage returns', async () => {
    const directory = installDirectory();
    const staged = await nodeUpdateFs(testKernelLock()).stage(directory, 0o755);
    open.push(staged);
    expect(await testKernelLock().isHeld(staged.path)).toBe(true);
  });

  it('keeps a staged file whose writer is still writing when another install sweeps the directory', async () => {
    const directory = installDirectory();
    const updateFs = nodeUpdateFs(testKernelLock());
    const staged = await updateFs.stage(directory, 0o755);
    open.push(staged);
    await staged.write(new TextEncoder().encode('partial download'));
    await updateFs.removeLeftovers(directory);
    expect(fs.existsSync(staged.path)).toBe(true);
  });
});
