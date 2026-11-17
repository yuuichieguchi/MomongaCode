import { EXIT_CONFIG, ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it, vi } from 'vitest';
import type { CliPorts } from '../src/ports.ts';
import { runHeadless } from '../src/run/headless.ts';
import type { HeadlessOptions } from '../src/run/headless.ts';
import { virtualClock } from './fake-supervisor.ts';

vi.mock('../src/run/open-session.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/run/open-session.ts')>();
  return {
    ...original,
    openSession: async () => {
      throw new original.NoModelConnected();
    },
  };
});

describe('momonga -p with no model target exits with the configuration code', () => {
  it('returns EXIT_CONFIG, the code the daemon entry gives a configuration error', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const ports = {
      version: '1.0.0',
      env: { PATH: '/usr/bin' },
      home,
      cwd: home,
      clock: virtualClock(),
      random: () => 0.5,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    } as unknown as CliPorts;
    const options = {
      prompt: async () => 'explain the module',
      format: 'text',
      verbose: false,
      interrupt: new AbortController().signal,
      capabilitiesOf: async () => ({}),
      modelList: async () => ({ data: [], start: null }),
    } as unknown as HeadlessOptions;
    expect(await runHeadless(ports, paths, options)).toBe(EXIT_CONFIG);
  });
});
