import fs from 'node:fs';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
import { alwaysWriteDenied, createSeatbeltSandbox } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, registerCleanup, withTempDir, NEVER_CANCELLED, testKernelLock } from '@momonga/testkit';
import { run } from './helpers.ts';
import { createLauncherFixture, recordLauncherLinks } from './launcher-fixture.ts';
import type { LauncherFixture, LauncherLayout } from './launcher-fixture.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

type Scenario = { fixture: LauncherFixture; sh: (script: string) => Promise<{ code: number | null; stdout: string; stderr: string }> };

const policyFor = async (fixture: LauncherFixture): Promise<SandboxPolicy> => {
  const denied = await alwaysWriteDenied(fixture.home, NEVER_CANCELLED);
  return {
    writableRoots: [fixture.home],
    writeDenied: [...denied.subtrees],
    protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [...denied.literals], fileRules: EMPTY_FILE_RULES,
    readDenied: [],
    network: 'deny',
  };
};

const scenario = (context: TestContext, layout: LauncherLayout): Scenario => {
  const home = withTempDir(context, { asHome: true });
  expect(home).not.toBe(fs.realpathSync(os.homedir()));
  const fixture = createLauncherFixture(home, layout);
  expect(fixture.launcher.startsWith(path.join(fs.realpathSync(os.homedir()), '.local'))).toBe(false);
  fs.writeFileSync(path.join(home, 'other'), 'other');
  const sandbox = createSeatbeltSandbox({ lock: testKernelLock(), tmpRoot: withTempDir(context), killGraceMs: 300 });
  const sh = async (script: string) => {
    const proc = await sandbox.spawn(
      { argv: ['/bin/sh', '-c', script], cwd: home, env: { PATH: BASE_PATH, HOME: home } },
      await policyFor(fixture),
      new AbortController().signal,
    );
    registerCleanup(context, async () => killGroupsForCleanup([(await proc).pgid]));
    return run(await proc);
  };
  return { fixture, sh };
};

const expectLinkIntact = (fixture: LauncherFixture): void => {
  expect(fs.lstatSync(fixture.launcher).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(fixture.launcher)).toBe(fixture.target);
  expect(fs.readFileSync(fixture.target, 'utf8')).toBe(fixture.targetContent);
};

const q = (value: string): string => `'${value}'`;

type Attack = { name: string; script: (home: string, link: string) => string };

const binOf = (link: string): string => path.dirname(link);
const parentOf = (link: string): string => path.dirname(binOf(link));

const commonAttacks: Attack[] = [
  { name: 'ln -sf replaces the link', script: (home, link) => `ln -sf ${q(path.join(home, 'evil'))} ${q(link)}` },
  { name: 'unlink removes the link', script: (_home, link) => `unlink ${q(link)}` },
  { name: 'rm removes the link', script: (_home, link) => `rm -f ${q(link)}` },
  { name: 'mv -f renames another file over the link', script: (home, link) => `mv -f ${q(path.join(home, 'other'))} ${q(link)}` },
  { name: 'mv renames the link directory away', script: (_home, link) => `mv ${q(binOf(link))} ${q(`${binOf(link)}.old`)}` },
  { name: 'mv renames the parent of the link directory away', script: (_home, link) => `mv ${q(parentOf(link))} ${q(`${parentOf(link)}.old`)}` },
  {
    name: 'the rename-and-recreate sequence plants a new link',
    script: (home, link) =>
      `mv ${q(parentOf(link))} ${q(`${parentOf(link)}.old`)} && mkdir -p ${q(binOf(link))} && ln -s ${q(path.join(home, 'evil'))} ${q(link)}`,
  },
  { name: 'a write through the link reaches the target', script: (_home, link) => `echo x > ${q(link)}` },
];

const symlinkedOnlyAttacks: Attack[] = [
  { name: 'mv renames ~/dotfiles away', script: (home) => `mv ${q(path.join(home, 'dotfiles'))} ${q(path.join(home, 'dotfiles.old'))}` },
  { name: 'mv renames ~/dotfiles/local away', script: (home) => `mv ${q(path.join(home, 'dotfiles', 'local'))} ${q(path.join(home, 'dotfiles', 'local.old'))}` },
];

type Control = { name: string; script: (home: string, link: string) => string; verify: (home: string, link: string) => void };

const controls: Control[] = [
  {
    name: 'creates a file in the home',
    script: (home) => `echo ok > ${q(path.join(home, 'newfile'))}`,
    verify: (home) => expect(fs.readFileSync(path.join(home, 'newfile'), 'utf8')).toBe('ok\n'),
  },
  {
    name: 'makes a directory in the home',
    script: (home) => `mkdir ${q(path.join(home, 'd'))}`,
    verify: (home) => expect(fs.statSync(path.join(home, 'd')).isDirectory()).toBe(true),
  },
  {
    name: 'renames a file in the home',
    script: (home) => `echo ok > ${q(path.join(home, 'newfile'))} && mv ${q(path.join(home, 'newfile'))} ${q(path.join(home, 'renamed'))}`,
    verify: (home) => {
      expect(fs.existsSync(path.join(home, 'newfile'))).toBe(false);
      expect(fs.readFileSync(path.join(home, 'renamed'), 'utf8')).toBe('ok\n');
    },
  },
  {
    name: 'creates another file in the link directory',
    script: (_home, link) => `echo y > ${q(path.join(binOf(link), 'other-tool'))}`,
    verify: (_home, link) => expect(fs.readFileSync(path.join(binOf(link), 'other-tool'), 'utf8')).toBe('y\n'),
  },
  {
    name: 'creates and removes another file in the link directory',
    script: (_home, link) => `echo y > ${q(path.join(binOf(link), 'other-tool'))} && unlink ${q(path.join(binOf(link), 'other-tool'))}`,
    verify: (_home, link) => expect(fs.existsSync(path.join(binOf(link), 'other-tool'))).toBe(false),
  },
  {
    name: 'makes a directory in the link directory',
    script: (_home, link) => `mkdir ${q(path.join(binOf(link), 'sub'))}`,
    verify: (_home, link) => expect(fs.statSync(path.join(binOf(link), 'sub')).isDirectory()).toBe(true),
  },
];

const layouts: Array<{ layout: LauncherLayout; title: string; attacks: Attack[] }> = [
  { layout: 'plain', title: 'plain ~/.local', attacks: commonAttacks },
  { layout: 'symlinked', title: 'symlinked ~/.local -> ~/dotfiles/local', attacks: [...commonAttacks, ...symlinkedOnlyAttacks] },
  { layout: 'custom', title: 'custom link recorded in launcher-links', attacks: commonAttacks },
];

describe.runIf(process.platform === 'darwin')('seatbelt protects the launcher link (real sandbox-exec, fake HOME)', () => {
  for (const { layout, title, attacks } of layouts) {
    describe(title, () => {
      it.for(attacks)('refuses: $name', async ({ script }, context) => {
        const { fixture, sh } = scenario(context, layout);
        const result = await sh(`${script(fixture.home, fixture.launcher)} 2>/dev/null`);
        expect(result.code).not.toBe(0);
        expectLinkIntact(fixture);
      });

      it.for(controls)('still allows: $name', async ({ script, verify }, context) => {
        const { fixture, sh } = scenario(context, layout);
        const result = await sh(`${script(fixture.home, fixture.launcher)} 2>/dev/null`);
        expect(result.code).toBe(0);
        verify(fixture.home, fixture.launcher);
        expectLinkIntact(fixture);
      });

      it('still refuses writes into the momonga root and the keychains from the single source', async (context) => {
        const { fixture, sh } = scenario(context, layout);
        fs.mkdirSync(path.join(fixture.home, 'Library', 'Keychains'), { recursive: true });
        const momonga = await sh(`echo x > ${q(path.join(fixture.home, '.momonga', 'planted'))} 2>/dev/null`);
        const keychains = await sh(`echo x > ${q(path.join(fixture.home, 'Library', 'Keychains', 'planted'))} 2>/dev/null`);
        expect(momonga.code).not.toBe(0);
        expect(keychains.code).not.toBe(0);
        expect(fs.existsSync(path.join(fixture.home, '.momonga', 'planted'))).toBe(false);
        expect(fs.existsSync(path.join(fixture.home, 'Library', 'Keychains', 'planted'))).toBe(false);
      });
    });
  }

  it('refuses creating a link at a recorded path that does not exist yet', async (context) => {
    const { fixture, sh } = scenario(context, 'plain');
    const planned = path.join(fixture.home, 'newbin', 'momonga');
    fs.mkdirSync(path.dirname(planned));
    recordLauncherLinks(fixture.home, `${planned}\n`);
    const result = await sh(`ln -s ${q(path.join(fixture.home, 'evil'))} ${q(planned)} 2>/dev/null`);
    expect(result.code).not.toBe(0);
    await expect((async () => fs.lstatSync(planned))()).rejects.toThrow();
  });

  describe('missing ancestors of a protected link', () => {
    const missingHome = (context: TestContext): Scenario & { home: string } => {
      const home = withTempDir(context, { asHome: true });
      expect(home).not.toBe(fs.realpathSync(os.homedir()));
      fs.writeFileSync(path.join(home, 'other'), 'other');
      const sandbox = createSeatbeltSandbox({ lock: testKernelLock(), tmpRoot: withTempDir(context), killGraceMs: 300 });
      const fixture: LauncherFixture = { home, launcher: path.join(home, '.local', 'bin', 'momonga'), target: '/bin/ls', targetContent: '' };
      const sh = async (script: string) => {
        const proc = await sandbox.spawn(
          { argv: ['/bin/sh', '-c', script], cwd: home, env: { PATH: BASE_PATH, HOME: home } },
          await policyFor(fixture),
          new AbortController().signal,
        );
        registerCleanup(context, async () => killGroupsForCleanup([(await proc).pgid]));
        return run(await proc);
      };
      return { fixture, sh, home };
    };

    const resolvesTo = (link: string, planted: string): boolean => {
      try {
        return fs.realpathSync(link) === fs.realpathSync(planted);
      } catch {
        return false;
      }
    };

    it('refuses planting a symlink at a missing ~/.local', async (context) => {
      const { sh, home } = missingHome(context);
      const result = await sh(
        `mkdir -p ev/bin && ln -s /bin/ls ev/bin/momonga && ln -s ev .local 2>/dev/null`,
      );
      expect(result.code).not.toBe(0);
      expect(resolvesTo(path.join(home, '.local', 'bin', 'momonga'), '/bin/ls')).toBe(false);
      await expect((async () => fs.lstatSync(path.join(home, '.local')))()).rejects.toThrow();
    });

    it('refuses planting a symlink at a missing ancestor of a recorded link', async (context) => {
      const { sh, home } = missingHome(context);
      const recorded = path.join(home, 'later', 'dir', 'mm2');
      recordLauncherLinks(home, `${recorded}\n`);
      const result = await sh(`mkdir -p ev2/dir && ln -s /bin/ls ev2/dir/mm2 && ln -s ev2 later 2>/dev/null`);
      expect(result.code).not.toBe(0);
      expect(resolvesTo(recorded, '/bin/ls')).toBe(false);
      await expect((async () => fs.lstatSync(path.join(home, 'later')))()).rejects.toThrow();
    });

    it('refuses renaming a pre-made symlink onto a missing ~/.local', async (context) => {
      const { sh, home } = missingHome(context);
      const result = await sh(
        `mkdir -p ev/bin && ln -s /bin/ls ev/bin/momonga && ln -s ev premade && mv premade .local 2>/dev/null`,
      );
      expect(result.code).not.toBe(0);
      expect(resolvesTo(path.join(home, '.local', 'bin', 'momonga'), '/bin/ls')).toBe(false);
      await expect((async () => fs.lstatSync(path.join(home, '.local')))()).rejects.toThrow();
    });

    it('still allows mkdir -p ~/.local/bin', async (context) => {
      const { sh, home } = missingHome(context);
      const result = await sh(`mkdir -p .local/bin 2>/dev/null`);
      expect(result.code).toBe(0);
      expect(fs.statSync(path.join(home, '.local', 'bin')).isDirectory()).toBe(true);
    });
  });
});
