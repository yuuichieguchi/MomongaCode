import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide } from '@momonga/policy';
import type { PolicyTool } from '@momonga/policy';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, protectedSetWith } from './helpers.ts';

const WRITE: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write', subjectKind: 'path' };

describe('protected dangling link whose target has dotdot after a symlink', () => {
  it('protects the location the kernel would write through the link', async () => {
    const layout = makeLayout();
    const envrc = path.join(layout.project, '.envrc');
    fs.mkdirSync(path.join(layout.project, 'sub', 'deep'), { recursive: true });
    fs.symlinkSync(path.join(layout.project, 'sub', 'deep'), path.join(layout.project, 's'));
    fs.symlinkSync('s/../evil', envrc);
    const decision = await decide({
      tool: WRITE,
      subject: { kind: 'path', tool: 'Write', paths: [path.join(layout.project, 'sub', 'evil')], access: 'write' },
      mode: 'acceptEdits',
      rules: [],
      roots: [layout.project],
      home: layout.home,
      cwd: layout.project,
      protectedSet: protectedSetWith([layout.project], [envrc]), fs: fakeFs(), searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor([layout.project]), fileRules: await fileRulesFor([], [layout.project]),
    });
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
  });
});
