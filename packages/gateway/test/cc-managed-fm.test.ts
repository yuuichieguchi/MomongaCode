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
import { ESTIMATED_ERROR_SHAPE, errorBoundOfShape } from '@momonga/protocol';
import type { ProbeReport } from '@momonga/protocol';
import { FAKE_DETERMINISTIC_REPLY, createFakeClock, startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer, FakeClock } from '@momonga/testkit';
import { START_MS, getJson, makeDir, postJson, readJson, registerCleanup, startGateway } from './gateway-helpers.ts';
import { TARGET, collect, outputTextOf, userText } from './cc-support.ts';
import { makeReport } from './report-fixture.ts';

const BINARY = '/usr/bin/fm';
const POLL_MS = 25;
const LICENSE_NOTICE = 'YOU HAVE NOT AGREED TO THE FM TERMS';
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
  countExitCode?: number;
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
  const warnings: string[] = [];
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
    onWarning: (message) => warnings.push(message),
  });
  registerCleanup(async () => {
    await fmServe.stop();
    expect(warnings).toEqual([]);
    for (const child of children) await child.exit();
  });
  const execCalls: ExecCall[] = [];
  const exec = async (file: string, args: readonly string[], stdin: string): Promise<ExecResult> => {
    execCalls.push({ file, args, stdin });
    return config.countExitCode === undefined
      ? { exitCode: 0, stdout: config.countStdout ?? '20\n', stderr: '' }
      : { exitCode: config.countExitCode, stdout: '', stderr: LICENSE_NOTICE };
  };
  const managed: ManagedFmTarget = await createManagedFmTarget({
    fmServe,
    binary: BINARY,
    exec,
    probeRecordDir: recordDir,
    recordKey: RECORD_KEY,
    toolCallingSetting: config.report === undefined ? 'native' : 'auto',
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

  it('uses the declared native tool calling, full keyword support and conservative unprobed capabilities without a record', async () => {
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
    expect(result).toEqual({ input_tokens: 25, method: 'calibrated', error_bound: 7, error_shape: { ratio: 0.25, minimum: 1 } });
    expect(result.error_bound).toBe(errorBoundOfShape(result.error_shape, result.input_tokens));
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.file).toBe(BINARY);
    expect(execCalls[0]?.args.slice(0, 2)).toEqual(['count-tokens', '-q']);
    expect(execCalls[0]?.stdin).toContain('Be terse.');
    expect(execCalls[0]?.stdin).toContain('count these words');
  });

  it('reports an estimated count without a calibration', async () => {
    const { managed } = await setup({ countStdout: '20\n' });
    const result = await managed.countTokens(TARGET, { model: 'fast', input: 'count these words' }, new AbortController().signal);
    expect(result).toEqual({ input_tokens: 20, method: 'estimated', error_bound: 6, error_shape: ESTIMATED_ERROR_SHAPE });
    expect(result.error_bound).toBe(errorBoundOfShape(result.error_shape, result.input_tokens));
  });

  it('counts a request with no text as zero tokens without running fm count-tokens', async () => {
    const { managed, execCalls } = await setup({ countStdout: '20\n' });
    const result = await managed.countTokens(TARGET, { model: 'fast', input: [], tools: [] }, new AbortController().signal);
    expect(result.input_tokens).toBe(0);
    expect(execCalls.filter((call) => call.args[0] === 'count-tokens')).toEqual([]);
  });

  it('still runs fm count-tokens with the text of a non-empty request', async () => {
    const { managed, execCalls } = await setup({ countStdout: '20\n' });
    const result = await managed.countTokens(TARGET, { model: 'fast', input: [userText('hello')] }, new AbortController().signal);
    expect(result.input_tokens).toBe(20);
    expect(execCalls).toEqual([{ file: BINARY, args: ['count-tokens', '-q'], stdin: 'hello' }]);
  });

  it('counts each tool as canonical JSON on its own line between instructions and input items', async () => {
    const { managed, execCalls } = await setup({ countStdout: '20\n' });
    const tools = [
      { type: 'function' as const, name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: true },
      { type: 'function' as const, name: 'Bash', description: 'Run a command', parameters: { type: 'object', properties: {} } },
    ];
    await managed.countTokens(TARGET, { model: 'fast', instructions: 'Be terse.', tools, input: [userText('count these words')] }, new AbortController().signal);
    const lines = (execCalls[0]?.stdin ?? '').split('\n');
    expect(lines).toEqual([
      'Be terse.',
      '{"description":"Read a file","name":"Read","parameters":{"properties":{"path":{"type":"string"}},"type":"object"}}',
      '{"description":"Run a command","name":"Bash","parameters":{"properties":{},"type":"object"}}',
      'count these words',
    ]);
  });
});

describe('createManagedFmTarget unlicensed token counting', () => {
  it('rejects fm count-tokens exit 69 with a precondition failure carrying the remedy', async () => {
    const { managed } = await setup({ countExitCode: 69 });
    await expect(managed.countTokens(TARGET, { model: 'fast', input: 'count these words' }, new AbortController().signal)).rejects.toMatchObject({
      name: 'PreconditionFailedError',
      detail: LICENSE_NOTICE,
      remediation: 'sudo fm license',
    });
  });

  it('answers /v1/momonga/count_tokens with a non-retryable precondition_failed carrying the remedy', async () => {
    const { managed, clock, execCalls } = await setup({ countExitCode: 69 });
    const { client } = await startGateway({
      adapters: { fm: adapterFor(managed, clock) },
      config: { aliases: { fast: ['fm'] }, targets: { fm: { model: 'system' } } },
    });
    const response = await readJson(await postJson(client, '/v1/momonga/count_tokens', { model: 'fast', input: 'count these words' }));
    expect(response.status).toBe(412);
    expect(response.body.error).toMatchObject({ type: 'invalid_request', code: 'precondition_failed' });
    expect(response.body.error.message).toContain('sudo fm license');
    expect(response.body.error.message).toContain(LICENSE_NOTICE);
    expect(execCalls).toHaveLength(1);
  });

  it('classifies a precondition failure of the stream path as non-retryable precondition_failed', async () => {
    const { managed, clock } = await setup({ licenseExitCode: 69 });
    const adapter = adapterFor(managed, clock);
    const { error } = await collect(adapter, { model: 'system', input: [userText('hi')] });
    expect(adapter.classify(error)).toMatchObject({ retryable: false, error: { type: 'invalid_request', code: 'precondition_failed' } });
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
      config: { aliases: { fast: ['fm'] }, targets: { fm: { model: 'system' } } },
    });
    const health = await getJson(client, '/v1/momonga/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(false);
    expect(health.body.targets.fm).toMatchObject({ ok: false, breaker: 'closed', reason: 'precondition_failed', remediation: 'sudo fm license' });
  });
});

describe('createManagedFmTarget compaction and wire counting', () => {
  it('advertises compact through the chat-completions adapter and answers through fake-fm', async () => {
    const { managed, clock } = await setup();
    const adapter = adapterFor(managed, clock);
    expect(adapter.compact).toBeTypeOf('function');
    const result = await adapter.compact?.(
      { model: 'system', input: [userText('summarise this')], momonga: { max_summary_tokens: 64 } },
      { signal: new AbortController().signal, target: TARGET, attempt: 1 },
    );
    expect(result?.summary).toBe(FAKE_DETERMINISTIC_REPLY);
  });

  it('answers /v1/responses/compact for a managed fm alias', async () => {
    const { managed, clock } = await setup();
    const { client } = await startGateway({
      adapters: { fm: adapterFor(managed, clock) },
      config: { aliases: { fast: ['fm'] }, targets: { fm: { model: 'system' } } },
    });
    const response = await readJson(await postJson(client, '/v1/responses/compact', { model: 'fast', input: [userText('summarise this')] }));
    expect(response.status).toBe(200);
    expect(response.body.object).toBe('response.compaction');
  });

  it('feeds fm count-tokens the text parts of the wire through /v1/momonga/count_tokens', async () => {
    const { managed, clock, execCalls } = await setup({ countStdout: '20\n' });
    const { client } = await startGateway({
      adapters: { fm: adapterFor(managed, clock) },
      config: { aliases: { fast: ['fm'] }, targets: { fm: { model: 'system' } } },
    });
    const tools = [{ type: 'function' as const, name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
    const response = await readJson(
      await postJson(client, '/v1/momonga/count_tokens', { model: 'fast', instructions: 'Be terse.', tools, input: [userText('count these words')] }),
    );
    expect(response.status).toBe(200);
    const stdin = execCalls.find((call) => call.args[0] === 'count-tokens')?.stdin ?? '';
    expect(stdin).toContain('Be terse.');
    expect(stdin).toContain('count these words');
    expect(stdin).toContain('"function":{');
    expect(stdin).not.toContain('{"description":"Read a file","name":"Read","parameters"');
  });

  it('counts an empty wire request as zero tokens through /v1/momonga/count_tokens without running fm count-tokens', async () => {
    const { managed, clock, execCalls } = await setup({ countStdout: '20\n' });
    const { client } = await startGateway({
      adapters: { fm: adapterFor(managed, clock) },
      config: { aliases: { fast: ['fm'] }, targets: { fm: { model: 'system' } } },
    });
    const response = await readJson(await postJson(client, '/v1/momonga/count_tokens', { model: 'fast', input: [], tools: [] }));
    expect(response.status).toBe(200);
    expect(response.body.input_tokens).toBe(0);
    expect(execCalls.filter((call) => call.args[0] === 'count-tokens')).toEqual([]);
  });
});
