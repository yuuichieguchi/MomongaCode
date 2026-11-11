import fs from 'node:fs';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, momongaLayout, syncPaths } from '@momonga/foundation';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { alwaysWriteDenied, buildSeatbeltProfile } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { withTempDir, NEVER_CANCELLED, testPaths } from '@momonga/testkit';
import { createLauncherFixture, launcherLinksFile, recordLauncherLinks } from './launcher-fixture.ts';

const keychainsOf = (home: string): string => momongaLayout(home, process.platform, process.env).keychains;

const ancestorsWithinHome = (home: string, subtree: string): string[] => {
  const found: string[] = [];
  const canonicalHome = syncPaths.canonicalPath(home);
  for (let directory = path.dirname(syncPaths.canonicalPath(subtree)); directory !== canonicalHome; directory = path.dirname(directory)) found.push(directory);
  return [...found, canonicalHome];
};

const deniedSubtreeAncestors = (home: string): string[] => [...ancestorsWithinHome(home, keychainsOf(home)), ...ancestorsWithinHome(home, momongaLayout(home, process.platform, process.env).executables)];

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

const paramsOfRule = (profile: string, params: Record<string, string>, rule: string): string[] => {
  const pattern = new RegExp(`^\\(deny ${rule.replace('*', '\\*')} \\(literal \\(param "([^"]+)"\\)\\)\\)$`, 'gm');
  return [...profile.matchAll(pattern)].map((match) => params[match[1] ?? ''] ?? `<missing param ${match[1]}>`);
};

const policyFor = async (home: string): Promise<SandboxPolicy> => {
  const denied = await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED);
  return {
    writableRoots: [home],
    writeDenied: [...denied.subtrees],
    protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [...denied.literals], fileRules: EMPTY_FILE_RULES,
    readDenied: [],
    network: 'deny',
  };
};

describe('alwaysWriteDenied', () => {
  it('returns the momonga root and the keychains as subtrees and the launcher as a literal for a plain ~/.local', async (context) => {
    const { home } = createLauncherFixture(withTempDir(context), 'plain');
    const denied = await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED);
    expect(denied.root).toBe(path.join(home, '.momonga'));
    expect(denied.keychains).toBe(keychainsOf(home));
    expect([...denied.subtrees].sort()).toEqual([denied.root, denied.keychains, path.join(momongaLayout(home, process.platform, process.env).cacheBase, 'executables')].sort());
    expect(sortedUnique(denied.literals)).toEqual([path.join(home, '.local', 'bin', 'momonga')]);
  });

  it('returns both the lexical link and its canonical-parent form when ~/.local is a symlink', async (context) => {
    const { home } = createLauncherFixture(withTempDir(context), 'symlinked');
    const denied = await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED);
    expect(denied.root).toBe(path.join(home, '.momonga'));
    expect(denied.keychains).toBe(keychainsOf(home));
    expect([...denied.subtrees].sort()).toEqual([denied.root, denied.keychains, path.join(momongaLayout(home, process.platform, process.env).cacheBase, 'executables')].sort());
    expect(sortedUnique(denied.literals)).toEqual(
      sortedUnique([path.join(home, '.local', 'bin', 'momonga'), path.join(home, 'dotfiles', 'local', 'bin', 'momonga')]),
    );
  });

  it('denies the executables area of the cache base the product runs with, which XDG_CACHE_HOME moves on Linux', async (context) => {
    const { home } = createLauncherFixture(withTempDir(context), 'plain');
    const cache = path.join(home, 'elsewhere-cache');
    const denied = await alwaysWriteDenied(momongaLayout(home, 'linux', { XDG_CACHE_HOME: cache }), NEVER_CANCELLED);
    expect(denied.executables).toBe(path.join(cache, 'momonga', 'executables'));
    expect(denied.subtrees).toContain(path.join(cache, 'momonga', 'executables'));
  });

  it('never follows the final link to the versioned target', async (context) => {
    const { home, target } = createLauncherFixture(withTempDir(context), 'symlinked');
    const denied = await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED);
    expect(denied.literals).not.toContain(target);
  });
});

describe('buildSeatbeltProfile with writeDeniedLiterals', () => {
  it('emits file-write* literal denies for the link and unlink denies for its ancestors in a plain layout', async (context) => {
    const { home } = createLauncherFixture(withTempDir(context), 'plain');
    const { profile, params } = await buildSeatbeltProfile(await policyFor(home), {}, testPaths());
    expect(sortedUnique(paramsOfRule(profile, params, 'file-write*'))).toEqual([path.join(home, '.local', 'bin', 'momonga')]);
    expect(sortedUnique(paramsOfRule(profile, params, 'file-write-unlink'))).toEqual(
      sortedUnique([path.join(home, '.local', 'bin'), path.join(home, '.local'), ...deniedSubtreeAncestors(home)]),
    );
  });

  it('emits lexical and canonical literal and ancestor denies when ~/.local is a symlink', async (context) => {
    const { home } = createLauncherFixture(withTempDir(context), 'symlinked');
    const { profile, params } = await buildSeatbeltProfile(await policyFor(home), {}, testPaths());
    expect(sortedUnique(paramsOfRule(profile, params, 'file-write*'))).toEqual(
      sortedUnique([path.join(home, '.local', 'bin', 'momonga'), path.join(home, 'dotfiles', 'local', 'bin', 'momonga')]),
    );
    expect(sortedUnique(paramsOfRule(profile, params, 'file-write-unlink'))).toEqual(
      sortedUnique([
        path.join(home, '.local', 'bin'),
        path.join(home, '.local'),
        path.join(home, 'dotfiles', 'local', 'bin'),
        path.join(home, 'dotfiles', 'local'),
        path.join(home, 'dotfiles'),
        ...deniedSubtreeAncestors(home),
      ]),
    );
  });

  it('does not canonicalize the literal onto the versioned target', async (context) => {
    const { home, target } = createLauncherFixture(withTempDir(context), 'symlinked');
    const { profile, params } = await buildSeatbeltProfile(await policyFor(home), {}, testPaths());
    expect(paramsOfRule(profile, params, 'file-write*')).not.toContain(target);
  });

  it('never interpolates the literal paths into the profile text', async (context) => {
    const { home } = createLauncherFixture(withTempDir(context), 'symlinked');
    const { profile } = await buildSeatbeltProfile(await policyFor(home), {}, testPaths());
    expect(profile).not.toContain(home);
  });

  it('still emits subtree denies for the momonga root and the keychains from the single source', async (context) => {
    const { home } = createLauncherFixture(withTempDir(context), 'plain');
    const { profile, params } = await buildSeatbeltProfile(await policyFor(home), {}, testPaths());
    const subtreeDenied = [...profile.matchAll(/^\(deny file-write\* \(subpath \(param "([^"]+)"\)\)\)$/gm)].map((match) => params[match[1] ?? '']);
    expect(subtreeDenied).toEqual(expect.arrayContaining([path.join(home, '.momonga'), keychainsOf(home)]));
  });
});

describe('alwaysWriteDenied reads the installer launcher-links record', () => {
  const defaultLink = (home: string): string => path.join(home, '.local', 'bin', 'momonga');

  it('adds a recorded custom link next to the default link', async (context) => {
    const { home, launcher } = createLauncherFixture(withTempDir(context), 'custom');
    expect(sortedUnique((await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED)).literals)).toEqual(sortedUnique([defaultLink(home), launcher]));
  });

  it('adds the canonical-parent form of a recorded link whose directory is reached through a symlink', async (context) => {
    const home = withTempDir(context);
    fs.mkdirSync(path.join(home, 'real', 'bin'), { recursive: true });
    fs.symlinkSync(path.join(home, 'real'), path.join(home, 'alias'));
    const recorded = path.join(home, 'alias', 'bin', 'momonga');
    fs.symlinkSync(path.join(home, 'nowhere'), recorded);
    recordLauncherLinks(home, `${recorded}\n`);
    expect(sortedUnique((await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED)).literals)).toEqual(
      sortedUnique([defaultLink(home), recorded, path.join(home, 'real', 'bin', 'momonga')]),
    );
  });

  it('returns only the default link without error when the record is absent', async (context) => {
    const home = withTempDir(context);
    expect(fs.existsSync(launcherLinksFile(home))).toBe(false);
    expect(sortedUnique((await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED)).literals)).toEqual([defaultLink(home)]);
    expect((await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED)).launcherLinks).toEqual({ status: 'absent' });
  });

  it('ignores a relative line and keeps the absolute ones', async (context) => {
    const home = withTempDir(context);
    const recorded = path.join(home, 'opt', 'momonga');
    recordLauncherLinks(home, `relative/bin/momonga\n${recorded}\n`);
    expect(sortedUnique((await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED)).literals)).toEqual(sortedUnique([defaultLink(home), recorded]));
  });

  it('emits literal and ancestor denies for a recorded link', async (context) => {
    const { home, launcher } = createLauncherFixture(withTempDir(context), 'custom');
    const { profile, params } = await buildSeatbeltProfile(await policyFor(home), {}, testPaths());
    expect(paramsOfRule(profile, params, 'file-write*')).toContain(launcher);
    expect(sortedUnique(paramsOfRule(profile, params, 'file-write-unlink'))).toEqual(
      sortedUnique([
        path.join(home, 'opt', 'tools'),
        path.join(home, 'opt'),
        path.join(home, '.local', 'bin'),
        path.join(home, '.local'),
        ...deniedSubtreeAncestors(home),
      ]),
    );
  });
});

describe('alwaysWriteDenied launcher-links decisions', () => {
  const defaultLink = (home: string): string => path.join(home, '.local', 'bin', 'momonga');
  const literalsOf = async (home: string): Promise<string[]> => sortedUnique((await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED)).literals);

  it('ignores a launcher-links that is a symlink and keeps only the default launcher', async (context) => {
    const home = withTempDir(context);
    const elsewhere = path.join(home, 'elsewhere-links');
    fs.writeFileSync(elsewhere, `${path.join(home, 'opt', 'momonga')}\n`);
    fs.mkdirSync(path.dirname(launcherLinksFile(home)), { recursive: true });
    fs.symlinkSync(elsewhere, launcherLinksFile(home));
    expect(await literalsOf(home)).toEqual([defaultLink(home)]);
    expect((await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED)).launcherLinks).toEqual({ status: 'ignored', reason: 'symlink' });
  });

  it('ignores a launcher-links that is a directory', async (context) => {
    const home = withTempDir(context);
    fs.mkdirSync(launcherLinksFile(home), { recursive: true });
    expect(await literalsOf(home)).toEqual([defaultLink(home)]);
    expect((await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED)).launcherLinks).toEqual({ status: 'ignored', reason: 'not_regular' });
  });

  it('ignores a launcher-links larger than 64 KiB', async (context) => {
    const home = withTempDir(context);
    const recorded = path.join(home, 'opt', 'momonga');
    const line = `${recorded}\n`;
    recordLauncherLinks(home, line.repeat(Math.ceil((64 * 1024 + 1) / line.length)));
    expect(fs.statSync(launcherLinksFile(home)).size).toBeGreaterThan(64 * 1024);
    expect(await literalsOf(home)).toEqual([defaultLink(home)]);
    expect((await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED)).launcherLinks).toEqual({ status: 'ignored', reason: 'too_large' });
  });

  it('reads a launcher-links of exactly 64 KiB', async (context) => {
    const home = withTempDir(context);
    const recorded = path.join(home, 'opt', 'momonga');
    const head = `${recorded}\n`;
    recordLauncherLinks(home, head + '\n'.repeat(64 * 1024 - Buffer.byteLength(head)));
    expect(fs.statSync(launcherLinksFile(home)).size).toBe(64 * 1024);
    expect(await literalsOf(home)).toEqual(sortedUnique([defaultLink(home), recorded]));
    expect((await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED)).launcherLinks).toEqual({ status: 'read' });
  });

  it('skips blank lines, relative paths and lines with a NUL and keeps the absolute lines', async (context) => {
    const home = withTempDir(context);
    const first = path.join(home, 'a', 'momonga');
    const second = path.join(home, 'b', 'momonga');
    recordLauncherLinks(home, `\n   \n${first}\nrelative/momonga\n${path.join(home, 'c')}\u0000x\n\n${second}\n`);
    expect(await literalsOf(home)).toEqual(sortedUnique([defaultLink(home), first, second]));
    expect((await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED)).launcherLinks).toEqual({ status: 'read' });
  });

  it('skips a line that is not valid UTF-8 and keeps the others', async (context) => {
    const home = withTempDir(context);
    const valid = path.join(home, 'ok', 'momonga');
    fs.mkdirSync(path.dirname(launcherLinksFile(home)), { recursive: true });
    fs.writeFileSync(
      launcherLinksFile(home),
      Buffer.concat([Buffer.from(`${path.join(home, 'bad')}`), Buffer.from([0xff, 0xfe]), Buffer.from(`\n${valid}\n`)]),
      { mode: 0o600 },
    );
    expect(await literalsOf(home)).toEqual(sortedUnique([defaultLink(home), valid]));
    expect((await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED)).launcherLinks).toEqual({ status: 'read' });
  });

  it('protects a recorded path that does not exist yet', async (context) => {
    const home = withTempDir(context);
    const recorded = path.join(home, 'not', 'there', 'momonga');
    recordLauncherLinks(home, `${recorded}\n`);
    expect(fs.existsSync(path.dirname(recorded))).toBe(false);
    expect(await literalsOf(home)).toEqual(sortedUnique([defaultLink(home), recorded]));
  });

  it('protects a recorded path that is a regular file, not a symlink', async (context) => {
    const home = withTempDir(context);
    const recorded = path.join(home, 'plainfile', 'momonga');
    fs.mkdirSync(path.dirname(recorded));
    fs.writeFileSync(recorded, 'not a link');
    recordLauncherLinks(home, `${recorded}\n`);
    expect(await literalsOf(home)).toEqual(sortedUnique([defaultLink(home), recorded]));
  });

  it('emits exactly the subtree and ancestor denies main emits for the momonga root and the keychains', async (context) => {
    const home = withTempDir(context);
    const legacy: SandboxPolicy = {
      writableRoots: [home],
      writeDenied: [path.join(home, '.momonga'), path.join(home, 'Library', 'Keychains')],
      protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES,
      readDenied: [],
      network: 'deny',
    };
    const { profile, params } = await buildSeatbeltProfile(legacy, {}, testPaths());
    const subtrees = [...profile.matchAll(/^\(deny file-write\* \(subpath \(param "([^"]+)"\)\)\)$/gm)].map((match) => params[match[1] ?? '']);
    expect(subtrees).toEqual([path.join(home, '.momonga'), path.join(home, 'Library', 'Keychains')]);
    expect(sortedUnique(paramsOfRule(profile, params, 'file-write-unlink'))).toEqual(sortedUnique([home, path.join(home, 'Library')]));
    expect(paramsOfRule(profile, params, 'file-write*')).toEqual([]);
  });

  it('reproduces the exact profile and params that main f037ac6 produced for a legacy policy', async () => {
    const golden: unknown = JSON.parse(fs.readFileSync(new URL('./fixtures/main-f037ac6-profile.json', import.meta.url), 'utf8'));
    const legacy: SandboxPolicy = {
      writableRoots: ['/golden/work', '/golden/sessions/one'],
      writeDenied: ['/golden/home/.momonga', '/golden/home/Library/Keychains', '/golden/sessions', '/golden/work/.git/hooks', '/golden/work/.mcp.json'],
      protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES,
      readDenied: ['/golden/home/.momonga', '/golden/home/Library/Keychains', '/golden/sessions', '/golden/home/.ssh'],
      readAllowed: ['/golden/sessions/one'],
      network: 'allow',
    };
    expect(await buildSeatbeltProfile(legacy, { tmpDir: '/golden/sessions/one' }, testPaths())).toEqual(golden);
  });
});
