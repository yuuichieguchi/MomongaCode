import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { targetCounterOf } from '@momonga/gateway';
import { makeDir } from './gateway-helpers.ts';

const CAPABILITIES = { contextWindow: 8192, maxOutputTokens: 1024 };
const CODE_DIGEST = 'a'.repeat(64);
const OTHER_CODE_DIGEST = 'b'.repeat(64);
const FM = { binarySha256: '1'.repeat(64), osBuild: '25A354' };
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

  it('changes for an fm target when the binary sha256 or the OS build changes', async () => {
    const target = await resolvedTarget({ adapter: 'managed', server: 'fm' });
    expect(target.adapter).toBe('fm');
    const base = targetCounterOf({ target, codeDigest: CODE_DIGEST, fm: FM });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(targetCounterOf({ target, codeDigest: CODE_DIGEST, fm: { ...FM } })).toBe(base);
    expect(targetCounterOf({ target, codeDigest: CODE_DIGEST, fm: { ...FM, binarySha256: '2'.repeat(64) } })).not.toBe(base);
    expect(targetCounterOf({ target, codeDigest: CODE_DIGEST, fm: { ...FM, osBuild: '25A355' } })).not.toBe(base);
  });

  it('changes for a probed endpoint target when its probe record names another upstream identity', async () => {
    const target = await resolvedTarget({ ...HOSTED, toolCalling: 'auto' });
    const first = targetCounterOf({ target, codeDigest: CODE_DIGEST, upstreamIdentity: 'identity-one' });
    expect(targetCounterOf({ target, codeDigest: CODE_DIGEST, upstreamIdentity: 'identity-one' })).toBe(first);
    expect(targetCounterOf({ target, codeDigest: CODE_DIGEST, upstreamIdentity: 'identity-two' })).not.toBe(first);
    expect(targetCounterOf({ target, codeDigest: CODE_DIGEST })).not.toBe(first);
  });
});
