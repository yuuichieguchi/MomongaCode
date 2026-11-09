import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { loadUserSettings } from '@momonga/config';

type ResolvedTarget = Awaited<ReturnType<typeof loadUserSettings>>['settings']['models']['targets'][string];

export type TargetCounterInput = {
  target: ResolvedTarget;
  codeDigest: string;
  probeKey?: string;
  upstreamIdentity?: string;
};

export const targetCounterOf = ({ target, codeDigest, probeKey, upstreamIdentity }: TargetCounterInput): string =>
  sha256Hex(canonicalJson({ definition: target, codeDigest, ...(probeKey === undefined ? {} : { probeKey }), ...(upstreamIdentity === undefined ? {} : { upstreamIdentity }) }));
