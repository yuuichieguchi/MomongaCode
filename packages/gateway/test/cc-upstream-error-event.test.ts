import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createChatCompletionsAdapter, createManagedTarget, saveProbeRecord, unauthenticatedSource } from '@momonga/gateway';
import type { ExecResult, ManagedServer } from '@momonga/gateway';
import type { HealthResult } from '@momonga/protocol';
import { FM_CONTEXT_OVERFLOW_ERROR, FM_UNSUPPORTED_GUIDE_ERROR, createFakeClock, startFakeSseUpstream } from '@momonga/testkit';
import type { FakeUpstreamServer } from '@momonga/testkit';
import { START_MS, makeDir, postJson, readSse, registerCleanup, startGateway } from './gateway-helpers.ts';
import { CC_CAPABILITIES, collect, terminalOf, userText } from './cc-support.ts';
import { FM_CURRENCY, fmRecordKey, fmTargetBase, primed, recordKeyOptions } from './fm-record-support.ts';
import { makeReport } from './report-fixture.ts';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';
import type { KnownProbeKey } from '@momonga/config';

const FM_ROLE_CHUNK = {
  id: 'chatcmpl-fm',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'system',
  choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
};

const GENERIC_SERVER_ERROR = {
  error: { type: 'server_error', code: '500', message: 'The model crashed while generating the reply.' },
};

const NOT_THE_ERROR_ITSELF = ['context_window_exceeded', 'upstream_protocol_error', 'empty_upstream_stream', 'malformed_output'];

const startFmStyleUpstream = async (errorBody: unknown): Promise<FakeUpstreamServer> => {
  const upstream = await startFakeSseUpstream({
    path: '/v1/chat/completions',
    respond: () => ({ kind: 'stream', frames: [{ data: FM_ROLE_CHUNK }, { event: 'error', data: errorBody }] }),
  });
  registerCleanup(() => upstream.close());
  return upstream;
};

const unprobedFmAdapter = async (upstream: FakeUpstreamServer) => {
  const endpoint = { kind: 'unix' as const, path: upstream.socketPath };
  const fmServe: ManagedServer = {
    restarts: 0,
    start: async () => endpoint,
    ensureRunning: async () => endpoint,
    stop: async () => undefined,
    health: async (): Promise<HealthResult> => ({ ok: true }),
  };
  const countTokens = async (): Promise<ExecResult> => ({ exitCode: 0, stdout: '5\n', stderr: '' });
  const probeRecordDir = path.join(makeDir(), 'probe');
  const key: KnownProbeKey = fmRecordKey('ab'.repeat(32), '25A100');
  await saveProbeRecord(probeRecordDir, key, makeReport(1, 1), FM_CURRENCY);
  const managed = await primed(
    createManagedTarget({
      ...fmTargetBase(),
      server: fmServe,
      binary: '/opt/fake/fm',
      exec: countTokens,
      probeRecordDir,
      ...recordKeyOptions(key),
      toolCallingSetting: 'native',
      declaredModel: 'system',
    }),
    'fm',
  );
  const adapter = createChatCompletionsAdapter({ authSource: unauthenticatedSource, liveness: UNDICI_DEFAULT_LIVENESS, ...managed, clock: createFakeClock(START_MS) });
  registerCleanup(() => adapter.close());
  return adapter;
};

const genericAdapter = (upstream: FakeUpstreamServer) => {
  const adapter = createChatCompletionsAdapter({ authSource: unauthenticatedSource, liveness: UNDICI_DEFAULT_LIVENESS, schemaDialect: () => 'json-schema-2020-12',
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: upstream.socketPath }),
    capabilities: async () => CC_CAPABILITIES,
    clock: createFakeClock(START_MS),
  });
  registerCleanup(() => adapter.close());
  return adapter;
};

const classifiedFailure = async (adapter: ReturnType<typeof genericAdapter>) => {
  const { events, error } = await collect(adapter, { model: 'system', input: [userText('hello')] });
  return { error: error === undefined ? terminalOf(events).response.error : adapter.classify(error).error };
};

describe('an upstream error event inside a 200 chat-completions stream', () => {
  it('surfaces fm reporting an unsupported generation guide as the invalid_request that a generic upstream 400 rejection takes', async () => {
    const upstream = await startFmStyleUpstream(FM_UNSUPPORTED_GUIDE_ERROR);
    const adapter = await unprobedFmAdapter(upstream);

    const { error: failure } = await classifiedFailure(adapter);

    expect(failure.type).toBe('invalid_request');
    expect(failure.message).toContain(FM_UNSUPPORTED_GUIDE_ERROR.error.message);
    expect(NOT_THE_ERROR_ITSELF).not.toContain(failure.code);
  });

  it('leaves fm\'s unsupported generation guide wording to fm: a generic chat-completions target surfaces it as the server error it reports', async () => {
    const upstream = await startFmStyleUpstream(FM_UNSUPPORTED_GUIDE_ERROR);
    const adapter = genericAdapter(upstream);

    const { error: failure } = await classifiedFailure(adapter);

    expect(failure.type).toBe('server_error');
    expect(failure.message).toContain(FM_UNSUPPORTED_GUIDE_ERROR.error.message);
    expect(NOT_THE_ERROR_ITSELF).not.toContain(failure.code);
  });

  it('surfaces fm reporting a transcript over its context size as a context_window_exceeded failure, the shape the Anthropic overflow takes', async () => {
    const upstream = await startFmStyleUpstream(FM_CONTEXT_OVERFLOW_ERROR);
    const adapter = await unprobedFmAdapter(upstream);
    const { client } = await startGateway({ adapters: { fm: adapter }, config: { aliases: { fast: ['fm'] }, targets: { fm: { model: 'system' } } } });

    const frames = await readSse(await postJson(client, '/v1/responses', { model: 'fast', stream: true, input: [userText('hello')] }));

    const terminal = frames.at(-1)?.data;
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ code: 'context_window_exceeded', type: 'invalid_request' });
    expect(upstream.requests.filter((request) => request.path === '/v1/chat/completions')).toHaveLength(1);
  });

  it('surfaces any other error event as the upstream server error it reports, not as an overflow nor as a malformed or empty stream', async () => {
    const upstream = await startFmStyleUpstream(GENERIC_SERVER_ERROR);
    const adapter = await unprobedFmAdapter(upstream);

    const { events, error } = await collect(adapter, { model: 'system', input: [userText('hello')] });

    const failure = error === undefined ? terminalOf(events).response.error : adapter.classify(error).error;
    expect(failure.type).toBe('server_error');
    expect(failure.message).toContain(GENERIC_SERVER_ERROR.error.message);
    expect(NOT_THE_ERROR_ITSELF).not.toContain(failure.code);
  });
});
