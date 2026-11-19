import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { ResolvedModelTarget } from '@momonga/config';
import type { ManagedServerDescription, ReasoningCapability } from '@momonga/protocol';
import type { ProbeOutputPolicy } from './probe/decide.ts';

type ResolvedTarget = ResolvedModelTarget & { canon?: string; ownName?: string; defaultTag?: string; naming?: string };

const definitionOf = (target: ResolvedTarget): ResolvedModelTarget => {
  const { canon: _canon, ownName: _ownName, defaultTag: _defaultTag, naming: _naming, ...definition } = target;
  return definition;
};

export type ServedAccount = { profile: string; account: string | null };

export type ReportedNumbers = { contextWindow: number; maxOutputTokens: number; reasoning?: ReasoningCapability } | null;

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
      definition: definitionOf(target),
      codeDigest,
      ...(server === undefined ? {} : { server }),
      ...(probeKey === undefined ? {} : { probeKey }),
      ...(upstreamIdentity === undefined ? {} : { upstreamIdentity }),
      ...(served === undefined ? {} : { served }),
      ...(reported === undefined ? {} : { reported }),
      ...(outputPolicy === undefined || !readsOutputPolicy(target) ? {} : { outputPolicy }),
    }),
  );
