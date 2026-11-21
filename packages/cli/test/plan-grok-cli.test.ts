import { describe, expect, it } from 'vitest';
import { planProfileOf } from '@momonga/config';
import { EXIT_OK, systemTiming } from '@momonga/foundation';
import type { PlanProfileView } from '@momonga/protocol';
import { authLogin } from '../src/commands/auth.ts';
import { callbackPathOf, callbackPortOf, loopbackSignInListener } from '../src/plan/sign-in.ts';
import { fakePlanBackend } from './fake-plan-gateway.tsx';

const GROK_VIEW: PlanProfileView = (() => {
  const shipped = planProfileOf('grok');
  return {
    id: shipped.id,
    displayName: shipped.displayName,
    usageUrl: shipped.usageUrl,
    loginLabel: shipped.loginLabel,
    messages: shipped.messages,
    usesHostIdentity: false,
  };
})();

const writer = () => {
  const written: string[] = [];
  return { written, write: (text: string): void => void written.push(text), text: (): string => written.join('') };
};

describe('Grok subscription CLI sign-in integration', () => {
  it('reads callbackPath and callbackPort from the shipped plan profiles', () => {
    expect(callbackPathOf('grok')).toBe('/callback');
    expect(callbackPortOf('grok')).toBe(56121);
    expect(callbackPathOf('chatgpt')).toBe('/auth/callback');
    expect(callbackPortOf('chatgpt')).toBeUndefined();
  });

  it('loopbackSignInListener binds an explicit port when requested and uses an ephemeral port when omitted', async () => {
    const start = loopbackSignInListener(systemTiming, new AbortController().signal);
    const ephemeral = await start('/auth/callback');
    expect(ephemeral.port).toBeGreaterThan(0);
    expect(new URL(ephemeral.redirectUrl).pathname).toBe('/auth/callback');
    const chosenPort = ephemeral.port;
    await ephemeral.close();

    const fixed = await start('/callback', chosenPort);
    expect(fixed.port).toBe(chosenPort);
    expect(fixed.redirectUrl).toBe(`http://127.0.0.1:${chosenPort}/callback`);
    await fixed.close();
  });

  it('passes callbackPath /callback and callbackPort 56121 to startListener when signing in to grok', async () => {
    const listenerCalls: Array<{ path: string; port: number | undefined }> = [];
    const backend = fakePlanBackend({ accounts: [], profiles: [GROK_VIEW] });
    const out = writer();
    const err = writer();
    const code = await authLogin(
      {
        stdout: out,
        stderr: err,
        plan: backend.plan,
        startListener: (path, port) => {
          listenerCalls.push({ path, port });
          return backend.startSignInListener(path, port);
        },
        openUrl: () => Promise.resolve(),
        sandbox: async () => 'seatbelt' as const,
        signal: new AbortController().signal,
        timers: systemTiming,
        isTerminal: false,
      },
      { provider: 'grok' },
    );
    expect(code).toBe(EXIT_OK);
    expect(listenerCalls).toEqual([{ path: '/callback', port: 56121 }]);
  });
});
