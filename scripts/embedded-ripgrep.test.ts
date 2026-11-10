import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RIPGREP_BINARY_ASSET, RIPGREP_NOTICES_ASSET } from '@momonga/tools';
import { assertEmbeddedRipgrep, embeddedRipgrepManifests } from './embedded-ripgrep.ts';
import { RIPGREP_VERSION } from './ripgrep-release.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

const manifestText = (target: string, version: string = RIPGREP_VERSION): string =>
  JSON.stringify({
    version,
    target,
    binary: { asset: RIPGREP_BINARY_ASSET, sha256: 'a'.repeat(64), size: 1, name: target === 'win-x64' ? 'rg.exe' : 'rg' },
    notices: { asset: RIPGREP_NOTICES_ASSET, sha256: 'b'.repeat(64) },
  });

const executableWith = (...manifests: string[]): Buffer =>
  Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]), ...manifests.map((text) => Buffer.from(`\0{"version":"x"}\0${text}\0\xff`, 'latin1')), Buffer.from([0xff, 0xfe])]);

let root = '';

beforeAll(() => {
  root = createTempRoot();
});

afterAll(async () => {
  await removeTempRoot(root);
});

const written = (name: string, bytes: Buffer): string => {
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  return file;
};

describe('the ripgrep manifest embedded in a built executable', () => {
  it('is read back out of the executable bytes', () => {
    expect(embeddedRipgrepManifests(executableWith(manifestText('linux-x64'))).map((manifest) => manifest.target)).toEqual(['linux-x64']);
  });

  it('passes when the executable embeds exactly the manifest of its own target at the pinned version', () => {
    expect(() => assertEmbeddedRipgrep(written('own', executableWith(manifestText('linux-arm64'))), 'linux-arm64')).not.toThrow();
  });

  it('fails naming the file and both targets when it embeds the manifest of another target', () => {
    const file = written('other', executableWith(manifestText('linux-x64')));
    expect(() => assertEmbeddedRipgrep(file, 'linux-arm64')).toThrow(`${file} embeds the ripgrep manifest of linux-x64, not of linux-arm64`);
  });

  it('fails when the executable embeds no ripgrep manifest', () => {
    const file = written('none', executableWith());
    expect(() => assertEmbeddedRipgrep(file, 'win-x64')).toThrow(`${file} embeds no ripgrep manifest`);
  });

  it('fails when the executable embeds more than one ripgrep manifest', () => {
    const file = written('two', executableWith(manifestText('win-x64'), manifestText('win-x64')));
    expect(() => assertEmbeddedRipgrep(file, 'win-x64')).toThrow(`${file} embeds 2 ripgrep manifests`);
  });

  it('fails when the embedded version is not the pinned one', () => {
    const file = written('version', executableWith(manifestText('darwin-arm64', '14.1.0')));
    expect(() => assertEmbeddedRipgrep(file, 'darwin-arm64')).toThrow(`${file} embeds ripgrep 14.1.0, not the pinned ${RIPGREP_VERSION}`);
  });
});
