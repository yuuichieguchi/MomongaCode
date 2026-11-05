import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packagesDir = path.resolve(import.meta.dirname, '..', 'packages');

const sourcesOf = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'test' || entry.name === 'dist' ? [] : sourcesOf(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

const relative = (file: string): string => path.relative(packagesDir, file).split(path.sep).join('/');

const filesMatching = (pattern: RegExp): string[] =>
  fs
    .readdirSync(packagesDir)
    .flatMap((name) => sourcesOf(path.join(packagesDir, name, 'src')).filter((file) => pattern.test(fs.readFileSync(file, 'utf8'))))
    .map(relative)
    .sort();

describe('who reads the snapshot of a run, which a terminal transition writes on the event loop', () => {
  it('is read only through store.load, by these callers and by the store itself', () => {
    expect(filesMatching(/store\.load\(/)).toEqual([
      'runtime/src/process/cancel-upstream.ts',
      'runtime/src/process/child-runs.ts',
      'runtime/src/process/release-stopped.ts',
      'runtime/src/worker/journal.ts',
    ]);
  });

  it('is written only through store.writeSnapshot, by the journal', () => {
    expect(filesMatching(/\.writeSnapshot\(/)).toEqual(['runtime/src/worker/journal.ts']);
  });

  it('is read by the store itself only for the claim, for inheritance and through load', () => {
    const source = fs.readFileSync(path.join(packagesDir, 'store', 'src', 'runtime-store.ts'), 'utf8');
    expect(source.match(/loadInReadTx\(/g)).toHaveLength(2);
    expect(source.match(/foldedRun\(/g)).toHaveLength(2);
  });
});
