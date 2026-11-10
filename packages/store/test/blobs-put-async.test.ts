import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAtomicWriteTemporary } from '@momonga/foundation';
import { harness } from './helpers.ts';

const SOURCE = path.resolve(import.meta.dirname, '../src/blobs.ts');

describe('blobs.put is asynchronous', () => {
  it('returns a promise of the reference, and the content is on disk and readable once it settles', async () => {
    const { store, dir } = harness();
    const pending = store.blobs.put('one\ntwo\n', { mediaType: 'text/plain' });

    expect(pending).toBeInstanceOf(Promise);
    const ref = await pending;

    expect(ref).toEqual({ handle: store.blobs.handleFor('one\ntwo\n'), sha256: ref.handle, byteLength: 8, lineCount: 2 });
    expect(fs.readFileSync(path.join(dir, 'blobs', ref.handle), 'utf8')).toBe('one\ntwo\n');
    expect((await store.blobs.read(ref.handle, { lineStart: 1, lineEnd: 2 })).text).toBe('one\ntwo\n');
  });

  it('settles every concurrent put of the same content with the same reference and leaves one file', async () => {
    const { store, dir } = harness();

    const refs = await Promise.all(Array.from({ length: 8 }, () => store.blobs.put('same content', { mediaType: 'text/plain' })));

    expect(new Set(refs.map((ref) => ref.handle)).size).toBe(1);
    const names = fs.readdirSync(path.join(dir, 'blobs'));
    expect(names.filter((name) => !isAtomicWriteTemporary(name))).toEqual([refs[0]?.handle]);
    expect(names.filter(isAtomicWriteTemporary)).toEqual([]);
  });

  it('rejects content that is not UTF-8 text', async () => {
    const { store } = harness();
    await expect(store.blobs.put(Uint8Array.from([0xff, 0xfe]), { mediaType: 'text/plain' })).rejects.toThrow(TypeError);
  });

  it('writes through the asynchronous atomic write and holds no synchronous write or content read', () => {
    const source = fs.readFileSync(SOURCE, 'utf8');
    expect(source).toMatch(/\bwriteFileAtomically\(/);
    expect(source).not.toMatch(/\bwriteFileAtomicallySync\b/);
    expect(source).not.toMatch(/\breadFileSync\(/);
  });
});
