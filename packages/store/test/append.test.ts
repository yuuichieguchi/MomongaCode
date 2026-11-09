import { describe, expect, it } from 'vitest';
import { START_MS, enqueue, harness, mustClaim, mustRun, newSession, openStoreAt } from './helpers.ts';

const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, total_tokens: input + output });

describe('append', () => {
  it('assigns contiguous seq, the lease token, the clock time and the current step', async () => {
    const { clock, store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    clock.advance(3);
    const result = store.append(claim, [
      { type: 'run.started', attempt: 1, now: START_MS + 3, pins: {} },
      { type: 'model.requested', step: 1, attempt: 1, digest: 'd', body: { a: 1 } },
      { type: 'notice', level: 'info', message: 'after request' },
    ]);
    expect(result).toEqual({ kind: 'ok', lastSeq: 4 });
    const events = store.readRunEvents(run.id, 1, 10);
    expect(events.map((event) => [event.type, event.seq, event.step, event.leaseToken, event.createdAt])).toEqual([
      ['run.started', 2, 0, 1, START_MS + 3],
      ['model.requested', 3, 1, 1, START_MS + 3],
      ['notice', 4, 1, 1, START_MS + 3],
    ]);
    expect(events[1]).toMatchObject({ body: { a: 1 }, digest: 'd' });
  });

  it('projects step and usage totals onto the run', async () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    store.append(claim, [
      { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: {} },
      { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [], usage: usage(10, 5) } },
      { type: 'model.requested', step: 2, attempt: 1, digest: 'd2', body: {} },
      { type: 'model.responded', step: 2, attempt: 1, response: { status: 'completed', output: [], usage: usage(7, 3) } },
    ]);
    expect(mustRun(store, run.id)).toMatchObject({
      step: 2,
      lastSeq: 5,
      usage: { inputTokens: 17, outputTokens: 8, totalTokens: 25 },
    });
  });

  it('accepts an empty batch without writing', async () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    expect(store.append(mustClaim(store, 'w1'), [])).toEqual({ kind: 'ok', lastSeq: 1 });
    expect(store.readRunEvents(run.id, 0, 10)).toHaveLength(1);
  });

  it('is allowed while CANCELLING', async () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    await store.requestCancel(run.id);
    expect(store.append(claim, [{ type: 'notice', level: 'warning', message: 'stopping' }]).kind).toBe('ok');
  });

  it('returns lease_lost once the lease was released or the run left RUNNING', async () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    await store.release(claim, 'WAITING_HUMAN');
    expect(store.append(claim, [{ type: 'notice', level: 'info', message: 'x' }])).toEqual({ kind: 'lease_lost' });
    expect(mustRun(store, run.id).lastSeq).toBe(2);
  });

  it('returns lease_lost for a forged owner or token', async () => {
    const { store } = harness();
    enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    const event = { type: 'notice', level: 'info', message: 'x' } as const;
    expect(store.append({ ...claim, workerId: 'w2' }, [event])).toEqual({ kind: 'lease_lost' });
    expect(store.append({ ...claim, leaseToken: 0 }, [event])).toEqual({ kind: 'lease_lost' });
  });

  it('keeps seq contiguous and global ids increasing when service and worker writes interleave across connections', async () => {
    const { dbPath, clock, store: worker } = harness();
    const service = openStoreAt(dbPath, clock);
    const session = newSession(worker);
    const run = enqueue(worker, session.id);
    const claim = mustClaim(worker, 'w1');
    for (let index = 0; index < 20; index += 1) {
      if (index % 2 === 0) {
        expect(worker.append(claim, [{ type: 'notice', level: 'info', message: `w${index}` }]).kind).toBe('ok');
      } else {
        const current = mustRun(service, run.id);
        const result = service.appendAsService(run.id, current.version, null, [{ type: 'notice', level: 'info', message: `s${index}` }]);
        expect((await result).kind).toBe('ok');
      }
    }
    const events = service.readRunEvents(run.id, 0, 100);
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 21 }, (_value, index) => index + 1));
    for (let index = 1; index < events.length; index += 1) expect(events[index]!.id).toBeGreaterThan(events[index - 1]!.id);
    expect(events.slice(1).map((event) => (event.type === 'notice' ? event.message : ''))).toEqual(
      Array.from({ length: 20 }, (_value, index) => `${index % 2 === 0 ? 'w' : 's'}${index}`),
    );
  });
});
