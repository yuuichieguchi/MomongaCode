import { describe, expect, it } from 'vitest';
import { fakePolicyFilesystem } from '@momonga/testkit';
import * as runtime from '@momonga/runtime';
import { createSession, makeLogger, makeTempHome, openStore } from './helpers.ts';

const setup = async () => {
  const temp = await makeTempHome();
  const { store, clock } = openStore(temp);
  const states = runtime.createSessionStates({ clock, store, logger: makeLogger(), releaseScratch: () => undefined });
  const policyFor = runtime.createPolicyFor({
    paths: temp.paths,
    home: temp.home,
    sessionStates: states,
    fs: fakePolicyFilesystem(),
    ruleEnforcement: 'seatbelt-profile',
  });
  return { temp, store, policyFor };
};

describe('createPolicyFor and the Unix socket allow list', () => {
  it('builds a policy without any allowed socket when no list is given', async () => {
    const { temp, store, policyFor } = await setup();
    const policy = await policyFor(createSession(store, temp.project), { env: {}, rules: [] });
    expect(policy.sandboxPolicy.unixSocketAllow).toEqual([]);
    expect(policy.sandboxPolicy.network).toBe('deny');
  });

  it('carries the list the caller read from the user settings, call by call', async () => {
    const { temp, store, policyFor } = await setup();
    const session = createSession(store, temp.project);
    expect((await policyFor(session, { env: {}, rules: [], unixSocketAllow: ['/var/run/agent'] })).sandboxPolicy.unixSocketAllow).toEqual(['/var/run/agent']);
    const later = await policyFor(session, { env: {}, rules: [], unixSocketAllow: [] });
    expect(later.sandboxPolicy.unixSocketAllow).toEqual([]);
    expect(later.sandboxPolicy.network).toBe('deny');
  });
});
