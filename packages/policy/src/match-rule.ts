import { EDIT_TOOLS, PATH_TOOL_RULES, PATH_TOOLS } from '@momonga/config';
import type { PathToolName, PermissionRule } from '@momonga/config';
import { commandMatchStrength, matchesCommand } from './command-match.ts';
import type { MatchStrength } from './command-match.ts';
import path from 'node:path';
import { everyAsync, fileRuleBlocks, someAsync } from '@momonga/foundation';
import type { FileRuleSet, PathProbes } from '@momonga/foundation';
import { foldedKey } from './fold.ts';
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

export type RuleResolution = PathProbes['canonicalise'];

const pathMatchesRule = async (rule: PermissionRule, target: string, fileRules: FileRuleSet, ruleIndex: number, canonicalise: RuleResolution): Promise<boolean> => {
  const requested = path.resolve(rule.cwd, target);
  const resolution = await canonicalise(absoluteFrom(target, rule.cwd));
  if (!resolution.ok && rule.effect === 'allow') return false;
  const resolved = resolution.ok ? resolution.path : requested;
  return fileRules.entries.some((entry) => entry.ruleIndex === ruleIndex && fileRuleBlocks(fileRules, entry, requested, resolved));
};

export const wildcardMatches = (pattern: string, text: string): boolean => {
  let patternIndex = 0;
  let textIndex = 0;
  let starIndex = -1;
  let resumeIndex = 0;
  while (textIndex < text.length) {
    if (pattern[patternIndex] === '*') {
      starIndex = patternIndex;
      resumeIndex = textIndex;
      patternIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === text[textIndex]) {
      patternIndex += 1;
      textIndex += 1;
    } else if (starIndex >= 0) {
      resumeIndex += 1;
      textIndex = resumeIndex;
      patternIndex = starIndex + 1;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === '*') patternIndex += 1;
  return patternIndex === pattern.length;
};

const forgeTarget = (subject: Extract<PermissionSubject, { kind: 'forge' }>): string => `${subject.host}:${subject.repo}`;

const repoRefs = (subject: Extract<PermissionSubject, { kind: 'repo' }>): readonly string[] => (subject.refs.length === 0 ? [''] : subject.refs);

const repoAllowMatches = (specifier: string, subject: Extract<PermissionSubject, { kind: 'repo' }>): boolean => {
  const remote = subject.remote ?? '';
  return repoRefs(subject).every((ref) => {
    const byName = subject.destinationsMatchFetch && wildcardMatches(specifier, `${remote}:${ref}`);
    const byDestination = subject.destinations.length > 0 && subject.destinations.every((destination) => wildcardMatches(specifier, `${destination}:${ref}`));
    return byName || byDestination;
  });
};

const restrictingMatch = (specifier: string, targets: readonly string[]): boolean => {
  const key = foldedKey(specifier);
  return targets.some((target) => wildcardMatches(key, foldedKey(target)));
};

const repoRestrictMatches = (specifier: string, subject: Extract<PermissionSubject, { kind: 'repo' }>): boolean => {
  const places = [subject.remote ?? '', ...subject.destinations];
  return restrictingMatch(specifier, repoRefs(subject).flatMap((ref) => places.map((place) => `${place}:${ref}`)));
};

type PathSubject = Extract<PermissionSubject, { kind: 'path' }>;

export const matchPathlessRule = (rule: PermissionRule, subject: Exclude<PermissionSubject, PathSubject>): boolean => {
  if (!ruleCoversSubject(rule, subject)) return false;
  if (rule.specifier === undefined) return true;
  if (subject.kind === 'repo') return rule.effect === 'allow' ? repoAllowMatches(rule.specifier, subject) : repoRestrictMatches(rule.specifier, subject);
  if (subject.kind === 'forge') return rule.effect === 'allow' ? wildcardMatches(rule.specifier, forgeTarget(subject)) : restrictingMatch(rule.specifier, [forgeTarget(subject)]);
  if (subject.kind === 'command') return matchesCommand(rule, subject.command);
  return false;
};

export const matchRule = async (rule: PermissionRule, subject: PermissionSubject, fileRules: FileRuleSet, ruleIndex: number, canonicalise: RuleResolution): Promise<boolean> => {
  if (subject.kind !== 'path') return matchPathlessRule(rule, subject);
  if (!ruleCoversSubject(rule, subject)) return false;
  if (rule.specifier === undefined) return true;
  if (subject.paths.length === 0) return false;
  const matches = (target: string): Promise<boolean> => pathMatchesRule(rule, target, fileRules, ruleIndex, canonicalise);
  return rule.effect === 'allow' ? everyAsync(subject.paths, matches) : someAsync(subject.paths, matches);
};

export type PathlessSubject = Exclude<PermissionSubject, PathSubject>;

export const matchPathlessStrength = (rule: PermissionRule, subject: PathlessSubject): MatchStrength | null => {
  if (subject.kind === 'command' && rule.specifier !== undefined && ruleCoversToolName(rule, subject.tool)) {
    return commandMatchStrength(rule, subject.command);
  }
  return matchPathlessRule(rule, subject) ? 'position' : null;
};

export const matchStrength = async (rule: PermissionRule, subject: PermissionSubject, fileRules: FileRuleSet, ruleIndex: number, canonicalise: RuleResolution): Promise<MatchStrength | null> => {
  if (subject.kind !== 'path') return matchPathlessStrength(rule, subject);
  return (await matchRule(rule, subject, fileRules, ruleIndex, canonicalise)) ? 'position' : null;
};
