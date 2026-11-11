import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES = path.join(ROOT, 'packages');

const sourcesUnder = (directory: string): string[] =>
  fs
    .readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .map((entry) => path.join(directory, entry))
    .filter((file) => /\.tsx?$/.test(file));

const productSources = (): string[] =>
  fs
    .readdirSync(PACKAGES)
    .filter((name) => name !== 'testkit')
    .map((name) => path.join(PACKAGES, name, 'src'))
    .filter((directory) => fs.existsSync(directory))
    .flatMap(sourcesUnder);

const relative = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

const SYNCHRONOUS_CALL = /\b\w+Sync\b|\bsyncPaths\b/;

const SYNCHRONOUS_DRIVER = /\bsyncPaths\b/;

const SYNCHRONOUS_HOST_CALL = /\b(realpathSync|readlinkSync)\b/;

const isGenerated = (file: string): boolean => file.endsWith('.generated.ts');

const ASYNCHRONOUS_FILES: readonly string[] = [
  'packages/foundation/src/path-compare.ts',
  'packages/foundation/src/path-resolution.ts',
  'packages/foundation/src/file-rules.ts',
  'packages/foundation/src/protected-set.ts',
  'packages/foundation/src/tool-path.ts',
  'packages/policy/src/host-filesystem.ts',
  'packages/tools/src/read-access.ts',
  'packages/tools/src/builtins/paths.ts',
  'packages/tools/src/builtins/sandbox-policy.ts',
  'packages/tools/src/builtins/walk.ts',
  'packages/tools/src/history/read-denial.ts',
  'packages/config/src/file-lock.ts',
  'packages/config/src/load-settings.ts',
  'packages/config/src/mcp-servers.ts',
  'packages/config/src/project-mandate.ts',
  'packages/foundation/src/path-asking.ts',
  'packages/config/src/edit-user-settings.ts',
  'packages/config/src/edit-settings.ts',
  'packages/config/src/json-file.ts',
  'packages/config/src/kept-settings.ts',
  'packages/config/src/layers.ts',
  'packages/config/src/local-settings.ts',
  'packages/config/src/models.ts',
  'packages/config/src/user-settings.ts',
  'packages/context/src/instructions.ts',
  'packages/verify/src/path-model.ts',
  'packages/sandbox/src/profile.ts',
  'packages/sandbox/src/always-write-denied.ts',
  'packages/runtime/src/process/tool-policy.ts',
  'packages/runtime/src/process/history-port.ts',
  'packages/runtime/src/process/evidence-run.ts',
  'packages/runtime/src/process/operation-tools.ts',
  'packages/runtime/src/service/app.ts',
  'packages/runtime/src/service/service.ts',
  'packages/runtime/src/service/trust.ts',
  'packages/runtime/src/service/project-query.ts',
  'packages/cli/src/acp/serve.ts',
];

const SYNCHRONOUS_USERS: Readonly<Record<string, string>> = {
  'packages/foundation/src/sync-paths.ts': 'the synchronous driver of the one resolution algorithm',
  'packages/foundation/src/index.ts': 'exports the synchronous driver',
  'packages/foundation/src/secret-store.ts': 'the real path of the secret program, checked for its owners when the store is chosen, which is synchronous like the PATH search',
};

describe('path resolution is asynchronous and goes through the file-system port', () => {
  it('names files that exist', () => {
    expect([...ASYNCHRONOUS_FILES, ...Object.keys(SYNCHRONOUS_USERS)].filter((file) => !fs.existsSync(path.join(ROOT, file)))).toEqual([]);
  });

  it('keeps no synchronous call in the files that resolve paths for a decision, a tool call or a sandbox', () => {
    const files = [...ASYNCHRONOUS_FILES.map((file) => path.join(ROOT, file)), ...sourcesUnder(path.join(PACKAGES, 'policy', 'src'))];
    expect(files.filter((file) => SYNCHRONOUS_CALL.test(fs.readFileSync(file, 'utf8'))).map(relative)).toEqual([]);
  });

  it('lets the synchronous driver be used by exactly the listed files, each with its reason', () => {
    const users = productSources()
      .filter((file) => !isGenerated(file) && SYNCHRONOUS_DRIVER.test(fs.readFileSync(file, 'utf8')))
      .map(relative)
      .sort();
    expect(users).toEqual(Object.keys(SYNCHRONOUS_USERS).sort());
    expect(Object.values(SYNCHRONOUS_USERS).filter((reason) => reason.trim() === '')).toEqual([]);
  });

  it('resolves no link and no real path synchronously outside the file-system adapter and the synchronous driver', () => {
    const callers = productSources()
      .filter((file) => !isGenerated(file) && SYNCHRONOUS_HOST_CALL.test(fs.readFileSync(file, 'utf8')))
      .map(relative)
      .sort();
    expect(callers).toEqual(['packages/foundation/src/node-file-system.ts', 'packages/foundation/src/sync-paths.ts']);
  });

  it('exports no synchronous path resolution by its old name from the foundation', () => {
    const index = fs.readFileSync(path.join(PACKAGES, 'foundation/src/index.ts'), 'utf8');
    expect(index).toMatch(/\bcreatePathResolver\b/);
    expect(index).toMatch(/\bhostPaths\b/);
    expect(index).not.toMatch(/\b(canonicalPath|canonicalDirectory|comparableContains|comparablePath|locateThroughFiles|volumeIsCaseInsensitive|caseSensitivityOf)\b/);
  });

  it('lets the scan of port bypasses hold path-compare to the port', () => {
    const scan = fs.readFileSync(path.join(ROOT, 'test/ports-bypass.test.ts'), 'utf8');
    expect(scan).not.toContain("'packages/foundation/src/path-compare.ts'");
  });
});
