import { EDIT_TOOLS, PATH_TOOL_RULES, PATH_TOOLS } from '@momonga/config';
import type { PathToolName, PermissionRule } from '@momonga/config';
import { commandMatchStrength, matchesCommand } from './command-match.ts';
import type { MatchStrength } from './command-match.ts';
import path from 'node:path';
import { fileRuleBlocks, resolveCanonicalPath } from '@momonga/foundation';
import type { FileRuleSet } from '@momonga/foundation';
import { absoluteFrom } from './path-match.ts';
import type { PermissionSubject } from './types.ts';

export const EDIT_FAMILY: ReadonlySet<string> = EDIT_TOOLS;

export const sameToolName = (ruleTool: string, subjectTool: string): boolean =>
  ruleTool === subjectTool || (EDIT_FAMILY.has(ruleTool) && EDIT_FAMILY.has(subjectTool));

export const READ_FAMILY: ReadonlySet<string> = new Set(PATH_TOOLS.filter((tool: PathToolName) => PATH_TOOL_RULES[tool].access === 'read'));

export const ruleCoversToolName = (rule: PermissionRule, toolName: string): boolean => {
  if (rule.tool === 'Read' && rule.specifier !== undefined && READ_FAMILY.has(toolName)) return true;
  if (rule.tool.startsWith('mcp__') && !rule.tool.slice('mcp__'.length).includes('__')) return toolName.startsWith(`${rule.tool}__`);
  return sameToolName(rule.tool, toolName);
};

export const ruleCoversSubject = (rule: PermissionRule, subject: PermissionSubject): boolean => {
  if (ruleCoversToolName(rule, subjectToolName(subject))) return true;
  return subject.kind === 'path' && subject.access === 'write' && rule.tool === 'Read' && rule.specifier !== undefined && rule.effect !== 'allow';
};

const subjectToolName = (subject: PermissionSubject): string =>
  subject.kind === 'mcp' ? `mcp__${subject.server}__${subject.tool}` : subject.tool;

const pathMatchesRule = (rule: PermissionRule, target: string, fileRules: FileRuleSet, ruleIndex: number): boolean => {
  const requested = path.resolve(rule.cwd, target);
  const resolution = resolveCanonicalPath(absoluteFrom(target, rule.cwd));
  if (!resolution.ok && rule.effect === 'allow') return false;
  const resolved = resolution.ok ? resolution.path : requested;
  return fileRules.entries.some((entry) => entry.ruleIndex === ruleIndex && fileRuleBlocks(fileRules, entry, requested, resolved));
};

export const matchRule = (rule: PermissionRule, subject: PermissionSubject, fileRules: FileRuleSet, ruleIndex: number): boolean => {
  if (!ruleCoversSubject(rule, subject)) return false;
  if (rule.specifier === undefined) return true;
  if (subject.kind === 'command') return matchesCommand(rule, subject.command);
  if (subject.kind !== 'path') return false;
  if (subject.paths.length === 0) return false;
  const matches = (target: string): boolean => pathMatchesRule(rule, target, fileRules, ruleIndex);
  return rule.effect === 'allow' ? subject.paths.every(matches) : subject.paths.some(matches);
};

export const matchStrength = (rule: PermissionRule, subject: PermissionSubject, fileRules: FileRuleSet, ruleIndex: number): MatchStrength | null => {
  if (subject.kind === 'command' && rule.specifier !== undefined && ruleCoversToolName(rule, subject.tool)) {
    return commandMatchStrength(rule, subject.command);
  }
  return matchRule(rule, subject, fileRules, ruleIndex) ? 'position' : null;
};
