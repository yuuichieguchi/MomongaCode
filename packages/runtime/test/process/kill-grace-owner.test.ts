import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src');

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

describe('the kill grace of the runtime is the one foundation value', () => {
  it('no runtime source names a grace constant of its own', () => {
    const named = sourceFiles(sourceRoot).filter((file) => fs.readFileSync(file, 'utf8').includes('MARKER_REAP_KILL_GRACE_MS'));
    expect(named).toEqual([]);
  });
});
