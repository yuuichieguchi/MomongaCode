import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDir, documentFolderDigestOf, documentFolderOf } from '../src/index.ts';

describe('documentFolderOf', () => {
  it('returns absent when the environment variable is not set, and named when explicitly given', () => {
    expect(documentFolderOf('MOMONGA_DESIGN_DOCUMENTS', undefined, {})).toEqual({ kind: 'absent' });
    expect(documentFolderOf('MOMONGA_DESIGN_DOCUMENTS', undefined, { MOMONGA_DESIGN_DOCUMENTS: '/given' })).toEqual({ kind: 'named', folder: '/given' });
  });

  it('computes a content digest when a folder exists and returns absent when it does not', () => {
    const dir = createTempDir();
    try {
      expect(documentFolderDigestOf(path.join(dir, 'missing'))).toBe('absent');
      fs.writeFileSync(path.join(dir, 'a.md'), 'one');
      const first = documentFolderDigestOf(dir);
      fs.writeFileSync(path.join(dir, 'a.md'), 'two');
      const second = documentFolderDigestOf(dir);
      expect(first).not.toBe(second);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
