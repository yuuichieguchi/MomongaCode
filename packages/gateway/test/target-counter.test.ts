import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { targetCounterOf } from '@momonga/gateway';
import * as targetCounterModule from '../src/target-counter.ts';
import { makeDir } from './gateway-helpers.ts';
import { fmRecordKey } from './fm-record-support.ts';

const CAPABILITIES = { contextWindow: 8192, maxOutputTokens: 1024 };
const CODE_DIGEST = 'a'.repeat(64);
const OTHER_CODE_DIGEST = 'b'.repeat(64);
const HOSTED = { adapter: 'chat-completions', model: 'm', baseUrl: 'https://api.example.com/v1', provider: 'acme', toolCalling: 'native', capabilities: CAPABILITIES };

const resolvedTarget = async (target: Record<string, unknown>) => {
  const home = makeDir();
  fs.mkdirSync(path.join(home, '.momonga'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.momonga', 'settings.json'), JSON.stringify({ models: { targets: { only: target }, aliases: { default: 'only' } } }), { mode: 0o600 });
  const { settings } = await loadUserSettings({ home });
  const resolved = settings.models.targets['only'];
  if (resolved === undefined) throw new Error('the settings resolved no target');
  return resolved;
};

describe('targetCounterOf', () => {
  it('is a sha256 in lowercase hex, the same for the same inputs', async () => {
    const target = await resolvedTarget(HOSTED);
    const again = await resolvedTarget({ ...HOSTED });
    const counter = targetCounterOf({ target, codeDigest: CODE_DIGEST });
    expect(counter).toMatch(/^[0-9a-f]{64}$/);
    expect(targetCounterOf({ target: again, codeDigest: CODE_DIGEST })).toBe(counter);
  });

  it.each([
    ['the upstream model', { model: 'm2' }],
    ['the endpoint', { baseUrl: 'https://api.example.org/v1' }],
    ['the provider', { provider: 'other' }],
    ['the capability override', { capabilities: { ...CAPABILITIES, tokenErrorRatio: 0.25 } }],
    ['maxConcurrency, which does not change counting', { maxConcurrency: 7 }],
    ['admissionTimeoutMs, which does not change counting', { admissionTimeoutMs: 1234 }],
    ['billing, which does not change counting', { billing: 'local' }],
    ['the name of the key variable, which does not change counting', { apiKeyEnv: 'ANOTHER_KEY' }],
  ])('changes when %s of the resolved definition changes', async (_label, change) => {
    const original = await resolvedTarget({ ...HOSTED, apiKeyEnv: 'HOSTED_KEY' });
    const changed = await resolvedTarget({ ...HOSTED, apiKeyEnv: 'HOSTED_KEY', ...change });
    expect(changed).not.toEqual(original);
    expect(targetCounterOf({ target: changed, codeDigest: CODE_DIGEST })).not.toBe(targetCounterOf({ target: original, codeDigest: CODE_DIGEST }));
  });

  it('changes when the adapter kind changes', async () => {
    const { toolCalling: _toolCalling, ...withoutToolCalling } = HOSTED;
    const chatTarget = await resolvedTarget(HOSTED);
    const responsesTarget = await resolvedTarget({ ...withoutToolCalling, adapter: 'open-responses' });
    expect(responsesTarget.adapter).toBe('open-responses');
    expect(targetCounterOf({ target: responsesTarget, codeDigest: CODE_DIGEST })).not.toBe(targetCounterOf({ target: chatTarget, codeDigest: CODE_DIGEST }));
  });

  it('changes when the code digest of the running gateway changes', async () => {
    const target = await resolvedTarget(HOSTED);
    expect(targetCounterOf({ target, codeDigest: OTHER_CODE_DIGEST })).not.toBe(targetCounterOf({ target, codeDigest: CODE_DIGEST }));
  });

  it('changes for a managed target when its probe key changes (the binary sha256, the OS build or the declared model)', async () => {
    const target = await resolvedTarget({ adapter: 'managed', server: 'fm' });
    expect(target.adapter).toBe('managed');
    const keyOf = (binarySha256: string, osBuild: string, model?: string) => fmRecordKey(binarySha256, osBuild, model).canonical;
    const base = targetCounterOf({ target, codeDigest: CODE_DIGEST, probeKey: keyOf('1'.repeat(64), '25A354') });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(targetCounterOf({ target, codeDigest: CODE_DIGEST, probeKey: keyOf('1'.repeat(64), '25A354') })).toBe(base);
    expect(targetCounterOf({ target, codeDigest: CODE_DIGEST, probeKey: keyOf('2'.repeat(64), '25A354') })).not.toBe(base);
    expect(targetCounterOf({ target, codeDigest: CODE_DIGEST, probeKey: keyOf('1'.repeat(64), '25A355') })).not.toBe(base);
    expect(targetCounterOf({ target, codeDigest: CODE_DIGEST, probeKey: keyOf('1'.repeat(64), '25A354', 'system') })).not.toBe(base);
  });

  it('changes for a probed endpoint target when its probe record names another upstream identity', async () => {
    const target = await resolvedTarget({ ...HOSTED, toolCalling: 'auto' });
    const first = targetCounterOf({ target, codeDigest: CODE_DIGEST, upstreamIdentity: 'identity-one' });
    expect(targetCounterOf({ target, codeDigest: CODE_DIGEST, upstreamIdentity: 'identity-one' })).toBe(first);
    expect(targetCounterOf({ target, codeDigest: CODE_DIGEST, upstreamIdentity: 'identity-two' })).not.toBe(first);
    expect(targetCounterOf({ target, codeDigest: CODE_DIGEST })).not.toBe(first);
  });
});

type ServedInput = { profile: string; account: string | null };
type ReportedInput = { contextWindow: number; maxOutputTokens: number } | null;
type OutputPolicyInput = { unboundedOutputReserve: boolean };
type CounterInput = Parameters<typeof targetCounterOf>[0] & { served?: ServedInput; reported?: ReportedInput; outputPolicy?: OutputPolicyInput };

const counterOf = (input: CounterInput): string => targetCounterOf(input as Parameters<typeof targetCounterOf>[0]);

const readsOutputPolicyOf = (target: unknown): boolean => {
  const value = (targetCounterModule as Record<string, unknown>)['readsOutputPolicy'];
  if (typeof value !== 'function') throw new Error('gateway/src/target-counter.ts does not export readsOutputPolicy (design-chatgpt-plan O-R5-6 L3)');
  return (value as (target: unknown) => boolean)(target);
};

const PLAN_TARGET = { adapter: 'open-responses', model: 'plan-model', capabilities: CAPABILITIES, plan: { profile: 'chatgpt', account: 'work' } };
const OLLAMA = { adapter: 'ollama', model: 'qwen', baseUrl: 'http://127.0.0.1:11434', capabilities: CAPABILITIES };

describe('O-R5-6 L3: counter inputs', () => {
  it('served, reported and outputPolicy each change the counter; equal inputs give equal counters', async () => {
    const target = await resolvedTarget(PLAN_TARGET);
    const served: ServedInput = { profile: 'chatgpt', account: 'work' };
    const reported: ReportedInput = { contextWindow: 200000, maxOutputTokens: 32000 };
    const base = counterOf({ target, codeDigest: CODE_DIGEST, served, reported });
    expect(counterOf({ target, codeDigest: CODE_DIGEST, served: { profile: 'chatgpt', account: 'work' }, reported: { contextWindow: 200000, maxOutputTokens: 32000 } })).toBe(base);
    expect(counterOf({ target, codeDigest: CODE_DIGEST, served: { profile: 'chatgpt', account: 'spare' }, reported })).not.toBe(base);
    expect(counterOf({ target, codeDigest: CODE_DIGEST, served: { profile: 'chatgpt', account: null }, reported })).not.toBe(base);
    expect(counterOf({ target, codeDigest: CODE_DIGEST, served, reported: { contextWindow: 100000, maxOutputTokens: 32000 } })).not.toBe(base);
    expect(counterOf({ target, codeDigest: CODE_DIGEST, served, reported: { contextWindow: 200000, maxOutputTokens: 16000 } })).not.toBe(base);
    expect(counterOf({ target, codeDigest: CODE_DIGEST, served, reported: null })).not.toBe(base);
    const probed = await resolvedTarget({ ...HOSTED, toolCalling: 'auto' });
    expect(counterOf({ target: probed, codeDigest: CODE_DIGEST, outputPolicy: { unboundedOutputReserve: true } })).not.toBe(counterOf({ target: probed, codeDigest: CODE_DIGEST, outputPolicy: { unboundedOutputReserve: false } }));
    expect(counterOf({ target: probed, codeDigest: CODE_DIGEST, outputPolicy: { unboundedOutputReserve: true } })).toBe(counterOf({ target: probed, codeDigest: CODE_DIGEST, outputPolicy: { unboundedOutputReserve: true } }));
  });

  it('outputPolicy changes only the three kinds that read it: managed, ollama and chat-completions with toolCalling auto', async () => {
    const managed = await resolvedTarget({ adapter: 'managed', server: 'fm' });
    const ollama = await resolvedTarget(OLLAMA);
    const probed = await resolvedTarget({ ...HOSTED, toolCalling: 'auto' });
    const native = await resolvedTarget(HOSTED);
    const { toolCalling: _toolCalling, ...withoutToolCalling } = HOSTED;
    const responses = await resolvedTarget({ ...withoutToolCalling, adapter: 'open-responses' });
    const plan = await resolvedTarget(PLAN_TARGET);
    const differs = (target: CounterInput['target']): boolean =>
      counterOf({ target, codeDigest: CODE_DIGEST, outputPolicy: { unboundedOutputReserve: true } }) !== counterOf({ target, codeDigest: CODE_DIGEST, outputPolicy: { unboundedOutputReserve: false } });
    expect([managed, ollama, probed].map(readsOutputPolicyOf)).toEqual([true, true, true]);
    expect([native, responses, plan].map(readsOutputPolicyOf)).toEqual([false, false, false]);
    expect([managed, ollama, probed].map(differs)).toEqual([true, true, true]);
    expect([native, responses, plan].map(differs)).toEqual([false, false, false]);
  });
});
