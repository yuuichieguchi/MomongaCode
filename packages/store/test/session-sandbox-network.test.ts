import { describe, expect, it } from 'vitest';
import { harness } from './helpers.ts';

const SESSION = { cwd: '/work/a', env: { PATH: '/usr/bin' }, permissionMode: 'manual', model: 'fm' } as const;

describe('the network of a sandboxed command given on the command line is a fact of the session', () => {
  it.each(['deny', 'ask', 'allow'] as const)('stores and returns %s', (value) => {
    const { store } = harness();
    const created = store.createSession({ ...SESSION, sandboxNetwork: value });
    expect(created.sandboxNetwork).toBe(value);
    expect(store.getSession(created.id)?.sandboxNetwork).toBe(value);
    expect(store.listSessions({ limit: 100, cursor: null }).sessions.map((session) => session.sandboxNetwork)).toEqual([value]);
  });

  it('is absent when the command line gave none, so the user setting decides', () => {
    const { store } = harness();
    expect(store.createSession(SESSION).sandboxNetwork).toBeNull();
  });
});
