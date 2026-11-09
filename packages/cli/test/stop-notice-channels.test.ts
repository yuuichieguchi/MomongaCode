import { momongaPaths } from '@momonga/foundation';
import { describe, expect, it, vi } from 'vitest';
import type { CliPorts } from '../src/ports.ts';

const NOTICE = 'the stop values could not be read from the user settings (bad JSON); the default values were used';
const FOLLOW_REACHED = 'follow reached its restore';

const noticeOf = (onNotice: unknown): void => {
  if (typeof onNotice !== 'function') throw new Error(NOTICE);
  (onNotice as (message: string) => void)(NOTICE);
};

vi.mock('../src/daemon/ensure-daemon.ts', () => ({
  daemonReadyBoundMs: async () => 1000,
  ensureDaemon: async (_ports: unknown, _paths: unknown, options: { onNotice?: unknown } = {}) => {
    noticeOf(options.onNotice);
    return {};
  },
  restoreDaemon: (_ports: unknown, _paths: unknown, onNotice?: unknown) => async () => {
    noticeOf(onNotice);
  },
}));

vi.mock('../src/run/open-session.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/run/open-session.ts')>()),
  connectRuntime: () => ({ trust: async () => ({ trusted: true }), close: async () => undefined }),
}));

vi.mock('../src/run/follow.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/run/follow.ts')>()),
  followRun: async (options: { restoreConnection(signal: AbortSignal | undefined): Promise<void> }) => {
    await options.restoreConnection(undefined);
    throw new Error(FOLLOW_REACHED);
  },
}));

const captured: { options?: { daemonReady(): Promise<void> } } = {};

vi.mock('../src/acp/agent.ts', () => ({
  createAcpAgent: (options: { daemonReady(): Promise<void> }) => {
    captured.options = options;
    return { connect: () => ({ closed: Promise.resolve(), close: () => undefined }) };
  },
}));

const { createTuiBackend } = await import('../src/tui/backend.ts');
const { watchRun } = await import('../src/run/headless.ts');
const { acpDiagnosticText, serveAcp } = await import('../src/acp/serve.ts');

const paths = momongaPaths('/home/alice');

const portsWritingTo = (stderr: string[]): CliPorts =>
  ({
    version: '1.2.3',
    env: {},
    home: '/home/alice',
    cwd: '/home/alice/project',
    clock: { now: () => 0, sleep: async () => undefined },
    random: () => 0.5,
    stdout: { write: () => true },
    stderr: { write: (chunk: string) => (stderr.push(chunk), true) },
    acpStdio: () => ({ input: new ReadableStream(), output: new WritableStream() }),
  }) as unknown as CliPorts;

describe('each caller of a daemon stop supplies a notice channel (design 1.5)', () => {
  it('the TUI reports the defaults notice of its boot once among its startup notices and does not throw', async () => {
    const backend = createTuiBackend(portsWritingTo([]), paths, {}, { load: async () => [], append: async () => undefined }, []);
    await expect(backend.boot()).resolves.toBeDefined();
    expect(await backend.startupNotices()).toEqual([NOTICE]);
  });

  it('the headless run reports the defaults notice of a reconnect once on stderr and does not throw it', async () => {
    const stderr: string[] = [];
    const failure = await watchRun(portsWritingTo(stderr), paths, {
      client: { cancel: async () => undefined } as never,
      runId: 'run-1',
      format: 'text',
      verbose: false,
      interrupt: new AbortController().signal,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((failure as Error).message).toBe(FOLLOW_REACHED);
    expect(stderr.filter((chunk) => chunk.includes(NOTICE))).toHaveLength(1);
  });

  it('ACP reports the defaults notice of its daemon start once as a diagnostic and does not throw', async () => {
    const stderr: string[] = [];
    await serveAcp(portsWritingTo(stderr), paths, new AbortController().signal);
    await expect(captured.options?.daemonReady()).resolves.toBeUndefined();
    expect(stderr).toEqual([acpDiagnosticText(NOTICE)]);
  });
});
