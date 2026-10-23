import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { volumeIsCaseInsensitive } from '@momonga/policy';
import { buildSandboxPolicy } from '@momonga/tools';
import { makeLayout } from '../helpers.ts';

const fixture = () => {
  const layout = makeLayout();
  const sessions = momongaLayout(layout.home, 'darwin', {}).tmp.sessions;
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
    it(`denies writes to .momonga, Keychains and the sessions root with roots of ${label}`, () => {
      const { layout, sessions, tmpDir } = fixture();
      const policy = buildSandboxPolicy({ roots: rootsOf(layout), home: layout.home, tmpDir, sessionsTmpRoot: sessions });
      expect(policy.writeDenied).toEqual(
        expect.arrayContaining([path.join(layout.home, '.momonga'), path.join(layout.home, 'Library', 'Keychains'), sessions]),
      );
    });
  }

  it('keeps the protected paths of every root for a normal project', () => {
    const { layout, sessions, tmpDir } = fixture();
    const policy = buildSandboxPolicy({ roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions });
    expect(policy.writeDenied).toEqual(expect.arrayContaining([path.join(layout.project, '.git', 'hooks'), path.join(layout.project, '.momonga')]));
    expect(policy.writableRoots).toEqual([layout.project, tmpDir]);
  });
});

describe('buildSandboxPolicy session tmp invariants', () => {
  it('denies reads of the sessions root before extraReadDenied', () => {
    const { layout, sessions, tmpDir } = fixture();
    const ssh = path.join(layout.home, '.ssh');
    const policy = buildSandboxPolicy({ roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, extraReadDenied: [ssh] });
    expect(policy.readDenied).toEqual([path.join(layout.home, '.momonga'), path.join(layout.home, 'Library', 'Keychains'), sessions, ssh]);
  });

  it('allows reading tmpDir without a readAllowed option', () => {
    const { layout, sessions, tmpDir } = fixture();
    const policy = buildSandboxPolicy({ roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions });
    expect(policy.readAllowed).toEqual([tmpDir]);
  });

  it('deduplicates tmpDir given again in readAllowed', () => {
    const { layout, sessions, tmpDir } = fixture();
    const policy = buildSandboxPolicy({ roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, readAllowed: [tmpDir] });
    expect(policy.readAllowed).toEqual([tmpDir]);
  });

  it('puts tmpDir before the other readAllowed entries', () => {
    const { layout, sessions, tmpDir } = fixture();
    const vault = path.join(layout.outside, 'vault');
    const ok = path.join(vault, 'ok');
    fs.mkdirSync(ok, { recursive: true });
    const policy = buildSandboxPolicy({ roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, extraReadDenied: [vault], readAllowed: [ok, tmpDir] });
    expect(policy.readAllowed).toEqual([tmpDir, ok]);
  });

  it('throws for readAllowed equal to the sessions root without extraReadDenied', () => {
    const { layout, sessions, tmpDir } = fixture();
    expect(() => buildSandboxPolicy({ roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, readAllowed: [sessions] })).toThrow();
  });
});

describe('buildSandboxPolicy readAllowed validation', () => {
  it('throws for an entry outside every readDenied entry', () => {
    const { layout, sessions, tmpDir } = fixture();
    expect(() =>
      buildSandboxPolicy({ roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, readAllowed: [layout.outside] }),
    ).toThrow();
  });

  it('throws for an entry equal to a readDenied entry', () => {
    const { layout, sessions, tmpDir } = fixture();
    expect(() =>
      buildSandboxPolicy({ roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, readAllowed: [sessions] }),
    ).toThrow();
  });

  it('throws for an entry that is an ancestor of a readDenied entry', () => {
    const { layout, sessions, tmpDir } = fixture();
    const vault = path.join(layout.outside, 'vault');
    const inner = path.join(vault, 'a', 'b');
    fs.mkdirSync(inner, { recursive: true });
    expect(() =>
      buildSandboxPolicy({
        roots: [layout.project],
        home: layout.home,
        tmpDir,
        sessionsTmpRoot: sessions,
        extraReadDenied: [vault, inner],
        readAllowed: [path.join(vault, 'a')],
      }),
    ).toThrow();
  });

  it('throws for an entry inside home/.momonga', () => {
    const { layout, sessions, tmpDir } = fixture();
    const inside = path.join(layout.home, '.momonga', 'projects');
    fs.mkdirSync(inside, { recursive: true });
    expect(() =>
      buildSandboxPolicy({ roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, readAllowed: [inside] }),
    ).toThrow();
  });

  it('throws for an entry inside home/Library/Keychains', () => {
    const { layout, sessions, tmpDir } = fixture();
    const inside = path.join(layout.home, 'Library', 'Keychains', 'sub');
    fs.mkdirSync(inside, { recursive: true });
    expect(() =>
      buildSandboxPolicy({ roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, readAllowed: [inside] }),
    ).toThrow();
  });

  it('throws for an entry that reaches home/.momonga through a symlink inside a readDenied entry', () => {
    const { layout, sessions, tmpDir } = fixture();
    const momonga = path.join(layout.home, '.momonga');
    fs.mkdirSync(momonga, { recursive: true });
    const link = path.join(tmpDir, 'link');
    fs.symlinkSync(momonga, link);
    expect(() =>
      buildSandboxPolicy({ roots: [layout.project], home: layout.home, tmpDir, sessionsTmpRoot: sessions, readAllowed: [link] }),
    ).toThrow();
  });
});

describe.runIf(volumeIsCaseInsensitive(os.tmpdir()))('buildSandboxPolicy readAllowed validation on a case-insensitive volume', () => {
  it('throws for an entry inside Keychains spelled in another case', () => {
    const { layout, sessions, tmpDir } = fixture();
    const library = path.join(layout.home, 'Library');
    fs.mkdirSync(path.join(library, 'Keychains'), { recursive: true });
    expect(() =>
      buildSandboxPolicy({
        roots: [layout.project],
        home: layout.home,
        tmpDir,
        sessionsTmpRoot: sessions,
        extraReadDenied: [library],
        readAllowed: [path.join(library, 'KEYCHAINS')],
      }),
    ).toThrow();
  });

  it('throws for an entry equal to home/.momonga in another case', () => {
    const { layout, sessions, tmpDir } = fixture();
    fs.mkdirSync(path.join(layout.home, '.momonga'), { recursive: true });
    expect(() =>
      buildSandboxPolicy({
        roots: [layout.project],
        home: layout.home,
        tmpDir,
        sessionsTmpRoot: sessions,
        extraReadDenied: [layout.home],
        readAllowed: [path.join(layout.home, '.MOMONGA')],
      }),
    ).toThrow();
  });

  it('throws for an entry equal to the sessions root in another case', () => {
    const { layout, sessions, tmpDir } = fixture();
    expect(() =>
      buildSandboxPolicy({
        roots: [layout.project],
        home: layout.home,
        tmpDir,
        sessionsTmpRoot: sessions,
        extraReadDenied: [path.dirname(sessions)],
        readAllowed: [path.join(path.dirname(sessions), path.basename(sessions).toUpperCase())],
      }),
    ).toThrow();
  });
});
