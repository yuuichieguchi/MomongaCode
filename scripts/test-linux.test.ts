import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

const script = fs.readFileSync(path.join(import.meta.dirname, 'test-linux.sh'), 'utf8');
const SYSTEM_PACKAGES_END = 'mkdir /opt/git-build';

let root: string;

beforeAll(() => {
  root = createTempRoot();
  const fakeApt = path.join(root, 'apt-get');
  fs.writeFileSync(fakeApt, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${path.join(root, 'apt.log')}"\n`, { mode: 0o755 });
});

afterAll(() => removeTempRoot(root));

const installedWith = (env: Record<string, string>): string[] => {
  const log = path.join(root, 'apt.log');
  fs.rmSync(log, { force: true });
  const prefix = script.slice(0, script.indexOf(SYSTEM_PACKAGES_END));
  execFileSync('/bin/bash', ['-c', prefix], { env: { PATH: `${root}:/usr/bin:/bin`, ...env } });
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('install '))
    .flatMap((line) => line.split(' '));
};

describe('scripts/test-linux.sh', () => {
  it('installs the system ripgrep by default, for the unit and e2e runs from source', () => {
    expect(script.indexOf(SYSTEM_PACKAGES_END)).toBeGreaterThan(0);
    expect(installedWith({})).toContain('ripgrep');
  });

  it('leaves the system ripgrep out with WITHOUT_SYSTEM_RIPGREP=1, for the packaging run of the linux-x64 executable', () => {
    const packages = installedWith({ WITHOUT_SYSTEM_RIPGREP: '1' });
    expect(packages).not.toContain('ripgrep');
    expect(packages).toEqual(expect.arrayContaining(['bubblewrap', 'git', 'lsof', 'procps', 'tini']));
  });
});
