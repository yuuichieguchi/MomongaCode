import { compileFileRuleSet, resolveCanonicalPath, volumeIsCaseInsensitive } from '@momonga/foundation';
import type { FileRuleSet, FileRuleSpec } from '@momonga/foundation';

export type FileSpecOptions = {
  roots: readonly string[];
  home: string;
  ruleIndex?: number;
  tool?: FileRuleSpec['tool'];
  effect?: FileRuleSpec['effect'];
  exceptions?: readonly string[];
  settingsRoot?: string;
  layer?: FileRuleSpec['provenance']['layer'];
  source?: string;
};

export const fileSpec = (specifier: string, options: FileSpecOptions): FileRuleSpec => {
  const tool = options.tool ?? 'Read';
  const effect = options.effect ?? 'deny';
  const layer = options.layer ?? 'user';
  return {
    ruleIndex: options.ruleIndex ?? 0,
    tool,
    access: tool === 'Edit' ? 'write' : 'read',
    effect,
    specifier,
    exceptions: options.exceptions ?? [],
    context: { roots: options.roots, home: options.home, settingsRoot: options.settingsRoot ?? (options.roots[0] as string), effect },
    provenance: { ruleText: `${tool}(${specifier})`, layer, source: options.source ?? `${layer}-settings` },
  };
};

export const indexed = (specs: readonly FileRuleSpec[]): FileRuleSpec[] => specs.map((spec, ruleIndex) => ({ ...spec, ruleIndex }));

export const fileRulesOf = (specs: readonly FileRuleSpec[], roots: readonly string[], exemptDirectory: string | null = null): FileRuleSet =>
  compileFileRuleSet(indexed(specs), roots, exemptDirectory, resolveCanonicalPath, volumeIsCaseInsensitive);

export const escapeKernel = (value: string): string => value.replace(/[.*+?()[\]{}|^$\\]/g, '\\$&');
