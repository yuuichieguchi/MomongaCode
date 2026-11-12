import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelKey } from '../packages/runtime/src/model-key.ts';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { TEST_FENCE } from '@momonga/testkit';

const root = path.resolve(import.meta.dirname, '..');
const specs = path.join(root, 'specs', 'tla');
const spec = fs.readFileSync(path.join(specs, 'ModelResend.tla'), 'utf8');

const lineOf = (file: string, line: number): string => (fs.readFileSync(path.join(root, file), 'utf8').split('\n')[line - 1] ?? '');

const constantIn = (config: string, name: string): string => {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(\\S+)`, 'm').exec(fs.readFileSync(path.join(specs, config), 'utf8'));
  if (match === null) throw new Error(`${name} is not set in ${config}`);
  return match[1] as string;
};

const IDS = { runId: 'run-1', sessionId: 'sess-1' };

const foldAll = (payloads: readonly RunEventPayload[]): RunState =>
  payloads.reduce<RunState>((state, payload, index) => {
    const step = 'step' in payload && typeof payload.step === 'number' ? payload.step : 0;
    return foldRunState(state, { ...payload, id: index + 1, ...IDS, seq: index + 1, step, leaseToken: 1, createdAt: 0 } as RunEvent);
  }, initialRunState({ ...IDS, fence: TEST_FENCE }));

const requested = (attempt: number): RunEventPayload => ({ type: 'model.requested', step: 1, attempt, digest: 'd', body: { model: 'fm', input: [], stream: true } });

const rejected = (attempt: number): RunEventPayload => ({ type: 'model.rejected', step: 1, attempt, reason: 'counter_mismatch', counter: 'b'.repeat(64), meterCounter: 'a'.repeat(64) });

const charge = (totalTokens: number): RunEventPayload => ({
  type: 'usage.charged',
  purpose: 'rejected_answer',
  inputTokens: totalTokens,
  outputTokens: 0,
  totalTokens,
  responseId: 'resp_rejected',
  cachedInputTokens: 0,
});

describe('ModelResend.tla matches the code', () => {
  const CITATIONS: readonly (readonly [string, number, string])[] = [
    ['packages/runtime/src/worker/model-step.ts', 327, 'modelKey(ctx.run.id, position.step, position.attempt)'],
    ['packages/runtime/src/worker/model-step.ts', 346, 'export const resumeInFlight'],
    ['packages/runtime/src/worker/model-step.ts', 350, 'attempt: inFlight.attempt'],
    ['packages/runtime/src/worker/model-step.ts', 177, 'const reject = '],
    ['packages/store/src/fold.ts', 454, "case 'model.requested'"],
    ['packages/store/src/fold.ts', 477, "case 'model.rejected'"],
    ['packages/store/src/fold.ts', 480, 'attempt: event.attempt + 1'],
    ['packages/gateway/src/core/idempotency.ts', 44, "kind: 'inflight'"],
    ['packages/gateway/src/core/idempotency.ts', 54, "kind: 'stored'"],
    ['packages/gateway/src/core/store-database.ts', 225, 'statements.putIdempotency.run(key, digest'],
    ['packages/gateway/src/core/idempotency.ts', 43, 'throw idempotencyInProgressError(key)'],
    ['packages/gateway/src/core/run.ts', 228, 'joinable: () => retained'],
  ];

  it('cites code lines that still hold the code it names, each cited in the spec header, and no retired symbol', () => {
    for (const [file, line, text] of CITATIONS) {
      expect(lineOf(file, line), `${file}:${line}`).toContain(text);
      const cited = spec.split('\n').filter((entry) => entry.includes(`${file}:`));
      expect(cited.some((entry) => new RegExp(`[:,\\-]:?${line}\\b`).test(entry.slice(entry.indexOf(file)))), `${file}:${line} is cited in the spec`).toBe(true);
    }
    expect(spec).not.toContain('MODEL_ATTEMPT');
  });

  it('AttemptOnReject is TRUE where the code raises the attempt on a rejection, and FALSE only in the evidence configuration', () => {
    expect(constantIn('ModelResend.cfg', 'AttemptOnReject')).toBe('TRUE');
    expect(constantIn('ModelResend.attemptLimit.cfg', 'AttemptOnReject')).toBe('TRUE');
    expect(constantIn('ModelResend.fixedAttempt.cfg', 'AttemptOnReject')).toBe('FALSE');
    expect(foldAll([requested(1), rejected(1)]).inFlightModelRequest?.attempt).toBe(2);
  });

  it('RecordReject: the recorded attempt is att + 1 after each rejection of the attempt in flight, and a rejection of another attempt changes nothing', () => {
    expect(foldAll([requested(1), rejected(1), rejected(2)]).inFlightModelRequest?.attempt).toBe(3);
    expect(foldAll([requested(2), rejected(1)]).inFlightModelRequest?.attempt).toBe(2);
  });

  it('Send: the key is a function of run, step and attempt, so a resend of the same attempt joins or replays and the next attempt is a new call', () => {
    expect(modelKey('run-1', 1, 1)).toBe(modelKey('run-1', 1, 1));
    expect(modelKey('run-1', 1, 2)).not.toBe(modelKey('run-1', 1, 1));
    expect(modelKey('run-1', 2, 1)).not.toBe(modelKey('run-1', 1, 1));
    expect(modelKey('run-2', 1, 1)).not.toBe(modelKey('run-1', 1, 1));
  });

  it('ChargedOncePerAttempt: a rejection spends through its usage.charged once and the fold adds nothing for model.rejected itself', () => {
    expect(foldAll([requested(1), rejected(1)]).usage.totalTokens).toBe(0);
    expect(foldAll([requested(1), rejected(1), charge(307)]).usage.totalTokens).toBe(307);
  });

  it('names the invariants and transitions that the configurations check', () => {
    for (const name of ['OneUpstreamCallPerAttempt', 'RejectedNeverRedelivered', 'AcceptedMatchesCounter', 'ChargedOncePerAttempt']) {
      expect(spec).toMatch(new RegExp(`^${name} ==`, 'm'));
      expect(fs.readFileSync(path.join(specs, 'ModelResend.cfg'), 'utf8')).toContain(name);
    }
    for (const action of ['Claim', 'Record', 'Send', 'Finish', 'Deliver', 'Decide', 'RecordAccept', 'RecordReject']) {
      expect(spec).toMatch(new RegExp(`^${action} ==`, 'm'));
    }
  });
});

describe('SettingsHealth.tla cites code lines that hold what it names', () => {
  const header = fs.readFileSync(path.join(specs, 'SettingsHealth.tla'), 'utf8').split('\nEXTENDS')[0] ?? '';

  const CITATIONS: readonly (readonly [string, number, string, string])[] = [['packages/runtime/src/service/app.ts', 350, 'const sessionSettingsOf = ', 'app.ts:350']];

  it.each(CITATIONS)('%s:%i holds %s and the header cites it as %s', (file, line, text, cited) => {
    expect(lineOf(file, line), `${file}:${line}`).toContain(text);
    expect(header).toContain(cited);
  });
});
