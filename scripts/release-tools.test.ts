import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { HAS_POSIX_SHELL } from './support/host.ts';
import { createTempDir } from '@momonga/testkit';

const TOOLS_SCRIPT = `${repoRoot}scripts/release-tools.sh`;
const RELEASE_SCRIPT = `${repoRoot}scripts/release.sh`;
const RELEASE_TOOLS = ['git', 'node', 'npm', 'gh', 'zig', 'codesign', 'xcrun', 'spctl', 'ditto', 'ssh-keygen', 'shasum'];

describe.skipIf(!HAS_POSIX_SHELL)('the tools a release needs', () => {
  let root = '';

  const stubbed = (names: readonly string[]): string => {
    const directory = createTempDir({ parent: root });
    for (const name of names) fs.writeFileSync(path.join(directory, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return directory;
  };

  const check = (directory: string) => spawnSync('/bin/bash', [TOOLS_SCRIPT], { encoding: 'utf8', env: { PATH: directory } });

  beforeAll(() => {
    root = createTempRoot();
  });

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('passes when every tool is on PATH', () => {
    const result = check(stubbed(RELEASE_TOOLS));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('stops, naming every missing tool, when zig and gh are not on PATH', () => {
    const result = check(stubbed(RELEASE_TOOLS.filter((name) => name !== 'zig' && name !== 'gh')));
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('release.sh: a release needs gh and zig on PATH, and they were not found; nothing was built\n');
  });

  it('is run by release.sh before the tests, the build, the signing and the notarization', () => {
    const lines = fs.readFileSync(RELEASE_SCRIPT, 'utf8').split('\n');
    const toolsLine = lines.findIndex((line) => line.includes('scripts/release-tools.sh'));
    const firstStep = lines.findIndex((line) => line.startsWith('step '));
    const firstRequirement = lines.findIndex((line) => line.startsWith('require_env '));
    expect(toolsLine).toBeGreaterThan(0);
    expect(toolsLine).toBeLessThan(firstRequirement);
    expect(toolsLine).toBeLessThan(firstStep);
  });
});
