import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FM_VOCABULARY, createChatCompletionsAdapter, createManagedFmTarget, saveProbeRecord } from '@momonga/gateway';
import type { ChatCompletionsAdapter, ExecResult, FmServe } from '@momonga/gateway';
import type { HealthResult, ProbeReport } from '@momonga/protocol';
import { FM_CONTEXT_OVERFLOW_ERROR, FM_GUARDRAIL_ERROR, createFakeClock, startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer, FakeScriptedReply } from '@momonga/testkit';
import { START_MS, makeDir, postJson, readJson, readSse, registerCleanup, startGateway } from './gateway-helpers.ts';
import { collect, makeAdapter, userText } from './cc-support.ts';
import { makeReport } from './report-fixture.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';

const RECORD_KEY = { target: 'fm', binarySha256: 'cd'.repeat(32), osBuild: '25A100' };

const startFakeFm = async (reply: FakeScriptedReply): Promise<FakeChatCompletionsServer> => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', wire: 'fm', script: [reply] });
  registerCleanup(() => fake.close());
  return fake;
};

const fmAdapter = async (fake: FakeChatCompletionsServer, report?: ProbeReport) => {
  const endpoint = { kind: 'unix' as const, socketPath: fake.socketPath };
  const fmServe: FmServe = {
    restarts: 0,
    start: async () => endpoint,
    ensureRunning: async () => endpoint,
    stop: async () => undefined,
    health: async (): Promise<HealthResult> => ({ ok: true }),
  };
  const probeRecordDir = path.join(makeDir(), 'probe');
  if (report !== undefined) await saveProbeRecord(probeRecordDir, RECORD_KEY, report, CURRENT_DIALECTS);
  const managed = await createManagedFmTarget({
    fmServe,
    binary: '/opt/fake/fm',
    exec: async (): Promise<ExecResult> => ({ exitCode: 0, stdout: '5\n', stderr: '' }),
    probeRecordDir,
    recordKey: RECORD_KEY,
    toolCallingSetting: report === undefined ? 'native' : 'auto',
    declaredModel: 'system',
  });
  const adapter = createChatCompletionsAdapter({ ...managed, clock: createFakeClock(START_MS) });
  registerCleanup(() => adapter.close());
  return adapter;
};

const reportWithMeasuredGuardrail = (): ProbeReport => ({ ...makeReport(1, 1), guardrail: { errorShape: structuredClone(FM_GUARDRAIL_ERROR) } });

const failureThroughGateway = async (adapter: ChatCompletionsAdapter, fake: FakeChatCompletionsServer) => {
  const { client } = await startGateway({ adapters: { fm: adapter }, config: { aliases: { fast: ['fm'] }, targets: { fm: { model: 'system' } } } });
  const response = await postJson(client, '/v1/responses', { model: 'fast', stream: true, input: [userText('one two three four five six seven eight nine ten')] });
  const upstreamRequests = fake.requests.filter((request) => request.path === '/v1/chat/completions').length;
  if (response.status !== 200) {
    const error = (await readJson(response)).body.error;
    return { errorType: error?.type, errorCode: error?.code, message: error?.message, upstreamRequests };
  }
  const terminal = (await readSse(response)).at(-1)?.data;
  expect(terminal?.type).toBe('response.failed');
  const error = terminal?.response?.error;
  return { errorType: error?.type, errorCode: error?.code, message: error?.message, upstreamRequests };
};

const throughFmGateway = async (fake: FakeChatCompletionsServer, report?: ProbeReport) => failureThroughGateway(await fmAdapter(fake, report), fake);

const chatCompletionsHttpOverflow = async () => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', contextWindow: 8 });
  registerCleanup(() => fake.close());
  const adapter = makeAdapter(fake);
  registerCleanup(() => adapter.close());
  return failureThroughGateway(adapter, fake);
};

describe('fm classifies its error vocabulary the same in an error event inside a 200 stream as in an HTTP error body', () => {
  it('ends the response with the guardrail refusal for the measured guardrail error event, after exactly one upstream request', async () => {
    const fake = await startFakeFm({ kind: 'error-event', body: FM_GUARDRAIL_ERROR });

    const observed = await throughFmGateway(fake);

    expect(observed).toEqual({
      errorType: 'model_error',
      errorCode: 'guardrail_violation',
      message: FM_GUARDRAIL_ERROR.error.message,
      upstreamRequests: 1,
    });
  });

  it('ends the response with the guardrail refusal for the measured guardrail error event when the probe recorded that guardrail shape', async () => {
    const fake = await startFakeFm({ kind: 'error-event', body: FM_GUARDRAIL_ERROR });

    const observed = await throughFmGateway(fake, reportWithMeasuredGuardrail());

    expect(observed).toMatchObject({ errorType: 'model_error', errorCode: 'guardrail_violation', upstreamRequests: 1 });
  });

  it('ends the response for the measured overflow error event with the failure a chat-completions HTTP overflow rejection gets', async () => {
    const reference = await chatCompletionsHttpOverflow();
    const fake = await startFakeFm({ kind: 'error-event', body: FM_CONTEXT_OVERFLOW_ERROR });

    const observed = await throughFmGateway(fake);

    expect(reference).toMatchObject({ errorType: 'invalid_request', errorCode: 'context_window_exceeded', upstreamRequests: 1 });
    expect({ ...observed, message: undefined }).toEqual({ ...reference, message: undefined });
  });

  it('keeps the measured overflow error event an overflow, not a guardrail refusal, when the probe recorded the guardrail shape that shares its code 500', async () => {
    const fake = await startFakeFm({ kind: 'error-event', body: FM_CONTEXT_OVERFLOW_ERROR });

    const observed = await throughFmGateway(fake, reportWithMeasuredGuardrail());

    expect(observed).toEqual({
      errorType: 'invalid_request',
      errorCode: 'context_window_exceeded',
      message: FM_CONTEXT_OVERFLOW_ERROR.error.message,
      upstreamRequests: 1,
    });
  });
});

const OTHER_SERVER_ERROR = { error: { code: '500', type: 'server_error', message: 'the model service restarted' } };

const reportRecordingCode500Guardrail = (): ProbeReport => ({
  ...makeReport(1, 1),
  guardrail: { errorShape: { error: { code: '500', type: 'server_error', message: 'a guardrail message recorded from another build' } } },
});

describe('a recorded guardrail shape with a generic code never matches by its code alone', () => {
  const request = { model: 'system', input: [userText('one two three four five six seven eight nine ten')] };

  it('keeps a 500 error body with a different message a retryable server_error', async () => {
    const fake = await startFakeFm({ kind: 'error', status: 500, body: OTHER_SERVER_ERROR });
    const adapter = await fmAdapter(fake, reportRecordingCode500Guardrail());

    const { error } = await collect(adapter, request);

    expect(adapter.classify(error)).toMatchObject({ retryable: true, error: { type: 'server_error' } });
  });

  it('keeps a 500 error event with a different message a server_error failure', async () => {
    const fake = await startFakeFm({ kind: 'error-event', body: OTHER_SERVER_ERROR });
    const adapter = await fmAdapter(fake, reportRecordingCode500Guardrail());

    const { events, error } = await collect(adapter, request);

    expect(error).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'response.failed', response: { error: { type: 'server_error', code: '500' } } });
  });

  it('matches the recorded guardrail when code and message both agree', async () => {
    const fake = await startFakeFm({ kind: 'error', status: 500, body: reportRecordingCode500Guardrail().guardrail.errorShape });
    const adapter = await fmAdapter(fake, reportRecordingCode500Guardrail());

    const { error } = await collect(adapter, request);

    expect(adapter.classify(error)).toMatchObject({ retryable: false, error: { type: 'model_error', code: 'guardrail_violation' } });
  });
});

describe('fm has no status rule that makes a 413 an overflow', () => {
  it('reads a 413 without the overflow message as payload_too_large', () => {
    expect(FM_VOCABULARY.kindOf(413, { error: { message: 'x' } })).toBe('payload_too_large');
  });
});
