import { COMPACT_AT_PERCENT, OUTPUT_FORMATTERS } from '@momonga/protocol';
import type { OutputFormatterName } from '@momonga/protocol';
import type { AcceptedCheck } from './declared-checks.ts';
import type { BashOnTimeout, ContextSettings, MemorySettings, RipgrepSetting, ToolsSettings, VerificationSettings } from './settings.ts';

export type ResolvedMemorySettings = { reflection: { enabled: boolean; maxTokens?: number }; forgetAfterDays: number; repositoryFacts: boolean };

export type ResolvedVerificationSettings = { commands?: string[]; manifests: string[]; conditions: string[]; required: boolean };

export type ResolvedContextSettings = {
  adaptiveBudget: boolean;
  autoCompact: boolean;
  compactAt: number;
  cachePrefix: boolean;
  outputFormatters: OutputFormatterName[];
  loopGuidance: boolean;
  observedCapacity: boolean;
  unboundedOutputReserve: boolean;
};

export type ResolvedBashSettings = { defaultTimeoutMs: number; maxTimeoutMs: number; onTimeout: BashOnTimeout; backgroundTimeoutMs: number; maxBackgroundTimeoutMs: number; drainIdleMs: number };

export type ResolvedToolsSettings = {
  deferral: boolean;
  conciseDescriptions: boolean;
  ripgrep: RipgrepSetting;
  bash: ResolvedBashSettings;
  search: { timeoutMs: number };
  operations: { timeoutMs: number };
};

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const DEFAULT_BASH_MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_BASH_BACKGROUND_TIMEOUT_MS = 1_800_000;
export const DEFAULT_BASH_MAX_BACKGROUND_TIMEOUT_MS = 7_200_000;
export const DEFAULT_BASH_DRAIN_IDLE_MS = 1000;
export const DEFAULT_SEARCH_TIMEOUT_MS = 60_000;
export const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
export const DEFAULT_UPDATE_STALL_TIMEOUT_MS = 30_000;

export const DEFAULT_FORGET_AFTER_DAYS = 90;

export const DEFAULT_VERIFICATION_MANIFESTS: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'Package.swift',
  'Makefile',
];

export const defaultMemorySettings = (): ResolvedMemorySettings => ({
  reflection: { enabled: true },
  forgetAfterDays: DEFAULT_FORGET_AFTER_DAYS,
  repositoryFacts: true,
});

export const defaultVerificationSettings = (): ResolvedVerificationSettings => ({
  manifests: [...DEFAULT_VERIFICATION_MANIFESTS],
  conditions: [],
  required: false,
});

export const defaultContextSettings = (): ResolvedContextSettings => ({
  adaptiveBudget: true,
  autoCompact: true,
  compactAt: COMPACT_AT_PERCENT.default,
  cachePrefix: true,
  outputFormatters: [...OUTPUT_FORMATTERS],
  loopGuidance: true,
  observedCapacity: true,
  unboundedOutputReserve: true,
});

export const defaultToolsSettings = (): ResolvedToolsSettings => ({
  deferral: true,
  conciseDescriptions: true,
  ripgrep: 'bundled',
  bash: {
    defaultTimeoutMs: DEFAULT_BASH_TIMEOUT_MS,
    maxTimeoutMs: DEFAULT_BASH_MAX_TIMEOUT_MS,
    onTimeout: 'background',
    backgroundTimeoutMs: DEFAULT_BASH_BACKGROUND_TIMEOUT_MS,
    maxBackgroundTimeoutMs: DEFAULT_BASH_MAX_BACKGROUND_TIMEOUT_MS,
    drainIdleMs: DEFAULT_BASH_DRAIN_IDLE_MS,
  },
  search: { timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS },
  operations: { timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS },
});

export const mergeMemorySettings = (base: ResolvedMemorySettings, layer: MemorySettings | undefined): ResolvedMemorySettings => {
  if (layer === undefined) return base;
  const maxTokens = layer.reflection?.maxTokens ?? base.reflection.maxTokens;
  return {
    reflection: { enabled: layer.reflection?.enabled ?? base.reflection.enabled, ...(maxTokens === undefined ? {} : { maxTokens }) },
    forgetAfterDays: layer.forgetAfterDays ?? base.forgetAfterDays,
    repositoryFacts: layer.repositoryFacts ?? base.repositoryFacts,
  };
};

export const mergeVerificationSettings = (base: ResolvedVerificationSettings, layer: VerificationSettings | undefined): ResolvedVerificationSettings => {
  if (layer === undefined) return base;
  const commands = layer.commands ?? base.commands;
  return {
    ...(commands === undefined ? {} : { commands }),
    manifests: layer.manifests ?? base.manifests,
    conditions: base.conditions,
    required: layer.required ?? base.required,
  };
};

export const mergeContextSettings = (base: ResolvedContextSettings, layer: ContextSettings | undefined): ResolvedContextSettings => {
  if (layer === undefined) return base;
  return {
    adaptiveBudget: layer.adaptiveBudget ?? base.adaptiveBudget,
    autoCompact: layer.autoCompact ?? base.autoCompact,
    compactAt: layer.compactAt ?? base.compactAt,
    cachePrefix: layer.cachePrefix ?? base.cachePrefix,
    outputFormatters: layer.outputFormatters ?? base.outputFormatters,
    loopGuidance: layer.loopGuidance ?? base.loopGuidance,
    observedCapacity: layer.observedCapacity ?? base.observedCapacity,
    unboundedOutputReserve: layer.unboundedOutputReserve ?? base.unboundedOutputReserve,
  };
};

export const mergeToolsSettings = (base: ResolvedToolsSettings, layer: ToolsSettings | undefined): ResolvedToolsSettings => {
  if (layer === undefined) return base;
  return {
    deferral: layer.deferral ?? base.deferral,
    conciseDescriptions: layer.conciseDescriptions ?? base.conciseDescriptions,
    ripgrep: layer.ripgrep ?? base.ripgrep,
    bash: { ...base.bash, ...layer.bash },
    search: { ...base.search, ...layer.search },
    operations: { ...base.operations, ...layer.operations },
  };
};

export const withCompletionConditions = (
  verification: ResolvedVerificationSettings,
  declaredCommands: readonly string[] | undefined,
  accepted: AcceptedCheck | undefined,
): ResolvedVerificationSettings => {
  if (declaredCommands !== undefined) return { ...verification, conditions: [...declaredCommands] };
  if (accepted !== undefined && 'commands' in accepted) return { ...verification, conditions: [...accepted.commands] };
  return { ...verification, conditions: [] };
};
