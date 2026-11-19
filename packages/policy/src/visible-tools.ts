import type { PermissionRule } from '@momonga/config';
import type { PermissionMode } from '@momonga/protocol';
import { matchPathlessRule, ruleCoversToolName } from './match-rule.ts';
import type { PathlessSubject } from './match-rule.ts';
import type { PolicyTool } from './types.ts';

export type VisibleToolsOptions = { mode: PermissionMode; rules: PermissionRule[] };

export const planModeRefuses = (tool: PolicyTool): boolean =>
  tool.sideEffect !== 'read_only' && tool.subjectKind !== 'command' && tool.subjectKind !== 'governance';

export const modelVisibleTools = (tools: PolicyTool[], { mode, rules }: VisibleToolsOptions): PolicyTool[] => {
  const blanketDenies = rules.filter((rule) => rule.effect === 'deny' && rule.specifier === undefined);
  return tools.filter((tool) => {
    if (mode === 'plan' && planModeRefuses(tool)) return false;
    return !blanketDenies.some((rule) => ruleCoversToolName(rule, tool.name));
  });
};

export const deniedByNamedRule = (rules: readonly PermissionRule[], subject: PathlessSubject): boolean =>
  rules.some((rule) => rule.effect === 'deny' && rule.specifier !== undefined && matchPathlessRule(rule, subject));
