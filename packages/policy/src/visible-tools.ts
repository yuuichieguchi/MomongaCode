import type { PermissionRule } from '@momonga/config';
import type { PermissionMode } from '@momonga/protocol';
import { ruleCoversToolName } from './match-rule.ts';
import type { PolicyTool } from './types.ts';

export type VisibleToolsOptions = { mode: PermissionMode; rules: PermissionRule[] };

export const modelVisibleTools = (tools: PolicyTool[], { mode, rules }: VisibleToolsOptions): PolicyTool[] => {
  const blanketDenies = rules.filter((rule) => rule.effect === 'deny' && rule.specifier === undefined);
  return tools.filter((tool) => {
    if (mode === 'plan' && tool.sideEffect !== 'read_only' && tool.kind !== 'execute') return false;
    return !blanketDenies.some((rule) => ruleCoversToolName(rule, tool.name));
  });
};
