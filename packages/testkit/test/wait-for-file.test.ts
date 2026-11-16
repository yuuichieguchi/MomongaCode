import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForFile } from '../src/wait-for.ts';
import { createTempDir, removeTempDir } from '../src/test-support.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

const freshDir = (): string => {
  const dir = createTempDir();
  dirs.push(dir);
  return dir;
};

describe('waitForFile reads the file again on every poll, under a bound and a signal', () => {
  it('returns the content once the file holds what is asked, with no file-system event needed', async () => {
    const file = path.join(freshDir(), 'ready');
    fs.writeFileSync(file, 'starting');
    const waiting = waitForFile(file, { description: 'ready', boundMs: 5000, holds: (content) => content === 'ready' });
    fs.writeFileSync(file, 'ready');
    expect(await waiting).toBe('ready');
  });

  it('fails with its description when the bound passes', async () => {
    const file = path.join(freshDir(), 'never');
    await expect(waitForFile(file, { description: 'a file that never comes', boundMs: 50 })).rejects.toThrow(/a file that never comes not met within 50 ms/);
  });

  it('ends with the reason of its signal', async () => {
    const controller = new AbortController();
    const waiting = waitForFile(path.join(freshDir(), 'held'), { description: 'held', boundMs: 5000, signal: controller.signal });
    controller.abort(new Error('released by abort'));
    await expect(waiting).rejects.toThrow('released by abort');
  });
});
