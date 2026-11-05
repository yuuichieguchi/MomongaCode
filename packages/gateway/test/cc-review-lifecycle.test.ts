import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createChatCompletionsAdapter, createFmServe, createGateway, createManagedFmTarget } from '@momonga/gateway';
import type { ExecResult, FmServe, FmServeTimers, ProbeRecordKey, ProviderAdapter } from '@momonga/gateway';
import { createFakeClock, createFakeTimers, createScriptedAdapter, startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { HMAC_KEY, START_MS, TEST_VERSION, buildConfig, makeDir, registerCleanup, startGateway } from './gateway-helpers.ts';
import { TARGET } from './cc-support.ts';
import { saveProbeRecord } from '@momonga/gateway';
import { makeReport } from './report-fixture.ts';

const KEY: ProbeRecordKey = { target: 'fm', binarySha256: 'ef'.repeat(32), osBuild: '25A100' };
const userRequest = { model: 'fast', input: [{ type: 'message' as const, role: 'user' as const, content: 'x' }] };

class Child extends EventEmitter {
  readonly signals: string[] = [];
  private server: FakeChatCompletionsServer | undefined;
  private alive = true;
  private readonly socketPath: string;
  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
    void startFakeChatCompletions({ scenario: 'tools-ok', socketPath }).then(async (server) => {
      if (!this.alive) await server.close();
      else this.server = server;
    });
  }
  kill(signal: string = 'SIGTERM'): boolean {
    this.signals.push(signal);
    void this.exit();
    return true;
  }
  async exit(): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    await this.server?.close();
    fs.rmSync(this.socketPath, { force: true });
    this.emit('exit', 0, null);
  }
}

const pollNow = (): FmServeTimers => ({
  setTimeout: (callback, ms) => {
    if (ms === 25) setImmediate(callback);
    return undefined;
  },
  clearTimeout: () => undefined,
  now: () => 0,
});

const okExec = async (): Promise<ExecResult> => ({ exitCode: 0, stdout: '', stderr: '' });

const managedFm = async () => {
  const dir = makeDir();
  const socketPath = path.join(dir, 'fm.sock');
  const children: Child[] = [];
  const warnings: string[] = [];
  const fmServe: FmServe = createFmServe({
    binary: '/usr/bin/fm',
    socketPath,
    exec: okExec,
    spawn: () => {
      const child = new Child(socketPath);
      children.push(child);
      return child;
    },
    timers: pollNow(),
    healthTimeoutMs: 400,
    restartBackoffMs: 50,
    stopGraceMs: 30,
    maxRestarts: 3,
    restartResetMs: 5000,
    preconditionTtlMs: 1000,
    onWarning: (message) => warnings.push(message),
  });
  registerCleanup(async () => {
    await fmServe.stop();
    expect(warnings).toEqual([]);
    for (const child of children) await child.exit();
  });
  const managed = await createManagedFmTarget({
    fmServe,
    binary: '/usr/bin/fm',
    exec: async () => ({ exitCode: 0, stdout: '5\n', stderr: '' }),
    probeRecordDir: path.join(dir, 'probe'),
    recordKey: KEY,
    toolCallingSetting: 'native',
  });
  const clock = createFakeClock(START_MS);
  const adapter = createChatCompletionsAdapter({ ...managed, clock });
  return { managed, adapter, children, fmServe };
};

describe('managed endpoint', () => {
  it('asks fm serve to be running on every resolve instead of caching the first endpoint', async () => {
    const ensureRunning = vi.fn(async () => ({ kind: 'unix' as const, socketPath: '/s.sock' }));
    const fmServe: FmServe = { restarts: 0, start: ensureRunning, ensureRunning, stop: async () => undefined, health: async () => ({ ok: true }) };
    const managed = await createManagedFmTarget({
      fmServe,
      binary: '/usr/bin/fm',
      exec: okExec,
      probeRecordDir: makeDir(),
      recordKey: KEY,
      toolCallingSetting: 'native',
    });
    await managed.resolveEndpoint(TARGET);
    await managed.resolveEndpoint(TARGET);
    expect(ensureRunning).toHaveBeenCalledTimes(2);
  });
});

describe('adapter and gateway shutdown', () => {
  it('closes the managed fm serve through adapter.close, idempotently', async () => {
    const { managed, adapter, children } = await managedFm();
    await managed.resolveEndpoint(TARGET);
    expect(children).toHaveLength(1);
    await adapter.close();
    expect(children[0]?.signals).toEqual(['SIGTERM']);
    expect(await managed.health(TARGET)).toMatchObject({ ok: false, reason: 'not_running' });
    await adapter.close();
    await managed.close();
    expect(children[0]?.signals).toEqual(['SIGTERM']);
  });

  it('closes every distinct adapter once when the gateway closes', async () => {
    const { adapter, children, managed } = await managedFm();
    await managed.resolveEndpoint(TARGET);
    const closes = vi.fn(async () => undefined);
    const other: ProviderAdapter = { ...createScriptedAdapter({ calls: [] }), close: closes };
    const { gateway } = await startGateway({
      adapters: { fm: adapter, a: other, b: other },
      config: {
        aliases: { fast: ['fm'], other: ['a', 'b'] },
        targets: { fm: { model: 'system' }, a: { model: 'm' }, b: { model: 'm' } },
      },
    });
    await gateway.close();
    await gateway.close();
    expect(closes).toHaveBeenCalledTimes(1);
    expect(children[0]?.signals).toEqual(['SIGTERM']);
  });

  it('finishes the whole cleanup, then rejects close() with an AggregateError of adapter failures', async () => {
    const failure = new Error('close exploded');
    const failing: ProviderAdapter = {
      ...createScriptedAdapter({ calls: [] }),
      close: async () => {
        throw failure;
      },
    };
    const healthy = vi.fn(async () => undefined);
    const dir = makeDir();
    const socketPath = path.join(dir, 'gw.sock');
    const clock = createFakeClock(START_MS);
    const gateway = await createGateway({
      random: () => 0.5,
      credentials: [],
      config: buildConfig({
        aliases: { fast: ['a'], other: ['b'] },
        targets: { a: { model: 'm' }, b: { model: 'm' } },
      }),
      adapters: { a: failing, b: { ...createScriptedAdapter({ calls: [] }), close: healthy } },
      clock,
      timers: createFakeTimers(clock),
      dbPath: path.join(dir, 'state', 'gateway.db'),
      hmacKey: HMAC_KEY,
      socketPath,
      version: TEST_VERSION,
    });
    const closing = gateway.close();
    await expect(closing).rejects.toBeInstanceOf(AggregateError);
    await expect(closing).rejects.toMatchObject({ errors: [failure] });
    expect(gateway.close()).toBe(closing);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});

describe('count-tokens', () => {
  const calibrated = async (ratio: number, counted: string, signals: AbortSignal[]) => {
    const dir = makeDir();
    await saveProbeRecord(dir, KEY, { ...makeReport(1, 1), tokenCalibration: { ratio, errorBound: 0.1 } });
    return createManagedFmTarget({
      fmServe: { restarts: 0, start: async () => ({ kind: 'unix', socketPath: '/s' }), ensureRunning: async () => ({ kind: 'unix', socketPath: '/s' }), stop: async () => undefined, health: async () => ({ ok: true }) },
      binary: '/usr/bin/fm',
      exec: async (_file: string, _args: readonly string[], _stdin: string, signal: AbortSignal) => {
        signals.push(signal);
        return { exitCode: 0, stdout: `${counted}\n`, stderr: '' };
      },
      probeRecordDir: dir,
      recordKey: KEY,
      toolCallingSetting: 'auto',
    });
  };

  it('passes the abort signal to exec', async () => {
    const signals: AbortSignal[] = [];
    const managed = await calibrated(1.25, '20', signals);
    const controller = new AbortController();
    await managed.countTokens(TARGET, { model: 'fast', input: 'x' }, controller.signal);
    expect(signals).toEqual([controller.signal]);
  });

  it('rounds calibrated counts up', async () => {
    const managed = await calibrated(1.3, '21', []);
    const result = await managed.countTokens(TARGET, { model: 'fast', input: 'x' }, new AbortController().signal);
    expect(result.input_tokens).toBe(28);
  });

  it('does not round up floating point noise', async () => {
    const managed = await calibrated(1.1, '20', []);
    const result = await managed.countTokens(TARGET, { model: 'fast', input: 'x' }, new AbortController().signal);
    expect(result.input_tokens).toBe(22);
  });
});


describe('closed adapter', () => {
  it('rejects create after close without resolving an endpoint', async () => {
    const resolveEndpoint = vi.fn(async () => ({ kind: 'unix' as const, socketPath: '/never.sock' }));
    const adapter = createChatCompletionsAdapter({
      resolveEndpoint,
      toolCalling: () => 'native',
      capabilities: async () => {
        throw new Error('unused');
      },
      clock: createFakeClock(START_MS),
    });
    await adapter.close();
    const iterator = adapter
      .create(
        { model: 'm', input: [{ type: 'message', role: 'user', content: 'x' }] },
        { signal: new AbortController().signal, target: TARGET, attempt: 1, reasoningOrigin: EVERY_REASONING_IS_OWN },
      )
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/closed/);
    expect(resolveEndpoint).not.toHaveBeenCalled();
  });
});
