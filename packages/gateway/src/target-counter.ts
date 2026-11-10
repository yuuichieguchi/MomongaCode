import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { loadUserSettings } from '@momonga/config';
import type { ManagedServerDescription } from '@momonga/protocol';

type ResolvedTarget = Awaited<ReturnType<typeof loadUserSettings>>['settings']['models']['targets'][string];

export type TargetCounterInput = {
  target: ResolvedTarget;
  codeDigest: string;
  probeKey?: string;
  upstreamIdentity?: string;
  server?: ManagedServerDescription;
};

export const targetCounterOf = ({ target, codeDigest, probeKey, upstreamIdentity, server }: TargetCounterInput): string =>
  sha256Hex(canonicalJson({ definition: target, codeDigest, ...(server === undefined ? {} : { server }), ...(probeKey === undefined ? {} : { probeKey }), ...(upstreamIdentity === undefined ? {} : { upstreamIdentity }) }));
