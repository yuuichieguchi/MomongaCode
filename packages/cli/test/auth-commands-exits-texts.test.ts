import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, systemTiming } from '@momonga/foundation';
import type { PlanProfileView } from '@momonga/protocol';
import { authLogin, authLogout, authResetHost, authResume } from '../src/commands/auth.ts';
import { CHATGPT, account, fakePlanBackend } from './fake-plan-gateway.tsx';

const writer = () => {
  const written: string[] = [];
  return { written, write: (text: string): void => void written.push(text), text: (): string => written.join('') };
};

const OTHER: PlanProfileView = { ...CHATGPT, id: 'other', messages: { ...CHATGPT.messages, identityLabel: 'Other' } };

const neverAsked = async (): Promise<number | undefined> => {
  throw new Error('a question was asked');
};

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('the auth commands take their texts and exit codes from one source (gateway-accounts C32)', () => {
  it('auth logout in a terminal with no saved account asks nothing, says so in the words of the terminal UI, and exits 1', async () => {
    const out = writer();
    const err = writer();
    const backend = fakePlanBackend({ accounts: [] });
    expect(await authLogout({ stdout: out, stderr: err, plan: backend.plan, isTerminal: true, choose: neverAsked }, {})).toBe(EXIT_FAILURE);
    expect(err.text()).toBe('no subscription account is saved\n');
    expect(backend.planCalls.map((call) => call.route)).not.toContain('sign-out');
  });

  it('the terminal UI says the same words for no saved account', () => {
    const flows = fs.readFileSync(path.resolve(import.meta.dirname, '../src/tui/plan-flows.ts'), 'utf8');
    expect(flows).toContain('ports.info(NO_ACCOUNT_SAVED_TEXT)');
    expect(flows).not.toContain("'no subscription account is saved'");
  });

  it('auth logout without a label where nobody can be asked names the label and the command that lists the accounts, without claiming a missing terminal: exit 2', async () => {
    const out = writer();
    const err = writer();
    const backend = fakePlanBackend({ accounts: [account({ label: 'work' })] });
    expect(await authLogout({ stdout: out, stderr: err, plan: backend.plan, isTerminal: false }, {})).toBe(EXIT_USAGE);
    expect(err.text()).toBe('Name the account to sign out: momonga auth logout <account>. momonga auth status lists the saved accounts.\n');
  });

  it('auth resume and auth logout fail the same way for a label that is not saved', async () => {
    const backend = fakePlanBackend({ accounts: [account({ label: 'work' })] });
    const resumed = await failureOf(authResume({ stdout: writer(), stderr: writer(), plan: backend.plan }, { account: 'nobody' }));
    const signedOut = await failureOf(authLogout({ stdout: writer(), stderr: writer(), plan: backend.plan, isTerminal: false }, { account: 'nobody' }));
    expect(resumed).toBeInstanceOf(Error);
    expect((resumed as Error).message).toBe('no saved account is labelled "nobody"; momonga auth status lists them');
    expect((signedOut as Error).message).toBe((resumed as Error).message);
  });

  it('auth reset-host takes the provider named in its warning from the profile', async () => {
    const out = writer();
    const backend = fakePlanBackend({ accounts: [], profiles: [OTHER] });
    expect(await authResetHost({ stdout: out, stderr: writer(), plan: backend.plan, isTerminal: false }, { yes: true })).toBe(EXIT_OK);
    expect(out.text()).toContain(
      'This computer will be registered as a new host with Other. Saved accounts keep their records; whether Other accepts them under the new host is not documented, so sign in again if one stops working.',
    );
    expect(out.text()).not.toContain('ChatGPT');
  });

  it('auth reset-host names every provider that uses host identity and omits public-client providers', async () => {
    const out = writer();
    const publicProvider: PlanProfileView = { ...CHATGPT, id: 'grok', usesHostIdentity: false, messages: { ...CHATGPT.messages, identityLabel: 'Grok' } };
    const backend = fakePlanBackend({ accounts: [], profiles: [CHATGPT, OTHER, publicProvider] });
    await authResetHost({ stdout: out, stderr: writer(), plan: backend.plan, isTerminal: false }, { yes: true });
    expect(out.text()).toContain('registered as a new host with ChatGPT and Other. Saved accounts keep their records; whether ChatGPT and Other accept them under the new host is not documented');
    expect(out.text()).not.toContain('Grok');
  });

  it('auth login with no provider to sign in to asks nothing and says so: exit 1', async () => {
    const out = writer();
    const err = writer();
    const backend = fakePlanBackend({ accounts: [], profiles: [] });
    const code = await authLogin(
      {
        stdout: out,
        stderr: err,
        plan: backend.plan,
        startListener: backend.startSignInListener,
        openUrl: () => Promise.resolve(),
        sandbox: async () => 'seatbelt' as const,
        signal: new AbortController().signal,
        timers: systemTiming,
        isTerminal: true,
        choose: neverAsked,
        terminal: { stdin: process.stdin, stdout: process.stdout },
      },
      {},
    );
    expect(code).toBe(EXIT_FAILURE);
    expect(err.text()).toBe('no subscription provider is available\n');
  });

  it('the auth commands write no exit code of their own', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../src/commands/auth.ts'), 'utf8');
    expect(source.match(/return \d+;/g)).toBeNull();
  });
});
