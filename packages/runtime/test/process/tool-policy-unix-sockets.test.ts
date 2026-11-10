import { describe, expect, it } from 'vitest';
import { fakePolicyFilesystem } from '@momonga/testkit';
import * as runtime from '@momonga/runtime';
import { createSession, makeLogger, makeTempHome, openStore } from './helpers.ts';

const setup = async (unixSocketAllow?: () => readonly string[]) => {
  const temp = await makeTempHome();
  const { store, clock } = openStore(temp);
  const states = runtime.createSessionStates({ clock, store, logger: makeLogger(), releaseScratch: () => undefined });
  const policyFor = runtime.createPolicyFor({
    paths: temp.paths,
    home: temp.home,
    sessionStates: states,
    fs: fakePolicyFilesystem(),
    ruleEnforcement: 'seatbelt-profile',
    ...(unixSocketAllow === undefined ? {} : { unixSocketAllow }),
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

  it('reads the list of the user settings at each call', async () => {
    let allow: readonly string[] = ['/var/run/agent'];
    const { temp, store, policyFor } = await setup(() => allow);
    const session = createSession(store, temp.project);
    expect((await policyFor(session, { env: {}, rules: [] })).sandboxPolicy.unixSocketAllow).toEqual(['/var/run/agent']);
    allow = [];
    expect((await policyFor(session, { env: {}, rules: [] })).sandboxPolicy.unixSocketAllow).toEqual([]);
    expect((await policyFor(session, { env: {}, rules: [] })).sandboxPolicy.network).toBe('deny');
  });
});
