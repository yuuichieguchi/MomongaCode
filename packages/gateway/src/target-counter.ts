import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { loadUserSettings } from '@momonga/config';

type ResolvedTarget = Awaited<ReturnType<typeof loadUserSettings>>['settings']['models']['targets'][string];

export type TargetCounterInput = {
  target: ResolvedTarget;
  codeDigest: string;
  fm?: { binarySha256: string | null; osBuild: string };
  upstreamIdentity?: string;
};

export const targetCounterOf = ({ target, codeDigest, fm, upstreamIdentity }: TargetCounterInput): string =>
  sha256Hex(canonicalJson({ definition: target, codeDigest, fm: fm ?? null, upstreamIdentity: upstreamIdentity ?? null }));
