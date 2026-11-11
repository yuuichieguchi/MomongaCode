import { COMMAND_PREFIX_SUFFIX, hasBalancedParentheses } from '@momonga/config';
import type { PathResolution } from '@momonga/foundation';
import { analyzeCommand } from './shell.ts';
import { absoluteFrom } from './path-match.ts';
import type { PermissionSubject, PolicyTool } from './types.ts';

const UNMATCHABLE_PATH_CHARACTERS = /[*?[\]{}!+@()\\\0]/;

const suggestForCommand = (command: string): string | undefined => {
  const text = command.trim();
  if (text === '' || text.endsWith(COMMAND_PREFIX_SUFFIX) || !hasBalancedParentheses(text)) return undefined;
  const analysis = analyzeCommand(text);
  if (analysis === null || analysis.nested.length > 0 || analysis.redirects.length > 0 || analysis.reads.length > 0) return undefined;
  const [segment] = analysis.segments;
  if (analysis.segments.length !== 1 || segment === undefined || segment.opaque || segment.unanalyzable || segment.text !== text) return undefined;
  return `Bash(${text})`;
};

const suggestForPath = (tool: PolicyTool, subject: Extract<PermissionSubject, { kind: 'path' }>, cwd: string, canonicalise: (absolute: string) => PathResolution): string | undefined => {
  const [target] = subject.paths;
  if (subject.paths.length !== 1 || target === undefined) return undefined;
  const resolution = canonicalise(absoluteFrom(target, cwd));
  if (!resolution.ok || UNMATCHABLE_PATH_CHARACTERS.test(resolution.path)) return undefined;
  return `${tool.name}(/${resolution.path})`;
};

export const suggestAllowRule = (
  tool: PolicyTool,
  subject: PermissionSubject,
  cwd: string,
  canonicalise: (absolute: string) => PathResolution,
): string | undefined => {
  switch (subject.kind) {
    case 'command':
      return subject.network === undefined ? suggestForCommand(subject.command) : undefined;
    case 'path':
      return suggestForPath(tool, subject, cwd, canonicalise);
    case 'mcp':
      return `mcp__${subject.server}__${subject.tool}`;
    case 'memory':
    case 'history':
    case 'governance':
      return undefined;
    case 'repo':
    case 'forge':
      return subject.approval === 'always' ? undefined : subject.tool;
    case 'none':
      return tool.name;
  }
};
