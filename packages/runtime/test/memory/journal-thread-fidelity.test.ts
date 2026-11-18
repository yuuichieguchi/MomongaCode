import v8 from 'node:v8';
import { describe, expect, it, vi } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { FIDELITY_SCAN_PAGE_BYTES } from '../../src/memory/journal-thread-limits.ts';
import { fidelityEnv, startedCall } from './fidelity-fixture.ts';
import type { FidelityReply } from './fidelity-fixture.ts';

vi.setConfig({ testTimeout: 300_000 });

const IN_EVENT = 'npm run only-in-event';
const IN_BLOB = 'src/only/in-blob.ts';
const ACROSS = 'ACROSS-THE-PAGE-BOUNDARY-TOKEN';
const ABSENT = 'npm run never-recorded';

const TOKENS = [
  { token: IN_EVENT, claim: 'executed' as const },
  { token: IN_BLOB, claim: 'executed' as const },
  { token: ACROSS, claim: 'executed' as const },
  { token: ABSENT, claim: 'executed' as const },
];

const pageSize = (): number => {
  expect(Number.isInteger(FIDELITY_SCAN_PAGE_BYTES)).toBe(true);
  expect(FIDELITY_SCAN_PAGE_BYTES).toBeGreaterThan(ACROSS.length);
  return FIDELITY_SCAN_PAGE_BYTES;
};

const blobText = (page: number, totalBytes: number): string => {
  const split = page - Math.floor(ACROSS.length / 2);
  const head = `${'a'.repeat(split)}${ACROSS}`;
  const middle = `${'b'.repeat(page)} ${IN_BLOB} `;
  return `${head}${middle}${'c'.repeat(Math.max(0, totalBytes - head.length - middle.length))}`;
};

const withoutLastSeq = (reply: FidelityReply): Omit<FidelityReply, 'lastSeq' | 'checkedThrough'> => {
  const { lastSeq: _lastSeq, checkedThrough: _checkedThrough, ...rest } = reply;
  return rest;
};

const serialized = (value: unknown): number => v8.serialize(value).length;

const answered = async (eventCount: number, blobBytes: number) => {
  const env = await fidelityEnv();
  const page = pageSize();
  const { handle } = await env.store.blobs.put(blobText(page, Math.max(blobBytes, 3 * page)), { mediaType: 'text/plain' } as never);
  const filler: RunEventPayload[] = Array.from({ length: Math.max(0, Math.floor((eventCount - 6) / 3)) }, (_unused, index) => startedCall(`f${index}`, { command: 'ls' })).flat();
  const run = await env.finished([...startedCall('c1', { command: IN_EVENT }), ...startedCall('c2', { command: 'cat big' }, 'omitted', { handle }), ...filler]);
  const request = { kind: 'fidelity', runId: run.id, throughEventSeq: env.store.getRun(run.id)?.lastSeq ?? 0, cwd: env.project, sessionBoundary: env.session.fenceNonce, tokens: TOKENS };
  const reply = await env.fidelity(run.id, TOKENS);
  return { reply, request };
};

describe('the fidelity request kind of the journal thread', () => {
  it('attests a token in an event, in a handled blob larger than one page and across a page boundary, and not one never recorded', async () => {
    const { reply } = await answered(10, 0);
    expect([...reply.attested].sort()).toEqual([ACROSS, IN_EVENT, IN_BLOB].sort());
    expect(reply.unreadable).toEqual([]);
    expect(reply.lastSeq).toBeGreaterThan(0);
  });

  it('lists a missing blob as unreadable and leaves the tokens found only there unattested', async () => {
    const env = await fidelityEnv();
    const missing = 'f'.repeat(64);
    const run = await env.finished([...startedCall('c1', { command: IN_EVENT }), ...startedCall('c2', { command: 'cat big' }, 'omitted', { handle: missing })]);
    const reply = await env.fidelity(run.id, TOKENS);
    expect(reply.attested).toEqual([IN_EVENT]);
    expect(reply.unreadable).toHaveLength(1);
    expect(reply.unreadable[0]).toMatchObject({ handle: missing });
    expect(typeof reply.unreadable[0]?.reason).toBe('string');
  });

  it('keeps the request and the reply the same size for a run of 10 and of 10,000 events', async () => {
    const small = await answered(10, 0);
    const large = await answered(10_000, 0);
    expect(serialized({ ...large.request, runId: '', throughEventSeq: 0 })).toBe(serialized({ ...small.request, runId: '', throughEventSeq: 0 }));
    expect(serialized(withoutLastSeq(large.reply))).toBe(serialized(withoutLastSeq(small.reply)));
  });

  it('keeps the reply the same size for a 1 KB and a 50 MB blob', async () => {
    const small = await answered(10, 1024);
    const large = await answered(10, 50 * 1024 * 1024);
    expect(serialized(withoutLastSeq(large.reply))).toBe(serialized(withoutLastSeq(small.reply)));
  });
});
