import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { HAS_POSIX_SHELL } from './support/host.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

describe.skipIf(!HAS_POSIX_SHELL)('tlc.sh', () => {
  let root = '';
  let result: SpawnSyncReturns<string>;

  beforeAll(() => {
    root = createTempRoot();
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(`${repoRoot}scripts/tlc.sh`, path.join(root, 'scripts/tlc.sh'));
    result = spawnSync('/bin/bash', [path.join(root, 'scripts/tlc.sh'), 'RunRecovery'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
  });

  afterAll(() => {
    removeTempRoot(root);
  });

  it('prints a fetch command for the exact release that carries the pinned jar, never the latest release', () => {
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('curl -L -o');
    expect(result.stderr).toContain('https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar');
    expect(result.stderr).not.toContain('latest');
  });
});

describe.skipIf(!HAS_POSIX_SHELL)('tlc.sh with a config of another module', () => {
  const tinySpec = ['---- MODULE Tiny ----', 'EXTENDS Naturals', 'VARIABLE x', 'Init == x = 0', "Next == (x < 2 /\\ x' = x + 1) \\/ (x = 2 /\\ x' = x)", 'Spec == Init /\\ [][Next]_x', 'Small == x <= 2', '===='].join('\n');
  let root = '';
  let result: SpawnSyncReturns<string>;

  beforeAll(() => {
    root = createTempRoot();
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'specs', 'tla'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cache', 'tla'), { recursive: true });
    fs.copyFileSync(`${repoRoot}scripts/tlc.sh`, path.join(root, 'scripts/tlc.sh'));
    fs.symlinkSync(`${repoRoot}.cache/tla/tla2tools.jar`, path.join(root, '.cache', 'tla', 'tla2tools.jar'));
    fs.writeFileSync(path.join(root, 'specs', 'tla', 'Tiny.tla'), tinySpec);
    fs.writeFileSync(path.join(root, 'specs', 'tla', 'Tiny.small.cfg'), ['SPECIFICATION Spec', '', 'INVARIANTS', '    Small', ''].join('\n'));
    result = spawnSync('/bin/bash', [path.join(root, 'scripts/tlc.sh'), 'Tiny.small'], {
      encoding: 'utf8',
      env: process.env,
    });
  });

  afterAll(() => {
    removeTempRoot(root);
  });

  it('checks the module named by the part of the config name before the first dot', () => {
    expect(result.stderr).not.toContain('RunRecovery');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Model checking completed. No error has been found.');
    expect(result.stdout).toContain('3 distinct states found');
  });
});
