import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import { FAKE_SERVER } from '@momonga/testkit';

type Reading = { kind: 'read'; value: string } | { kind: 'unreadable'; reason: string };
type ManagedKeyInput = { subject: string; identity: readonly string[]; readings: Record<string, Reading>; model: string | undefined };
type EndpointKeyInput = { subject: 'endpoint'; endpoint: string; model: string };
type KeyOutcome = { kind: 'known'; canonical: string; digest: string } | { kind: 'unknown'; component: string; reason: string };

const exportOf = <T>(name: string): T => {
  const value = (config as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`@momonga/config does not export ${name}`);
  return value as T;
};

const probeKeyOf = (input: ManagedKeyInput | EndpointKeyInput): KeyOutcome => exportOf<(input: ManagedKeyInput | EndpointKeyInput) => KeyOutcome>('probeKeyOf')(input);
const managedServerDigest = (description: unknown): string => exportOf<(description: unknown) => string>('managedServerDigest')(description);

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const BUILD = '25A354';
const FM_IDENTITY = ['binarySha256', 'hostOsBuild'] as const;

const read = (value: string): Reading => ({ kind: 'read', value });

const fmKey = (overrides: Partial<ManagedKeyInput> = {}): KeyOutcome =>
  probeKeyOf({ subject: 'fm', identity: FM_IDENTITY, readings: { binarySha256: read(HASH), hostOsBuild: read(BUILD) }, model: undefined, ...overrides });

const sha16 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

describe('the one probe key rule (design-managed-servers section 6.1, item 10 of section 17)', () => {
  it('is the canonical JSON of the subject, each identity component and the declared model, with null for no model', () => {
    const canonical = `{"binarySha256":"${HASH}","hostOsBuild":"${BUILD}","model":null,"subject":"fm"}`;
    expect(fmKey()).toEqual({ kind: 'known', canonical, digest: sha16(canonical) });
  });

  it('carries the declared model', () => {
    const canonical = `{"binarySha256":"${HASH}","hostOsBuild":"${BUILD}","model":"system","subject":"fm"}`;
    expect(fmKey({ model: 'system' })).toEqual({ kind: 'known', canonical, digest: sha16(canonical) });
  });

  it('takes only the components the description lists, so a server keyed by its binary alone ignores a host reading', () => {
    const canonical = `{"binarySha256":"${HASH}","model":null,"subject":"fake"}`;
    expect(probeKeyOf({ subject: 'fake', identity: ['binarySha256'], readings: { binarySha256: read(HASH), hostOsBuild: read(BUILD) }, model: undefined })).toEqual({ kind: 'known', canonical, digest: sha16(canonical) });
  });

  it('keeps the endpoint key shape: endpoint and model', () => {
    const canonical = '{"endpoint":"http://127.0.0.1:1234/v1","model":"qwen","subject":"endpoint"}';
    expect(probeKeyOf({ subject: 'endpoint', endpoint: 'http://127.0.0.1:1234/v1', model: 'qwen' })).toEqual({ kind: 'known', canonical, digest: sha16(canonical) });
  });

  it('changes when a component or the declared model changes, and only then', () => {
    const base = fmKey();
    expect(fmKey()).toEqual(base);
    expect(fmKey({ readings: { binarySha256: read(OTHER_HASH), hostOsBuild: read(BUILD) } })).not.toEqual(base);
    expect(fmKey({ readings: { binarySha256: read(HASH), hostOsBuild: read('25B78') } })).not.toEqual(base);
    expect(fmKey({ model: 'system' })).not.toEqual(fmKey({ model: 'other' }));
    expect(fmKey({ model: 'system' })).not.toEqual(base);
  });

  it('is unknown, naming the component and its reason, when a listed component cannot be read; no key text is produced', () => {
    expect(fmKey({ readings: { binarySha256: read(HASH), hostOsBuild: { kind: 'unreadable', reason: 'sw_vers is not on PATH' } } })).toEqual({ kind: 'unknown', component: 'hostOsBuild', reason: 'sw_vers is not on PATH' });
  });

  it('is unknown when a listed component has no reading at all', () => {
    expect(probeKeyOf({ subject: 'fm', identity: FM_IDENTITY, readings: { binarySha256: read(HASH) }, model: undefined })).toMatchObject({ kind: 'unknown', component: 'hostOsBuild' });
  });
});

describe('the description digest, the currency stamp of a probe record (design section 6.1)', () => {
  const withPreconditionText = (message: string, remedy: string): unknown => ({
    ...FAKE_SERVER,
    preconditions: FAKE_SERVER.preconditions.map((precondition) => ({
      ...precondition,
      rules: precondition.rules.map((rule) => (rule.verdict === 'refused' && 'remedy' in rule ? { ...rule, message, remedy } : rule)),
    })),
  });

  it('is a SHA-256 hex digest and the same for the same description', () => {
    expect(managedServerDigest(FAKE_SERVER)).toMatch(/^[0-9a-f]{64}$/);
    expect(managedServerDigest({ ...FAKE_SERVER })).toBe(managedServerDigest(FAKE_SERVER));
  });

  it('does not change when only the user-facing text of a precondition changes', () => {
    expect(managedServerDigest(withPreconditionText('another wording', 'export FAKE_KEY=1'))).toBe(managedServerDigest(FAKE_SERVER));
  });

  it.each([
    ['the launch argv', { launch: { argv: ['run', '--listen', '{socket}'] } }],
    ['the readiness path', { ready: { ...FAKE_SERVER.ready, path: '/health' } }],
    ['the identity rule', { identity: ['binarySha256', 'hostOsBuild'] }],
    ['the restart policy', { restart: { ...FAKE_SERVER.restart, maxRestarts: 6 } }],
  ])('changes when %s changes', (_label, change) => {
    expect(managedServerDigest({ ...FAKE_SERVER, ...change })).not.toBe(managedServerDigest(FAKE_SERVER));
  });
});
