import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFsInstructionReader } from '@momonga/context';
import { createTempDir } from '@momonga/testkit';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const fileIn = (): string => {
  const dir = createTempDir();
  dirs.push(dir);
  const file = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(file, 'rules');
  return file;
};

describe('an instruction read ends with the operation that asked for it', () => {
  it.each(['read', 'exists', 'realpath'] as const)('%s answers the reason of an ended asker, not the file', async (method) => {
    const asker = new AbortController();
    const ended = new Error('the claim ended');
    asker.abort(ended);
    await expect(createFsInstructionReader(asker.signal, process.platform)[method](fileIn())).rejects.toBe(ended);
  });
});

describe('the instruction reader takes its platform from the start', () => {
  it('names the platform it was given, not the host it runs on', () => {
    expect(createFsInstructionReader(new AbortController().signal, 'win32').platform).toBe('win32');
  });
});
