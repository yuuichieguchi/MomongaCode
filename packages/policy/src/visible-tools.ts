import type { PermissionRule } from '@momonga/config';
import type { PermissionMode } from '@momonga/protocol';
import { ruleCoversToolName } from './match-rule.ts';
import type { PolicyTool } from './types.ts';

export type VisibleToolsOptions = { mode: PermissionMode; rules: PermissionRule[]; jobsRunning?: boolean };

export const modelVisibleTools = (tools: PolicyTool[], { mode, rules, jobsRunning = false }: VisibleToolsOptions): PolicyTool[] => {
  const blanketDenies = rules.filter((rule) => rule.effect === 'deny' && rule.specifier === undefined);
  const permitted = (tool: PolicyTool): boolean => {
    if (mode === 'plan' && tool.sideEffect !== 'read_only' && tool.kind !== 'execute') return false;
    return !blanketDenies.some((rule) => ruleCoversToolName(rule, tool.name));
  };
  const permittedNames = new Set(tools.filter(permitted).map((tool) => tool.name));
  return tools.filter((tool) => permittedNames.has(tool.name) && (tool.companionOf === undefined || jobsRunning || permittedNames.has(tool.companionOf)));
};
