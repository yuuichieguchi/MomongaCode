import { describe, expect, it } from 'vitest';
import { classifierIdentityOf, probeKeyOf } from '@momonga/config';
import type { KnownProbeKey, ResolvedModelTarget } from '@momonga/config';
import { FM_SERVER } from '@momonga/protocol';

type IdentityOf = (target: ResolvedModelTarget, probeKey: KnownProbeKey | undefined) => string;

const identityOf = classifierIdentityOf as unknown as IdentityOf;

const known = (input: Parameters<typeof probeKeyOf>[0]): KnownProbeKey => {
  const key = probeKeyOf(input);
  if (key.kind !== 'known') throw new Error('the test builds keys from read components');
  return key;
};

const managed: ResolvedModelTarget = { adapter: 'managed', server: 'fm', binary: '/usr/bin/fm', readyTimeoutMs: 10_000, toolCalling: 'auto', billing: 'local', maxConcurrency: 1, admissionTimeoutMs: 30_000 } as ResolvedModelTarget;

const fmKey = (binarySha256: string, model?: string): KnownProbeKey =>
  known({ subject: FM_SERVER.id, identity: FM_SERVER.identity, readings: { binarySha256: { kind: 'read', value: binarySha256 }, hostOsBuild: { kind: 'read', value: '25A354' } }, model });

describe('the classifier identity is the probe key (design-managed-servers section 18, item 6; F-5)', () => {
  it('is the canonical probe key of a managed target, not its adapter, server, binary path and model', () => {
    const key = fmKey('a'.repeat(64));
    expect(identityOf(managed, key)).toBe(key.canonical);
  });

  it('changes with the binary hash, which the old managed|server|binary|model identity never saw', () => {
    expect(identityOf(managed, fmKey('a'.repeat(64)))).not.toBe(identityOf(managed, fmKey('b'.repeat(64))));
  });

  it('is the canonical endpoint probe key of an endpoint target', () => {
    const target = { adapter: 'chat-completions', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', toolCalling: 'auto', billing: 'metered', maxConcurrency: 4, admissionTimeoutMs: 30_000, capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } } as unknown as ResolvedModelTarget;
    expect(identityOf(target, undefined)).toBe(known({ subject: 'endpoint', endpoint: 'https://upstream.invalid/v1', model: 'm' }).canonical);
  });
});
