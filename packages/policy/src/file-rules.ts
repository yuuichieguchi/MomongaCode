import { compileFileRuleSet, resolveCanonicalPath, volumeIsCaseInsensitive } from '@momonga/foundation';
import type { FileRuleSet, FileRuleSpec, PathResolution } from '@momonga/foundation';
import type { PermissionRule } from '@momonga/config';

const TOOL_BY_RULE_TOOL: Readonly<Record<string, FileRuleSpec['tool']>> = { Read: 'Read', Write: 'Edit', Edit: 'Edit', Glob: 'Glob', Grep: 'Grep' };

export const fileRuleSpecsOf = (rules: readonly PermissionRule[], roots: readonly string[]): FileRuleSpec[] =>
  rules.flatMap((rule, ruleIndex) => {
    const tool = TOOL_BY_RULE_TOOL[rule.tool];
    if (tool === undefined || rule.specifier === undefined) return [];
    return [
      {
        ruleIndex,
        tool,
        access: tool === 'Edit' ? 'write' : 'read',
        effect: rule.effect,
        specifier: rule.specifier,
        exceptions: rule.exceptions ?? [],
        context: { roots, home: rule.home, settingsRoot: rule.settingsRoot, effect: rule.effect },
        provenance: { ruleText: rule.text, layer: rule.origin, source: rule.source },
      },
    ];
  });

export const computeFileRules = (
  rules: readonly PermissionRule[],
  roots: readonly string[],
  exemptDirectory: string | null,
  canonicalise: (absolute: string) => PathResolution = resolveCanonicalPath,
  volumeProbe: (directory: string) => boolean = volumeIsCaseInsensitive,
): FileRuleSet => compileFileRuleSet(fileRuleSpecsOf(rules, roots), roots, exemptDirectory, canonicalise, volumeProbe);
