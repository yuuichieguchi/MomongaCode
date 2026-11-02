import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { HAS_POSIX_SHELL } from './support/host.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

describe.skipIf(!HAS_POSIX_SHELL)('tlc.sh', () => {
  let root = '';
  let result: ReturnType<typeof spawnSync<string>>;

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
