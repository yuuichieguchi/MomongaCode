import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import type { AliasCapabilities, NeedsProbe, ToolCallingState } from '@momonga/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeClient } from '../src/client/runtime-client.ts';
import type { CliPorts } from '../src/ports.ts';
import { runHeadless } from '../src/run/headless.ts';
import type { HeadlessOptions } from '../src/run/headless.ts';
import { frameOf } from './acp-harness.ts';
import { SESSION, capabilitiesOf, runView } from './fake-backend.ts';
import { virtualClock } from './fake-supervisor.ts';

const log: string[] = [];

const fakeClient = {
  skills: async () => ({ skills: [], warnings: [] }),
  createRun: async () => {
    log.push('createRun');
    return { run: runView({ id: 'run-1', status: 'QUEUED' }) };
  },
  streamEvents: async function* () {
    yield frameOf('run-1', 1, { type: 'agent.message.delta', step: 1, attempt: 0, itemId: 'm1', text: 'A plain answer.' });
  },
  getRun: async () => runView({ id: 'run-1', status: 'COMPLETED', result: 'A plain answer.' }),
  childRuns: async () => [],
  cancel: async () => ({ status: 202, run: runView({ status: 'CANCELLED' }) }),
  close: async () => undefined,
} as unknown as RuntimeClient;

vi.mock('../src/run/open-session.ts', () => ({
  openSession: async () => {
    log.push('openSession');
    return { client: fakeClient, created: { session: SESSION, strippedEnvKeys: [] }, close: async () => undefined };
  },
}));

const NO_TOOLS_NOTICE = 'This model cannot call tools';

const NEEDS_PROBE: NeedsProbe = {
  state: 'needs_probe',
  message: 'target local has not been probed for tool calling',
  evidence: 'no probe record for local',
  remedy: 'run the tool-calling probe for local',
};

const headless = async (context: Parameters<typeof withTempDir>[0], toolCalling: ToolCallingState) => {
  log.length = 0;
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  await ensureMomongaDirs(paths);
  const stderr: string[] = [];
  const stdout: string[] = [];
  const ports = {
    version: '1.0.0',
    env: { PATH: '/usr/bin' },
    home,
    cwd: home,
    clock: virtualClock(),
    random: () => 0.5,
    stdout: { write: (text: string) => stdout.push(text) },
    stderr: {
      write: (text: string) => {
        log.push(`stderr:${text}`);
        stderr.push(text);
      },
    },
  } as unknown as CliPorts;
  const capabilitiesOfAlias = async (alias: string): Promise<AliasCapabilities> => {
    log.push(`capabilitiesOf:${alias}`);
    return { ...capabilitiesOf(), toolCalling } as AliasCapabilities;
  };
  const options = { prompt: 'explain the module', format: 'text', verbose: false, interrupt: new AbortController().signal, capabilitiesOf: capabilitiesOfAlias } as HeadlessOptions;
  const code = await runHeadless(ports, paths, options);
  return { code, stderr: stderr.join(''), stdout: stdout.join('') };
};

describe('headless asks capabilitiesOf(alias) at session open and shows the verdict before any request (design R1, second moment)', () => {
  it('shows the no-tools notice once on stderr before the run is created, and the run proceeds', async (context) => {
    const result = await headless(context, 'none');

    expect(result.stderr.split(NO_TOOLS_NOTICE).length - 1).toBe(1);
    const noticeAt = log.findIndex((entry) => entry.startsWith('stderr:') && entry.includes(NO_TOOLS_NOTICE));
    expect(log).toContain(`capabilitiesOf:${SESSION.modelAlias}`);
    expect(noticeAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(log.indexOf('createRun'));
    expect(result.stderr).toContain('/model');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('A plain answer.');
  });

  it('ends an unprobed target with the refusal and its remedy and creates no run', async (context) => {
    const result = await headless(context, NEEDS_PROBE);

    expect(result.code).not.toBe(0);
    expect(log).toContain(`capabilitiesOf:${SESSION.modelAlias}`);
    expect(log).not.toContain('createRun');
    expect(result.stderr).toContain(NEEDS_PROBE.remedy);
    expect(result.stderr).toContain('target_not_ready');
  });
});
