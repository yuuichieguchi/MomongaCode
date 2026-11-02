import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEA_NODE_VERSION, SEA_TARGETS, extractArchiveArgs, isSeaTargetName } from './node-runtime.ts';
import { buildSea, hostSeaTarget } from './sea.ts';
import { repoRoot } from './bundle.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

describe('SEA targets', () => {
  it('pins one sha256 per target for the pinned node version', () => {
    expect(SEA_NODE_VERSION).toBe('26.12.1');
    for (const target of Object.values(SEA_TARGETS)) expect(target.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(Object.values(SEA_TARGETS).map((target) => target.archiveSha256)).size).toBe(4);
  });

  it('names the release assets installers expect', () => {
    expect(Object.values(SEA_TARGETS).map((target) => target.assetName)).toEqual(['momonga-darwin-arm64', 'momonga-linux-x64', 'momonga-linux-arm64', 'momonga-win-x64.exe']);
  });

  it('extracts tarballs with -z and zip archives through bsdtar', () => {
    expect(extractArchiveArgs(SEA_TARGETS['linux-x64'], '/c/a.tar.gz', '/c')).toEqual(['-xzf', '/c/a.tar.gz', '-C', '/c']);
    expect(extractArchiveArgs(SEA_TARGETS['win-x64'], '/c/a.zip', '/c')).toEqual(['-xf', '/c/a.zip', '-C', '/c']);
  });

  it('maps the build host to a pinned runtime and rejects unpinned hosts', () => {
    expect(hostSeaTarget('darwin', 'arm64')).toBe('darwin-arm64');
    expect(hostSeaTarget('linux', 'x64')).toBe('linux-x64');
    expect(hostSeaTarget('win32', 'x64')).toBe('win-x64');
    expect(() => hostSeaTarget('linux', 'riscv64')).toThrow('no pinned node runtime');
    expect(isSeaTargetName('win-x64')).toBe(true);
    expect(isSeaTargetName('freebsd-x64')).toBe(false);
  });
});

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')('cross-built executables (not executed: the host cannot run them)', () => {
  let root = '';

  beforeAll(() => {
    root = createTempRoot();
  });

  afterAll(() => {
    removeTempRoot(root);
  });

  it.each([
    ['linux-x64', Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
    ['win-x64', Buffer.from('MZ')],
  ] as const)('%s produces an executable with the right container format', async (target, magic) => {
    const output = path.join(root, `momonga-${target}`);
    await buildSea({ entry: `${repoRoot}test/fixtures/sea/entry.ts`, output, workDir: path.join(root, `work-${target}`), target });
    const head = Buffer.alloc(magic.length);
    const fd = fs.openSync(output, 'r');
    try {
      fs.readSync(fd, head, 0, magic.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    expect(head).toEqual(magic);
  });
});
