import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));

const ALLOWLIST: ReadonlySet<string> = new Set([
  'support/tracked-spawn-port.ts',
  'fixtures/p2-supervisor-fixture.ts',
  'fixtures/p2-manager-fixture.ts',
  'scan.test.ts',
]);

const FORBIDDEN = [/createSpawnPort/, /[/'"`]spawn-port(?:\.[cm]?[jt]s)?['"`]/];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts']);

const findRealPortReferences = (source: string): string[] => FORBIDDEN.filter((pattern) => pattern.test(source)).map((pattern) => pattern.source);

const listFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
  });

describe('real SpawnPort access', () => {
  it('supervisor tests take the real SpawnPort only from trackedSpawnPort', () => {
    const files = listFiles(TEST_ROOT).map((file) => path.relative(TEST_ROOT, file).split(path.sep).join('/'));
    expect(files).toContain('support/tracked-spawn-port.ts');
    expect(files).toContain('scan.test.ts');
    const offenders = files.filter((file) => !ALLOWLIST.has(file)).filter((file) => findRealPortReferences(fs.readFileSync(path.join(TEST_ROOT, file), 'utf8')).length > 0);
    expect(offenders).toEqual([]);
  });

  it('the support helper itself reaches the real port', () => {
    const source = fs.readFileSync(path.join(TEST_ROOT, 'support/tracked-spawn-port.ts'), 'utf8');
    expect(findRealPortReferences(source).length).toBeGreaterThan(0);
  });

  it('the scan reports every route to the real port (negative control)', () => {
    const routes = [
      "import { createSpawnPort } from '../src/spawn-port.ts';",
      "const port = await import('../src/spawn-port.ts');",
      "import * as supervisor from '../src/index.ts';\nconst port = supervisor.createSpawnPort();",
      "export { createSpawnPort } from '../../src/index.ts';",
    ];
    for (const route of routes) expect(findRealPortReferences(route).length, route).toBeGreaterThan(0);
    expect(findRealPortReferences("import { createFakeSpawnPort } from './support/p2-fake-spawn-port.ts';")).toEqual([]);
    expect(findRealPortReferences("import { trackedSpawnPort } from './support/tracked-spawn-port.ts';")).toEqual([]);
    expect(findRealPortReferences("const port = await import('../src/spawn-port');")).toHaveLength(1);
  });
});
