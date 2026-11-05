import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '@momonga/protocol';
import type { ContributionPayload, RuntimeStore, TerminalContribution } from '@momonga/store';
import { LEASE_MS, cancel, enqueue, harness, mustClaim, mustRun, newSession } from './helpers.ts';

const contribution: ContributionPayload = { type: 'context.contribution', items: [{ kind: 'memory', id: 'm1', contributed: true }] };

const hook: TerminalContribution = { eventTypes: ['user.message'], measure: () => contribution };

const typesOf = (store: RuntimeStore, runId: string): string[] =>
  store
    .readRunEvents(runId, 0, 1000)
    .map((event) => (event.type === 'run.status' ? `run.status:${event.to}` : event.type));

const contributionsOf = (store: RuntimeStore, runId: string): number => typesOf(store, runId).filter((type) => type === 'context.contribution').length;

describe('facts that specs/tla/TerminalPrepare.tla relies on', () => {
  it('CommitFresh: fences a commit by the lease token alone: a holder whose lease expired and who nobody reclaimed still commits, with its contribution', () => {
    const h = harness({ contribution: hook });
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    h.clock.advance(LEASE_MS + 1);

    expect(h.store.transition(claim, ['RUNNING'], 'COMPLETED').kind).toBe('ok');

    expect(typesOf(h.store, run.id).slice(-2)).toEqual(['context.contribution', 'run.status:COMPLETED']);
    expect(contributionsOf(h.store, run.id)).toBe(1);
  });

  it('CommitLost, FencedCommit: refuses the commit of a superseded holder before anything is written, so its prepared result cannot reach the journal', () => {
    const h = harness({ contribution: hook });
    const run = enqueue(h.store, newSession(h.store).id);
    const stale = mustClaim(h.store, 'w1');
    h.clock.advance(LEASE_MS + 1);
    const fresh = mustClaim(h.store, 'w2');
    const before = typesOf(h.store, run.id);

    h.store.prepareTerminal(run.id);
    expect(h.store.transition(stale, ['RUNNING'], 'COMPLETED')).toEqual({ kind: 'lease_lost' });

    expect(typesOf(h.store, run.id)).toEqual(before);
    expect(contributionsOf(h.store, run.id)).toBe(0);
    expect(h.store.transition(fresh, ['RUNNING'], 'COMPLETED').kind).toBe('ok');
    expect(contributionsOf(h.store, run.id)).toBe(1);
  });

  it('Stop, AtMostOneContribution: leaves a finished run with one contribution whatever finisher comes next: a holder, a service cancel and a second transition all find it terminal', () => {
    const h = harness({ contribution: hook });
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    expect(h.store.transition(claim, ['RUNNING'], 'COMPLETED').kind).toBe('ok');
    const settled = mustRun(h.store, run.id).lastSeq;

    expect(h.store.transition(claim, ['RUNNING'], 'COMPLETED')).toEqual({ kind: 'lease_lost' });
    expect(h.store.requestCancel(run.id)).toMatchObject({ kind: 'ok', changed: false });

    expect(mustRun(h.store, run.id).lastSeq).toBe(settled);
    expect(contributionsOf(h.store, run.id)).toBe(1);
  });

  it('Cancel, CommitRefuseStale: lets a service cancel append to the journal of a running run without the lease, which moves lastSeq under a holder that is finishing', () => {
    const h = harness({ contribution: hook });
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    const seen = mustRun(h.store, run.id).lastSeq;

    h.store.prepareTerminal(run.id);
    expect(cancel(h.store, run.id).status).toBe('CANCELLING');

    expect(mustRun(h.store, run.id).lastSeq).toBeGreaterThan(seen);
    expect(h.store.transition(claim, ['RUNNING'], 'COMPLETED').kind).toBe('conflict');
    expect(h.store.transition(claim, ['CANCELLING'], 'CANCELLED').kind).toBe('ok');
    expect(typesOf(h.store, run.id).slice(-2)).toEqual(['context.contribution', 'run.status:CANCELLED']);
    expect(contributionsOf(h.store, run.id)).toBe(1);
  });

  it('Keepalive is absent: a heartbeat appends no event, which RePrepareBounded and Terminates need', () => {
    const h = harness({ contribution: hook });
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    const before = mustRun(h.store, run.id).lastSeq;
    const typesBefore = typesOf(h.store, run.id);

    for (let beat = 0; beat < 5; beat += 1) {
      h.clock.advance(LEASE_MS / 4);
      expect(h.store.heartbeat(claim).kind).toBe('ok');
    }

    expect(mustRun(h.store, run.id).lastSeq).toBe(before);
    expect(typesOf(h.store, run.id)).toEqual(typesBefore);
  });

  it('names the event types the model abstracts as C, T and the leading events', () => {
    expect(EVENT_TYPES).toEqual(expect.arrayContaining(['context.contribution', 'run.status']));
  });
});
