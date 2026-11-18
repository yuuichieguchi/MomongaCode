import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir } from '@momonga/testkit';
import { ensureExtracted } from '../scripts/node-runtime.ts';

let cacheDir = '';

beforeEach(() => {
  cacheDir = createTempDir();
});

afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

const writeNode = (directory: string): void => {
  fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'bin', 'node'), 'node binary');
};

describe('the extracted node runtime in the shared cache', () => {
  it('leaves a present runtime that passes its check untouched, and extracts nothing', async () => {
    const extracted = path.join(cacheDir, 'node-v26.12.1-darwin-arm64');
    writeNode(extracted);
    const binary = path.join(extracted, 'bin', 'node');
    const before = fs.statSync(binary);
    let extractions = 0;
    const result = await ensureExtracted({ cacheDir, stem: 'node-v26.12.1-darwin-arm64', nodeRelativePath: ['bin', 'node'], valid: (file) => fs.existsSync(file), extract: () => void (extractions += 1) });
    const after = fs.statSync(binary);
    expect(result).toBe(binary);
    expect(extractions).toBe(0);
    expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs });
  });

  it('extracts a missing runtime into a temporary directory and renames it into place, so the final path never holds a partial tree', async () => {
    const seen: string[] = [];
    const result = await ensureExtracted({
      cacheDir,
      stem: 'node-v26.12.1-darwin-arm64',
      nodeRelativePath: ['bin', 'node'],
      valid: (file) => fs.existsSync(file),
      extract: (into) => {
        seen.push(into);
        expect(fs.existsSync(path.join(cacheDir, 'node-v26.12.1-darwin-arm64'))).toBe(false);
        writeNode(path.join(into, 'node-v26.12.1-darwin-arm64'));
      },
    });
    expect(seen).toHaveLength(1);
    expect(path.dirname(seen[0] as string)).toBe(cacheDir);
    expect(result).toBe(path.join(cacheDir, 'node-v26.12.1-darwin-arm64', 'bin', 'node'));
    expect(fs.readFileSync(result, 'utf8')).toBe('node binary');
    expect(fs.readdirSync(cacheDir)).toEqual(['node-v26.12.1-darwin-arm64']);
  });

  it('replaces a runtime that fails its check by renaming the new tree over it', async () => {
    const extracted = path.join(cacheDir, 'node-v26.12.1-darwin-arm64');
    fs.mkdirSync(extracted);
    const result = await ensureExtracted({
      cacheDir,
      stem: 'node-v26.12.1-darwin-arm64',
      nodeRelativePath: ['bin', 'node'],
      valid: (file) => fs.existsSync(file),
      extract: (into) => writeNode(path.join(into, 'node-v26.12.1-darwin-arm64')),
    });
    expect(fs.readFileSync(result, 'utf8')).toBe('node binary');
    expect(fs.readdirSync(cacheDir).sort()).toEqual(['node-v26.12.1-darwin-arm64']);
  });
});
