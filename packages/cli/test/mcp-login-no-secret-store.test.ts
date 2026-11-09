import { describe, expect, it, vi } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import type { CliPorts } from '../src/ports.ts';

const REFUSAL =
  'No secret store was found on this host (security (Keychain) is not on PATH). MomongaCode does not keep sign-in tokens in a plain file unless you ask: set credentials.plaintextTokenFiles to true in your user settings to keep them in a file only you can read.';

const runtimeClient = {
  startMcpAuthorization: vi.fn(async () => ({ server: 'docs', status: 'failed', startedAt: 0, expiresAt: 0, failure: { code: 'store_unwritable', message: REFUSAL } })),
  mcpAuthorization: vi.fn(),
  cancelMcpAuthorization: vi.fn(),
};

vi.mock('../src/run/open-session.ts', () => ({
  openSession: async () => ({ created: { session: { id: 'session-1' } }, client: runtimeClient, close: async () => undefined }),
}));

const { mcpLogin, McpLoginFailed } = await import('../src/commands/mcp.ts');

describe('momonga mcp login with no OS secret store and credentials.plaintextTokenFiles false (N81)', () => {
  it('is refused with exactly the refusal text, and no browser is opened', async () => {
    const openUrl = vi.fn();
    const ports = { openUrl, stdout: { write: () => true }, stderr: { write: () => true }, clock: { now: () => 0 } } as unknown as CliPorts;
    const attempt = mcpLogin(ports, momongaLayout('/home/u'), 'docs', { openBrowser: true, interrupt: new AbortController().signal });
    const failure = await attempt.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(McpLoginFailed);
    expect(failure).toMatchObject({ server: 'docs', code: 'store_unwritable', message: REFUSAL });
    expect(openUrl).not.toHaveBeenCalled();
  });
});
