import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installTrust } from '../src/outbound.ts';
import type { NetworkConfig } from '../src/network-route.ts';
import { waitFor } from '@momonga/testkit';

const workers = vi.hoisted(() => ({ started: [] as Array<{ terminated: number; exited: Promise<number>; online: Promise<void> }> }));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  const BLOCKED_READ = 'for (;;) {}';
  class BlockedReadWorker extends actual.Worker {
    private readonly record: { terminated: number; exited: Promise<number>; online: Promise<void> };
    constructor(_code: string | URL, options?: import('node:worker_threads').WorkerOptions) {
      super(BLOCKED_READ, { ...options, eval: true });
      const exited = new Promise<number>((resolve) => this.once('exit', resolve));
      const online = new Promise<void>((resolve) => this.once('online', () => resolve()));
      this.record = { terminated: 0, exited, online };
      workers.started.push(this.record);
    }
    override terminate(): Promise<number> {
      this.record.terminated += 1;
      return super.terminate();
    }
  }
  const patched = { ...actual, Worker: BlockedReadWorker };
  return { ...patched, default: patched };
});

const noFiles = { readTextFile: (): Promise<string> => Promise.reject(new Error('no file is read in this test')) };
const noCaFiles: NetworkConfig = { caFiles: [] };

let original: string[] = [];

beforeAll(() => {
  original = tls.getCACertificates('default');
});

afterAll(() => {
  tls.setDefaultCACertificates(original);
});

describe('the default worker reader is terminated when the signal aborts', () => {
  it('terminates a worker whose read blocks and fires no event, and reports the system failure', async () => {
    workers.started.length = 0;
    const controller = new AbortController();

    const pending = installTrust(noCaFiles, noFiles, { signal: controller.signal });
    await waitFor(() => workers.started.length > 0, { description: 'the worker of the trust read to start' });
    await workers.started[0]?.online;
    controller.abort(new Error('the host read bound passed'));
    const report = await pending;

    expect(workers.started).toHaveLength(1);
    expect(workers.started[0]?.terminated).toBe(1);
    await workers.started[0]?.exited;
    expect(report.sources.find((entry) => entry.source === 'system')).toEqual({ source: 'system', certificates: 0 });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.reason.startsWith('the system store was not read:')).toBe(true);
    expect(report.failures[0]?.reason).toContain('the host read bound passed');
  });
});
