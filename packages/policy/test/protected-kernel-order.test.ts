import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide } from '@momonga/policy';
import type { PolicyTool } from '@momonga/policy';
import { fileRulesFor, makeLayout } from './helpers.ts';

const WRITE: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write' };

describe('protected dangling link whose target has dotdot after a symlink', () => {
  it('protects the location the kernel would write through the link', () => {
    const layout = makeLayout();
    const envrc = path.join(layout.project, '.envrc');
    fs.mkdirSync(path.join(layout.project, 'sub', 'deep'), { recursive: true });
    fs.symlinkSync(path.join(layout.project, 'sub', 'deep'), path.join(layout.project, 's'));
    fs.symlinkSync('s/../evil', envrc);
    const decision = decide({
      tool: WRITE,
      subject: { kind: 'path', tool: 'Write', paths: [path.join(layout.project, 'sub', 'evil')], access: 'write' },
      mode: 'acceptEdits',
      rules: [],
      roots: [layout.project],
      home: layout.home,
      cwd: layout.project,
      protectedPaths: [envrc], fileRules: fileRulesFor([], [layout.project]),
    });
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
  });
});
