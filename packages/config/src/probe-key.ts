import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { ProbeKeyReading } from '@momonga/foundation';
import type { ManagedServerDescription } from '@momonga/protocol';

export const PROBE_KEY_DIGEST_CHARS = 16;

export type ManagedProbeKeyInput = {
  subject: string;
  identity: readonly string[];
  readings: Readonly<Record<string, ProbeKeyReading>>;
  model: string | undefined;
};

export type EndpointProbeKeyInput = { subject: 'endpoint'; endpoint: string; model: string };

export type ProbeKeyInput = ManagedProbeKeyInput | EndpointProbeKeyInput;

export type KnownProbeKey = { kind: 'known'; canonical: string; digest: string };

export type UnknownProbeKey = { kind: 'unknown'; component: string; reason: string };

export type ProbeKey = KnownProbeKey | UnknownProbeKey;

const NOT_READ_REASON = 'it was not read';

export const knownKeyOf = (fields: Readonly<Record<string, string | null>>): KnownProbeKey => {
  const canonical = canonicalJson(fields);
  return { kind: 'known', canonical, digest: sha256Hex(canonical).slice(0, PROBE_KEY_DIGEST_CHARS) };
};

const isEndpointInput = (input: ProbeKeyInput): input is EndpointProbeKeyInput => 'endpoint' in input;

export const probeKeyOf = (input: ProbeKeyInput): ProbeKey => {
  if (isEndpointInput(input)) return knownKeyOf({ subject: input.subject, endpoint: input.endpoint, model: input.model });
  const fields: Record<string, string | null> = { subject: input.subject, model: input.model ?? null };
  for (const component of input.identity) {
    const reading = input.readings[component];
    if (reading === undefined) return { kind: 'unknown', component, reason: NOT_READ_REASON };
    if (reading.kind === 'unreadable') return { kind: 'unknown', component, reason: reading.reason };
    fields[component] = reading.value;
  }
  return knownKeyOf(fields);
};

const behaviourOf = ({ provider: _provider, ...description }: ManagedServerDescription): unknown => ({
  ...description,
  errors: description.errors.map((entry) => ({ kind: entry.kind })),
  preconditions: description.preconditions.map((precondition) => ({
    argv: precondition.argv,
    rules: precondition.rules.map((rule) => ('otherExit' in rule ? { otherExit: rule.otherExit, verdict: rule.verdict } : { exitCode: rule.exitCode, verdict: rule.verdict })),
  })),
});

export const managedServerDigest = (description: ManagedServerDescription): string => sha256Hex(canonicalJson(behaviourOf(description)));
