import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide } from '@momonga/policy';
import type { DecideInput, PermissionSubject, PolicyTool } from '@momonga/policy';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, protectedSetWith } from './helpers.ts';

const WRITE: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write', subjectKind: 'path' };

const loopGuard = () => {
  const layout = makeLayout();
  fs.mkdirSync(layout.project, { recursive: true });
  const loop = path.join(layout.root, 'loop');
  fs.symlinkSync(loop, loop);
  return { layout, loop, guard: path.join(loop, 'x') };
};

const writeInput = (layout: ReturnType<typeof makeLayout>, target: string, guard: string): DecideInput => ({
  tool: WRITE,
  subject: { kind: 'path', tool: 'Write', paths: [target], access: 'write' } satisfies PermissionSubject,
  mode: 'acceptEdits',
  rules: [],
  roots: [layout.project],
  fileRules: fileRulesFor([], [layout.project]),
  home: layout.home,
  cwd: layout.project,
  protectedSet: protectedSetWith([layout.project], [guard]),
  fs: fakeFs(), searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor([layout.project]),
});

describe('an unresolvable protected path', () => {
  it('does not block an unrelated write', () => {
    const { layout, guard } = loopGuard();
    const target = path.join(layout.project, 'a.txt');
    expect(decide(writeInput(layout, target, guard))).toMatchObject({ kind: 'allow', source: 'mode' });
  });

  it('asks before a write lexically under the guard', () => {
    const { layout, loop, guard } = loopGuard();
    expect(decide(writeInput(layout, path.join(loop, 'x', 'y'), guard))).toMatchObject({ kind: 'ask', source: 'protected' });
  });
});
