import { describe, expect, it } from 'vitest';
import { EXIT_OK, systemTiming } from '@momonga/foundation';
import type { PlanSignInCompleteResponse } from '@momonga/protocol';
import { authLogin } from '../src/commands/auth.ts';
import { account, fakePlanBackend } from './fake-plan-gateway.tsx';

const NEXT_STEP =
  'No model uses this account yet. Run momonga models catalog chatgpt to list its models, then momonga models add --plan chatgpt --account chatgpt --model <own name> --yes to add one.';

const login = async (complete: PlanSignInCompleteResponse): Promise<string> => {
  const written: string[] = [];
  const backend = fakePlanBackend({ accounts: [], complete });
  const code = await authLogin(
    {
      stdout: { write: (text) => void written.push(text) },
      stderr: { write: () => undefined },
      plan: backend.plan,
      startListener: backend.startSignInListener,
      openUrl: () => Promise.resolve(),
      sandbox: async () => 'seatbelt' as const,
      signal: new AbortController().signal,
      timers: systemTiming,
      isTerminal: false,
    },
    { provider: 'chatgpt' },
  );
  expect(code).toBe(EXIT_OK);
  return written.join('');
};

describe('momonga auth login: a sign-in that leaves the person one step short names that step (gateway-accounts C30, product-surface-02)', () => {
  it('with no model that uses the account names the catalog and the add command, and does not say the plan is in use', async () => {
    const printed = await login({ outcome: 'signed_in', account: account({ pinnedBy: [] }), firstSignIn: true });
    expect(printed).toContain('Signed in as chatgpt (ada@example.com)');
    expect(printed.split('\n')).toContain(NEXT_STEP);
    expect(printed).not.toContain("You're using your ChatGPT plan");
    expect(printed).not.toContain('Eligible usage in this app uses your ChatGPT plan');
    expect(printed).toContain('Manage usage: https://chatgpt.com/settings/usage');
  });

  it('names the step on a later sign-in too, while no model uses the account', async () => {
    const printed = await login({ outcome: 'signed_in', account: account({ pinnedBy: [] }), firstSignIn: false });
    expect(printed.split('\n')).toContain(NEXT_STEP);
  });

  it('with a model that uses the account prints no next step, and the first sign-in says the plan is in use', async () => {
    const printed = await login({ outcome: 'signed_in', account: account({ pinnedBy: ['chatgpt/gpt-5'] }), firstSignIn: true });
    expect(printed).not.toContain('No model uses this account yet');
    expect(printed).toContain("You're using your ChatGPT plan");
    expect(printed).toContain('Manage usage: https://chatgpt.com/settings/usage');
  });
});
