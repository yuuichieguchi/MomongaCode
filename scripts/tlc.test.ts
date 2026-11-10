import { spawnSync } from '@momonga/testkit/child-process';
import type { SpawnSyncReturns } from '@momonga/testkit/child-process';
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

  afterAll(async () => {
    await removeTempRoot(root);
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

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('checks the module named by the part of the config name before the first dot', () => {
    expect(result.stderr).not.toContain('RunRecovery');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Model checking completed. No error has been found.');
    expect(result.stdout).toContain('3 distinct states found');
  });
});

describe.skipIf(!HAS_POSIX_SHELL)('tlc.sh --fetch-jar', () => {
  let root = '';
  const realJar = `${repoRoot}.cache/tla/tla2tools.jar`;

  const fetchJar = (url: string): SpawnSyncReturns<string> =>
    spawnSync('/bin/bash', [path.join(root, 'scripts/tlc.sh'), '--fetch-jar'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', TLC_JAR_URL: url },
    });

  const placedJar = (): string => path.join(root, '.cache', 'tla', 'tla2tools.jar');

  beforeAll(() => {
    root = createTempRoot();
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(`${repoRoot}scripts/tlc.sh`, path.join(root, 'scripts/tlc.sh'));
  });

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('refuses a download whose sha256 is not the pinned one and leaves no jar behind', () => {
    const impostor = path.join(root, 'impostor.jar');
    fs.writeFileSync(impostor, 'not the jar');
    const run = fetchJar(`file://${impostor}`);
    expect(run.status).toBe(4);
    expect(run.stderr).toContain('sha256 mismatch');
    expect(fs.existsSync(placedJar())).toBe(false);
    expect(fs.existsSync(path.dirname(placedJar())) ? fs.readdirSync(path.dirname(placedJar())) : []).toEqual([]);
  });

  it.skipIf(!fs.existsSync(realJar))('places a download whose sha256 is the pinned one', () => {
    const run = fetchJar(`file://${realJar}`);
    expect(run.status).toBe(0);
    expect(fs.readFileSync(placedJar()).equals(fs.readFileSync(realJar))).toBe(true);
  });
});
