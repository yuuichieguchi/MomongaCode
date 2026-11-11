import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimNewEntry, lockFormOf, nodeFileSystem, sha256Hex } from '@momonga/foundation';
import type { HeldKernelLock, KernelLockMechanism } from '@momonga/foundation';
import { expectedKernelLockOn } from '@momonga/testkit';
import { BUNDLED_EXECUTABLE_STAGED_INFIX, ensureBundledExecutable } from '../../src/platform/bundled-executable.ts';
import type { BundledExecutableKind } from '../../src/platform/bundled-executable.ts';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';

const BINARY = new TextEncoder().encode('the keeper of this test');
const SHA256 = sha256Hex(BINARY);
const NAME = 'momonga-keeper.exe';

const KIND: BundledExecutableKind = { what: 'keeper', manifestAsset: 'keeper-manifest.json', folder: 'windows-keeper', failure: (message) => new Error(message) };

const ASSETS: Record<string, Uint8Array> = {
  'keeper-manifest.json': new TextEncoder().encode(JSON.stringify({ target: 'win32-x64', binary: { asset: 'keeper.exe', sha256: SHA256, size: BINARY.length, name: NAME } })),
  'keeper.exe': BINARY,
};

const asset = (name: string): Uint8Array => {
  const bytes = ASSETS[name];
  if (bytes === undefined) throw new Error(`no asset ${name}`);
  return bytes;
};

const stagedBy = async (lock: KernelLockMechanism, file: string): Promise<HeldKernelLock> => {
  const held = await claimNewEntry(lock, file, lockFormOf(lock, 'file'));
  fs.writeFileSync(file, 'half written');
  return held;
};

describe('the staged file of an extracted executable is a locked entry its extraction sweeps (14.2)', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform} mechanism: a staged file left by a crashed extraction is removed at the next extraction, and one a live extraction holds is kept`, async () => {
      const lock = expectedKernelLockOn(platform);
      const executablesRoot = makeTemporaryDirectory();
      const directory = path.join(executablesRoot, `${KIND.folder}-${SHA256.slice(0, 16)}`);
      fs.mkdirSync(directory, { recursive: true });
      const crashed = path.join(directory, `${NAME}${BUNDLED_EXECUTABLE_STAGED_INFIX}x`);
      const live = path.join(directory, `${NAME}${BUNDLED_EXECUTABLE_STAGED_INFIX}y`);
      (await stagedBy(lock, crashed)).release();
      const holding = await stagedBy(lock, live);
      try {
        const extracted = await ensureBundledExecutable(KIND, { asset, executablesRoot, random: { hex: () => 'abcdef0123456789' }, files: nodeFileSystem, lock });
        expect(extracted).toBe(path.join(directory, NAME));
        const names = fs.readdirSync(directory);
        expect(names.filter((name) => name.startsWith(path.basename(crashed)))).toEqual([]);
        expect(names).toContain(path.basename(live));
        expect(names.filter((name) => name.includes(BUNDLED_EXECUTABLE_STAGED_INFIX) && !name.startsWith(path.basename(live)))).toEqual([]);
      } finally {
        holding.release();
      }
    });
  }
});
