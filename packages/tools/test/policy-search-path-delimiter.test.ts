import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPolicyFilesystem } from '@momonga/tools';
import { createTempDir } from '@momonga/testkit';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const twoDirectories = (): { empty: string; holding: string; program: string } => {
  const root = createTempDir();
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const empty = path.join(root, 'empty');
  const holding = path.join(root, 'holding');
  fs.mkdirSync(empty);
  fs.mkdirSync(holding);
  const program = path.join(holding, 'tool-under-test');
  fs.writeFileSync(program, '#!/bin/sh\n', { mode: 0o755 });
  return { empty, holding, program };
};

const NOT_WRITABLE = (): boolean => false;
const SHELLS = { isExecutable: () => true, env: {} };
const NEVER = new AbortController().signal;

describe('the search path of a program is split by the delimiter of the platform asked about', () => {
  it('splits on a colon for a POSIX platform', async () => {
    const { empty, holding, program } = twoDirectories();
    const host = createPolicyFilesystem('linux', SHELLS);
    expect(await host.resolveProgram('tool-under-test', empty, `${empty}:${holding}`, NOT_WRITABLE, NEVER)).toEqual({ program });
  });

  it('splits on a semicolon for Windows, where a colon belongs to a drive', async () => {
    const { empty, holding, program } = twoDirectories();
    const host = createPolicyFilesystem('win32', SHELLS);
    expect(await host.resolveProgram('tool-under-test', empty, `${empty};${holding}`, NOT_WRITABLE, NEVER)).toEqual({ program });
    expect(await host.resolveProgram('tool-under-test', empty, `${empty}:${holding}`, NOT_WRITABLE, NEVER)).toEqual({ none: true });
  });
});
