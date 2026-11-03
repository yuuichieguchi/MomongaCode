import type { PermissionRule } from '@momonga/config';
import type { PermissionMode } from '@momonga/protocol';
import { ruleCoversToolName } from './match-rule.ts';
import type { PermissionSubject, PolicyTool } from './types.ts';

export type VisibleToolsOptions = { mode: PermissionMode; rules: PermissionRule[] };

export const planModeRefuses = (sideEffect: PolicyTool['sideEffect'], subjectKind: PermissionSubject['kind'] | undefined): boolean =>
  sideEffect !== 'read_only' && subjectKind !== 'command' && subjectKind !== 'governance';

export const modelVisibleTools = (tools: PolicyTool[], { mode, rules }: VisibleToolsOptions): PolicyTool[] => {
  const blanketDenies = rules.filter((rule) => rule.effect === 'deny' && rule.specifier === undefined);
  return tools.filter((tool) => {
    if (mode === 'plan' && planModeRefuses(tool.sideEffect, tool.subjectKind)) return false;
    return !blanketDenies.some((rule) => ruleCoversToolName(rule, tool.name));
  });
};
