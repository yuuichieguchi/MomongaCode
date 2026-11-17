import { nodeFileSystemSync, systemRandom } from '@momonga/foundation';
import { TEST_FENCE, TEST_UNPROTECTED_LAUNCH } from '@momonga/testkit';
import { contextOf } from './own-reasoning.ts';
import Ajv2020 from 'ajv/dist/2020.js';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  capabilitiesFromProbe,
  createChatCompletionsAdapter,
  createManagedServer,
  createManagedTarget,
  saveProbeRecord,
  unauthenticatedSource,
} from '@momonga/gateway';
import type { ExecResult, ManagedServer, ManagedServerTimers, ManagedTarget } from '@momonga/gateway';
import { ESTIMATED_ERROR_SHAPE, TARGET_PROBING, errorBoundOfShape } from '@momonga/protocol';
import type { ProbeReport } from '@momonga/protocol';
import { FAKE_DETERMINISTIC_REPLY, createFakeClock, startFakeChatCompletions, testKernelLock, testProcessInspector } from '@momonga/testkit';
import type { FakeChatCompletionsServer, FakeClock } from '@momonga/testkit';
import { START_MS, getJson, makeDir, postJson, readJson, registerCleanup, startGateway } from './gateway-helpers.ts';
import { TARGET, collect, outputTextOf, userText } from './cc-support.ts';
import { makeReport } from './report-fixture.ts';
import { PROBE_METHOD_VERSION } from '../src/probe/run-probe.ts';
import { FM_CURRENCY, fmRecordKey, fmModelBase, probingAnswer, recordKeyOptions } from './fm-record-support.ts';
import type { Probing } from '@momonga/protocol';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';
import type { KnownProbeKey } from '@momonga/config';
import { FM_SERVER } from '@momonga/protocol';

const countTokensOf = (managed: { countTokens?: ManagedTarget['countTokens'] }): NonNullable<ManagedTarget['countTokens']> => {
  if (managed.countTokens === undefined) throw new Error('the fm description declares a token counter, so the managed target counts tokens');
  return managed.countTokens;
};

const BINARY = '/usr/bin/fm';
const POLL_MS = 25;
const LICENSE_NOTICE = 'YOU HAVE NOT AGREED TO THE FM TERMS';
const RECORD_KEY: KnownProbeKey = fmRecordKey('ab'.repeat(32), '25A100');
const { tokenCalibration: _calibration, ...uncalibrated } = makeReport(1, 1);
const UNCALIBRATED_REPORT: ProbeReport = uncalibrated;
const ALL_TRUE = { enum: true, anyOf: true, const: true, pattern: true, minimum: true, nested: true, additionalProperties: true };

class FakeManagedChild extends EventEmitter {
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

  completionBodies(): any[] {
    return (this.server?.requests ?? []).filter((request) => request.path === '/v1/chat/completions').map((request) => request.body);
  }

  async kill(): Promise<boolean> {
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

const pollingTimers = (clock: FakeClock): ManagedServerTimers => ({
  setTimeout: (callback, ms) => {
    if (ms === POLL_MS) setImmediate(callback);
    return undefined;
  },
  clearTimeout: () => undefined,
  now: () => clock.now(),
  monotonicMs: () => clock.monotonicMs(),
});

type Setup = {
  report?: ProbeReport;
  unprobed?: true;
  licenseExitCode?: number;
  countStdout?: string;
  countExitCode?: number;
};

const setup = async (config: Setup = {}) => {
  const dir = makeDir();
  const socketPath = path.join(dir, 'fm.sock');
  const recordDir = path.join(dir, 'probe');
  const recorded = config.unprobed === true ? undefined : (config.report ?? UNCALIBRATED_REPORT);
  if (recorded !== undefined) await saveProbeRecord(recordDir, RECORD_KEY, recorded, FM_CURRENCY, testKernelLock());
  const probeStarts: KnownProbeKey[] = [];
  const startProbe = async (key: KnownProbeKey): Promise<Probing> => {
    probeStarts.push(key);
    return probingAnswer();
  };
  const clock = createFakeClock(START_MS);
  const children: FakeManagedChild[] = [];
  const spawn = vi.fn(async (_file: string, _args: readonly string[]) => {
    const child = new FakeManagedChild(socketPath);
    children.push(child);
    return child;
  });
  const serveExec = async (_file: string, args: readonly string[]): Promise<ExecResult> =>
    args[0] === 'license' && config.licenseExitCode !== undefined
      ? { exitCode: config.licenseExitCode, stdout: '', stderr: 'The license agreement has not been accepted.' }
      : { exitCode: 0, stdout: '', stderr: '' };
  const warnings: string[] = [];
  const fmServe: ManagedServer = createManagedServer({
    inspector: testProcessInspector(), random: systemRandom, fileSystem: nodeFileSystemSync,
    launch: TEST_UNPROTECTED_LAUNCH,
    lock: testKernelLock(),
    description: FM_SERVER,
    target: 'scripted/system',
    lockPath: `${socketPath}.lock`,
    readyTimeoutMs: 400,
    readStopGraceMs: () => 30,
    binary: BINARY,
    socketPath,
    exec: serveExec,
    spawn,
    timers: pollingTimers(clock),
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
  const managed: ManagedTarget = await createManagedTarget({
    ...fmModelBase(),
    server: fmServe,
    binary: BINARY,
    exec,
    probeRecordDir: recordDir,
    ...recordKeyOptions(RECORD_KEY, startProbe),
    toolCallingSetting: config.report === undefined ? 'native' : 'auto',
  });
  if (recorded !== undefined) await managed.capabilities(TARGET);
  return { managed, spawn, socketPath, execCalls, clock, children, probeStarts };
};

const adapterFor = (managed: ManagedTarget, clock: FakeClock) => {
  const adapter = createChatCompletionsAdapter({ authSource: unauthenticatedSource, liveness: UNDICI_DEFAULT_LIVENESS, ...managed, clock });
  registerCleanup(() => adapter.close());
  return adapter;
};

describe('createManagedTarget endpoint', () => {
  it('starts fm serve on first use and reuses it afterwards', async () => {
    const { managed, spawn, socketPath } = await setup();
    expect(spawn).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([managed.resolveEndpoint(TARGET, new AbortController().signal), managed.resolveEndpoint(TARGET, new AbortController().signal)]);
    const third = await managed.resolveEndpoint(TARGET, new AbortController().signal);
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

describe('createManagedTarget probe-derived settings', () => {
  it('decides tool calling and keyword support from the probe record', async () => {
    const report: ProbeReport = {
      ...makeReport(0.5, 1),
      keywordSupport: { ...ALL_TRUE, pattern: false, anyOf: false },
      schemaDialect: { selected: 'explicit-keys', shape: 'union', tried: [{ id: 'json-schema-2020-12', result: 'refused' }, { id: 'explicit-keys', result: 'accepted' }] },
    } as ProbeReport;
    const { managed } = await setup({ report });
    expect((await managed.capabilities(TARGET)).toolCalling).toBe('constrained');
    expect(managed.keywordSupport(TARGET)).toEqual({ ...ALL_TRUE, pattern: false, anyOf: false });
    expect(await managed.capabilities(TARGET)).toEqual({ ...capabilitiesFromProbe(report, { mode: 'constrained' }), schemaDialect: 'explicit-keys', allowedTools: ['envelope'] });
  });

  it('takes the dialect id from the probe record, never from code that names fm', async () => {
    const { managed } = await setup({ report: makeReport(0.5, 1) });
    expect((await managed.capabilities(TARGET)).schemaDialect).toBe('json-schema-2020-12');
    expect(managed.schemaDialect(TARGET)).toBe('json-schema-2020-12');
  });

  it('hands the recorded construct table to the adapter', async () => {
    const constructSupport = { ref: 'accepted', typeArray: 'accepted', mixedEnum: 'refused' } as const;
    const { managed } = await setup({ report: { ...makeReport(0.5, 1), constructSupport } as ProbeReport });
    expect(managed.constructSupport(TARGET)).toEqual(constructSupport);
  });

  it('answers a target with no record 503 target_probing, with no capability, and starts the probe of its key', async () => {
    const { managed, probeStarts } = await setup({ unprobed: true });
    await expect(managed.capabilities(TARGET)).rejects.toMatchObject({ status: 503, body: { code: TARGET_PROBING } });
    expect(probeStarts).toEqual([RECORD_KEY]);
  });

  it('exposes the tool-calling mode only through capabilities', async () => {
    const { managed } = await setup({ report: makeReport(0.5, 1) });
    expect(managed).not.toHaveProperty('toolCalling');
  });

  it('declares the envelope as its only allowed_tools form, whether tool calling is probed or declared', async () => {
    const probed = await setup({ report: makeReport(0.5, 1) });
    const declared = await setup();
    expect((await probed.managed.capabilities(TARGET)).allowedTools).toEqual(['envelope']);
    expect((await declared.managed.capabilities(TARGET)).allowedTools).toEqual(['envelope']);
  });

  it('sends the envelope over the allowed subset to a constrained fm target', async () => {
    const { managed, clock, children } = await setup({ report: makeReport(0.5, 1) });
    const toolNamed = (name: string) => ({ type: 'function' as const, name, parameters: { type: 'object', properties: {}, additionalProperties: false } });
    await collect(adapterFor(managed, clock), {
      model: 'system',
      input: [userText('hi')],
      tools: [toolNamed('alpha'), toolNamed('beta'), toolNamed('gamma')],
      tool_choice: { type: 'allowed_tools', tools: [{ type: 'function', name: 'alpha' }, { type: 'function', name: 'beta' }], mode: 'required' },
    });
    const bodies = children.flatMap((child) => child.completionBodies());
    expect(bodies).toHaveLength(1);
    const validate = new Ajv2020.default({ strict: false }).compile(bodies[0].response_format.json_schema.schema as object);
    const callOf = (name: string) => ({ kind: 'tool_calls', calls: [{ name, arguments: {} }] });
    expect(validate(callOf('alpha'))).toBe(true);
    expect(validate(callOf('beta'))).toBe(true);
    expect(validate(callOf('gamma'))).toBe(false);
    expect(validate({ kind: 'final', text: 'done' })).toBe(false);
  });

  it('uses the declared native tool calling over the record, and the context window the record measured', async () => {
    const { managed } = await setup();
    expect(await managed.capabilities(TARGET)).toMatchObject({
      contextWindow: UNCALIBRATED_REPORT.contextWindow.value,
      toolCalling: 'native',
      source: 'probed',
    });
  });
});

describe('createManagedTarget token counting', () => {
  it('counts with fm count-tokens on stdin and applies the probed calibration', async () => {
    const report = { ...makeReport(1, 1), tokenCalibration: { ratio: 1.25, errorBound: 0.25 } };
    const { managed, execCalls } = await setup({ report, countStdout: '20\n' });
    const result = await countTokensOf(managed)(TARGET, { model: 'scripted/system', instructions: 'Be terse.', input: [userText('count these words')] }, new AbortController().signal);
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
    const result = await countTokensOf(managed)(TARGET, { model: 'scripted/system', input: 'count these words' }, new AbortController().signal);
    expect(result).toEqual({ input_tokens: 20, method: 'estimated', error_bound: 6, error_shape: ESTIMATED_ERROR_SHAPE });
    expect(result.error_bound).toBe(errorBoundOfShape(result.error_shape, result.input_tokens));
  });

  it('counts a request with no text as zero tokens without running fm count-tokens', async () => {
    const { managed, execCalls } = await setup({ countStdout: '20\n' });
    const result = await countTokensOf(managed)(TARGET, { model: 'scripted/system', input: [], tools: [] }, new AbortController().signal);
    expect(result.input_tokens).toBe(0);
    expect(execCalls.filter((call) => call.args[0] === 'count-tokens')).toEqual([]);
  });

  it('still runs fm count-tokens with the text of a non-empty request', async () => {
    const { managed, execCalls } = await setup({ countStdout: '20\n' });
    const result = await countTokensOf(managed)(TARGET, { model: 'scripted/system', input: [userText('hello')] }, new AbortController().signal);
    expect(result.input_tokens).toBe(20);
    expect(execCalls).toEqual([{ file: BINARY, args: ['count-tokens', '-q'], stdin: 'hello' }]);
  });

  it('counts each tool as canonical JSON on its own line between instructions and input items', async () => {
    const { managed, execCalls } = await setup({ countStdout: '20\n' });
    const tools = [
      { type: 'function' as const, name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: true },
      { type: 'function' as const, name: 'Bash', description: 'Run a command', parameters: { type: 'object', properties: {} } },
    ];
    await countTokensOf(managed)(TARGET, { model: 'scripted/system', instructions: 'Be terse.', tools, input: [userText('count these words')] }, new AbortController().signal);
    const lines = (execCalls[0]?.stdin ?? '').split('\n');
    expect(lines).toEqual([
      'Be terse.',
      '{"description":"Read a file","name":"Read","parameters":{"properties":{"path":{"type":"string"}},"type":"object"}}',
      '{"description":"Run a command","name":"Bash","parameters":{"properties":{},"type":"object"}}',
      'count these words',
    ]);
  });
});

describe('createManagedTarget token counter failure: one generic text for every exit code, with no exit code given a meaning of its own (design-managed-servers section 9, text table)', () => {
  it('rejects a counter exit 69 with the generic token counter text, not a licence precondition', async () => {
    const { managed } = await setup({ countExitCode: 69 });
    const failure = await countTokensOf(managed)(TARGET, { model: 'scripted/system', input: 'count these words' }, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).not.toBe('PreconditionFailedError');
    expect((failure as Error).message).toMatch(/^the model "fm\/system": the token counter failed with exit code 69: /);
  });

  it('answers /v1/momonga/count_tokens with 502 adapter_error carrying that text when the counter exits 69', async () => {
    const { managed, clock, execCalls } = await setup({ countExitCode: 69 });
    const { client } = await startGateway({
      adapters: { 'scripted/system': adapterFor(managed, clock) },
      config: { chains: { 'scripted/system': ['scripted/system'] }, targets: { 'scripted/system': {} } },
    });
    const response = await readJson(await postJson(client, '/v1/momonga/count_tokens', { model: 'scripted/system', input: 'count these words' }));
    expect(response.status).toBe(502);
    expect(response.body.error).toMatchObject({ code: 'adapter_error' });
    expect(response.body.error.message).toMatch(/the model "fm\/system": the token counter failed with exit code 69: /);
    expect(execCalls).toHaveLength(1);
  });

  it('classifies a precondition failure of the stream path as non-retryable precondition_failed', async () => {
    const { managed, clock } = await setup({ licenseExitCode: 69 });
    const adapter = adapterFor(managed, clock);
    const { error } = await collect(adapter, { model: 'system', input: [userText('hi')] });
    expect(adapter.classify(error)).toMatchObject({ retryable: false, error: { type: 'invalid_request', code: 'precondition_failed' } });
  });
});

describe('createManagedTarget health', () => {
  it('delegates to fm serve health', async () => {
    const { managed } = await setup();
    expect(await managed.health(TARGET)).toMatchObject({ ok: true, detail: 'idle; starts on demand' });
    await managed.resolveEndpoint(TARGET, new AbortController().signal);
    expect(await managed.health(TARGET)).toEqual({ ok: true });
  });

  it('surfaces a license precondition failure with its remediation in /v1/momonga/health', async () => {
    const { managed, clock } = await setup({ licenseExitCode: 69 });
    const adapter = adapterFor(managed, clock);
    const { client } = await startGateway({
      adapters: { 'scripted/system': adapter },
      config: { chains: { 'scripted/system': ['scripted/system'] }, targets: { 'scripted/system': {} } },
    });
    const health = await getJson(client, '/v1/momonga/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(false);
    expect(health.body.models['scripted/system']).toMatchObject({ ok: false, breaker: 'closed', reason: 'precondition_failed', remediation: 'sudo fm license' });
  });
});

describe('createManagedTarget compaction and wire counting', () => {
  it('advertises compact through the chat-completions adapter and answers through fake-fm', async () => {
    const { managed, clock } = await setup();
    const adapter = adapterFor(managed, clock);
    expect(adapter.compact).toBeTypeOf('function');
    const result = await adapter.compact?.(
      { model: 'system', input: [userText('summarise this')], momonga: { fence: TEST_FENCE, max_summary_tokens: 64 } },
      await contextOf(adapter, TARGET),
    );
    expect(result?.summary).toBe(FAKE_DETERMINISTIC_REPLY);
  });

  it('answers /v1/responses/compact for a managed fm alias', async () => {
    const { managed, clock } = await setup();
    const { client } = await startGateway({
      adapters: { 'scripted/system': adapterFor(managed, clock) },
      config: { chains: { 'scripted/system': ['scripted/system'] }, targets: { 'scripted/system': {} } },
    });
    const response = await readJson(await postJson(client, '/v1/responses/compact', { model: 'scripted/system', input: [userText('summarise this')] }));
    expect(response.status).toBe(200);
    expect(response.body.object).toBe('response.compaction');
  });

  it('feeds fm count-tokens the text parts of the wire through /v1/momonga/count_tokens', async () => {
    const { managed, clock, execCalls } = await setup({ countStdout: '20\n' });
    const { client } = await startGateway({
      adapters: { 'scripted/system': adapterFor(managed, clock) },
      config: { chains: { 'scripted/system': ['scripted/system'] }, targets: { 'scripted/system': {} } },
    });
    const tools = [{ type: 'function' as const, name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
    const response = await readJson(
      await postJson(client, '/v1/momonga/count_tokens', { model: 'scripted/system', instructions: 'Be terse.', tools, input: [userText('count these words')] }),
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
      adapters: { 'scripted/system': adapterFor(managed, clock) },
      config: { chains: { 'scripted/system': ['scripted/system'] }, targets: { 'scripted/system': {} } },
    });
    const response = await readJson(await postJson(client, '/v1/momonga/count_tokens', { model: 'scripted/system', input: [], tools: [] }));
    expect(response.status).toBe(200);
    expect(response.body.input_tokens).toBe(0);
    expect(execCalls.filter((call) => call.args[0] === 'count-tokens')).toEqual([]);
  });
});
