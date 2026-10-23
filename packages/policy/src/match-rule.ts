import type { PermissionRule } from '@momonga/config';
import { commandMatchStrength, matchesCommand } from './command-match.ts';
import type { MatchStrength } from './command-match.ts';
import { pathMatchesRule } from './path-match.ts';
import type { PermissionSubject } from './types.ts';

const EDIT_FAMILY: ReadonlySet<string> = new Set(['Edit', 'Write']);

export const sameToolName = (ruleTool: string, subjectTool: string): boolean =>
  ruleTool === subjectTool || (EDIT_FAMILY.has(ruleTool) && EDIT_FAMILY.has(subjectTool));

export const ruleCoversToolName = (rule: PermissionRule, toolName: string): boolean => {
  if (rule.tool.startsWith('mcp__') && !rule.tool.slice('mcp__'.length).includes('__')) return toolName.startsWith(`${rule.tool}__`);
  return sameToolName(rule.tool, toolName);
};

const subjectToolName = (subject: PermissionSubject): string =>
  subject.kind === 'mcp' ? `mcp__${subject.server}__${subject.tool}` : subject.tool;

export const matchRule = (rule: PermissionRule, subject: PermissionSubject, roots: readonly string[] = [rule.cwd]): boolean => {
  if (!ruleCoversToolName(rule, subjectToolName(subject))) return false;
  if (rule.specifier === undefined) return true;
  if (subject.kind === 'command') return matchesCommand(rule, subject.command);
  if (subject.kind !== 'path') return false;
  const strict = rule.effect === 'allow';
  if (subject.paths.length === 0) return false;
  const matches = (target: string): boolean => pathMatchesRule(rule, target, strict, roots);
  return strict ? subject.paths.every(matches) : subject.paths.some(matches);
};

export const matchStrength = (rule: PermissionRule, subject: PermissionSubject, roots: readonly string[]): MatchStrength | null => {
  if (subject.kind === 'command' && rule.specifier !== undefined && ruleCoversToolName(rule, subject.tool)) {
    return commandMatchStrength(rule, subject.command);
  }
  return matchRule(rule, subject, roots) ? 'position' : null;
};
