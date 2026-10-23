import { describe, expect, it } from 'vitest';
import { RUN_STATUSES, TERMINAL_STATUSES } from '@momonga/protocol';
import type { RunStatus } from '@momonga/protocol';
import type { Claim, Run, RuntimeStore } from '@momonga/store';
import { enqueue, harness, mustClaim, mustRun, newSession } from './helpers.ts';
import { parkWaitingHuman } from './approval-fixture.ts';

const ALLOWED: Record<RunStatus, readonly RunStatus[]> = {
  QUEUED: ['CANCELLED'],
  RUNNING: ['WAITING_TOOL', 'WAITING_HUMAN', 'COMPLETED', 'STOPPED', 'FAILED', 'CANCELLING', 'QUEUED'],
  WAITING_TOOL: ['QUEUED', 'CANCELLING'],
  WAITING_HUMAN: ['QUEUED', 'CANCELLED', 'STOPPED'],
  CANCELLING: ['CANCELLED'],
  COMPLETED: [],
  STOPPED: [],
  FAILED: [],
  CANCELLED: [],
};

const WORKER_OWNED: readonly RunStatus[] = ['RUNNING', 'CANCELLING'];

type Fixture = { store: RuntimeStore; run: Run; claim?: Claim };

const arrange = (from: RunStatus): Fixture => {
  const { store } = harness();
  const created = enqueue(store, newSession(store).id);
  const claimIt = () => mustClaim(store, 'w1');
  switch (from) {
    case 'QUEUED':
      return { store, run: created };
    case 'RUNNING': {
      const claim = claimIt();
      return { store, run: mustRun(store, created.id), claim };
    }
    case 'CANCELLING': {
      const claim = claimIt();
      store.requestCancel(created.id);
      return { store, run: mustRun(store, created.id), claim: { ...claim, status: 'CANCELLING' } };
    }
    case 'CANCELLED':
      store.requestCancel(created.id);
      return { store, run: mustRun(store, created.id) };
    case 'WAITING_HUMAN':
      parkWaitingHuman(store, claimIt());
      return { store, run: mustRun(store, created.id) };
    default: {
      const claim = claimIt();
      expect(store.release(claim, from).kind).toBe('ok');
      return { store, run: mustRun(store, created.id) };
    }
  }
};

const attempt = (fixture: Fixture, from: RunStatus, to: RunStatus) =>
  WORKER_OWNED.includes(from) && fixture.claim !== undefined
    ? fixture.store.transition(fixture.claim, [from], to)
    : fixture.store.appendAsService(fixture.run.id, fixture.run.version, to, []);

const cases = RUN_STATUSES.flatMap((from) => RUN_STATUSES.map((to) => [from, to, ALLOWED[from].includes(to)] as const));

describe('transition table', () => {
  it('covers all 81 pairs', () => {
    expect(cases).toHaveLength(81);
  });

  it.each(cases.filter(([, , allowed]) => allowed))('%s -> %s is allowed and writes run.status', (from, to) => {
    const fixture = arrange(from);
    expect(fixture.run.status).toBe(from);
    const result = attempt(fixture, from, to);
    expect(result.kind).toBe('ok');
    const after = mustRun(fixture.store, fixture.run.id);
    expect(after.status).toBe(to);
    expect(after.version).toBe(fixture.run.version + 1);
    const events = fixture.store.readRunEvents(fixture.run.id, fixture.run.lastSeq, 10);
    if (TERMINAL_STATUSES.some((terminal) => terminal === to)) expect(fixture.store.approvals.listPending(fixture.run.id)).toEqual([]);
    const leading = events.slice(0, -1);
    expect(leading.map((event) => event.type)).toEqual(leading.map(() => 'tool.permission.cancelled'));
    expect(after.lastSeq).toBe(fixture.run.lastSeq + events.length);
    expect(events.at(-1)).toMatchObject({ type: 'run.status', from, to, seq: after.lastSeq });
  });

  it.each(cases.filter(([, , allowed]) => !allowed))('%s -> %s is rejected as a conflict and writes nothing', (from, to) => {
    const fixture = arrange(from);
    const result = attempt(fixture, from, to);
    expect(result.kind).toBe('conflict');
    expect(mustRun(fixture.store, fixture.run.id)).toEqual(fixture.run);
    expect(fixture.store.readRunEvents(fixture.run.id, fixture.run.lastSeq, 10)).toEqual([]);
  });
});

describe('transition', () => {
  it('rejects QUEUED -> RUNNING outside claim', () => {
    const fixture = arrange('QUEUED');
    expect(fixture.store.appendAsService(fixture.run.id, fixture.run.version, 'RUNNING', []).kind).toBe('conflict');
  });

  it('rejects when the current status is not in the expected from list', () => {
    const fixture = arrange('RUNNING');
    expect(fixture.store.transition(fixture.claim!, ['WAITING_TOOL'], 'QUEUED').kind).toBe('conflict');
    expect(mustRun(fixture.store, fixture.run.id).status).toBe('RUNNING');
  });

  it('records the stop reason from the patch', () => {
    const fixture = arrange('RUNNING');
    const result = fixture.store.transition(fixture.claim!, ['RUNNING'], 'STOPPED', { stopReason: 'max_steps' });
    expect(result).toMatchObject({ kind: 'ok', run: { status: 'STOPPED', stopReason: 'max_steps' } });
    expect(fixture.store.readRunEvents(fixture.run.id, 0, 10).at(-1)).toMatchObject({
      type: 'run.status',
      from: 'RUNNING',
      to: 'STOPPED',
      reason: 'max_steps',
    });
  });

  it('records the error from the patch on FAILED', () => {
    const fixture = arrange('RUNNING');
    const result = fixture.store.transition(fixture.claim!, ['RUNNING'], 'FAILED', { error: { code: 'boom', message: 'x' } });
    expect(result).toMatchObject({ kind: 'ok', run: { status: 'FAILED', error: { code: 'boom', message: 'x' } } });
  });

  it('keeps terminal runs immutable even for the lease holder', () => {
    const fixture = arrange('RUNNING');
    expect(fixture.store.transition(fixture.claim!, ['RUNNING'], 'COMPLETED').kind).toBe('ok');
    const done = mustRun(fixture.store, fixture.run.id);
    const result = fixture.store.transition(fixture.claim!, ['COMPLETED'], 'FAILED');
    expect(['conflict', 'lease_lost']).toContain(result.kind);
    expect(mustRun(fixture.store, fixture.run.id)).toEqual(done);
  });
});

describe('appendAsService', () => {
  it('rejects a stale version as a conflict', () => {
    const fixture = arrange('WAITING_HUMAN');
    const result = fixture.store.appendAsService(fixture.run.id, fixture.run.version - 1, 'QUEUED', []);
    expect(result).toMatchObject({ kind: 'conflict' });
    expect(mustRun(fixture.store, fixture.run.id)).toEqual(fixture.run);
  });

  it('appends events before the status change and bumps the version once', () => {
    const fixture = arrange('WAITING_HUMAN');
    const result = fixture.store.appendAsService(fixture.run.id, fixture.run.version, 'QUEUED', [
      { type: 'tool.permission.resolved', approvalId: 'a1', optionId: 'allow_once' },
    ]);
    expect(result).toMatchObject({ kind: 'ok', run: { status: 'QUEUED', version: fixture.run.version + 1 } });
    expect(fixture.store.readRunEvents(fixture.run.id, fixture.run.lastSeq, 10).map((event) => event.type)).toEqual([
      'tool.permission.resolved',
      'run.status',
    ]);
  });

  it('appends events without a status change', () => {
    const fixture = arrange('QUEUED');
    const result = fixture.store.appendAsService(fixture.run.id, fixture.run.version, null, [
      { type: 'notice', level: 'info', message: 'service note' },
    ]);
    expect(result).toMatchObject({ kind: 'ok', run: { status: 'QUEUED', lastSeq: fixture.run.lastSeq + 1 } });
  });

  it('refuses to append to a terminal run', () => {
    const fixture = arrange('COMPLETED');
    const result = fixture.store.appendAsService(fixture.run.id, fixture.run.version, null, [
      { type: 'notice', level: 'info', message: 'late' },
    ]);
    expect(result.kind).toBe('conflict');
    expect(fixture.store.readRunEvents(fixture.run.id, fixture.run.lastSeq, 10)).toEqual([]);
  });

  it('lets only one of two callers holding the same version append events', () => {
    const fixture = arrange('QUEUED');
    const notice = { type: 'notice', level: 'info', message: 'x' } as const;
    expect(fixture.store.appendAsService(fixture.run.id, fixture.run.version, null, [notice]).kind).toBe('ok');
    const second = fixture.store.appendAsService(fixture.run.id, fixture.run.version, null, [notice]);
    expect(second.kind).toBe('conflict');
    expect(fixture.store.readRunEvents(fixture.run.id, fixture.run.lastSeq, 10)).toHaveLength(1);
  });

  it('bumps the version on every service append', () => {
    const fixture = arrange('QUEUED');
    const result = fixture.store.appendAsService(fixture.run.id, fixture.run.version, null, [{ type: 'notice', level: 'info', message: 'service note' }]);
    expect(result).toMatchObject({ kind: 'ok', run: { version: fixture.run.version + 1 } });
  });

  it('does not let a fenced worker append invalidate a service version', () => {
    const fixture = arrange('RUNNING');
    const current = mustRun(fixture.store, fixture.run.id);
    expect(fixture.store.append(fixture.claim!, [{ type: 'notice', level: 'info', message: 'from worker' }]).kind).toBe('ok');
    expect(mustRun(fixture.store, fixture.run.id).version).toBe(current.version);
    expect(fixture.store.appendAsService(current.id, current.version, null, [{ type: 'notice', level: 'info', message: 'service note' }]).kind).toBe('ok');
  });
});
