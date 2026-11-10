import v8 from 'node:v8';
import { describe, expect, it, vi } from 'vitest';
import type { ClaimedToken } from '@momonga/protocol';
import { answeredRun, chainBuilder, generatedRun, referenceHarness, referenceOf } from '../../../store/test/support/reference.ts';
import type { ChainBuilder, ReferenceHarness } from '../../../store/test/support/reference.ts';
import { seeded } from '../../../store/test/support/seeded.ts';
import { mustRun, rawDb } from '../../../store/test/helpers.ts';
import { chainBound, directFidelity, oracleAttested, threadFidelity, threadOf } from './record-cut-support.ts';
import type { FidelityReply } from './fidelity-fixture.ts';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const ABSENT: ClaimedToken = { token: 'npm run never-recorded', claim: 'executed' };

const inheritingChild = async (h: ReferenceHarness, b: ChainBuilder) => {
  const child = b.createRun('the child task');
  const claim = b.claimNext(child.id);
  expect(await b.inherit(claim, 'manual')).toEqual({ kind: 'inherited' });
  return mustRun(h.store, child.id);
};

const chainOfLength = async (length: number) => {
  const h = referenceHarness();
  const b = chainBuilder(h);
  await answeredRun(h, b, 'root task', (claim) => b.tool(claim), { fresh: true });
  for (let index = 1; index < length; index += 1) await answeredRun(h, b, `task ${index}`, (claim) => b.text(claim));
  const child = await inheritingChild(h, b);
  return { h, b, child };
};

const withoutLastSeq = (reply: FidelityReply) => {
  const { lastSeq: _lastSeq, ...rest } = reply;
  return rest;
};

describe('rows stepped and reply size of the record cut (13.12 test (e))', () => {
  it.each([1, 10, 100])('with one unresolvable token, a chain of %i runs steps exactly the ranges of the whole chain', async (length) => {
    const { h, child } = await chainOfLength(length);
    const { reply, stepped } = await directFidelity(h, { runId: child.id, tokens: [ABSENT] });
    expect(reply.attested).toEqual([]);
    expect(stepped).toBe(chainBound(h, child.id));
  });

  it('keeps the reply the same size for chains of 1, 10 and 100 runs', async () => {
    const sizes: number[] = [];
    for (const length of [1, 10, 100]) {
      const { h, child } = await chainOfLength(length);
      const { reply } = await directFidelity(h, { runId: child.id, tokens: [ABSENT, { token: 'out c1', claim: 'executed' }] });
      expect(reply.attested).toEqual(['out c1']);
      sizes.push(v8.serialize(withoutLastSeq(reply)).length);
    }
    expect(new Set(sizes).size).toBe(1);
  });

  it('stops early when every token is resolved by the root of a chain of 10 runs', async () => {
    const { h, child } = await chainOfLength(10);
    const { reply, stepped } = await directFidelity(h, { runId: child.id, tokens: [{ token: 'out c1', claim: 'executed' }] });
    expect(reply.attested).toEqual(['out c1']);
    expect(stepped).toBeLessThan(chainBound(h, child.id) - mustRun(h.store, child.id).lastSeq);
  });
});

describe('the record cut runs to the end of every ancestor and reports its own faults (13.12 test (e2), design item 6)', () => {
  it('reads an old-shape root as its copy and runs to completion with via links and a compaction in the middle', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'root task', (claim) => b.tool(claim), { fresh: true });
    await answeredRun(h, b, 'old-shape run', (claim) => b.text(claim), { oldShape: true });
    await answeredRun(h, b, 'middle', (claim) => {
      b.text(claim);
      b.compact(claim, 3);
    });
    const late = b.createRun('Too late', { timeoutMs: 1000 });
    h.clock.advance(2000);
    expect(await h.store.expireApprovals(h.clock.now(), (error: unknown) => { throw error; })).toEqual([late.id]);
    const child = await inheritingChild(h, b);
    const tokens: ClaimedToken[] = [{ token: 'out c1', claim: 'executed' }, { token: 'Too late', claim: 'any' }, { token: 'old-shape run', claim: 'any' }, ABSENT];
    const reply = await threadFidelity(h, { runId: child.id, tokens });
    expect(reply.unreadable).toEqual([]);
    expect([...reply.attested].sort()).toEqual(['Too late', 'old-shape run', 'out c1']);
    expect([...reply.attested].sort()).toEqual(oracleAttested(h, child.id, tokens));
  });

  it('reports a numbering fault of an omitted task as unreadable chain:<runId> and does not throw', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'Say hello', (claim) => b.text(claim), { fresh: true });
    await answeredRun(h, b, 'x'.repeat(5000), () => undefined, { ending: { to: 'FAILED', code: 'pinned_overflow' } });
    const child = await inheritingChild(h, b);
    expect(referenceOf(h.store, child.id).omitSeqs).toEqual([3]);
    const db = rawDb(h.dbPath);
    db.exec('DROP TRIGGER IF EXISTS events_reject_update');
    db.prepare("UPDATE events SET payload_json = json_set(payload_json, '$.fromNextItemSeq', 40) WHERE run_id = ? AND type = 'context.inherited'").run(child.id);
    const reply = await threadFidelity(h, { runId: child.id, tokens: [ABSENT] });
    expect(reply.attested).toEqual([]);
    expect(reply.unreadable).toContainEqual(expect.objectContaining({ handle: expect.stringMatching(/^chain:/) }));
  });
});

describe('differential cases of the generator: via, omitted tasks, a compaction in the middle, old-shape roots (13.12 test (d))', () => {
  const TOKENS: ClaimedToken[] = [
    { token: 'out c1', claim: 'executed' },
    { token: 'out c2', claim: 'executed' },
    { token: 'x.txt', claim: 'executed' },
    { token: 'Too late', claim: 'any' },
    { token: 'Never mind this', claim: 'any' },
    { token: 'xxxxxxxxxx', claim: 'any' },
    { token: 'answer 1', claim: 'any' },
    { token: 'task 1', claim: 'any' },
  ];

  const compare = async (h: ReferenceHarness, runId: string) => {
    const reply = await threadFidelity(h, { runId, tokens: TOKENS });
    expect(reply.unreadable).toEqual([]);
    return { attested: [...reply.attested].sort(), oracle: oracleAttested(h, runId, TOKENS) };
  };

  it('a via link: the never-started task is part of the record', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const first = b.createRun('Say hello', { history: 'fresh' });
    const claim = b.claimNext(first.id);
    b.started(claim, 'manual');
    b.tool(claim);
    const late = b.createRun('Too late', { timeoutMs: 1000 });
    h.clock.advance(2000);
    expect(await h.store.expireApprovals(h.clock.now(), (error: unknown) => { throw error; })).toEqual([late.id]);
    await b.end(claim, { to: 'COMPLETED' });
    const child = await inheritingChild(h, b);
    expect(referenceOf(h.store, child.id).via.map((link) => link.runId)).toEqual([late.id]);
    const { attested, oracle } = await compare(h, child.id);
    expect(attested).toEqual(oracle);
    expect(attested).toContain('Too late');
  });

  it('a retracted task is not in the record', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const first = b.createRun('Say hello', { history: 'fresh' });
    const claim = b.claimNext(first.id);
    b.started(claim, 'manual');
    b.tool(claim);
    const retracted = b.createRun('Never mind this');
    expect((await h.store.requestCancel(retracted.id)).kind).toBe('ok');
    await h.store.finishCancelled((error) => {
      throw error;
    });
    await b.end(claim, { to: 'COMPLETED' });
    const child = await inheritingChild(h, b);
    const { attested, oracle } = await compare(h, child.id);
    expect(attested).toEqual(oracle);
    expect(attested).not.toContain('Never mind this');
  });

  it('a dropped task named by omitSeqs is not in the record', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'Say hello', (claim) => b.tool(claim), { fresh: true });
    await answeredRun(h, b, 'x'.repeat(5000), () => undefined, { ending: { to: 'FAILED', code: 'pinned_overflow' } });
    const child = await inheritingChild(h, b);
    const { attested, oracle } = await compare(h, child.id);
    expect(attested).toEqual(oracle);
    expect(attested).not.toContain('xxxxxxxxxx');
    expect(attested).toContain('out c1');
  });

  it('a compaction in the middle of the chain does not cut the record', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'task 1', (claim) => b.tool(claim), { fresh: true });
    await answeredRun(h, b, 'two', (claim) => {
      b.tool(claim);
      b.compact(claim, 4);
    });
    const child = await inheritingChild(h, b);
    const { attested, oracle } = await compare(h, child.id);
    expect(attested).toEqual(oracle);
    expect(attested).toEqual(expect.arrayContaining(['out c1', 'out c2', 'task 1']));
  });

  it.each([1, 2, 3, 4, 5, 6])('generated chains with an old-shape hop, seed %i', async (seed) => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const random = seeded(seed);
    await generatedRun(h, b, random, 1, { fresh: true });
    await generatedRun(h, b, random, 2, { oldShape: true });
    await generatedRun(h, b, random, 3);
    await generatedRun(h, b, random, 4);
    const child = await inheritingChild(h, b);
    const { attested, oracle } = await compare(h, child.id);
    expect(attested).toEqual(oracle);
  });
});

describe('the record walk runs in bounded units and lets other requests through (decision 40 B, 13.12b item 1)', () => {
  it('answers a ping queued behind a long walk before the walk ends', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'long root', (claim) => {
      for (let index = 0; index < 3000; index += 1) b.text(claim, 4);
    }, { fresh: true });
    const child = await inheritingChild(h, b);
    const client = await threadOf(h);
    const order: string[] = [];
    const walk = client
      .request({ kind: 'fidelity', runId: child.id, throughEventSeq: child.lastSeq, cwd: '/work/a', tokens: [{ ...ABSENT }] })
      .then(() => order.push('fidelity'));
    const ping = client.request({ kind: 'ping' }).then(() => order.push('ping'));
    await Promise.all([walk, ping]);
    expect(order).toEqual(['ping', 'fidelity']);
  });
});
