import { describe, expect, it, vi } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import type { CliPorts } from '../src/ports.ts';
import { eventually } from './fake-plan-gateway.tsx';

const SIGN_IN_URL = 'https://sso.example.test/a?b=1';

type Launch = { url: URL; watch: AbortSignal | undefined; onFailure: ((message: string) => void) | undefined };

const resolvedAnswer = { elicitation: { id: 'in-1', status: 'resolved' }, run: { id: 'run-1', status: 'RUNNING' } };

let release: (value: typeof resolvedAnswer) => void = () => undefined;

const client = {
  getElicitation: vi.fn(async () => ({
    id: 'in-1',
    runId: 'run-1',
    server: 'docs',
    status: 'pending',
    toolCall: { title: 'docs sign in' },
    requests: [{ key: 'k', mode: 'url', message: 'Sign in', url: SIGN_IN_URL }],
  })),
  resolveElicitation: vi.fn(
    () =>
      new Promise<typeof resolvedAnswer>((resolve) => {
        release = resolve;
      }),
  ),
  close: async () => undefined,
};

vi.mock('../src/run/open-session.ts', () => ({ connectRuntime: () => client }));
vi.mock('../src/daemon/ensure-daemon.ts', () => ({ ensureCurrentDaemon: async () => undefined }));

const { elicit } = await import('../src/commands/elicit.ts');

const writer = () => {
  const written: string[] = [];
  return { write: (text: string) => void written.push(text), text: () => written.join('') };
};

const run = () => {
  client.resolveElicitation.mockClear();
  const launches: Launch[] = [];
  const stdout = writer();
  const stderr = writer();
  const interrupt = new AbortController().signal;
  const ports = {
    stdout,
    stderr,
    cwd: '/work/project',
    clock: { now: () => 0, sleep: async () => undefined },
    openUrl: (url: URL, watch?: AbortSignal, onFailure?: (message: string) => void) => {
      launches.push({ url, watch, onFailure });
      return Promise.resolve();
    },
  } as unknown as CliPorts;
  let code: number | undefined;
  const exit = elicit(ports, momongaLayout('/home/u'), 'in-1', { accept: true, decline: false, cancel: false, set: [] }, interrupt).then((value) => (code = value));
  const failLaunch = (message: string): void => {
    const onFailure = launches.at(-1)?.onFailure;
    if (onFailure === undefined) throw new Error('no launch recorded with an onFailure callback');
    onFailure(message);
  };
  return { launches, stdout, stderr, interrupt, exit, code: () => code, failLaunch };
};

const untilResolving = (): Promise<void> => eventually(() => client.resolveElicitation.mock.calls.length === 1, 'the elicitation to be resolved');

describe('momonga elicit <id> --accept for a URL request prints the URL itself and starts the browser (P-C7 row 5)', () => {
  it('prints the URL itself, then starts the browser', async () => {
    const r = run();
    await untilResolving();
    expect(r.stderr.text()).toBe(`Open this URL in your browser: ${SIGN_IN_URL}\n`);
    expect(r.launches).toHaveLength(1);
    expect(r.launches[0]?.url.href).toBe(SIGN_IN_URL);
    expect(r.launches[0]?.watch).toBe(r.interrupt);
    release(resolvedAnswer);
    await r.exit;
    expect(r.stdout.text()).toBe('elicitation in-1 resolved; run run-1 is RUNNING\n');
    expect(r.code()).toBe(0);
  });

  it('a start error reported before the command ends adds the failure line', async () => {
    const r = run();
    await untilResolving();
    r.failLaunch('no opener');
    release(resolvedAnswer);
    await r.exit;
    expect(r.stderr.text()).toBe(`Open this URL in your browser: ${SIGN_IN_URL}\nCould not open the browser (no opener).\n`);
  });

  it('the elicitation is resolved even when the launch fails', async () => {
    const r = run();
    await untilResolving();
    r.failLaunch('no opener');
    release(resolvedAnswer);
    await r.exit;
    expect(client.resolveElicitation).toHaveBeenCalledTimes(1);
    expect(client.resolveElicitation).toHaveBeenCalledWith('in-1', { k: { action: 'accept' } });
    expect(r.code()).toBe(0);
  });
});
