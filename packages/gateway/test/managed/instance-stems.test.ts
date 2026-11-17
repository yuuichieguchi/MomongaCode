import { nodeFileSystemSync, systemRandom } from '@momonga/foundation';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir, testKernelLock, testProcessInspector, TEST_UNPROTECTED_LAUNCH } from '@momonga/testkit';
import { managedInstancePaths, momongaPaths } from '@momonga/foundation';
import { FM_SERVER, messageOf } from '@momonga/protocol';
import { createManagedServer, managedModelName } from '../../src/index.ts';

const HOME = '/home/someone';
const paths = momongaPaths(HOME, 'linux', {});

const stemOf = (socketPath: string): string => path.basename(socketPath, '.sock');

describe('the instance of a managed server is named by its server name (design-model-names 3.12)', () => {
  it('builds the stems <server>-<k>, _probe-<server> and _cli-serve-<server>', () => {
    expect(stemOf(managedInstancePaths(paths, { owner: 'gateway', generation: 1, purpose: 'serve', provider: 'apple', incarnation: 2 }).socketPath)).toBe('apple-2');
    expect(stemOf(managedInstancePaths(paths, { owner: 'gateway', generation: 1, purpose: 'probe', provider: 'apple' }).socketPath)).toBe('_probe-apple');
    expect(stemOf(managedInstancePaths(paths, { owner: 'cli', purpose: 'serve', provider: 'llama-server' }).socketPath)).toBe('_cli-serve-llama-server');
  });

  it.skipIf(process.platform === 'win32')('refuses a server name whose socket path is longer than the platform allows, through the existing fit check', async (context) => {
    const provider = `server-${'n'.repeat(140)}`;
    const instance = managedInstancePaths(momongaPaths(withTempDir(context, { asHome: true }), process.platform, {}), { owner: 'gateway', generation: 1, purpose: 'serve', provider, incarnation: 1 });
    const server = createManagedServer({
      inspector: testProcessInspector(), random: systemRandom, fileSystem: nodeFileSystemSync,
      launch: TEST_UNPROTECTED_LAUNCH,
      lock: testKernelLock(),
      description: FM_SERVER,
      target: managedModelName(provider, { declared: 'system' }),
      binary: '/opt/fake/fm',
      socketPath: instance.socketPath,
      lockPath: instance.lockPath,
      markerDirectory: instance.markerDirectory,
      readyTimeoutMs: 1000,
      env: {},
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      timers: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout), now: () => Date.now(), monotonicMs: () => performance.now() },
      readStopGraceMs: () => 1000,
      onWarning: () => undefined,
    });
    const refusal = await server.ensureRunning(new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    const message = refusal?.message ?? '';
    const measured = / in (.+) \((ENAMETOOLONG|EINVAL)\); /.exec(message);
    const text = messageOf('serverSocketPathTooLong', 'gateway', { model: `${provider}/system`, byteLength: Buffer.byteLength(instance.socketPath), directory: measured?.[1] ?? '', code: measured?.[2] ?? '' });
    expect(text).toMatch(/^the model "server-n+\/system": its server socket path is \d+ bytes, and the system refused to bind a socket path of that length in .+ \((ENAMETOOLONG|EINVAL)\); choose a shorter server name$/);
    expect(message).toBe(text);
  });
});
