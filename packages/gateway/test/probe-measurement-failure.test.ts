import { describe, expect, it } from 'vitest';
import { createRedactor } from '@momonga/foundation';
import { TARGET_PROBE_FAILED } from '@momonga/protocol';
import { createAutoProbe } from '@momonga/gateway';
import type { PreconditionVerdict, ProbeSubject } from '@momonga/gateway';
import { createFakeClock, createFakeTimers, testKernelLock } from '@momonga/testkit';
import { expectStatus } from '../src/probe/probe-chat.ts';
import { START_MS, makeDir } from './gateway-helpers.ts';
import { until } from './gateway-process-helpers.ts';

type GlassKey = { target: string; pane: string };

const KEY: GlassKey = { target: 'glass', pane: 'north' };
const DECLARATION = 'declare toolCalling for the model "glass" in its settings';
const LEAKY = 'Probe step "plain answer" failed with HTTP 500: {"error":{"message":"see https://upstream.example/v1/x?token=s3cret-value for /Users/someone/models/qwen.gguf"}}';

const REMEDY = 'trim the wick of the glass lamp';

const setup = () => {
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const failures: string[] = [];
  const state: { measures: number; verdict: PreconditionVerdict } = { measures: 0, verdict: { kind: 'met' } };
  const subject: ProbeSubject<GlassKey, { clear: boolean }> = {
    target: KEY.target,
    unknown: { fields: ['toolCalling'], declaration: DECLARATION },
    readKey: async () => KEY,
    precondition: { boundMs: 50, check: async () => state.verdict },
    measure: async () => {
      state.measures += 1;
      throw new Error(LEAKY);
    },
    save: async () => undefined,
  };
  const autoProbe = createAutoProbe({ redactor: createRedactor({ credentials: [] }), lock: testKernelLock(), dir: makeDir(), clock, timers, retryAfterMs: 120_000, onEvent: (event) => failures.push(event.kind) });
  return { clock, autoProbe, subject, state, failures };
};

const failedAnswer = async (): Promise<{ answer: unknown; clock: ReturnType<typeof createFakeClock>; state: { measures: number; verdict: PreconditionVerdict }; ensure: () => Promise<unknown> }> => {
  const { autoProbe, subject, state, failures, clock } = setup();
  await autoProbe.ensure(subject, KEY);
  await until(() => failures.includes('failed'), 'the measurement failed');
  const ensure = () => autoProbe.ensure(subject, KEY).catch((error: unknown) => error);
  return { answer: await ensure(), clock, state, ensure };
};

describe('a failed measurement is one stored state', () => {
  it('is kept: the next request, however late, gets the same state and starts no measurement again', async () => {
    const { answer, clock, state, ensure } = await failedAnswer();
    expect(answer).toMatchObject({ status: 503, body: { code: TARGET_PROBE_FAILED } });

    clock.advance(10 * 60_000);
    expect(await ensure()).toMatchObject({ body: { code: TARGET_PROBE_FAILED } });
    expect(state.measures).toBe(1);
  });

  it('carries a cause with no body text, no address and no path', async () => {
    const { answer } = await failedAnswer();
    const { message } = (answer as { body: { message: string } }).body;

    expect(message).not.toContain('https://');
    expect(message).not.toContain('token=');
    expect(message).not.toContain('s3cret');
    expect(message).not.toContain('/Users/');
    expect(message).not.toContain('{');
    expect(message).toContain('HTTP 500');
  });

  it('names the way forward: the declaration and the probe command of the model', async () => {
    const { answer } = await failedAnswer();
    const { message } = (answer as { body: { message: string } }).body;

    expect(message).toContain(DECLARATION);
    expect(message).toContain('momonga gateway probe glass');
  });
});

describe('the order of the answers', () => {
  it('answers a definite refusal 412 with its remedy while a failed measurement is kept, and the kept failure once the refusal is gone', async () => {
    const { state, ensure } = await failedAnswer();
    state.verdict = { kind: 'refused', message: 'the glass lamp has no wick', detail: 'wick length 0 mm', remedy: REMEDY };

    const refusal = await ensure();
    expect(refusal).toMatchObject({ status: 412, body: { code: 'target_not_ready' } });
    expect((refusal as Error).message).toContain(REMEDY);

    state.verdict = { kind: 'met' };
    expect(await ensure()).toMatchObject({ body: { code: TARGET_PROBE_FAILED } });
    expect(state.measures).toBe(1);
  });
});

describe('a refused probe step', () => {
  it('names the step and the status, never an excerpt of the reply body', () => {
    const failure = (() => {
      try {
        expectStatus({ status: 500, text: '{"error":"https://upstream.example/?key=abc"}', headers: {} }, [200], 'plain answer');
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(String(failure)).toContain('plain answer');
    expect(String(failure)).toContain('HTTP 500');
    expect(String(failure)).not.toContain('upstream.example');
  });
});
