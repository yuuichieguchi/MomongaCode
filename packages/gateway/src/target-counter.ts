import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { loadUserSettings } from '@momonga/config';
import type { ManagedServerDescription } from '@momonga/protocol';
import type { ProbeOutputPolicy } from './probe/decide.ts';

type ResolvedTarget = Awaited<ReturnType<typeof loadUserSettings>>['settings']['models']['targets'][string];

export type ServedAccount = { profile: string; account: string | null };

export type ReportedNumbers = { contextWindow: number; maxOutputTokens: number } | null;

export type TargetCounterInput = {
  target: ResolvedTarget;
  codeDigest: string;
  probeKey?: string;
  upstreamIdentity?: string;
  server?: ManagedServerDescription;
  served?: ServedAccount;
  reported?: ReportedNumbers;
  outputPolicy?: ProbeOutputPolicy;
};

export const readsOutputPolicy = (target: ResolvedTarget): boolean =>
  target.adapter === 'managed' || (target.adapter === 'chat-completions' && target.toolCalling === 'auto');

export const targetCounterOf = ({ target, codeDigest, probeKey, upstreamIdentity, server, served, reported, outputPolicy }: TargetCounterInput): string =>
  sha256Hex(
    canonicalJson({
      definition: target,
      codeDigest,
      ...(server === undefined ? {} : { server }),
      ...(probeKey === undefined ? {} : { probeKey }),
      ...(upstreamIdentity === undefined ? {} : { upstreamIdentity }),
      ...(served === undefined ? {} : { served }),
      ...(reported === undefined ? {} : { reported }),
      ...(outputPolicy === undefined || !readsOutputPolicy(target) ? {} : { outputPolicy }),
    }),
  );
