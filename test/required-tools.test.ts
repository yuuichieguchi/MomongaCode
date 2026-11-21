import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RIPGREP_TARGETS, ripgrepCacheDir } from '../scripts/ripgrep-release.ts';
import { SEA_TARGETS, archiveNameOf, nodeArchiveCacheDir } from '../scripts/node-runtime.ts';
import { TEST_SETUP_COMMAND } from '../scripts/fetch-tla.ts';
import { BUN_VERSION, REQUIRED_TOOLS, checkRequiredTools, missingToolsOf, requires } from './support/required-tools.ts';
import type { ToolHost } from './support/required-tools.ts';

const everythingPresent = (platform: NodeJS.Platform, arch = 'arm64'): ToolHost => ({
  platform,
  arch,
  exists: () => true,
  versionOf: () => `${BUN_VERSION}\n`,
  sha256Of: (file) => {
    const node = Object.values(SEA_TARGETS).find((target) => path.join(nodeArchiveCacheDir, archiveNameOf(target)) === file);
    if (node !== undefined) return node.archiveSha256;
    const ripgrep = Object.values(RIPGREP_TARGETS).find((row) => path.join(ripgrepCacheDir, row.archiveName) === file);
    return ripgrep?.archiveSha256;
  },
  onPath: () => true,
});

const namesOf = (project: Parameters<typeof missingToolsOf>[0], host: ToolHost): string[] => missingToolsOf(project, host).map((tool) => tool.name);

describe('the required tools of a run', () => {
  it('fails, naming the setup command, when bun is missing for the Open Responses suite', () => {
    expect(() => requires('bun', { ...everythingPresent('darwin'), exists: () => false })).toThrow(/bun.*npm run test:setup/s);
    expect(() => requires('bun', everythingPresent('darwin'))).not.toThrow();
  });

  it('counts a bun that is present but does not run its pinned version as missing, as npm ci --ignore-scripts leaves it', () => {
    expect(namesOf('e2e', { ...everythingPresent('darwin'), versionOf: () => undefined })).toEqual(['bun']);
    expect(namesOf('e2e', { ...everythingPresent('linux'), versionOf: () => '1.0.0\n' })).toEqual(['bun']);
  });

  it('refuses an e2e run at its start when bun is missing, before any test runs', () => {
    expect(() => checkRequiredTools('e2e', { ...everythingPresent('darwin'), versionOf: () => undefined })).toThrow(`run: ${TEST_SETUP_COMMAND}`);
    expect(() => checkRequiredTools('e2e', everythingPresent('darwin'))).not.toThrow();
  });

  it('refuses a packaging run at its start for every pinned archive, the TLA+ jar and zig it would otherwise fetch or miss in the middle', () => {
    const nothingCached: ToolHost = { ...everythingPresent('darwin'), exists: (file) => !file.includes(`${path.sep}.cache${path.sep}`), sha256Of: () => undefined, onPath: () => false };
    const missing = namesOf('packaging', nothingCached);
    expect(missing).toEqual(expect.arrayContaining(['zig', 'tla2tools.jar']));
    for (const target of Object.values(SEA_TARGETS)) expect(missing).toContain(archiveNameOf(target));
    for (const row of Object.values(RIPGREP_TARGETS)) expect(missing).toContain(row.archiveName);
    expect(namesOf('packaging', everythingPresent('darwin'))).toEqual([]);
  });

  it('counts an archive with another checksum than its pin as missing', () => {
    const linuxNode = SEA_TARGETS['linux-arm64'];
    const host: ToolHost = { ...everythingPresent('darwin'), sha256Of: (file) => (file.endsWith(archiveNameOf(linuxNode)) ? '0'.repeat(64) : everythingPresent('darwin').sha256Of(file)) };
    expect(namesOf('packaging', host)).toEqual([archiveNameOf(linuxNode)]);
  });

  it('asks for zig and the node archives only where the single executables are built, on an arm64 Mac', () => {
    const noNodeOrZig: ToolHost = { ...everythingPresent('linux', 'x64'), onPath: (program) => program !== 'zig', sha256Of: (file) => (file.startsWith(nodeArchiveCacheDir) ? undefined : everythingPresent('linux').sha256Of(file)) };
    expect(namesOf('packaging', noNodeOrZig)).toEqual([]);
  });

  it('checks each project for the tools of its platform only', () => {
    const absent: ToolHost = { ...everythingPresent('linux'), exists: () => false };
    expect(namesOf('unit', absent)).toContain('bwrap');
    expect(namesOf('unit', { ...everythingPresent('darwin'), exists: () => false })).not.toContain('bwrap');
  });

  it('refuses an e2e run that lacks a system program its tests start', () => {
    expect(namesOf('e2e', { ...everythingPresent('linux'), exists: (file) => file !== '/usr/bin/python3', onPath: (program) => program !== 'git' })).toEqual(['python3', 'git']);
  });

  it('gives every tool a setup command and at least one platform', () => {
    expect(REQUIRED_TOOLS.filter((tool) => tool.setup.trim() === '' || tool.platforms.length === 0)).toEqual([]);
  });

  it('names one preparation command for everything a run can fetch, and a system install for the rest', () => {
    const fetched = REQUIRED_TOOLS.filter((tool) => tool.setup === TEST_SETUP_COMMAND).map((tool) => tool.name);
    expect(fetched).toEqual(expect.arrayContaining(['bun', 'tla2tools.jar', ...Object.values(RIPGREP_TARGETS).map((row) => row.archiveName)]));
  });
});
