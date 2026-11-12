import { DEFAULT_KEY_TABLE } from '../src/tui/keys/table.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryIo } from '@momonga/foundation';
import type { RunReport } from '@momonga/protocol';
import type { CliPorts } from '../src/ports.ts';
import { createShellPort } from '../src/program.ts';
import { renderReport } from '../src/commands/report.ts';
import { DEFAULT_SLASH_COMMANDS } from '../src/tui/commands/index.ts';
import { createSlashRegistry } from '../src/tui/slash.ts';
import type { SlashContext } from '../src/tui/slash.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { fakeBackend } from './fake-backend.ts';
import type { FakeConversation } from './fake-backend.ts';
import { NO_HELPER } from './no-helper.ts';

const REPORT: RunReport = {
  runId: 'run-2',
  status: 'STOPPED',
  stopReason: 'conditions_unmet',
  durationMs: 1200,
  declaration: { conditions: [{ id: 'c1', command: 'npm test', when: 'always', source: 'request' }], requirements: [] },
  changes: { files: [{ path: '/work/src/a.ts', sha256: 'aa', lastSeq: 9 }], mutatingCalls: 1 },
  conditions: [{ id: 'c1', command: 'npm test', state: 'failed', rounds: 2, last: { seq: 14, exitCode: 1, durationMs: 40, mutationSeq: 9 } }],
  notRun: [],
  residualRisk: [],
  modelChecks: [],
};

const runtime = vi.hoisted(() => ({ asked: [] as string[], report: undefined as unknown }));

vi.mock('../src/daemon/ensure-daemon.ts', async (original) => ({ ...(await original<object>()), ensureDaemon: async () => undefined }));
vi.mock('../src/run/open-session.ts', async (original) => ({
  ...(await original<object>()),
  connectRuntime: () => ({
    getRun: async (runId: string) => {
      runtime.asked.push(runId);
      return { id: runId, report: runtime.report };
    },
    listSessions: async () => [{ id: 'another-session', createdAt: 99, latestRunId: 'run-of-another-session', latestRunAt: 100 }],
    close: async () => undefined,
  }),
}));
vi.mock('../src/paths.ts', () => ({ pathsOf: async () => ({}) }));

const home = '/home/user';

const shellPort = () => {
  const ports = { version: '9.9.9', platform: process.platform, home, cwd: home, terminal: undefined, env: {}, stdout: { write: () => undefined }, stderr: { write: () => undefined } } as unknown as CliPorts;
  const entry = async (): Promise<number> => 0;
  return createShellPort({
    ports,
    policyVerify: () => ({}) as never,
    entries: { supervise: entry, gateway: entry, runtime: entry },
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
};

const backgroundWork: Promise<unknown>[] = [];

const slashContext = (conversations: readonly FakeConversation[]) => {
  const infos: string[] = [];
  const context = {
    commands: DEFAULT_SLASH_COMMANDS,
    backend: fakeBackend({ conversations }),
    info: (text: string) => void infos.push(text),
    shell: shellPort(),
    screen: { current: () => 'fullscreen', set: async () => undefined },
    keys: DEFAULT_KEY_TABLE,
    negotiation: 'unknown',
    display: { a11y: () => ({ screenReader: false, reducedMotion: false }) },
    background: <T,>(_label: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const done = work(new AbortController().signal);
      backgroundWork.push(done);
      return done;
    },
  } as unknown as SlashContext;
  return { context, infos };
};

const run = async (line: string, context: SlashContext): Promise<void> => {
  const [name, ...rest] = line.slice(1).split(' ');
  const command = createSlashRegistry(DEFAULT_SLASH_COMMANDS).find(name ?? '');
  if (command === undefined) throw new Error(`/${name} is not a slash command`);
  await command.run(rest.join(' '), context);
  while (backgroundWork.length > 0) await Promise.all(backgroundWork.splice(0));
};

const THIS_SESSION: FakeConversation = { session: { id: 'session-1' }, firstPrompt: 'fix it', runs: [{ id: 'run-1', frames: [] }, { id: 'run-2', frames: [] }] };

beforeEach(() => {
  runtime.asked.length = 0;
  runtime.report = REPORT;
});

describe('/report', () => {
  it('is a default slash command with a usage, and /help lists it', async () => {
    const command = createSlashRegistry(DEFAULT_SLASH_COMMANDS).find('report');
    expect(command?.usage).toBe('[run-id] [--json]');
    expect(command?.description).toBeTruthy();
    const { context, infos } = slashContext([THIS_SESSION]);
    await run('/help', context);
    expect(infos.join('\n')).toContain('/report');
  });

  it('shows the report of the last run of this session, in the text momonga report prints', async () => {
    const { context, infos } = slashContext([THIS_SESSION]);
    await run('/report', context);
    expect(runtime.asked).toEqual(['run-2']);
    expect(infos).toEqual([renderReport(REPORT)]);
    expect(infos[0]).toContain('failed  npm test  (2 rounds, exit code 1)');
  });

  it('shows the report of the run that is working now', async () => {
    const working: FakeConversation = { ...THIS_SESSION, runs: [{ id: 'run-1', frames: [] }, { id: 'run-2', status: 'RUNNING', frames: [] }] };
    const { context } = slashContext([working]);
    await run('/report', context);
    expect(runtime.asked).toEqual(['run-2']);
  });

  it('shows the report of the run named, and the JSON of it with --json', async () => {
    const { context, infos } = slashContext([THIS_SESSION]);
    await run('/report run-1', context);
    expect(runtime.asked).toEqual(['run-1']);
    await run('/report --json', context);
    expect(runtime.asked).toEqual(['run-1', 'run-2']);
    expect(infos[1]).toBe(JSON.stringify(REPORT));
  });

  it('says that the session has no run yet, and asks the runtime for no run of another session', async () => {
    const { context, infos } = slashContext([]);
    await run('/report', context);
    expect(runtime.asked).toEqual([]);
    expect(infos).toEqual(['This session has no run yet, so there is no report to show.']);
  });
});
