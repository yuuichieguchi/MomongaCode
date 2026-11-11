import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFsInstructionReader } from '@momonga/context';
import { NEVER_CANCELLED } from '@momonga/testkit';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ctx-')));
  dirs.push(dir);
  return dir;
};

describe('createFsInstructionReader', () => {
  it('reads an existing file with its real path', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, 'hello rules');
    const result = await createFsInstructionReader(NEVER_CANCELLED, process.platform).read(file);
    expect(result).toEqual({ realPath: file, text: 'hello rules' });
  });

  it('returns undefined for a missing file', async () => {
    const dir = makeDir();
    expect(await createFsInstructionReader(NEVER_CANCELLED, process.platform).read(path.join(dir, 'AGENTS.md'))).toBeUndefined();
  });

  it('returns undefined when the path is a directory', async () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'AGENTS.md'));
    expect(await createFsInstructionReader(NEVER_CANCELLED, process.platform).read(path.join(dir, 'AGENTS.md'))).toBeUndefined();
  });

  it('resolves a symlink to its target', async () => {
    const project = makeDir();
    const outside = makeDir();
    const target = path.join(outside, 'real.md');
    fs.writeFileSync(target, 'outside rules');
    const link = path.join(project, 'AGENTS.md');
    fs.symlinkSync(target, link);
    expect(await createFsInstructionReader(NEVER_CANCELLED, process.platform).read(link)).toEqual({ realPath: target, text: 'outside rules' });
  });

  it('decodes UTF-8 text', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, 'ルール ✓');
    expect((await createFsInstructionReader(NEVER_CANCELLED, process.platform).read(file))?.text).toBe('ルール ✓');
  });
});
