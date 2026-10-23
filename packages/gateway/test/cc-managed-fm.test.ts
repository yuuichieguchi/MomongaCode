import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  capabilitiesFromProbe,
  createChatCompletionsAdapter,
  createFmServe,
  createManagedFmTarget,
  saveProbeRecord,
} from '@momonga/gateway';
import type { ExecResult, FmServe, FmServeTimers, ManagedFmTarget, ProbeRecordKey } from '@momonga/gateway';
import type { ProbeReport } from '@momonga/protocol';
import { FAKE_DETERMINISTIC_REPLY, createFakeClock, startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer, FakeClock } from '@momonga/testkit';
import { START_MS, getJson, makeDir, registerCleanup, startGateway } from './gateway-helpers.ts';
import { TARGET, collect, outputTextOf, userText } from './cc-support.ts';
import { makeReport } from './report-fixture.ts';

const BINARY = '/usr/bin/fm';
const POLL_MS = 25;
const RECORD_KEY: ProbeRecordKey = { target: 'fm', binarySha256: 'ab'.repeat(32), osBuild: '25A100' };
const ALL_TRUE = { enum: true, anyOf: true, const: true, pattern: true, minimum: true, nested: true, additionalProperties: true };

class FakeFmChild extends EventEmitter {
  private server: FakeChatCompletionsServer | undefined;
  private alive = true;
  private readonly socketPath: string;

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
    void startFakeChatCompletions({ scenario: 'tools-ok', socketPath }).then(async (server) => {
      if (!this.alive) {
        await server.close();
        return;
      }
      this.server = server;
    });
  }

  kill(): boolean {
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

type ExecCall = { file: string; args: readonly string[]; stdin: string };

const pollingTimers = (clock: FakeClock): FmServeTimers => ({
  setTimeout: (callback, ms) => {
    if (ms === POLL_MS) setImmediate(callback);
    return undefined;
  },
  clearTimeout: () => undefined,
  now: () => clock.now(),
});

type Setup = {
  report?: ProbeReport;
  licenseExitCode?: number;
  countStdout?: string;
};

const setup = async (config: Setup = {}) => {
  const dir = makeDir();
  const socketPath = path.join(dir, 'fm.sock');
  const recordDir = path.join(dir, 'probe');
  if (config.report !== undefined) await saveProbeRecord(recordDir, RECORD_KEY, config.report);
  const clock = createFakeClock(START_MS);
  const children: FakeFmChild[] = [];
  const spawn = vi.fn((_file: string, _args: readonly string[]) => {
    const child = new FakeFmChild(socketPath);
    children.push(child);
    return child;
  });
  const serveExec = async (_file: string, args: readonly string[]): Promise<ExecResult> =>
    args[0] === 'license' && config.licenseExitCode !== undefined
      ? { exitCode: config.licenseExitCode, stdout: '', stderr: 'The license agreement has not been accepted.' }
      : { exitCode: 0, stdout: '', stderr: '' };
  const fmServe: FmServe = createFmServe({
    binary: BINARY,
    socketPath,
    exec: serveExec,
    spawn,
    timers: pollingTimers(clock),
    healthTimeoutMs: 400,
    restartBackoffMs: 50,
    stopGraceMs: 30,
    maxRestarts: 3,
    restartResetMs: 5000,
    preconditionTtlMs: 1000,
  });
  registerCleanup(async () => {
    await fmServe.stop();
    for (const child of children) await child.exit();
  });
  const execCalls: ExecCall[] = [];
  const exec = async (file: string, args: readonly string[], stdin: string): Promise<ExecResult> => {
    execCalls.push({ file, args, stdin });
    return { exitCode: 0, stdout: config.countStdout ?? '20\n', stderr: '' };
  };
  const managed: ManagedFmTarget = await createManagedFmTarget({
    fmServe,
    binary: BINARY,
    exec,
    probeRecordDir: recordDir,
    recordKey: RECORD_KEY,
    toolCallingSetting: 'auto',
  });
  return { managed, spawn, socketPath, execCalls, clock };
};

const adapterFor = (managed: ManagedFmTarget, clock: FakeClock) => {
  const adapter = createChatCompletionsAdapter({ ...managed, clock });
  registerCleanup(() => adapter.close());
  return adapter;
};

describe('createManagedFmTarget endpoint', () => {
  it('starts fm serve on first use and reuses it afterwards', async () => {
    const { managed, spawn, socketPath } = await setup();
    expect(spawn).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([managed.resolveEndpoint(TARGET), managed.resolveEndpoint(TARGET)]);
    const third = await managed.resolveEndpoint(TARGET);
    expect(first).toEqual({ kind: 'unix', socketPath });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('serves a streamed completion through the chat-completions adapter', async () => {
    const { managed, clock } = await setup();
    const { events, error } = await collect(adapterFor(managed, clock), { model: 'system', input: [userText('hi')] });
    expect(error).toBeUndefined();
    expect(outputTextOf(events)).toBe(FAKE_DETERMINISTIC_REPLY);
  });
});

describe('createManagedFmTarget probe-derived settings', () => {
  it('decides tool calling and keyword support from the probe record', async () => {
    const report = { ...makeReport(0.5, 1), keywordSupport: { ...ALL_TRUE, pattern: false, anyOf: false } };
    const { managed } = await setup({ report });
    expect(managed.toolCalling(TARGET)).toBe('constrained');
    expect(managed.keywordSupport(TARGET)).toEqual({ ...ALL_TRUE, pattern: false, anyOf: false });
    expect(await managed.capabilities(TARGET)).toEqual(capabilitiesFromProbe(report, { mode: 'constrained' }));
  });

  it('falls back to native tool calling, full keyword support and conservative unprobed capabilities without a record', async () => {
    const { managed } = await setup();
    expect(managed.toolCalling(TARGET)).toBe('native');
    expect(managed.keywordSupport(TARGET)).toEqual(ALL_TRUE);
    expect(await managed.capabilities(TARGET)).toMatchObject({
      contextWindow: 4096,
      toolCalling: 'native',
      tokenCounting: 'estimated',
      source: 'unprobed',
    });
  });
});

describe('createManagedFmTarget token counting', () => {
  it('counts with fm count-tokens on stdin and applies the probed calibration', async () => {
    const report = { ...makeReport(1, 1), tokenCalibration: { ratio: 1.25, errorBound: 0.25 } };
    const { managed, execCalls } = await setup({ report, countStdout: '20\n' });
    const result = await managed.countTokens(TARGET, { model: 'fast', instructions: 'Be terse.', input: [userText('count these words')] }, new AbortController().signal);
    expect(result).toEqual({ input_tokens: 25, method: 'calibrated', error_bound: 7 });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.file).toBe(BINARY);
    expect(execCalls[0]?.args.slice(0, 2)).toEqual(['count-tokens', '-q']);
    expect(execCalls[0]?.stdin).toContain('Be terse.');
    expect(execCalls[0]?.stdin).toContain('count these words');
  });

  it('reports an estimated count without a calibration', async () => {
    const { managed } = await setup({ countStdout: '20\n' });
    const result = await managed.countTokens(TARGET, { model: 'fast', input: 'count these words' }, new AbortController().signal);
    expect(result).toEqual({ input_tokens: 20, method: 'estimated', error_bound: 6 });
  });
});

describe('createManagedFmTarget health', () => {
  it('delegates to fm serve health', async () => {
    const { managed } = await setup();
    expect(await managed.health(TARGET)).toMatchObject({ ok: true, detail: 'idle; starts on demand' });
    await managed.resolveEndpoint(TARGET);
    expect(await managed.health(TARGET)).toEqual({ ok: true });
  });

  it('surfaces a license precondition failure with its remediation in /v1/momonga/health', async () => {
    const { managed, clock } = await setup({ licenseExitCode: 69 });
    const adapter = adapterFor(managed, clock);
    const { client } = await startGateway({
      adapters: { fm: adapter },
      config: { aliases: { fast: ['fm'] }, targets: { fm: { adapter: 'fm', model: 'system' } } },
    });
    const health = await getJson(client, '/v1/momonga/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(false);
    expect(health.body.targets.fm).toMatchObject({ ok: false, breaker: 'closed', reason: 'precondition_failed', remediation: 'sudo fm license' });
  });
});
