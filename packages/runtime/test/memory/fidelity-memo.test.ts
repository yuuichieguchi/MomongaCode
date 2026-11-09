import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIDELITY_FOLD_VERSION } from '@momonga/protocol';
import type { ClaimedToken, RunEventPayload } from '@momonga/protocol';
import { blobDirectoryOf } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { answeredRun, chainBuilder, eventsOf, generatedRun, referenceHarness } from '../../../store/test/support/reference.ts';
import type { ChainBuilder, ReferenceHarness } from '../../../store/test/support/reference.ts';
import { seeded } from '../../../store/test/support/seeded.ts';
import { mustRun, rawDb } from '../../../store/test/helpers.ts';
import { CWD, directFidelity } from './record-cut-support.ts';
import type { FidelityRequest } from './record-cut-support.ts';
import type { FidelityReply } from './fidelity-fixture.ts';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

type MemoStore = RuntimeStore & { recordFidelityVerdicts(runId: string, cwd: string, reply: FidelityReply): void };

const memo = (h: ReferenceHarness): MemoStore => h.store as MemoStore;

const checked = async (h: ReferenceHarness, request: FidelityRequest) => {
  const result = await directFidelity(h, request);
  memo(h).recordFidelityVerdicts(request.runId, request.cwd ?? CWD, result.reply);
  return result;
};

type VerdictRow = { run_id: string; cwd: string; fold_version: number; token: string; inh: string; inh_deps: string; task_stated: number; stated_at: number | null; executed_at: number | null; own_deps: string; checked_through: number };

const rowsOf = (h: ReferenceHarness, runId: string): VerdictRow[] =>
  rawDb(h.dbPath).prepare('SELECT * FROM fidelity_verdicts WHERE run_id = ? ORDER BY cwd, token').all(runId) as unknown as VerdictRow[];

const inheritingRun = async (h: ReferenceHarness, b: ChainBuilder, task: string, body: (claim: Parameters<ChainBuilder['text']>[0]) => void = () => undefined) => answeredRun(h, b, task, body);

const ABSENT: ClaimedToken = { token: 'npm run never-recorded', claim: 'executed' };

const callEvents = (callId: string, rawInput: Record<string, unknown>, completion: Record<string, unknown>): RunEventPayload[] =>
  [
    { type: 'tool.call', callId, providerCallId: callId, name: 'Sh', kind: 'other', title: callId, rawInput },
    { type: 'tool.started', callId, idemKey: `k-${callId}` },
    { type: 'tool.completed', callId, status: 'completed', output: 'ok', ...completion },
  ] as RunEventPayload[];

describe('the memo of attestation verdicts (decision 40 B, 13.12b)', () => {
  it('writes one row per checked token under the current fold version, with the class found in the inherited part', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'root', (claim) => b.tool(claim), { fresh: true });
    const child = await inheritingRun(h, b, 'child', (claim) => b.text(claim));
    await checked(h, { runId: child.id, tokens: [{ token: 'out c1', claim: 'executed' }] });
    expect(rowsOf(h, child.id)).toEqual([
      expect.objectContaining({ cwd: CWD, fold_version: FIDELITY_FOLD_VERSION, token: 'out c1', inh: 'executed', inh_deps: '[]', executed_at: null, checked_through: mustRun(h.store, child.id).lastSeq }),
    ]);
  });

  it('sets checked_through only at a seq with no call pending: just before the tool.call of a call that never completed', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const run = await answeredRun(h, b, 'root', (claim) => {
      b.tool(claim);
      b.openCall(claim, true);
    }, { fresh: true, ending: { to: 'STOPPED', stopReason: 'timeout' } });
    const pending = eventsOf(h.store, run.id).filter((event) => event.type === 'tool.call').at(-1);
    await checked(h, { runId: run.id, tokens: [ABSENT] });
    expect(rowsOf(h, run.id).map((row) => row.checked_through)).toEqual([(pending?.seq ?? 0) - 1]);
  });

  it('writes no row for a check that met an unreadable blob', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const run = await answeredRun(h, b, 'root', (claim) => b.append(claim, callEvents('c9', { command: 'cat big' }, { handle: 'f'.repeat(64) })), { fresh: true });
    const { reply } = await checked(h, { runId: run.id, tokens: [ABSENT] });
    expect(reply.unreadable).toHaveLength(1);
    expect(rowsOf(h, run.id)).toEqual([]);
  });

  it('keeps the same raw path under two cwds in two rows with their own verdicts, because the path reduces by the cwd', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const run = await answeredRun(h, b, 'root', (claim) => b.append(claim, callEvents('c9', { file_path: 'sub/x.txt' }, {})), { fresh: true });
    const write = eventsOf(h.store, run.id).find((event) => event.type === 'tool.completed');
    const token = { token: '/work/a/sub/x.txt', claim: 'executed' as const };
    await checked(h, { runId: run.id, cwd: '/work/a', tokens: [token] });
    await checked(h, { runId: run.id, cwd: '/work/b', tokens: [token] });
    expect(rowsOf(h, run.id).map((row) => [row.cwd, row.executed_at])).toEqual([
      ['/work/a', write?.seq],
      ['/work/b', null],
    ]);
  });

  it('a second check after more events steps only the events since the memoised bound', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'long root', (claim) => {
      for (let index = 0; index < 1500; index += 1) b.text(claim, 4);
    }, { fresh: true });
    const second = await inheritingRun(h, b, 'second', (claim) => b.text(claim));
    const first = await checked(h, { runId: second.id, tokens: [ABSENT] });
    const third = await inheritingRun(h, b, 'third', (claim) => {
      for (let index = 0; index < 5; index += 1) b.text(claim);
    });
    const again = await checked(h, { runId: third.id, tokens: [ABSENT] });
    expect(first.stepped).toBeGreaterThan(3000);
    expect(again.reply.attested).toEqual([]);
    expect(again.stepped).toBe(mustRun(h.store, third.id).lastSeq);
  });

  it('carries the handle of a blob witness down a chain and drops the verdict when the blob is gone', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const TOKEN = { token: 'only-in-the-blob-token', claim: 'executed' as const };
    const { handle } = await h.store.blobs.put(`head ${TOKEN.token} tail`, { mediaType: 'text/plain' } as never);
    await answeredRun(h, b, 'root', (claim) => b.append(claim, callEvents('c9', { command: 'cat big' }, { output: 'omitted', handle })), { fresh: true });
    const second = await inheritingRun(h, b, 'second');
    expect((await checked(h, { runId: second.id, tokens: [TOKEN] })).reply.attested).toEqual([TOKEN.token]);
    const third = await inheritingRun(h, b, 'third');
    expect((await checked(h, { runId: third.id, tokens: [TOKEN] })).reply.attested).toEqual([TOKEN.token]);
    expect(rowsOf(h, third.id)).toEqual([expect.objectContaining({ inh: 'executed', inh_deps: JSON.stringify([handle]) })]);
    const db = rawDb(h.dbPath);
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('DELETE FROM blobs WHERE sha256 = ?').run(handle);
    fs.rmSync(path.join(blobDirectoryOf(h.dbPath), handle), { force: true });
    const after = await directFidelity(h, { runId: third.id, tokens: [TOKEN] });
    expect(after.reply.attested).toEqual([]);
  });

  it('a denied completion offers nothing, memoised or not', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'root', (claim) => b.append(claim, [
      { type: 'tool.call', callId: 'c9', providerCallId: 'c9', name: 'Sh', kind: 'other', title: 'c9', rawInput: { command: 'make deploy' } },
      { type: 'tool.completed', callId: 'c9', status: 'failed', output: 'Permission denied', denial: { source: 'rule', reason: 'rule' } },
    ] as RunEventPayload[]), { fresh: true });
    const second = await inheritingRun(h, b, 'second');
    const token = { token: 'make deploy', claim: 'executed' as const };
    expect((await checked(h, { runId: second.id, tokens: [token] })).reply.attested).toEqual([]);
    const third = await inheritingRun(h, b, 'third');
    expect((await checked(h, { runId: third.id, tokens: [token] })).reply.attested).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5])('a memoised check equals the unmemoised one for a generated chain, seed %i', async (seed) => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const random = seeded(seed);
    const tokens: ClaimedToken[] = [
      { token: 'out c1', claim: 'executed' },
      { token: 'out c3', claim: 'executed' },
      { token: 'x.txt', claim: 'executed' },
      { token: 'task 1', claim: 'any' },
      { token: 'task 3', claim: 'any' },
      ABSENT,
    ];
    await generatedRun(h, b, random, 1, { fresh: true });
    const second = await generatedRun(h, b, random, 2);
    await checked(h, { runId: second.id, tokens });
    const third = await generatedRun(h, b, random, 3);
    const memoised = await checked(h, { runId: third.id, tokens });
    rawDb(h.dbPath).exec('DELETE FROM fidelity_verdicts');
    const fresh = await directFidelity(h, { runId: third.id, tokens });
    expect([...memoised.reply.attested].sort()).toEqual([...fresh.reply.attested].sort());
  });
});
