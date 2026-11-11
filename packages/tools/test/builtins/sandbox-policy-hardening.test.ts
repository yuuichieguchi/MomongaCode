import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, momongaLayout, protectedSetFor, standardSecretLocations, syncPaths } from '@momonga/foundation';
import { fakePolicyFilesystem, NEVER_CANCELLED } from '@momonga/testkit';

import { buildSandboxPolicy } from '@momonga/tools';
import { makeLayout } from '../helpers.ts';

const fixture = () => {
  const layout = makeLayout();
  const sessions = momongaLayout(layout.home, process.platform, {}).tmp.sessions;
  const tmpDir = path.join(sessions, 'session-1');
  fs.mkdirSync(tmpDir, { recursive: true });
  return { layout, sessions, tmpDir };
};

describe('buildSandboxPolicy always-denied writes', () => {
  const rootCases: Array<[string, (layout: ReturnType<typeof makeLayout>) => string[]]> = [
    ['/', () => ['/']],
    ['home', (layout) => [layout.home]],
    ['the parent of home', (layout) => [path.dirname(layout.home)]],
    ['a normal project', (layout) => [layout.project]],
  ];

  for (const [label, rootsOf] of rootCases) {
    it(`denies writes to .momonga, Keychains and the sessions root with roots of ${label}`, async () => {
      const { layout, sessions, tmpDir } = fixture();
      const policy = await buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, roots: rootsOf(layout), home: layout.home, tmpDir, sessionsTmpRoot: sessions }, NEVER_CANCELLED);
      expect(policy.writeDenied).toEqual(
        expect.arrayContaining([path.join(layout.home, '.momonga'), momongaLayout(layout.home).keychains, sessions]),
      );
    });
  }

  it('keeps the protected paths of the protected set for a normal project', async () => {
    const { layout, sessions, tmpDir } = fixture();
    const protectedSet = await protectedSetFor([layout.project], fakePolicyFilesystem());
    const policy = await buildSandboxPolicy({ protectedSet, fileRules: EMPTY_FILE_RULES, roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions }, NEVER_CANCELLED);
    expect(policy.protectedSet).toBe(protectedSet);
    expect(policy.writeDenied).toEqual(
      expect.arrayContaining([
        path.join(layout.project, '.git', 'hooks'),
        path.join(layout.project, '.git', 'config.worktree'),
        path.join(layout.project, '.git', 'commondir'),
        path.join(layout.project, '.momonga'),
      ]),
    );
    expect(policy.writableRoots).toEqual([layout.project, tmpDir]);
  });
});

describe('buildSandboxPolicy session tmp invariants', () => {
  it('denies reads of the sessions root before extraReadDenied', async () => {
    const { layout, sessions, tmpDir } = fixture();
    const ssh = path.join(layout.home, '.ssh');
    const policy = await buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, extraReadDenied: [ssh] }, NEVER_CANCELLED);
    expect(policy.readDenied).toEqual([...standardSecretLocations(layout.home).map((location) => location.directory), sessions, ssh]);
  });

  it('allows reading tmpDir without a readAllowed option', async () => {
    const { layout, sessions, tmpDir } = fixture();
    const policy = await buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions }, NEVER_CANCELLED);
    expect(policy.readAllowed).toEqual([tmpDir]);
  });

  it('deduplicates tmpDir given again in readAllowed', async () => {
    const { layout, sessions, tmpDir } = fixture();
    const policy = await buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, readAllowed: [tmpDir] }, NEVER_CANCELLED);
    expect(policy.readAllowed).toEqual([tmpDir]);
  });

  it('puts tmpDir before the other readAllowed entries', async () => {
    const { layout, sessions, tmpDir } = fixture();
    const vault = path.join(layout.outside, 'vault');
    const ok = path.join(vault, 'ok');
    fs.mkdirSync(ok, { recursive: true });
    const policy = await buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, extraReadDenied: [vault], readAllowed: [ok, tmpDir] }, NEVER_CANCELLED);
    expect(policy.readAllowed).toEqual([tmpDir, ok]);
  });

  it('throws for readAllowed equal to the sessions root without extraReadDenied', async () => {
    const { layout, sessions, tmpDir } = fixture();
    await expect(buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, readAllowed: [sessions] }, NEVER_CANCELLED)).rejects.toThrow();
  });
});

describe('buildSandboxPolicy readAllowed validation', () => {
  it('throws for an entry outside every readDenied entry', async () => {
    const { layout, sessions, tmpDir } = fixture();
    await expect((async () =>
      await buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, readAllowed: [layout.outside] }, NEVER_CANCELLED))()).rejects.toThrow();
  });

  it('throws for an entry equal to a readDenied entry', async () => {
    const { layout, sessions, tmpDir } = fixture();
    await expect((async () =>
      await buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, readAllowed: [sessions] }, NEVER_CANCELLED))()).rejects.toThrow();
  });

  it('throws for an entry that is an ancestor of a readDenied entry', async () => {
    const { layout, sessions, tmpDir } = fixture();
    const vault = path.join(layout.outside, 'vault');
    const inner = path.join(vault, 'a', 'b');
    fs.mkdirSync(inner, { recursive: true });
    await expect((async () =>
      await buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES,
        roots: [layout.project],
        home: layout.home,
        tmpDir,
        sessionsTmpRoot: sessions,
        extraReadDenied: [vault, inner],
        readAllowed: [path.join(vault, 'a')],
      }, NEVER_CANCELLED))()).rejects.toThrow();
  });

  it('throws for an entry inside home/.momonga', async () => {
    const { layout, sessions, tmpDir } = fixture();
    const inside = path.join(layout.home, '.momonga', 'projects');
    fs.mkdirSync(inside, { recursive: true });
    await expect((async () =>
      await buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, readAllowed: [inside] }, NEVER_CANCELLED))()).rejects.toThrow();
  });

  it('throws for an entry inside the platform keychains', async () => {
    const { layout, sessions, tmpDir } = fixture();
    const inside = path.join(momongaLayout(layout.home).keychains, 'sub');
    fs.mkdirSync(inside, { recursive: true });
    await expect((async () =>
      await buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, readAllowed: [inside] }, NEVER_CANCELLED))()).rejects.toThrow();
  });

  it('throws for an entry that reaches home/.momonga through a symlink inside a readDenied entry', async () => {
    const { layout, sessions, tmpDir } = fixture();
    const momonga = path.join(layout.home, '.momonga');
    fs.mkdirSync(momonga, { recursive: true });
    const link = path.join(tmpDir, 'link');
    fs.symlinkSync(momonga, link);
    await expect((async () =>
      await buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, readAllowed: [link] }, NEVER_CANCELLED))()).rejects.toThrow();
  });
});

describe.runIf(syncPaths.volumeIsCaseInsensitive(os.tmpdir()))('buildSandboxPolicy readAllowed validation on a case-insensitive volume', () => {
  it('throws for an entry inside Keychains spelled in another case', async () => {
    const { layout, sessions, tmpDir } = fixture();
    const library = path.join(layout.home, 'Library');
    fs.mkdirSync(path.join(library, 'Keychains'), { recursive: true });
    await expect((async () =>
      await buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES,
        roots: [layout.project],
        home: layout.home,
        tmpDir,
        sessionsTmpRoot: sessions,
        extraReadDenied: [library],
        readAllowed: [path.join(library, 'KEYCHAINS')],
      }, NEVER_CANCELLED))()).rejects.toThrow();
  });

  it('throws for an entry equal to home/.momonga in another case', async () => {
    const { layout, sessions, tmpDir } = fixture();
    fs.mkdirSync(path.join(layout.home, '.momonga'), { recursive: true });
    await expect((async () =>
      await buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES,
        roots: [layout.project],
        home: layout.home,
        tmpDir,
        sessionsTmpRoot: sessions,
        extraReadDenied: [layout.home],
        readAllowed: [path.join(layout.home, '.MOMONGA')],
      }, NEVER_CANCELLED))()).rejects.toThrow();
  });

  it('throws for an entry equal to the sessions root in another case', async () => {
    const { layout, sessions, tmpDir } = fixture();
    await expect((async () =>
      await buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES,
        roots: [layout.project],
        home: layout.home,
        tmpDir,
        sessionsTmpRoot: sessions,
        extraReadDenied: [path.dirname(sessions)],
        readAllowed: [path.join(path.dirname(sessions), path.basename(sessions).toUpperCase())],
      }, NEVER_CANCELLED))()).rejects.toThrow();
  });
});
