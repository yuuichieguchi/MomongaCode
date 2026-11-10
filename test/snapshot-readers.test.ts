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
    .filter((name) => fs.existsSync(path.join(packagesDir, name, 'src')))
    .flatMap((name) => sourcesOf(path.join(packagesDir, name, 'src')).filter((file) => pattern.test(fs.readFileSync(file, 'utf8'))))
    .map(relative)
    .sort();

describe('who reads the snapshot of a run, which a terminal transition writes on the event loop', () => {
  it('is read only through store.load, by the claim start alone: child final text, upstream cancel and stopped-run release read small facts (row 3, I2)', () => {
    expect(filesMatching(/store\.load\(/)).toEqual(['runtime/src/worker/journal.ts']);
  });

  it('is reachable through an aliased store by no caller: no Pick<RuntimeStore, ..., load> remains (row 3, I2)', () => {
    expect(filesMatching(/Pick<RuntimeStore,[^>]*'load'/)).toEqual([]);
    expect(filesMatching(/\bload:\s*\(runId/)).toEqual(['store/src/runtime-store.ts']);
  });

  it('is written only through store.writeSnapshot, by the journal', () => {
    expect(filesMatching(/\.writeSnapshot\(/)).toEqual(['runtime/src/worker/journal.ts']);
  });

  it('is asked for by no terminal transition: the only journal.snapshot() of terminals.ts is in yieldTo, whose snapshot the next claim start reads (O14, I4b)', () => {
    const source = fs.readFileSync(path.join(packagesDir, 'runtime', 'src', 'worker', 'terminals.ts'), 'utf8');
    expect(source.match(/journal\.snapshot\(\)/g)).toHaveLength(1);
    const yieldTo = source.slice(source.indexOf('yieldTo: async'), source.indexOf('cancel,'));
    expect(yieldTo).toContain('journal.snapshot()');
  });

  it('is read by the store itself only through load: inheritance plans on the journal thread and the loop only commits it (row 11, 13.4 inherit_plan)', () => {
    const source = fs.readFileSync(path.join(packagesDir, 'store', 'src', 'runtime-store.ts'), 'utf8');
    expect(source.match(/loadInReadTx\(/g)).toHaveLength(1);
    expect(source.match(/foldedRun\(/g)).toBeNull();
  });
});
