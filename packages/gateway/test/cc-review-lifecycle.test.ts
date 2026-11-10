import { fixedRolePort } from '@momonga/foundation';
import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createChatCompletionsAdapter, createManagedServer, createGateway, createManagedTarget, unauthenticatedSource } from '@momonga/gateway';
import type { ExecResult, ManagedServer, ManagedServerTimers, ProviderAdapter } from '@momonga/gateway';
import { createFakeClock, createFakeTimers, createScriptedAdapter, startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { HMAC_KEY, START_MS, TEST_VERSION, buildConfig, makeDir, registerCleanup, startGateway } from './gateway-helpers.ts';
import { CC_CAPABILITIES, TARGET } from './cc-support.ts';
import { saveProbeRecord } from '@momonga/gateway';
import { makeReport } from './report-fixture.ts';
import { FM_CURRENCY, fmRecordKey, fmTargetBase, recordKeyOptions } from './fm-record-support.ts';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';
import type { KnownProbeKey } from '@momonga/config';
import { FM_SERVER } from '@momonga/protocol';
import type { ManagedTarget } from '@momonga/gateway';

const countTokensOf = (managed: { countTokens?: ManagedTarget['countTokens'] }): NonNullable<ManagedTarget['countTokens']> => {
  if (managed.countTokens === undefined) throw new Error('the fm description declares a token counter, so the managed target counts tokens');
  return managed.countTokens;
};

const KEY: KnownProbeKey = fmRecordKey('ef'.repeat(32), '25A100');
const userRequest = { model: 'scripted/scripted-primary', input: [{ type: 'message' as const, role: 'user' as const, content: 'x' }] };

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
  async kill(signal: string = 'SIGTERM'): Promise<boolean> {
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

const pollNow = (): ManagedServerTimers => ({
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
  const fmServe: ManagedServer = createManagedServer({
    description: FM_SERVER,
    target: 'scripted/system',
    lockPath: `${socketPath}.lock`,
    readyTimeoutMs: 400,
    readStopGraceMs: () => 30,
    binary: '/usr/bin/fm',
    socketPath,
    exec: okExec,
    spawn: () => {
      const child = new Child(socketPath);
      children.push(child);
      return child;
    },
    timers: pollNow(),
    onWarning: (message) => warnings.push(message),
  });
  registerCleanup(async () => {
    await fmServe.stop();
    expect(warnings).toEqual([]);
    for (const child of children) await child.exit();
  });
  const managed = await createManagedTarget({
    ...fmTargetBase(),
    server: fmServe,
    binary: '/usr/bin/fm',
    exec: async () => ({ exitCode: 0, stdout: '5\n', stderr: '' }),
    probeRecordDir: path.join(dir, 'probe'),
    ...recordKeyOptions(KEY),
    toolCallingSetting: 'native',
  });
  const clock = createFakeClock(START_MS);
  const adapter = createChatCompletionsAdapter({ authSource: unauthenticatedSource, liveness: UNDICI_DEFAULT_LIVENESS, ...managed, clock });
  return { managed, adapter, children, fmServe };
};

describe('managed endpoint', () => {
  it('asks fm serve to be running on every resolve instead of caching the first endpoint', async () => {
    const ensureRunning = vi.fn(async () => ({ kind: 'unix' as const, path: '/s.sock' }));
    const fmServe: ManagedServer = { restarts: 0, start: ensureRunning, ensureRunning, stop: async () => undefined, health: async () => ({ ok: true }) };
    const managed = await createManagedTarget({
      ...fmTargetBase(),
      server: fmServe,
      binary: '/usr/bin/fm',
      exec: okExec,
      probeRecordDir: makeDir(),
      ...recordKeyOptions(KEY),
      toolCallingSetting: 'native',
    });
    await managed.resolveEndpoint(TARGET, new AbortController().signal);
    await managed.resolveEndpoint(TARGET, new AbortController().signal);
    expect(ensureRunning).toHaveBeenCalledTimes(2);
  });
});

describe('adapter and gateway shutdown', () => {
  it('closes the managed fm serve through adapter.close, idempotently', async () => {
    const { managed, adapter, children } = await managedFm();
    await managed.resolveEndpoint(TARGET, new AbortController().signal);
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
    await managed.resolveEndpoint(TARGET, new AbortController().signal);
    const closes = vi.fn(async () => undefined);
    const other: ProviderAdapter = { ...createScriptedAdapter({ calls: [] }), close: closes };
    const { gateway } = await startGateway({
      adapters: { 'scripted/system': adapter, 'scripted/m': other, 'b/m': other },
      config: {
        chains: { 'scripted/system': ['scripted/system'], 'scripted/m': ['scripted/m', 'b/m'] },
        targets: { 'scripted/system': {}, 'scripted/m': {}, 'b/m': {} },
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
      role: fixedRolePort('serving'),
      random: () => 0.5,
      credentials: [],
      config: buildConfig({
        chains: { 'scripted/m': ['scripted/m'], 'b/m': ['b/m'] },
        targets: { 'scripted/m': {}, 'b/m': {} },
      }),
      adapters: { 'scripted/m': failing, 'b/m': { ...createScriptedAdapter({ calls: [] }), close: healthy } },
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
    await saveProbeRecord(dir, KEY, { ...makeReport(1, 1), tokenCalibration: { ratio, errorBound: 0.1 } }, FM_CURRENCY);
    return createManagedTarget({
      ...fmTargetBase(),
      server: { restarts: 0, start: async () => ({ kind: 'unix', path: '/s' }), ensureRunning: async () => ({ kind: 'unix', path: '/s' }), stop: async () => undefined, health: async () => ({ ok: true }) },
      binary: '/usr/bin/fm',
      exec: async (_file: string, _args: readonly string[], _stdin: string, signal: AbortSignal) => {
        signals.push(signal);
        return { exitCode: 0, stdout: `${counted}\n`, stderr: '' };
      },
      probeRecordDir: dir,
      ...recordKeyOptions(KEY),
      toolCallingSetting: 'auto',
    });
  };

  it('passes the abort signal to exec', async () => {
    const signals: AbortSignal[] = [];
    const managed = await calibrated(1.25, '20', signals);
    const controller = new AbortController();
    await countTokensOf(managed)(TARGET, { model: 'scripted/scripted-primary', input: 'x' }, controller.signal);
    expect(signals).toEqual([controller.signal]);
  });

  it('rounds calibrated counts up', async () => {
    const managed = await calibrated(1.3, '21', []);
    const result = await countTokensOf(managed)(TARGET, { model: 'scripted/scripted-primary', input: 'x' }, new AbortController().signal);
    expect(result.input_tokens).toBe(28);
  });

  it('does not round up floating point noise', async () => {
    const managed = await calibrated(1.1, '20', []);
    const result = await countTokensOf(managed)(TARGET, { model: 'scripted/scripted-primary', input: 'x' }, new AbortController().signal);
    expect(result.input_tokens).toBe(22);
  });
});


describe('closed adapter', () => {
  it('rejects create after close without resolving an endpoint', async () => {
    const resolveEndpoint = vi.fn(async () => ({ kind: 'unix' as const, socketPath: '/never.sock' }));
    const adapter = createChatCompletionsAdapter({ authSource: unauthenticatedSource, liveness: UNDICI_DEFAULT_LIVENESS, schemaDialect: () => 'json-schema-2020-12',
      resolveEndpoint,
      capabilities: async () => {
        throw new Error('unused');
      },
      clock: createFakeClock(START_MS),
    });
    await adapter.close();
    const iterator = adapter
      .create(
        { model: 'm', input: [{ type: 'message', role: 'user', content: 'x' }] },
        { signal: new AbortController().signal, target: TARGET, attempt: 1, reasoningOrigin: EVERY_REASONING_IS_OWN, capabilities: CC_CAPABILITIES },
      )
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/closed/);
    expect(resolveEndpoint).not.toHaveBeenCalled();
  });
});
