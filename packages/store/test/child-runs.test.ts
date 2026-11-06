import { describe, expect, it } from 'vitest';
import type { Run, RuntimeStore } from '@momonga/store';
import { parkWaitingHuman } from './approval-fixture.ts';
import { DEADLINE_MS, START_MS, enqueue, harness, mustClaim, mustRun, newSession } from './helpers.ts';

const spawn = (store: RuntimeStore, parent: Run, callId: string, input = 'child task') => {
  const result = store.createChildRun({ parentRunId: parent.id, parentCallId: callId, input, pins: { agent: { name: 'helper' } }, modelAlias: 'fm' });
  if (result.kind !== 'created' && result.kind !== 'existing') throw new Error(`expected a child run, got ${result.kind}`);
  return result;
};

const runningParent = (h: ReturnType<typeof harness>, sessionOptions: { mode?: 'default' | 'acceptEdits' } = {}) => {
  const session = h.store.createSession({
    cwd: '/work/a',
    env: { PATH: '/usr/bin' },
    permissionMode: sessionOptions.mode ?? 'default',
    modelAlias: 'fm',
    bypassAllowed: true,
    additionalDirectories: ['/work/extra'],
  });
  const parent = enqueue(h.store, session.id);
  const claim = mustClaim(h.store, 'w-parent');
  return { session, parent, claim };
};

describe('createChildRun', () => {
  it('creates a child run in its own session that shares the deadline, limits, mode and workspace of the parent', () => {
    const h = harness();
    const { session, parent } = runningParent(h);
    const { run, session: childSession, kind } = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    expect(kind).toBe('created');
    expect(childSession.id).not.toBe(session.id);
    expect(childSession).toMatchObject({
      cwd: '/work/a',
      env: { PATH: '/usr/bin' },
      permissionMode: 'default',
      bypassAllowed: true,
      additionalDirectories: ['/work/extra'],
      modelAlias: 'fm',
    });
    expect(run).toMatchObject({
      sessionId: childSession.id,
      ordinal: 1,
      status: 'QUEUED',
      deadlineAt: DEADLINE_MS,
      limits: { maxSteps: 10 },
      pins: { agent: { name: 'helper' } },
      history: 'fresh',
      previousRunId: null,
      parentRunId: parent.id,
      parentCallId: 'call-1',
    });
    expect(h.store.readRunEvents(run.id, 0, 10).map((event) => event.type)).toEqual(['user.message']);
  });

  it('gives the child the model alias it asks for', () => {
    const h = harness();
    const { parent } = runningParent(h);
    const result = h.store.createChildRun({ parentRunId: parent.id, parentCallId: 'c', input: 'x', pins: {}, modelAlias: 'other' });
    expect(result.kind === 'created' && result.session.modelAlias).toBe('other');
  });

  it('gives the child the alias the caller names even when the session has another', () => {
    const h = harness();
    const { session, parent } = runningParent(h);
    h.store.setModelAlias(session.id, 'switched');
    const result = h.store.createChildRun({ parentRunId: parent.id, parentCallId: 'c', input: 'x', pins: {}, modelAlias: 'fm' });
    expect(result.kind === 'created' && result.session.modelAlias).toBe('fm');
  });

  it('returns the existing child when the same tool call asks again', () => {
    const h = harness();
    const { parent } = runningParent(h);
    const first = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    const second = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    expect(second.kind).toBe('existing');
    expect(second.run.id).toBe(first.run.id);
    expect(h.store.listChildRuns(parent.id)).toHaveLength(1);
  });

  it('refuses a parent that is cancelling, terminal or missing', () => {
    const h = harness();
    const { parent } = runningParent(h);
    h.store.requestCancel(parent.id);
    expect(h.store.createChildRun({ parentRunId: parent.id, parentCallId: 'c', input: 'x', pins: {}, modelAlias: 'fm' })).toEqual({
      kind: 'parent_not_active',
      status: 'CANCELLING',
    });
    expect(h.store.createChildRun({ parentRunId: 'nope', parentCallId: 'c', input: 'x', pins: {}, modelAlias: 'fm' })).toEqual({
      kind: 'parent_not_active',
      status: 'missing',
    });
  });

  it('keeps child sessions out of the session list and resolves the root session', () => {
    const h = harness();
    const { session, parent } = runningParent(h);
    const { session: childSession, run: child } = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    const grandchild = h.store.createChildRun({ parentRunId: child.id, parentCallId: 'g', input: 'x', pins: {}, modelAlias: 'fm' });
    if (grandchild.kind !== 'created') throw new Error('expected a grandchild');
    expect(h.store.listSessions().map((entry) => entry.id)).toEqual([session.id]);
    expect(h.store.listSessions({ cwd: '/work/a' }).map((entry) => entry.id)).toEqual([session.id]);
    expect(h.store.rootSessionId(childSession.id)).toBe(session.id);
    expect(h.store.rootSessionId(grandchild.session.id)).toBe(session.id);
    expect(h.store.rootSessionId(session.id)).toBe(session.id);
  });

  it('does not block the child behind the parent that is still running', () => {
    const h = harness();
    const { parent } = runningParent(h);
    const { run: child } = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    expect(mustClaim(h.store, 'w-child').runId).toBe(child.id);
  });
});

describe('shared budget', () => {
  it('sums the tokens of the whole tree from any run in it', () => {
    const h = harness();
    const { parent, claim } = runningParent(h);
    h.store.append(claim, [
      {
        type: 'model.responded',
        step: 1,
        attempt: 1,
        response: { status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
      },
    ]);
    const { run: child } = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    const childClaim = mustClaim(h.store, 'w-child');
    h.store.append(childClaim, [
      {
        type: 'model.responded',
        step: 1,
        attempt: 1,
        response: { status: 'completed', output: [], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } },
      },
    ]);
    expect(h.store.treeTokens(parent.id)).toBe(45);
    expect(h.store.treeTokens(child.id)).toBe(45);
  });
});

describe('cancel cascade', () => {
  it('moves queued and running children to CANCELLING when the parent is cancelled, each with the status it had', () => {
    const h = harness();
    const { parent } = runningParent(h);
    const running = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    mustClaim(h.store, 'w-child');
    const queued = spawn(h.store, mustRun(h.store, parent.id), 'call-2');
    h.store.requestCancel(parent.id);
    expect(mustRun(h.store, running.run.id)).toMatchObject({ status: 'CANCELLING', cancelRequested: true, cancelOrigin: 'RUNNING' });
    expect(mustRun(h.store, queued.run.id)).toMatchObject({ status: 'CANCELLING', cancelRequested: true, cancelOrigin: 'QUEUED' });
  });

  it('reaches grandchildren', () => {
    const h = harness();
    const { parent } = runningParent(h);
    const child = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    const grandchild = h.store.createChildRun({ parentRunId: child.run.id, parentCallId: 'g', input: 'x', pins: {}, modelAlias: 'fm' });
    if (grandchild.kind !== 'created') throw new Error('expected a grandchild');
    h.store.requestCancel(parent.id);
    expect(mustRun(h.store, child.run.id).status).toBe('CANCELLING');
    expect(mustRun(h.store, grandchild.run.id).status).toBe('CANCELLING');
  });

  it('cancels the open children when the parent ends for another reason', async () => {
    const h = harness();
    const { parent, claim } = runningParent(h);
    const child = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    expect((await h.store.transition(claim, ['RUNNING'], 'FAILED', { error: { code: 'x', message: 'y' } })).kind).toBe('ok');
    expect(mustRun(h.store, child.run.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'QUEUED' });
  });

  it('leaves a finished child alone', async () => {
    const h = harness();
    const { parent } = runningParent(h);
    const child = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    const childClaim = mustClaim(h.store, 'w-child');
    await h.store.transition(childClaim, ['RUNNING'], 'COMPLETED');
    h.store.requestCancel(parent.id);
    expect(mustRun(h.store, child.run.id).status).toBe('COMPLETED');
  });
});

describe('waiting for a child', () => {
  const awaitChild = (h: ReturnType<typeof harness>, claim: ReturnType<typeof mustClaim>, childId: string, wakeAt = DEADLINE_MS) =>
    h.store.release(claim, 'WAITING_TOOL', wakeAt, { awaits: { runIds: [childId], jobIds: [] } });

  it('parks the parent until the child ends and then queues it', async () => {
    const h = harness();
    const { parent, claim } = runningParent(h);
    const child = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    expect(awaitChild(h, claim, child.run.id).kind).toBe('ok');
    expect(mustRun(h.store, parent.id)).toMatchObject({ status: 'WAITING_TOOL', leaseOwner: null });

    const childClaim = mustClaim(h.store, 'w-child');
    await h.store.transition(childClaim, ['RUNNING'], 'COMPLETED');
    expect(mustRun(h.store, parent.id)).toMatchObject({ status: 'QUEUED', availableAt: START_MS });
  });

  it('wakes the parent when the child is cancelled and its cancel is finished', async () => {
    const h = harness();
    const { parent, claim } = runningParent(h);
    const child = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    awaitChild(h, claim, child.run.id);
    h.store.requestCancel(child.run.id);
    expect(mustRun(h.store, parent.id).status).toBe('WAITING_TOOL');
    expect(await h.store.finishCancelled(() => undefined)).toEqual([child.run.id]);
    expect(mustRun(h.store, parent.id).status).toBe('QUEUED');
  });

  it('queues the parent at once when the child already ended before it could park', async () => {
    const h = harness();
    const { parent, claim } = runningParent(h);
    const child = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    h.store.requestCancel(child.run.id);
    expect(await h.store.finishCancelled(() => undefined)).toEqual([child.run.id]);
    expect(awaitChild(h, claim, child.run.id).kind).toBe('ok');
    expect(mustRun(h.store, parent.id).status).toBe('QUEUED');
  });

  it('does not wake a parent that is waiting for a human', () => {
    const h = harness();
    const { parent, claim } = runningParent(h);
    const child = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    parkWaitingHuman(h.store, claim);
    h.store.requestCancel(child.run.id);
    expect(mustRun(h.store, parent.id).status).toBe('WAITING_HUMAN');
  });

  it('leaves a parent that waits for a human only at the decision or the end of the run, whatever its child did', async () => {
    const decided = harness();
    const first = runningParent(decided);
    const firstChild = spawn(decided.store, mustRun(decided.store, first.parent.id), 'call-1');
    const firstApproval = parkWaitingHuman(decided.store, first.claim);
    decided.store.requestCancel(firstChild.run.id);
    expect(mustRun(decided.store, first.parent.id).status).toBe('WAITING_HUMAN');
    expect((await decided.store.resolveApproval(firstApproval.id, 'allow_once')).kind).toBe('ok');
    expect(mustRun(decided.store, first.parent.id).status).toBe('QUEUED');

    const expired = harness();
    const second = runningParent(expired);
    const secondChild = spawn(expired.store, mustRun(expired.store, second.parent.id), 'call-1');
    parkWaitingHuman(expired.store, second.claim);
    expired.store.requestCancel(secondChild.run.id);
    const deadlineAt = mustRun(expired.store, second.parent.id).deadlineAt;
    expired.clock.set(deadlineAt - 1);
    expect(await expired.store.expireApprovals(expired.clock.now(), (error: unknown) => { throw error; })).toEqual([]);
    expect(mustRun(expired.store, second.parent.id).status).toBe('WAITING_HUMAN');
    expired.clock.set(deadlineAt);
    expect(await expired.store.expireApprovals(expired.clock.now(), (error: unknown) => { throw error; })).toEqual([second.parent.id]);
    expect(mustRun(expired.store, second.parent.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
  });

  it('wakes a parked parent when its wake time arrives', async () => {
    const h = harness();
    const { parent, claim } = runningParent(h);
    const child = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    awaitChild(h, claim, child.run.id, START_MS + 5000);
    h.clock.set(START_MS + 4999);
    expect(await h.store.expireApprovals(h.clock.now(), (error: unknown) => { throw error; })).toEqual([]);
    expect(mustRun(h.store, parent.id).status).toBe('WAITING_TOOL');
    h.clock.set(START_MS + 5000);
    expect(await h.store.expireApprovals(h.clock.now(), (error: unknown) => { throw error; })).toEqual([parent.id]);
    expect(mustRun(h.store, parent.id).status).toBe('QUEUED');
  });
});

describe('permission inheritance', () => {
  it('moves the child sessions with the parent session mode', () => {
    const h = harness();
    const { session, parent } = runningParent(h);
    const child = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    h.store.setPermissionMode(session.id, 'plan');
    expect(h.store.getSession(child.session.id)?.permissionMode).toBe('plan');
    h.store.setPermissionMode(session.id, 'acceptEdits');
    expect(h.store.getSession(child.session.id)?.permissionMode).toBe('acceptEdits');
  });

  it('leaves the sessions of finished children alone', async () => {
    const h = harness();
    const { session, parent } = runningParent(h);
    const child = spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    await h.store.transition(mustClaim(h.store, 'w-child'), ['RUNNING'], 'COMPLETED');
    h.store.setPermissionMode(session.id, 'plan');
    expect(h.store.getSession(child.session.id)?.permissionMode).toBe('default');
  });
});

describe('a session that never had children', () => {
  it('lists no child runs', () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    expect(h.store.listChildRuns(run.id)).toEqual([]);
    expect(h.store.treeTokens(run.id)).toBe(0);
  });
});
