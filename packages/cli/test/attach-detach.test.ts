import { EXIT_INTERRUPTED, momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { RuntimeClient } from '../src/client/runtime-client.ts';
import type { CliPorts } from '../src/ports.ts';
import { watchRun } from '../src/run/headless.ts';
import { virtualClock } from './fake-supervisor.ts';
import { runView } from './fake-backend.ts';

type Watched = { client: RuntimeClient; cancelled: string[]; following: Promise<void>; streamEnded: Promise<unknown> };

const liveRun = (): Watched => {
  const cancelled: string[] = [];
  const following = Promise.withResolvers<void>();
  const streamEnded = Promise.withResolvers<unknown>();
  const client = {
    cancel: async (runId: string) => {
      cancelled.push(runId);
      return { status: 202, run: runView({ status: 'CANCELLED' }) };
    },
    streamEvents: async function* (_runId: string, options: { signal?: AbortSignal }) {
      following.resolve();
      const aborted = Promise.withResolvers<never>();
      options.signal?.addEventListener('abort', () => aborted.reject(options.signal?.reason), { once: true });
      try {
        await aborted.promise;
      } catch (error) {
        streamEnded.resolve(error);
        throw error;
      }
    },
    getRun: async () => runView({ status: 'RUNNING' }),
  } as unknown as RuntimeClient;
  return { client, cancelled, following: following.promise, streamEnded: streamEnded.promise };
};

const portsOf = (stdout: string[], stderr: string[]): CliPorts =>
  ({ version: '1.0.0', clock: virtualClock(), random: () => 0.5, stdout: { write: (text: string) => void stdout.push(text) }, stderr: { write: (text: string) => void stderr.push(text) } }) as unknown as CliPorts;

describe('an interrupt of attach', () => {
  it('ends the follow, leaves the run running and says how to follow or cancel it', async (context) => {
    const paths = momongaPaths(withTempDir(context, { asHome: true }), process.platform, process.env);
    const watched = liveRun();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const interrupt = new AbortController();

    const watching = watchRun(portsOf(stdout, stderr), paths, { client: watched.client, runId: 'run-1', format: 'text', verbose: false, interrupt: interrupt.signal, onInterrupt: 'detach' });
    await watched.following;
    interrupt.abort();

    expect(await watching).toBe(EXIT_INTERRUPTED);
    await watched.streamEnded;
    expect(watched.cancelled).toEqual([]);
    expect(stderr.join('')).toContain('momonga attach run-1');
    expect(stderr.join('')).toContain('momonga cancel run-1');
    expect(stdout).toEqual([]);
  });

  it('prints the result with the state of the run in a JSON format', async (context) => {
    const paths = momongaPaths(withTempDir(context, { asHome: true }), process.platform, process.env);
    const watched = liveRun();
    const stdout: string[] = [];
    const interrupt = new AbortController();

    const watching = watchRun(portsOf(stdout, []), paths, { client: watched.client, runId: 'run-1', format: 'json', verbose: false, interrupt: interrupt.signal, onInterrupt: 'detach' });
    await watched.following;
    interrupt.abort();

    expect(await watching).toBe(EXIT_INTERRUPTED);
    expect(watched.cancelled).toEqual([]);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ type: 'result', status: 'RUNNING' });
  });
});

describe('an interrupt of a headless run', () => {
  it('cancels the run', async (context) => {
    const paths = momongaPaths(withTempDir(context, { asHome: true }), process.platform, process.env);
    const cancelled: string[] = [];
    const ended = Promise.withResolvers<void>();
    const following = Promise.withResolvers<void>();
    const client = {
      cancel: async (runId: string) => {
        cancelled.push(runId);
        ended.resolve();
        return { status: 202, run: runView({ status: 'CANCELLED' }) };
      },
      streamEvents: async function* () {
        following.resolve();
        await ended.promise;
      },
      getRun: async () => runView({ status: 'CANCELLED' }),
    } as unknown as RuntimeClient;
    const interrupt = new AbortController();

    const watching = watchRun(portsOf([], []), paths, { client, runId: 'run-1', format: 'text', verbose: false, interrupt: interrupt.signal, onInterrupt: 'cancel' });
    await following.promise;
    interrupt.abort();

    expect(await watching).toBe(EXIT_INTERRUPTED);
    expect(cancelled).toEqual(['run-1']);
  });
});
