import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import type { ChainCapabilities } from '@momonga/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeClient } from '../src/client/runtime-client.ts';
import type { CliPorts } from '../src/ports.ts';
import { runHeadless } from '../src/run/headless.ts';
import type { HeadlessOptions } from '../src/run/headless.ts';
import { SESSION, capabilitiesOf } from './fake-backend.ts';
import { virtualClock } from './fake-supervisor.ts';

const fakeClient = {
  skills: async () => ({ skills: [], warnings: [] }),
  close: async () => undefined,
} as unknown as RuntimeClient;

vi.mock('../src/run/open-session.ts', () => ({
  openSession: async () => ({ client: fakeClient, created: { session: SESSION, strippedEnvKeys: [] }, close: async () => undefined }),
}));

const headless = async (context: Parameters<typeof withTempDir>[0], format: HeadlessOptions['format']) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home, process.platform, process.env);
  await ensureMomongaDirs(paths);
  const stdout: string[] = [];
  const ports = { version: '1.0.0', env: { PATH: '/usr/bin' }, home, cwd: home, clock: virtualClock(), random: () => 0.5, stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: () => undefined } } as unknown as CliPorts;
  const options = {
    prompt: async () => 'explain the module',
    skill: 'no-such-skill',
    format,
    verbose: false,
    interrupt: new AbortController().signal,
    capabilitiesOf: async () => capabilitiesOf() as ChainCapabilities,
    modelList: async () => ({ data: [], start: null }),
  } as HeadlessOptions;
  const failure = await runHeadless(ports, paths, options).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { failure, stdout: stdout.join('') };
};

describe('a failure before the run starts prints the JSON result under a JSON output format (cli-commands-C42)', () => {
  const expectOneErrorResult = async (context: Parameters<typeof withTempDir>[0], format: HeadlessOptions['format']): Promise<void> => {
    const { failure, stdout } = await headless(context, format);
    expect(failure).toBeInstanceOf(Error);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0] ?? '') as { type: string; subtype: string; is_error: boolean; error: { code: string; message: string } };
    expect(result).toMatchObject({ type: 'result', subtype: 'error', is_error: true });
    expect(result.error.message).toBe((failure as Error).message);
  };

  it('json: a skill that does not exist gives one error result on standard output, and the failure still ends the command', (context) => expectOneErrorResult(context, 'json'));

  it('stream-json: a skill that does not exist gives one error result on standard output, and the failure still ends the command', (context) => expectOneErrorResult(context, 'stream-json'));

  it('text: standard output stays empty', async (context) => {
    expect((await headless(context, 'text')).stdout).toBe('');
  });
});
