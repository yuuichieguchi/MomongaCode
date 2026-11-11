import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { decide, suggestAllowRule } from '@momonga/policy';

import type { DecideInput, PermissionSubject, PolicyTool } from '@momonga/policy';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, protectedSetOf } from './helpers.ts';

import type { Layout } from './helpers.ts';
import { syncPaths } from '@momonga/foundation';


const RUNNING_AS_ROOT = process.getuid?.() === 0;

const WRITE: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write', subjectKind: 'path' };
const READ: PolicyTool = { name: 'Read', kind: 'read', sideEffect: 'read_only' };

const withLockedDirectory = async <T>(action: (layout: Layout, locked: string) => T | Promise<T>): Promise<T> => {
  const layout = makeLayout();
  const locked = path.join(layout.project, 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o000);
  try {
    return await action(layout, locked);
  } finally {
    fs.chmodSync(locked, 0o700);
  }
};

const inputFor = async (layout: Layout, tool: PolicyTool, subject: PermissionSubject, extra: Partial<DecideInput> = {}): Promise<DecideInput> => ({
  tool,
  subject,
  mode: 'acceptEdits',
  rules: [],
  roots: [layout.project],
  home: layout.home,
  cwd: layout.project,
  fileRules: await fileRulesFor([], [layout.project]),
  fs: fakeFs(), searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor([layout.project]),
  protectedSet: EMPTY_PROTECTED_SET,
  ...extra,
});

describe.skipIf(RUNNING_AS_ROOT)('candidate-side canonicalisation under a mode 000 directory', () => {
  it('fs.canonicalise returns a typed EACCES and does not throw', async () => {
    await withLockedDirectory(async (_layout, locked) => {
      expect(await fakeFs().canonicalise(path.join(locked, 'x', 'y'))).toEqual({ ok: false, reason: { kind: 'errno', code: 'EACCES' } });
    });
  });

  it('decide asks as a protected write and names the errno', async () => {
    await withLockedDirectory(async (layout, locked) => {
      const subject: PermissionSubject = { kind: 'path', tool: 'Write', paths: [path.join(locked, 'x', 'y')], access: 'write' };
      const decision = await decide(await inputFor(layout, WRITE, subject, { protectedSet: await protectedSetOf([layout.project]) }));
      expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
      expect(decision.reason).toContain('EACCES');
    });
  });

  it('decide treats a read below it as outside the roots (pin)', async () => {
    await withLockedDirectory(async (layout, locked) => {
      const subject: PermissionSubject = { kind: 'path', tool: 'Read', paths: [path.join(locked, 'x', 'y')], access: 'read' };
      const decision = await decide({ ...(await inputFor(layout, READ, subject)), mode: 'manual' });
      expect(decision.kind).toBe('ask');
    });
  });

  it('suggestAllowRule suggests nothing (pin)', async () => {
    await withLockedDirectory(async (layout, locked) => {
      const subject: PermissionSubject = { kind: 'path', tool: 'Write', paths: [path.join(locked, 'x', 'y')], access: 'write' };
      expect(await suggestAllowRule(WRITE, subject, layout.project, syncPaths.resolveCanonicalPath)).toBeUndefined();
    });
  });
});

describe('candidate-side canonicalisation goes through fs.canonicalise', () => {
  it('routes the target of a Write subject through the port', async () => {
    const layout = makeLayout();
    const seen: string[] = [];
    const target = path.join(layout.project, 'a.txt');
    const filesystem = fakeFs({
      overrides: {
        canonicalise: (absolute) => {
          seen.push(absolute);
          return syncPaths.resolveCanonicalPath(absolute);
        },
      },
    });
    const subject: PermissionSubject = { kind: 'path', tool: 'Write', paths: [target], access: 'write' };
    expect((await decide(await inputFor(layout, WRITE, subject, { fs: filesystem }))).kind).toBe('allow');
    expect(seen).toContain(target);
  });

  it('rethrows EMFILE from fs.canonicalise', async () => {
    const layout = makeLayout();
    const emfile = Object.assign(new Error('EMFILE: injected'), { code: 'EMFILE' });
    const filesystem = fakeFs({
      overrides: {
        canonicalise: () => {
          throw emfile;
        },
      },
    });
    const subject: PermissionSubject = { kind: 'path', tool: 'Write', paths: [path.join(layout.project, 'a.txt')], access: 'write' };
    let caught: unknown;
    try {
      await decide(await inputFor(layout, WRITE, subject, { fs: filesystem }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(emfile);
  });

  it('rethrows EMFILE from the canonicalise passed to suggestAllowRule', async () => {
    const layout = makeLayout();
    const emfile = Object.assign(new Error('EMFILE: injected'), { code: 'EMFILE' });
    const subject: PermissionSubject = { kind: 'path', tool: 'Write', paths: [path.join(layout.project, 'a.txt')], access: 'write' };
    let caught: unknown;
    try {
      await suggestAllowRule(WRITE, subject, layout.project, async () => {
        throw emfile;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(emfile);
  });
});
