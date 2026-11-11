import { describe, expect, it } from 'vitest';
import { createManagedTarget, saveProbeRecord } from '@momonga/gateway';
import type { ManagedServer } from '@momonga/gateway';
import type { KnownProbeKey } from '@momonga/config';
import { FAKE_GUARDRAIL_ERROR, testKernelLock } from '@momonga/testkit';
import { makeDir } from './gateway-helpers.ts';
import { TARGET, collect, makeAdapter, startFake, userText } from './cc-support.ts';
import { makeReport } from './report-fixture.ts';
import { FM_CURRENCY, fmRecordKey, fmModelBase, primed, recordKeyOptions } from './fm-record-support.ts';

const RECORD_KEY: KnownProbeKey = fmRecordKey('cd'.repeat(32), '25A100');

const idleServe: ManagedServer = {
  restarts: 0,
  start: async () => ({ kind: 'unix', path: '/unused.sock' }),
  ensureRunning: async () => ({ kind: 'unix', path: '/unused.sock' }),
  stop: async () => undefined,
  health: async () => ({ ok: true }),
};

const managedWith = async (guardrail: unknown | undefined) => {
  const dir = makeDir();
  await saveProbeRecord(dir, RECORD_KEY, { ...makeReport(1, 1), guardrail: guardrail === undefined ? {} : { errorShape: guardrail } }, FM_CURRENCY, testKernelLock());
  return primed(createManagedTarget({
    ...fmModelBase(),
    server: idleServe,
    binary: '/usr/bin/fm',
    exec: async () => ({ exitCode: 0, stdout: '1\n', stderr: '' }),
    probeRecordDir: dir,
    ...recordKeyOptions(RECORD_KEY),
    toolCallingSetting: 'auto',
  }), 'fm');
};

const blocked = (code: string | null, type = 'invalid_request_error') => ({
  error: { message: 'blocked by policy', type, param: null, code },
});

const classifyBody = async (body: unknown, options: Parameters<typeof makeAdapter>[1]) => {
  const fake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'error', status: 400, body }] });
  const adapter = makeAdapter(fake, options);
  const { error } = await collect(adapter, { model: 'system', input: [userText('hi')] });
  return adapter.classify(error);
};

describe('guardrail detection', () => {
  it('classifies the probed guardrail error shape as guardrail_violation', async () => {
    const managed = await managedWith(blocked('safety_blocked'));
    const result = await classifyBody(blocked('safety_blocked'), { isGuardrail: managed.isGuardrail });
    expect(result.retryable).toBe(false);
    expect(result.error).toMatchObject({ type: 'model_error', code: 'guardrail_violation' });
  });

  it('does not classify other 400 errors as guardrail_violation when a probed shape exists', async () => {
    const managed = await managedWith(blocked('safety_blocked'));
    const result = await classifyBody(blocked('bad_field'), { isGuardrail: managed.isGuardrail });
    expect(result.error.type).toBe('invalid_request');
  });

  it('never matches on the error type alone when the probed shape has no code', async () => {
    const managed = await managedWith(blocked(null));
    const ordinary = await classifyBody(blocked('bad_field'), { isGuardrail: managed.isGuardrail });
    expect(ordinary.error.type).toBe('invalid_request');
    const typeOnly = await classifyBody(blocked(null), { isGuardrail: managed.isGuardrail });
    expect(typeOnly.error.type).toBe('invalid_request');
    const coded = await classifyBody(FAKE_GUARDRAIL_ERROR, { isGuardrail: managed.isGuardrail });
    expect(coded.error).toMatchObject({ type: 'model_error', code: 'guardrail_violation' });
  });

  it('matches the guardrail_violation code by default when the probe record measured no guardrail shape', async () => {
    const managed = await managedWith(undefined);
    expect(managed.isGuardrail(TARGET, 400, FAKE_GUARDRAIL_ERROR)).toBe(true);
    expect(managed.isGuardrail(TARGET, 400, blocked('safety_blocked'))).toBe(false);
    const result = await classifyBody(FAKE_GUARDRAIL_ERROR, { isGuardrail: managed.isGuardrail });
    expect(result.error).toMatchObject({ type: 'model_error', code: 'guardrail_violation' });
  });

  it('uses the isGuardrail option with the target, status and parsed body', async () => {
    const seen: unknown[] = [];
    const result = await classifyBody(blocked('anything'), {
      isGuardrail: (target, status, body) => {
        seen.push([target, status, body]);
        return true;
      },
    });
    expect(result.error.code).toBe('guardrail_violation');
    expect(seen).toEqual([[TARGET, 400, blocked('anything')]]);
  });
});

describe('connection-level classification', () => {
  const classifier = async () => makeAdapter(await startFake({ scenario: 'tools-ok' }));

  it.each(['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED', 'ECONNRESET', 'EPIPE'])(
    'treats %s as provider_unavailable',
    async (code) => {
      const result = (await classifier()).classify(Object.assign(new Error('boom'), { code }));
      expect(result).toMatchObject({ retryable: true, error: { type: 'server_error', code: 'provider_unavailable' } });
    },
  );

  it.each(['UND_ERR_ABORTED', 'UND_ERR_INVALID_ARG', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH'])('does not retry %s', async (code) => {
    const result = (await classifier()).classify(Object.assign(new Error('boom'), { code }));
    expect(result.retryable).toBe(false);
  });

  it('never classifies an abort caused by ctx.signal as retryable', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'hang' }] });
    const adapter = makeAdapter(fake);
    const controller = new AbortController();
    const pending = collect(adapter, { model: 'system', input: [userText('hi')] }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const { error } = await pending;
    expect(error).toBeDefined();
    expect(adapter.classify(error).retryable).toBe(false);
  });
});
