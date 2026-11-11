import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');
const TEST_ONLY_MODULES = ['replay-adapter'] as const;

const sourceFilesOf = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesOf(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

const productSources = (): string[] =>
  fs
    .readdirSync(packagesDir)
    .map((name) => path.join(packagesDir, name, 'src'))
    .filter((src) => fs.existsSync(src))
    .flatMap(sourceFilesOf);

const testOnlyReachOf = (file: string, source: string): string[] =>
  TEST_ONLY_MODULES.filter((name) => path.basename(file).startsWith(`${name}.`) || new RegExp(`from\\s+['"][^'"]*/${name}(\\.ts)?['"]`).test(source)).map(
    (name) => `${path.relative(root, file)}: ${name}`,
  );

describe('product source holds only what the product runs', () => {
  it('no file under packages/*/src is or imports a test-only module', () => {
    const reached = productSources().flatMap((file) => testOnlyReachOf(file, fs.readFileSync(file, 'utf8')));
    expect(reached).toEqual([]);
  });

  it('finds a planted import of a test-only module', () => {
    expect(testOnlyReachOf('/x/packages/gateway/src/index.ts', "export { createReplayAdapter } from './adapters/replay-adapter.ts';")).toHaveLength(1);
  });
});
