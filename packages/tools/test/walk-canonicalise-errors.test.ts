import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES } from '@momonga/foundation';
import { walkFiles } from '../src/builtins/walk.ts';
import { makeLayout } from './helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('walker canonicalisation of a symlinked file (OP-8 debt: node:fs spy until R7)', () => {
  it('rethrows EMFILE from the lstat of the link instead of skipping the entry', async () => {
    const layout = makeLayout();
    fs.writeFileSync(path.join(layout.project, 'target.txt'), 'x');
    const link = path.join(layout.project, 'link.txt');
    fs.symlinkSync(path.join(layout.project, 'target.txt'), link);
    const emfile = Object.assign(new Error('EMFILE: injected'), { code: 'EMFILE' });
    const original = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
      if (target === link) throw emfile;
      return (original as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.promises.lstat);
    const walk = async (): Promise<void> => {
      for await (const _entry of walkFiles({
        root: layout.project,
        readDenied: [],
        readAllowed: undefined,
        fileRules: EMPTY_FILE_RULES,
        tool: 'Glob',
        includeSymlinkedFiles: true,
        signal: new AbortController().signal,
        onUnreadable: () => undefined,
        onRuleBlocked: () => undefined,
      })) {
        continue;
      }
    };
    await expect(walk()).rejects.toBe(emfile);
  });
});
