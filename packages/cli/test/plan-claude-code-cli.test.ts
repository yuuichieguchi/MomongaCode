import { describe, expect, it } from 'vitest';
import { planProfileOf } from '@momonga/config';
import { EXIT_FAILURE, EXIT_OK, systemTiming } from '@momonga/foundation';
import type { PlanProfileView } from '@momonga/protocol';
import { authLogin, authResetHost } from '../src/commands/auth.ts';
import { CHATGPT, account, fakePlanBackend } from './fake-plan-gateway.tsx';

const CLAUDE_VIEW: PlanProfileView = (() => {
  const shipped = planProfileOf('claude-code');
  return {
    id: shipped.id,
    usageUrl: shipped.usageUrl,
    loginLabel: shipped.loginLabel,
    messages: shipped.messages,
    usesHostIdentity: false,
    externalCli: {
      command: shipped.externalCli!.command,
      loginCommand: shipped.externalCli!.loginCommand,
      installHint: shipped.externalCli!.installHint,
    },
  };
})();

const writer = () => {
  const written: string[] = [];
  return { written, write: (text: string): void => void written.push(text), text: (): string => written.join('') };
};

describe('Claude Code external CLI auth commands', () => {
  it('auth login claude-code succeeds without browser OAuth when local CLI is signed in', async () => {
    const out = writer();
    const err = writer();
    const opened: string[] = [];
    const backend = fakePlanBackend({
      profiles: [CLAUDE_VIEW],
      accounts: [account({ profile: 'claude-code', label: 'claude-code', email: 'dev@example.com', state: 'active' })],
    });
    const code = await authLogin(
      {
        stdout: out,
        stderr: err,
        plan: backend.plan,
        startListener: async () => {
          throw new Error('OAuth listener must not be started for externalCli');
        },
        openUrl: (url) => {
          opened.push(url.toString());
        },
        sandbox: async () => 'seatbelt' as const,
        signal: new AbortController().signal,
        timers: systemTiming,
        isTerminal: false,
      },
      { provider: 'claude-code' },
    );
    expect(code).toBe(EXIT_OK);
    expect(opened).toEqual([]);
    expect(out.text()).toContain('claude-code');
    expect(out.text()).toContain('https://claude.ai/settings/usage');
  });

  it('auth login claude-code reports install/login instructions when local CLI is not signed in', async () => {
    const out = writer();
    const err = writer();
    const backend = fakePlanBackend({
      profiles: [CLAUDE_VIEW],
      accounts: [account({ profile: 'claude-code', label: 'claude-code', state: 'needs_sign_in', cause: 'Not signed in; run claude auth login' })],
    });
    const code = await authLogin(
      {
        stdout: out,
        stderr: err,
        plan: backend.plan,
        startListener: async () => {
          throw new Error('OAuth listener must not be started for externalCli');
        },
        openUrl: () => undefined,
        sandbox: async () => 'seatbelt' as const,
        signal: new AbortController().signal,
        timers: systemTiming,
        isTerminal: false,
      },
      { provider: 'claude-code' },
    );
    expect(code).toBe(EXIT_FAILURE);
    expect(err.text()).toContain('claude auth login');
  });

  it('auth reset-host omits claude-code from its warning', async () => {
    const out = writer();
    const backend = fakePlanBackend({ accounts: [], profiles: [CHATGPT, CLAUDE_VIEW] });
    expect(await authResetHost({ stdout: out, stderr: writer(), plan: backend.plan, isTerminal: false }, { yes: true })).toBe(EXIT_OK);
    expect(out.text()).toContain('ChatGPT');
    expect(out.text()).not.toContain('Claude Code');
  });
});
