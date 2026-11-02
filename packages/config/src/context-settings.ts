import type { ContextSettings, MemorySettings, VerificationSettings } from './settings.ts';

export type ResolvedMemorySettings = { reflection: { enabled: boolean; maxTokens?: number }; forgetAfterDays: number };

export type ResolvedVerificationSettings = { commands: string[]; manifests: string[] };

export type ResolvedContextSettings = { adaptiveBudget: boolean };

export const DEFAULT_FORGET_AFTER_DAYS = 90;

export const DEFAULT_VERIFICATION_COMMANDS: readonly string[] = [
  'npm test',
  'pnpm test',
  'yarn test',
  'cargo test',
  'pytest',
  'go test ./...',
  'swift test',
  'make test',
];

export const DEFAULT_VERIFICATION_MANIFESTS: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'Package.swift',
  'Makefile',
];

export const defaultMemorySettings = (): ResolvedMemorySettings => ({ reflection: { enabled: false }, forgetAfterDays: DEFAULT_FORGET_AFTER_DAYS });

export const defaultVerificationSettings = (): ResolvedVerificationSettings => ({
  commands: [...DEFAULT_VERIFICATION_COMMANDS],
  manifests: [...DEFAULT_VERIFICATION_MANIFESTS],
});

export const defaultContextSettings = (): ResolvedContextSettings => ({ adaptiveBudget: false });

export const mergeMemorySettings = (base: ResolvedMemorySettings, layer: MemorySettings | undefined): ResolvedMemorySettings => {
  if (layer === undefined) return base;
  const maxTokens = layer.reflection?.maxTokens ?? base.reflection.maxTokens;
  return {
    reflection: { enabled: layer.reflection?.enabled ?? base.reflection.enabled, ...(maxTokens === undefined ? {} : { maxTokens }) },
    forgetAfterDays: layer.forgetAfterDays ?? base.forgetAfterDays,
  };
};

export const mergeVerificationSettings = (base: ResolvedVerificationSettings, layer: VerificationSettings | undefined): ResolvedVerificationSettings => {
  if (layer === undefined) return base;
  return { commands: layer.commands ?? base.commands, manifests: layer.manifests ?? base.manifests };
};

export const mergeContextSettings = (base: ResolvedContextSettings, layer: ContextSettings | undefined): ResolvedContextSettings => {
  if (layer === undefined) return base;
  return { adaptiveBudget: layer.adaptiveBudget ?? base.adaptiveBudget };
};
