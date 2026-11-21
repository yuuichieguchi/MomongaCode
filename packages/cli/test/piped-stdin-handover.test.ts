import type { EntryIo } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeClient } from '../src/client/runtime-client.ts';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import { HANDOVER_FORMAT } from '../src/handover/record.ts';
import type { HandoverHost } from '../src/handover/host.ts';
import type { CliPorts, StandardInput } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { runView } from './fake-backend.ts';
import { textDelta, watchedRun } from './headless-fakes.ts';
import { NO_HELPER } from './no-helper.ts';

const followed = vi.hoisted(() => ({ client: undefined as RuntimeClient | undefined }));

vi.mock('../src/daemon/ensure-daemon.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon/ensure-daemon.ts')>()),
  ensureSessionDaemon: async () => undefined,
}));

vi.mock('../src/run/open-session.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/run/open-session.ts')>()),
  connectSessionRuntime: () => {
    if (followed.client === undefined) throw new Error('no client to follow');
    return { ...followed.client, close: async () => undefined };
  },
}));

const AT_ITS_END: StandardInput = { isTerminal: false, bytes: async function* () {} };

describe('a headless run started from piped standard input that hands over', () => {
  it('goes on in the successor with the run the record names, whose input is the piped text, and reads no standard input again', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const run = watchedRun(home, [textDelta(1, 'm1', 'The log shows a timeout.')], runView({ id: 'run-1', status: 'COMPLETED' }));
    followed.client = run.client;
    const removed: string[] = [];
    const handover = {
      args: ['-p'],
      started: {
        file: '/run/handover/session-1.json',
        session: 'session-1',
        parsed: { kind: 'record', record: { format: HANDOVER_FORMAT, fromVersion: '1.2.3', toVersion: '1.2.4', session: 'session-1', lastSeq: { 'run-1': 0 }, kind: 'headless', runId: 'run-1', output: 'text', verbose: false } },
        terminal: undefined,
      },
      removeRecord: (file: string) => void removed.push(file),
    } as unknown as HandoverHost;
    const entry = async (): Promise<number> => 0;
    const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
    const codes: number[] = [];
    const ports = { ...run.ports, home, cwd: home, env: {}, platform: process.platform, interrupt: new AbortController().signal, version: '1.2.4', stdin: AT_ITS_END, handover } as CliPorts;
    const program = buildProgram(
      {
        ports,
        entries,
        update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS }),
        interrupt: new AbortController().signal,
        helper: NO_HELPER,
        entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
        complete: (code) => void codes.push(code),
      },
      { embedded: true },
    );

    await program.parseAsync(['-p'], { from: 'user' });

    expect(codes).toEqual([0]);
    expect(run.stdout.join('')).toBe('The log shows a timeout.\n');
    expect(removed).toEqual(['/run/handover/session-1.json']);
  });
});
