import { describe, expect, it } from 'vitest';
import type { AddGoverningFactInput } from '@momonga/store';
import { START_MS, harness } from './helpers.ts';

const commandFact = (overrides: Partial<AddGoverningFactInput> = {}): AddGoverningFactInput => ({
  kind: 'constraint',
  target: 'pandas',
  text: 'do not use pandas',
  scope: { level: 'project', project: '/work/a', paths: ['src/**'] },
  validUntil: null,
  supersedes: [],
  enforcement: null,
  source: { kind: 'command' },
  ...overrides,
});

const PROPOSAL = { kind: 'proposal', sessionId: 's1', runId: 'r1', seq: 4, callId: 'c1' } as const;

describe('governing fact store', () => {
  it('stores a command fact, with the clock as validFrom and source time, and reads it back', () => {
    const { store } = harness();
    const { fact, created } = store.governing.add(commandFact({ enforcement: { behavior: 'deny', rule: 'Bash(rm:*)' } }));
    expect(created).toBe(true);
    expect(fact).toEqual({
      id: fact.id,
      kind: 'constraint',
      target: 'pandas',
      text: 'do not use pandas',
      scope: { level: 'project', project: '/work/a', paths: ['src/**'] },
      validFrom: START_MS,
      validUntil: null,
      retiredAt: null,
      supersedes: [],
      enforcement: { behavior: 'deny', rule: 'Bash(rm:*)' },
      source: { kind: 'command', at: START_MS },
    });
    expect(store.governing.get(fact.id)).toEqual(fact);
  });

  it('round-trips a user scope, a validity end, supersedes and a proposal source', () => {
    const { store } = harness();
    const first = store.governing.add(commandFact({ scope: { level: 'user' } })).fact;
    const { fact } = store.governing.add(commandFact({ scope: { level: 'user' }, validUntil: START_MS + 9, supersedes: [first.id], source: PROPOSAL }));
    expect(store.governing.get(fact.id)).toMatchObject({ scope: { level: 'user' }, validUntil: START_MS + 9, supersedes: [first.id], source: PROPOSAL });
  });

  it('adds a replayed proposal once and returns the first fact, also with changed input', () => {
    const { store, clock } = harness();
    const first = store.governing.add(commandFact({ source: PROPOSAL }));
    clock.advance(50);
    const replay = store.governing.add(commandFact({ source: PROPOSAL, text: 'replayed text' }));
    expect(replay).toEqual({ fact: first.fact, created: false });
    expect(store.governing.list()).toHaveLength(1);
  });

  it('adds every command fact as a new fact', () => {
    const { store } = harness();
    store.governing.add(commandFact());
    expect(store.governing.add(commandFact()).created).toBe(true);
    expect(store.governing.list()).toHaveLength(2);
  });

  it('lists the user facts and the facts of one project, retired ones included', () => {
    const { store } = harness();
    const user = store.governing.add(commandFact({ scope: { level: 'user' } })).fact;
    const here = store.governing.add(commandFact()).fact;
    store.governing.add(commandFact({ scope: { level: 'project', project: '/work/b', paths: [] } }));
    store.governing.retire(here.id);
    expect(store.governing.list({ project: '/work/a' }).map((fact) => fact.id).sort()).toEqual([user.id, here.id].sort());
  });

  it('retires once: a second retirement keeps the first time', () => {
    const { store, clock } = harness();
    const { fact } = store.governing.add(commandFact());
    clock.advance(10);
    expect(store.governing.retire(fact.id)).toMatchObject({ retired: true, fact: { retiredAt: START_MS + 10 } });
    clock.advance(10);
    expect(store.governing.retire(fact.id)).toMatchObject({ retired: false, fact: { retiredAt: START_MS + 10 } });
  });

  it('returns undefined for retiring an unknown fact', () => {
    expect(harness().store.governing.retire('absent')).toBeUndefined();
  });

  it('gives the history of a fact as its whole revision chain, oldest first, from any member', () => {
    const { store, clock } = harness();
    const first = store.governing.add(commandFact()).fact;
    clock.advance(1);
    const second = store.governing.add(commandFact({ supersedes: [first.id] })).fact;
    clock.advance(1);
    const third = store.governing.add(commandFact({ supersedes: [second.id] })).fact;
    store.governing.add(commandFact({ target: 'numpy' }));
    const ids = [first.id, second.id, third.id];
    expect(store.governing.history(first.id).map((fact) => fact.id)).toEqual(ids);
    expect(store.governing.history(third.id).map((fact) => fact.id)).toEqual(ids);
  });
});
