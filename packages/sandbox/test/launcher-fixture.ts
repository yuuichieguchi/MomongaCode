import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LauncherLayout = 'plain' | 'symlinked' | 'custom';

export type LauncherFixture = {
  home: string;
  launcher: string;
  target: string;
  targetContent: string;
};

export const TARGET_CONTENT = 'versioned-binary';

export const assertFakeHome = (home: string): void => {
  const realHome = fs.realpathSync(os.homedir());
  const realTmp = fs.realpathSync(os.tmpdir());
  if (home === realHome || home.startsWith(`${realHome}${path.sep}`) || realHome.startsWith(`${home}${path.sep}`)) {
    throw new Error(`refusing to use the real home directory for launcher tests: ${home}`);
  }
  if (!home.startsWith(`${realTmp}${path.sep}`)) throw new Error(`launcher test home must live under the temp dir: ${home}`);
};

export const createLauncherFixture = (home: string, layout: LauncherLayout, targetDir = path.join(home, '.momonga', 'bin', 'versions', '1.0.0')): LauncherFixture => {
  assertFakeHome(home);
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, 'momonga');
  fs.writeFileSync(target, TARGET_CONTENT);
  if (layout === 'custom') {
    const launcher = path.join(home, 'opt', 'tools', 'momonga');
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.symlinkSync(target, launcher);
    recordLauncherLinks(home, `${launcher}\n`);
    return { home, launcher, target, targetContent: TARGET_CONTENT };
  }
  if (layout === 'plain') {
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  } else {
    fs.mkdirSync(path.join(home, 'dotfiles', 'local', 'bin'), { recursive: true });
    fs.symlinkSync(path.join(home, 'dotfiles', 'local'), path.join(home, '.local'));
  }
  const launcher = path.join(home, '.local', 'bin', 'momonga');
  fs.symlinkSync(target, launcher);
  return { home, launcher, target, targetContent: TARGET_CONTENT };
};

export const launcherLinksFile = (home: string): string => path.join(home, '.momonga', 'bin', 'launcher-links');

export const recordLauncherLinks = (home: string, content: string): void => {
  fs.mkdirSync(path.dirname(launcherLinksFile(home)), { recursive: true });
  fs.writeFileSync(launcherLinksFile(home), content, { mode: 0o600 });
};
