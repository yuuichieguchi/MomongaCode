import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { hostKernelLock, nodeFileSystem, sha256Hex } from '@momonga/foundation';
import type { HeldKernelLock } from '@momonga/foundation';
import { RIPGREP_BINARY_ASSET, RIPGREP_MANIFEST_ASSET, RIPGREP_NOTICES_ASSET, RIPGREP_STAGED_PREFIX, ensureBundledRipgrep, ripgrepDirectoryName } from '../src/ripgrep-distribution.ts';
import type { RipgrepDistributionPorts } from '../src/ripgrep-distribution.ts';

const BINARY = new TextEncoder().encode('#!rg-binary-bytes');
const NOTICES = new TextEncoder().encode('COPYING\n');
const MANIFEST = {
  version: '15.2.0',
  target: 'linux-x64',
  binary: { asset: RIPGREP_BINARY_ASSET, sha256: sha256Hex(BINARY), size: BINARY.length, name: 'rg' },
  notices: { asset: RIPGREP_NOTICES_ASSET, sha256: sha256Hex(NOTICES) },
};
const ASSETS: Record<string, Uint8Array> = {
  [RIPGREP_MANIFEST_ASSET]: new TextEncoder().encode(JSON.stringify(MANIFEST)),
  [RIPGREP_BINARY_ASSET]: brotliCompressSync(BINARY),
  [RIPGREP_NOTICES_ASSET]: NOTICES,
};

const created: string[] = [];
const held: HeldKernelLock[] = [];

afterEach(() => {
  for (const lock of held.splice(0)) lock.release();
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const executablesRoot = (): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ripgrep-leftover-')));
  created.push(root);
  return root;
};

const holdEntry = async (entry: string): Promise<void> => {
  const outcome = await hostKernelLock().claim(entry);
  if (outcome.kind !== 'claimed') throw new Error(`${entry} could not be claimed by the test`);
  held.push(outcome.lock);
  if (!fs.existsSync(entry)) fs.writeFileSync(entry, BINARY, { mode: 0o700 });
};

const portsOf = (root: string, isOwnerRunning: (owner: string) => Promise<boolean>): RipgrepDistributionPorts => {
  let counter = 0;
  return {
    asset: (name) => {
      const bytes = ASSETS[name];
      if (bytes === undefined) throw new Error(`no embedded asset ${name}`);
      return bytes;
    },
    executablesRoot: root,
    random: () => {
      counter += 1;
      return counter / 1000;
    },
    ownerId: 'self',
    isOwnerRunning,
    files: nodeFileSystem,
  };
};

describe('ripgrep-distribution.ts:138-144: a staged file whose owner holds its lock is kept, whatever the owner probe says', () => {
  it('keeps a held staged file whose owner the probe reports gone (the pidOnly variant)', async () => {
    const root = executablesRoot();
    const directory = path.join(root, ripgrepDirectoryName(MANIFEST));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const staged = path.join(directory, `${RIPGREP_STAGED_PREFIX}foreign-1-aaaa`);
    await holdEntry(staged);
    await (await ensureBundledRipgrep(portsOf(root, async (owner) => owner === 'self'))).release();
    expect(fs.existsSync(staged)).toBe(true);
  });

  it('removes a staged file whose lock no one holds, even when the owner probe reports it running', async () => {
    const root = executablesRoot();
    const directory = path.join(root, ripgrepDirectoryName(MANIFEST));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const staged = path.join(directory, `${RIPGREP_STAGED_PREFIX}other-2-bbbb`);
    fs.writeFileSync(staged, BINARY, { mode: 0o700 });
    await (await ensureBundledRipgrep(portsOf(root, async () => true))).release();
    expect(fs.existsSync(staged)).toBe(false);
  });
});
