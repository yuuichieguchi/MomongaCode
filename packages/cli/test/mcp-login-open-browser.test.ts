import { describe, expect, it, vi } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import type { CliPorts } from '../src/ports.ts';
import { eventually } from './fake-plan-gateway.tsx';

const AUTHORIZE_URL = 'https://mcp.example.test/authorize?x=1';

const completedView = { server: 'docs', status: 'completed', startedAt: 0, expiresAt: 600000 };

let release: (value: typeof completedView) => void = () => undefined;

const runtimeClient = {
  startMcpAuthorization: vi.fn(async () => ({ server: 'docs', status: 'awaiting_user', url: AUTHORIZE_URL, startedAt: 0, expiresAt: 600000 })),
  mcpAuthorization: vi.fn(
    () =>
      new Promise<typeof completedView>((resolve) => {
        release = resolve;
      }),
  ),
  cancelMcpAuthorization: vi.fn(async () => undefined),
};

vi.mock('../src/run/open-session.ts', () => ({
  openSession: async () => ({ created: { session: { id: 'session-1' } }, client: runtimeClient, close: async () => undefined }),
}));

const { mcpLogin } = await import('../src/commands/mcp.ts');

type Launch = { url: URL; watch: AbortSignal | undefined; onFailure: ((message: string) => void) | undefined };

const writer = () => {
  const written: string[] = [];
  return { write: (text: string) => void written.push(text), text: () => written.join('') };
};

describe('momonga mcp login starts the browser through the opener port (P-C7 row 6)', () => {
  it('mcp login prints the URL once and reports a failed launch', async () => {
    const launches: Launch[] = [];
    const stdout = writer();
    const stderr = writer();
    const ports = {
      stdout,
      stderr,
      clock: { now: () => 0, sleep: async () => undefined },
      openUrl: (url: URL, watch?: AbortSignal, onFailure?: (message: string) => void) => {
        launches.push({ url, watch, onFailure });
        return Promise.resolve();
      },
    } as unknown as CliPorts;
    const exit = mcpLogin(ports, momongaLayout('/home/u', process.platform, process.env), 'docs', { openBrowser: true, interrupt: new AbortController().signal });
    await eventually(() => runtimeClient.mcpAuthorization.mock.calls.length === 1, 'the poll of the authorization');
    const onFailure = launches[0]?.onFailure;
    if (onFailure === undefined) throw new Error('no launch recorded with an onFailure callback');
    onFailure('no opener');
    release(completedView);
    expect(await exit).toBe(0);
    expect(stdout.text()).toBe(`Authorize MCP server docs in your browser:\n${AUTHORIZE_URL}\nMCP server docs is authorized\n`);
    expect(stderr.text()).toBe('Could not open the browser (no opener). Open the URL above to continue.\n');
    expect(launches).toHaveLength(1);
    expect(launches[0]?.watch?.aborted).toBe(true);
  });
});
