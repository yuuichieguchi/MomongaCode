import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Approval, RuntimeStore } from '@momonga/store';
import { START_MS, enqueue, harness, makeStoreDir, newSession, openStoreAt } from './helpers.ts';

const fileMode = (file: string) => fs.statSync(file).mode & 0o777;
const sha256 = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');

describe('idempotency', () => {
  it('reports NEW, then PENDING with the record, then COMPLETED with the result', () => {
    const { clock, store } = harness();
    expect(store.idempotency.begin('k1', { expiresAt: START_MS + 1000, meta: { tool: 'Bash' } })).toEqual({ s: 'NEW' });
    clock.advance(5);
    store.idempotency.attachProcess('k1', { pgid: 4242, startedAt: START_MS + 5 });
    expect(store.idempotency.begin('k1', { expiresAt: START_MS + 1000, meta: {} })).toEqual({
      s: 'PENDING',
      rec: {
        key: 'k1',
        state: 'PENDING',
        meta: { tool: 'Bash' },
        pgid: 4242,
        startedAt: START_MS + 5,
        createdAt: START_MS,
        expiresAt: START_MS + 1000,
      },
    });
    store.idempotency.complete('k1', { exitCode: 0, output: 'ok' });
    expect(store.idempotency.begin('k1', { expiresAt: START_MS + 1000, meta: {} })).toEqual({
      s: 'COMPLETED',
      result: { exitCode: 0, output: 'ok' },
    });
  });

  it('reports UNKNOWN after markUnknown', () => {
    const { store } = harness();
    store.idempotency.begin('k1', { expiresAt: START_MS + 1000, meta: {} });
    store.idempotency.markUnknown('k1');
    expect(store.idempotency.begin('k1', { expiresAt: START_MS + 1000, meta: {} })).toMatchObject({
      s: 'UNKNOWN',
      rec: { key: 'k1', state: 'UNKNOWN' },
    });
  });

  it('lets exactly one of two connections win the insert', () => {
    const { dbPath, clock, store } = harness();
    const other = openStoreAt(dbPath, clock);
    const first = store.idempotency.begin('race', { expiresAt: START_MS + 1000, meta: {} });
    const second = other.idempotency.begin('race', { expiresAt: START_MS + 1000, meta: {} });
    expect([first.s, second.s]).toEqual(['NEW', 'PENDING']);
  });

  it('purges only expired records and returns how many', () => {
    const { store } = harness();
    store.idempotency.begin('old', { expiresAt: START_MS + 10, meta: {} });
    store.idempotency.begin('new', { expiresAt: START_MS + 1000, meta: {} });
    expect(store.idempotency.purgeExpired(START_MS + 10)).toBe(1);
    expect(store.idempotency.begin('old', { expiresAt: START_MS + 2000, meta: {} })).toEqual({ s: 'NEW' });
    expect(store.idempotency.begin('new', { expiresAt: START_MS + 2000, meta: {} }).s).toBe('PENDING');
  });

  it('throws naming the key when completing an unknown key', () => {
    const { store } = harness();
    expect(() => store.idempotency.complete('ghost', {})).toThrow(/ghost/);
  });
});

const createApproval = (store: RuntimeStore, input: Parameters<RuntimeStore['approvals']['create']>[0]): Approval => {
  const result = store.approvals.create(input);
  if (result.kind !== 'ok') throw new Error(`expected approval creation to succeed: ${result.reason ?? result.kind}`);
  return result.approval;
};

describe('approvals', () => {
  const options = [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  ] as const;

  const setup = () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    return { ...h, run };
  };

  it('creates one pending approval per (run, call) and lists it', () => {
    const { store, run } = setup();
    const approval = createApproval(store, { runId: run.id, callId: 'c1', options: [...options], expiresAt: START_MS + 60_000 });
    expect(approval).toMatchObject({
      runId: run.id,
      callId: 'c1',
      status: 'pending',
      options: [...options],
      expiresAt: START_MS + 60_000,
      createdAt: START_MS,
    });
    const again = createApproval(store, { runId: run.id, callId: 'c1', options: [...options], expiresAt: START_MS + 99_000 });
    expect(again.id).toBe(approval.id);
    expect(store.approvals.listPending(run.id).map((item) => item.id)).toEqual([approval.id]);
    expect(store.approvals.get(approval.id)).toEqual(approval);
  });

  it('refuses to re-request an approval that was already resolved instead of returning the stale one', () => {
    const { store, run } = setup();
    const approval = createApproval(store, { runId: run.id, callId: 'c1', options: [...options], expiresAt: START_MS + 60_000 });
    store.approvals.resolve(approval.id, { optionId: 'allow_once' });
    const again = store.approvals.create({ runId: run.id, callId: 'c1', options: [...options], expiresAt: START_MS + 60_000 });
    expect(again.kind).toBe('conflict');
    expect(store.approvals.listPending(run.id)).toEqual([]);
  });

  it('refuses to re-request a pending approval with different options', () => {
    const { store, run } = setup();
    createApproval(store, { runId: run.id, callId: 'c1', options: [...options], expiresAt: START_MS + 60_000 });
    const again = store.approvals.create({ runId: run.id, callId: 'c1', options: [options[0]], expiresAt: START_MS + 60_000 });
    expect(again.kind).toBe('conflict');
  });

  it('approves calls that share a provider id independently under their run-unique ids', () => {
    const { store, run } = setup();
    const first = createApproval(store, { runId: run.id, callId: 'run-call-1', options: [...options], expiresAt: START_MS + 60_000 });
    store.approvals.resolve(first.id, { optionId: 'allow_once' });
    const second = createApproval(store, { runId: run.id, callId: 'run-call-2', options: [...options], expiresAt: START_MS + 60_000 });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending');
    expect(store.approvals.resolve(second.id, { optionId: 'reject_once' })).toMatchObject({ kind: 'ok', approval: { optionId: 'reject_once' } });
    expect(store.approvals.get(first.id)?.optionId).toBe('allow_once');
  });

  it('resolves exactly once', () => {
    const { clock, store, run } = setup();
    const approval = createApproval(store, { runId: run.id, callId: 'c1', options: [...options], expiresAt: START_MS + 60_000 });
    clock.advance(9);
    expect(store.approvals.resolve(approval.id, { optionId: 'allow_once' })).toMatchObject({
      kind: 'ok',
      approval: { id: approval.id, status: 'resolved', optionId: 'allow_once', resolvedAt: START_MS + 9 },
    });
    expect(store.approvals.resolve(approval.id, { optionId: 'reject_once' }).kind).toBe('conflict');
    expect(store.approvals.get(approval.id)?.optionId).toBe('allow_once');
    expect(store.approvals.listPending(run.id)).toEqual([]);
  });

  it('rejects an option that was not offered', () => {
    const { store, run } = setup();
    const approval = createApproval(store, { runId: run.id, callId: 'c1', options: [...options], expiresAt: START_MS + 60_000 });
    expect(store.approvals.resolve(approval.id, { optionId: 'allow_always' }).kind).toBe('conflict');
    expect(store.approvals.get(approval.id)?.status).toBe('pending');
  });

  it('lists pending approvals that expired by a given time', () => {
    const { store, run } = setup();
    const soon = createApproval(store, { runId: run.id, callId: 'c1', options: [...options], expiresAt: START_MS + 10 });
    createApproval(store, { runId: run.id, callId: 'c2', options: [...options], expiresAt: START_MS + 100 });
    const resolved = createApproval(store, { runId: run.id, callId: 'c3', options: [...options], expiresAt: START_MS + 5 });
    store.approvals.resolve(resolved.id, { optionId: 'allow_once' });
    expect(store.approvals.listExpired(START_MS + 10).map((item) => item.id)).toEqual([soon.id]);
  });
});

describe('blobs', () => {
  const text = 'l1\nl2\nl3\nl4\n';

  it('stores content-addressed private files and deduplicates', () => {
    const { dir, store } = harness();
    const first = store.blobs.put(text, { mediaType: 'text/plain' });
    expect(first).toEqual({ handle: sha256(text), sha256: sha256(text), byteLength: 12, lineCount: 4 });
    const file = path.join(dir, 'blobs', sha256(text));
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(fileMode(file)).toBe(0o600);
    expect(fileMode(path.join(dir, 'blobs'))).toBe(0o700);
    expect(store.blobs.put(Buffer.from(text, 'utf8'), { mediaType: 'text/plain' })).toEqual(first);
    expect(fs.readdirSync(path.join(dir, 'blobs'))).toEqual([sha256(text)]);
  });

  it('reads an inclusive 1-based line range with totals', async () => {
    const { store } = harness();
    const { handle } = store.blobs.put(text, { mediaType: 'text/plain' });
    expect(await store.blobs.read(handle, { lineStart: 2, lineEnd: 3 })).toEqual({ text: 'l2\nl3\n', totalLines: 4, totalBytes: 12 });
    expect(await store.blobs.read(handle, { lineStart: 4, lineEnd: 99 })).toEqual({ text: 'l4\n', totalLines: 4, totalBytes: 12 });
    expect(await store.blobs.read(handle, { lineStart: 5, lineEnd: 9 })).toEqual({ text: '', totalLines: 4, totalBytes: 12 });
  });

  it('keeps an unterminated last line intact in a line range', async () => {
    const { store } = harness();
    const { handle } = store.blobs.put('a\nb', { mediaType: 'text/plain' });
    expect(await store.blobs.read(handle, { lineStart: 2, lineEnd: 2 })).toEqual({ text: 'b', totalLines: 2, totalBytes: 3 });
  });

  it('reads a byte range with totals and the actual range returned', async () => {
    const { store } = harness();
    const { handle } = store.blobs.put(text, { mediaType: 'text/plain' });
    expect(await store.blobs.read(handle, { offset: 3, length: 5 })).toEqual({
      text: 'l2\nl3',
      totalLines: 4,
      totalBytes: 12,
      offset: 3,
      length: 5,
    });
  });

  it('never splits a multi-byte character at either end of a byte range', async () => {
    const { store } = harness();
    const { handle } = store.blobs.put('a€b€c', { mediaType: 'text/plain' });
    const read = (offset: number, length: number) => store.blobs.read(handle, { offset, length });
    expect(await read(2, 6)).toMatchObject({ text: 'b€', offset: 4, length: 4 });
    expect(await read(0, 6)).toMatchObject({ text: 'a€b€', offset: 0, length: 8 });
    expect(await read(2, 4)).toMatchObject({ text: 'b€', offset: 4, length: 4 });
    expect(await read(2, 2)).toMatchObject({ text: 'b', offset: 4, length: 1 });
    expect(await read(1, 1)).toMatchObject({ text: '€', offset: 1, length: 3 });
    for (const slice of [await read(2, 6), await read(0, 6), await read(2, 4), await read(2, 2)]) {
      expect(slice.text).not.toContain('\uFFFD');
    }
    expect(await read(9, 4)).toMatchObject({ text: '', length: 0 });
    expect(await read(1, 0)).toMatchObject({ text: '', offset: 1, length: 0 });
  });

  it('continues a byte-range walk without gaps or duplicates', async () => {
    const { store } = harness();
    const content = 'aé€😀z'.repeat(20);
    const { handle, byteLength } = store.blobs.put(content, { mediaType: 'text/plain' });
    let offset = 0;
    let rebuilt = '';
    while (offset < byteLength) {
      const slice = await store.blobs.read(handle, { offset, length: 5 });
      rebuilt += slice.text;
      expect(slice.length).toBeGreaterThan(0);
      offset = slice.offset + slice.length;
    }
    expect(rebuilt).toBe(content);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('walks mixed 1-4 byte characters with window size %i to completion', async (window) => {
    const { store } = harness();
    const content = 'aé€😀z€é😀'.repeat(7);
    const { handle, byteLength } = store.blobs.put(content, { mediaType: 'text/plain' });
    let offset = 0;
    let rebuilt = '';
    let steps = 0;
    while (offset < byteLength) {
      steps += 1;
      expect(steps).toBeLessThanOrEqual(byteLength);
      const slice = await store.blobs.read(handle, { offset, length: window });
      expect(slice.length).toBeGreaterThan(0);
      expect(slice.offset).toBeGreaterThanOrEqual(offset);
      rebuilt += slice.text;
      offset = slice.offset + slice.length;
    }
    expect(rebuilt).toBe(content);
  });

  it('always makes progress and never emits a replacement character from any starting offset', async () => {
    const { store } = harness();
    const { handle, byteLength } = store.blobs.put('aé€😀z', { mediaType: 'text/plain' });
    for (let start = 0; start < byteLength; start += 1) {
      for (let window = 1; window <= 8; window += 1) {
        const slice = await store.blobs.read(handle, { offset: start, length: window });
        expect(slice.length).toBeGreaterThan(0);
        expect(slice.text).not.toContain('\uFFFD');
        expect(Buffer.byteLength(slice.text, 'utf8')).toBe(slice.length);
      }
    }
  });

  it('counts a last line without trailing newline', () => {
    const { store } = harness();
    expect(store.blobs.put('a\nb', { mediaType: 'text/plain' }).lineCount).toBe(2);
  });

  it('fails clearly for an unknown handle', async () => {
    const { store } = harness();
    const missing = sha256('never stored');
    await expect(store.blobs.read(missing, { offset: 0, length: 1 })).rejects.toThrow(new RegExp(`unknown blob.*${missing}`));
  });

  it('rejects content that is not valid UTF-8', () => {
    const { dir, store } = harness();
    expect(() => store.blobs.put(Buffer.from([0x61, 0xff, 0xfe]), { mediaType: 'application/octet-stream' })).toThrow(/UTF-8/);
    expect(fs.existsSync(path.join(dir, 'blobs'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'blobs'))).toEqual([]);
  });

  it('streams line ranges instead of loading the whole blob', async () => {
    const { store } = harness();
    const line = 'x'.repeat(99) + '\n';
    const { handle, byteLength } = store.blobs.put(line.repeat(200_000), { mediaType: 'text/plain' });
    expect(byteLength).toBe(20_000_000);
    const readFileSync = vi.spyOn(fs, 'readFileSync');
    const createReadStream = vi.spyOn(fs, 'createReadStream');
    try {
      const slice = await store.blobs.read(handle, { lineStart: 2, lineEnd: 3 });
      expect(slice.text).toBe(line.repeat(2));
      expect(readFileSync).not.toHaveBeenCalled();
      expect(createReadStream).toHaveBeenCalledTimes(1);
      const stream = createReadStream.mock.results[0]!.value as fs.ReadStream;
      expect(stream.bytesRead).toBeLessThan(2_000_000);
    } finally {
      readFileSync.mockRestore();
      createReadStream.mockRestore();
    }
  });

  it('fsyncs the blob directory after publishing a new blob', () => {
    const { dir, store } = harness();
    const open = vi.spyOn(fs, 'openSync');
    try {
      store.blobs.put('durable', { mediaType: 'text/plain' });
      expect(open.mock.calls.some(([target, flags]) => target === path.join(dir, 'blobs') && flags === 'r')).toBe(true);
    } finally {
      open.mockRestore();
    }
  });

  it.each([
    ['same size', (original: string) => 'z'.repeat(original.length)],
    ['different size', () => 'truncated'],
  ])('rewrites an existing blob file whose content no longer matches (%s)', (_name, corrupt) => {
    const { dir, store } = harness();
    const { handle } = store.blobs.put(text, { mediaType: 'text/plain' });
    const file = path.join(dir, 'blobs', handle);
    fs.writeFileSync(file, corrupt(text));
    store.blobs.put(text, { mediaType: 'text/plain' });
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(fileMode(file)).toBe(0o600);
    expect(fs.readdirSync(path.join(dir, 'blobs'))).toEqual([handle]);
  });
});

describe('trust', () => {
  it('stores decisions under the realpath', () => {
    const { store } = harness();
    const project = makeStoreDir();
    const link = path.join(makeStoreDir(), 'link');
    fs.symlinkSync(project, link);
    expect(store.trust.get(project)).toBeUndefined();
    store.trust.set(link, 'trusted');
    expect(store.trust.get(fs.realpathSync(project))).toBe('trusted');
    expect(store.trust.get(project)).toBe('trusted');
    store.trust.set(project, 'untrusted');
    expect(store.trust.get(link)).toBe('untrusted');
  });
});
