import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { SEA_NODE_ARCHIVE_SHA256, assertFileChecksum, assertPinnedChecksum, parseShasums } from './node-runtime.ts';
import { buildSea } from './sea.ts';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { RUNS_MACOS_ARM64_ARTIFACTS } from './support/host.ts';
import { testHostPath } from '@momonga/testkit';

const ARCHIVE = 'node-v26.12.1-darwin-arm64.tar.gz';
const OTHER_SHA = 'a'.repeat(64);

describe('SHASUMS256 verification', () => {
  const shasums = `${SEA_NODE_ARCHIVE_SHA256}  ${ARCHIVE}\n${OTHER_SHA}  node-v26.12.1-linux-x64.tar.gz\n`;

  it('parses every line into a name to checksum map', () => {
    expect([...parseShasums(shasums)]).toEqual([
      [ARCHIVE, SEA_NODE_ARCHIVE_SHA256],
      ['node-v26.12.1-linux-x64.tar.gz', OTHER_SHA],
    ]);
  });

  it('rejects a malformed line', () => {
    expect(() => parseShasums('not-a-checksum  file\n')).toThrow('malformed SHASUMS256 line');
  });

  it('accepts a listing that matches the pinned checksum', () => {
    expect(() => assertPinnedChecksum(shasums, ARCHIVE, SEA_NODE_ARCHIVE_SHA256)).not.toThrow();
  });

  it('rejects a listing whose checksum differs from the pin', () => {
    expect(() => assertPinnedChecksum(`${OTHER_SHA}  ${ARCHIVE}\n`, ARCHIVE, SEA_NODE_ARCHIVE_SHA256)).toThrow('pinned checksum');
  });

  it('rejects a listing without the archive', () => {
    expect(() => assertPinnedChecksum(`${OTHER_SHA}  other.tar.gz\n`, ARCHIVE, SEA_NODE_ARCHIVE_SHA256)).toThrow('is not listed');
  });

  it('rejects a file whose bytes do not match the checksum', () => {
    const root = createTempRoot();
    try {
      const file = path.join(root, 'blob');
      fs.writeFileSync(file, 'tampered');
      expect(() => assertFileChecksum(file, SEA_NODE_ARCHIVE_SHA256)).toThrow('sha256 mismatch');
    } finally {
      removeTempRoot(root);
    }
  });
});

describe.skipIf(!RUNS_MACOS_ARM64_ARTIFACTS)('single executable built from the fixture entry', () => {
  const NO_NODE_ENV = (home: string): NodeJS.ProcessEnv => ({ PATH: testHostPath('/usr/bin:/bin'), HOME: home });
  let root = '';
  let binary = '';

  const run = (...args: string[]) => spawnSync(binary, args, { encoding: 'utf8', env: NO_NODE_ENV(root) });

  beforeAll(async () => {
    root = createTempRoot();
    binary = path.join(root, 'sea-fixture');
    await buildSea({ entry: `${repoRoot}test/fixtures/sea/entry.ts`, output: binary, workDir: path.join(root, 'work') });
  }, UNBOUNDED_BUILD_WAIT_MS);

  afterAll(() => {
    removeTempRoot(root);
  });

  it('runs on a PATH that contains no node', () => {
    expect(fs.existsSync('/usr/bin/node')).toBe(false);
    expect(fs.existsSync('/bin/node')).toBe(false);
    const result = run('--version');
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 0, stdout: '0.0.0-fixture\n', stderr: '' });
  });

  it('embeds the pinned node runtime', () => {
    expect(run('node-version').stdout).toBe('v26.12.1\n');
  });

  it('passes user arguments from index 2 of process.argv', () => {
    expect(run('argv').stdout).toBe('["argv"]\n');
  });

  it('serves node:sqlite', () => {
    expect(run('sqlite').stdout).toBe('sqlite total=42\n');
  });

  it('serves FTS5 with the trigram tokenizer, which cannot match terms under three characters', () => {
    expect(run('fts5-trigram').stdout).toBe('fts5 english=1 japanese=1 short=0\n');
  });

  it("renders Ink's React tree", () => {
    expect(run('ink').stdout).toContain('ink output=ink-rendered');
  });

  it('loads code reached only through a dynamic import', () => {
    expect(run('__daemon').stdout).toBe('daemon module loaded pid-is-number=true host-is-string=true\n');
  });

  it('re-spawns itself with a subcommand through process.execPath', () => {
    expect(run('respawn', '__daemon').stdout).toBe('child exit=0 stdout=daemon module loaded pid-is-number=true host-is-string=true\n');
    expect(run('respawn', 'sqlite').stdout).toBe('child exit=0 stdout=sqlite total=42\n');
  });

  it('ignores NODE_OPTIONS', () => {
    const result = spawnSync(binary, ['argv'], { encoding: 'utf8', env: { ...NO_NODE_ENV(root), NODE_OPTIONS: '--definitely-not-a-node-option' } });
    expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 0, stdout: '["argv"]\n' });
  });

  it('is signed with the hardened runtime and only the JIT entitlement', () => {
    const display = spawnSync('/usr/bin/codesign', ['-d', '--verbose=2', '--entitlements', '-', binary], { encoding: 'utf8' });
    const output = `${display.stdout}${display.stderr}`;
    expect(output).toMatch(/flags=0x[0-9a-f]+\(adhoc,runtime\)/);
    expect(output).toContain('com.apple.security.cs.allow-jit');
    expect(output).not.toContain('get-task-allow');
    expect(() => execFileSync('/usr/bin/codesign', ['--verify', '--strict', binary])).not.toThrow();
  });
});
