import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { testKernelLock, withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { nodeFilesLockedBy } from '../src/node-ports.ts';
import { PollTimeout } from '../src/poll.ts';
import type { CliPorts, SelfExecutable } from '../src/ports.ts';
import { createTuiBackend } from '../src/tui/backend.ts';
import { installedProgram, recordingSpawn, virtualClock } from './fake-supervisor.ts';

const SELF: SelfExecutable = { kind: 'script', execPath: '/opt/node', script: '/opt/momonga/main.js' };

describe('the TUI backend', () => {
  it('stops starting the daemon when the interface is closed during boot', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const holder: { backend?: ReturnType<typeof createTuiBackend> } = {};
    const { spawn, spawned } = recordingSpawn(() => {
      void holder.backend?.close();
      return undefined;
    });
    const ports = { version: '1.2.3', files: nodeFilesLockedBy(testKernelLock), env: { PATH: '/usr/bin' }, home, cwd: home, clock: virtualClock(), self: SELF, spawnDetached: spawn, ...installedProgram('1.2.3').ports } as unknown as CliPorts;
    holder.backend = createTuiBackend(ports, paths, {}, { load: async () => [], append: async () => undefined }, []);

    const failure: unknown = await holder.backend.boot().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(spawned).toHaveLength(1);
    expect(failure).toBeDefined();
    expect(failure).not.toBeInstanceOf(PollTimeout);
    expect((failure as Error).name).toBe('AbortError');
  });

  it('opens a URL under the watch of its caller joined with the life of the interface', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const opened: { url: URL; watch: AbortSignal }[] = [];
    const failures: string[] = [];
    const ports = {
      version: '1.2.3',
      env: { PATH: '/usr/bin' },
      home,
      cwd: home,
      clock: virtualClock(),
      self: SELF,
      openUrl: (url: URL, watch: AbortSignal, onFailure: (message: string) => void) => {
        opened.push({ url, watch });
        onFailure('stand-in failure');
      },
      ...installedProgram('1.2.3').ports,
    } as unknown as CliPorts;
    const backend = createTuiBackend(ports, paths, {}, { load: async () => [], append: async () => undefined }, []);
    const first = new AbortController();
    const second = new AbortController();
    backend.openUrl(new URL('https://example.com/a'), first.signal, (message) => failures.push(message));
    backend.openUrl(new URL('https://example.com/b'), second.signal, (message) => failures.push(message));
    expect(opened.map(({ url }) => url.href)).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(failures).toEqual(['stand-in failure', 'stand-in failure']);
    first.abort();
    expect(opened[0]?.watch.aborted).toBe(true);
    expect(opened[1]?.watch.aborted).toBe(false);
    await backend.close();
    expect(opened[1]?.watch.aborted).toBe(true);
  });
});
