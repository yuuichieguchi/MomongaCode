import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide } from '@momonga/policy';
import type { DecideInput, PermissionSubject, PolicyTool } from '@momonga/policy';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, protectedSetWith } from './helpers.ts';

const WRITE: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write', subjectKind: 'path' };

const loopGuard = async () => {
  const layout = makeLayout();
  fs.mkdirSync(layout.project, { recursive: true });
  const loop = path.join(layout.root, 'loop');
  fs.symlinkSync(loop, loop);
  return { layout, loop, guard: path.join(loop, 'x') };
};

const writeInput = async (layout: ReturnType<typeof makeLayout>, target: string, guard: string): Promise<DecideInput> => ({
  tool: WRITE,
  subject: { kind: 'path', tool: 'Write', paths: [target], access: 'write' } satisfies PermissionSubject,
  mode: 'acceptEdits',
  rules: [],
  roots: [layout.project],
  fileRules: await fileRulesFor([], [layout.project]),
  home: layout.home,
  cwd: layout.project,
  protectedSet: protectedSetWith([layout.project], [guard]),
  fs: fakeFs(), searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor([layout.project]),
});

describe('an unresolvable protected path', () => {
  it('does not block an unrelated write', async () => {
    const { layout, guard } = await loopGuard();
    const target = path.join(layout.project, 'a.txt');
    expect(await decide(await writeInput(layout, target, guard))).toMatchObject({ kind: 'allow', source: 'mode' });
  });

  it('asks before a write lexically under the guard', async () => {
    const { layout, loop, guard } = await loopGuard();
    expect(await decide(await writeInput(layout, path.join(loop, 'x', 'y'), guard))).toMatchObject({ kind: 'ask', source: 'protected' });
  });
});
