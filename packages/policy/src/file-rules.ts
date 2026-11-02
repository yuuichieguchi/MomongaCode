import { compileFileRuleSet, resolveCanonicalPath, volumeIsCaseInsensitive } from '@momonga/foundation';
import type { FileRuleSet, FileRuleSpec, PathResolution } from '@momonga/foundation';
import { PATH_TOOL_RULES, isPathTool } from '@momonga/config';
import type { PermissionRule } from '@momonga/config';

export const fileRuleSpecsOf = (rules: readonly PermissionRule[], roots: readonly string[]): FileRuleSpec[] =>
  rules.flatMap((rule, ruleIndex) => {
    if (!isPathTool(rule.tool) || rule.specifier === undefined) return [];
    const { tool, access } = PATH_TOOL_RULES[rule.tool];
    return [
      {
        ruleIndex,
        tool,
        access,
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
