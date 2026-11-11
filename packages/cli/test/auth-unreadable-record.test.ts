import { describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, systemTiming } from '@momonga/foundation';
import { authLogin, authLogout } from '../src/commands/auth.ts';
import type { AuthLoginPorts } from '../src/commands/auth.ts';
import { savedAccountAction } from '../src/plan/accounts.ts';
import { account, fakePlanBackend } from './fake-plan-gateway.tsx';
import type { FakePlanBackend } from './fake-plan-gateway.tsx';

const writer = () => {
  const written: string[] = [];
  return { written, write: (text: string): void => void written.push(text) };
};

const UNREADABLE_NOTICE =
  'The saved record of work cannot be read (bad tag). Run momonga auth login chatgpt --account work to replace it with a new sign-in, or momonga auth logout work to forget it on this computer; forgetting it does not revoke the session at the provider.';

const login = async (backend: FakePlanBackend, label: string) => {
  const out = writer();
  const err = writer();
  const ports: AuthLoginPorts = {
    stdout: out,
    stderr: err,
    plan: backend.plan,
    startListener: backend.startSignInListener,
    openUrl: () => Promise.resolve(),
    sandbox: async () => 'seatbelt' as const,
    signal: new AbortController().signal,
    timers: systemTiming,
    isTerminal: false,
  };
  const code = await authLogin(ports, { provider: 'chatgpt', account: label });
  return { code, stdout: out.written.join(''), stderr: err.written.join('') };
};

describe('an account whose record cannot be read has a way forward in the command (gateway-accounts C31, DECISION-3)', () => {
  it('the saved-account action of an unreadable record is to replace it; a record that cannot be written or is signing out has none', () => {
    expect(savedAccountAction(account({ state: 'store_unreadable' }))).toBe('replace');
    expect(savedAccountAction(account({ state: 'store_unwritable' }))).toBe('none');
    expect(savedAccountAction(account({ state: 'signing_out' }))).toBe('none');
  });

  it('auth login with the label of an unreadable record says what the record is and what replaces or forgets it, and signs in', async () => {
    const backend = fakePlanBackend({ accounts: [account({ label: 'work', state: 'store_unreadable', active: false, cause: 'bad tag' })] });
    const ended = await login(backend, 'work');
    expect(ended.code).toBe(EXIT_OK);
    expect(ended.stderr).toBe(`${UNREADABLE_NOTICE}\n`);
    expect(backend.planCalls.find((call) => call.route === 'sign-in/begin')?.body).toMatchObject({ profile: 'chatgpt', account: 'work' });
    expect(ended.stdout).toContain('Signed in as work');
  });

  it('auth login still refuses the label of a record that cannot be written, with its cause', async () => {
    const backend = fakePlanBackend({ accounts: [account({ label: 'work', state: 'store_unwritable', active: false, cause: 'EACCES' })] });
    const ended = await login(backend, 'work');
    expect(ended.code).toBe(EXIT_FAILURE);
    expect(ended.stderr).toContain('work: record not writable');
    expect(ended.stderr).toContain('cause: EACCES');
    expect(backend.planCalls.map((call) => call.route)).not.toContain('sign-in/begin');
  });

  it('auth logout of an unreadable record asks the gateway to sign it out and reports that the revocation is not confirmed', async () => {
    const out = writer();
    const err = writer();
    const backend = fakePlanBackend({ accounts: [account({ label: 'work', state: 'store_unreadable', active: false, cause: 'bad tag' })], signOutRevocation: 'unconfirmed' });
    expect(await authLogout({ stdout: out, stderr: err, plan: backend.plan, isTerminal: false }, { account: 'work' })).toBe(EXIT_OK);
    expect(backend.planCalls.filter((call) => call.route === 'sign-out')).toEqual([{ route: 'sign-out', body: { profile: 'chatgpt', account: 'work' } }]);
    expect(out.written.join('')).toContain('Remote revocation was not confirmed; disconnect the app in ChatGPT Settings: https://chatgpt.com/settings/usage');
  });
});
