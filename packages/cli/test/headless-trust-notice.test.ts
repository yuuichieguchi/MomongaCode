import { EXIT_OK, ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeClient } from '../src/client/runtime-client.ts';
import type { CliPorts } from '../src/ports.ts';
import { runHeadless } from '../src/run/headless.ts';
import type { HeadlessOptions } from '../src/run/headless.ts';
import { frameOf } from './acp-harness.ts';
import { SESSION, capabilitiesOf, runView } from './fake-backend.ts';
import { virtualClock } from './fake-supervisor.ts';

const UNDECIDED = 'the folder /work is not decided, so its own settings and everything they could make the product run are not loaded; decide it with momonga trust /work';

const fakeClient = {
  skills: async () => ({ skills: [], warnings: [] }),
  createRun: async () => ({ run: runView({ id: 'run-1', status: 'QUEUED' }) }),
  streamEvents: async function* () {
    yield frameOf('run-1', 1, { type: 'agent.message.delta', step: 1, attempt: 0, itemId: 'm1', text: 'A plain answer.' });
  },
  getRun: async () => runView({ id: 'run-1', status: 'COMPLETED' }),
  childRuns: async () => [],
  cancel: async () => ({ status: 202, run: runView({ status: 'CANCELLED' }) }),
  close: async () => undefined,
} as unknown as RuntimeClient;

vi.mock('../src/run/open-session.ts', () => ({
  openSession: async () => ({ client: fakeClient, created: { session: SESSION, strippedEnvKeys: [], trustNotice: UNDECIDED }, close: async () => undefined }),
}));

describe('momonga -p with an undecided folder', () => {
  it('prints the one trust notice on stderr and leaves stdout to the answer', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
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
      stderr: { write: (text: string) => stderr.push(text) },
    } as unknown as CliPorts;
    const options = {
      prompt: async () => 'explain the module',
      format: 'text',
      verbose: false,
      interrupt: new AbortController().signal,
      capabilitiesOf: async () => capabilitiesOf(),
      modelList: async () => ({ data: [], start: null }),
    } as unknown as HeadlessOptions;
    expect(await runHeadless(ports, paths, options)).toBe(EXIT_OK);
    expect(stderr.join('').split('\n').filter((line) => line.includes('is not decided'))).toEqual([`momonga: ${UNDECIDED}`]);
    expect(stdout.join('')).toBe('A plain answer.\n');
  });
});
