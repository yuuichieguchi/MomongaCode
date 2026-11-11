import { COMMAND_PREFIX_SUFFIX, NETWORK_RULE_SUBJECT, hasBalancedParentheses } from '@momonga/config';
import { normalizedHosts } from '@momonga/foundation';
import type { PathProbes } from '@momonga/foundation';
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

const suggestForPath = async (tool: PolicyTool, subject: Extract<PermissionSubject, { kind: 'path' }>, cwd: string, canonicalise: PathProbes['canonicalise']): Promise<string | undefined> => {
  const [target] = subject.paths;
  if (subject.paths.length !== 1 || target === undefined) return undefined;
  const resolution = await canonicalise(absoluteFrom(target, cwd));
  if (!resolution.ok || UNMATCHABLE_PATH_CHARACTERS.test(resolution.path)) return undefined;
  return `${tool.name}(/${resolution.path})`;
};

export const suggestAllowRule = async (
  tool: PolicyTool,
  subject: PermissionSubject,
  cwd: string,
  canonicalise: PathProbes['canonicalise'],
): Promise<string | undefined> => {
  switch (subject.kind) {
    case 'command':
      return suggestForCommand(subject.command);
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

export const suggestNetworkRule = (subject: PermissionSubject): string | undefined => {
  if (subject.kind !== 'command' || subject.network === undefined || subject.network === 'open') return undefined;
  const hosts = normalizedHosts(subject.network.hosts);
  const [host] = hosts;
  return hosts.length === 1 && host !== undefined ? `${NETWORK_RULE_SUBJECT}(${host})` : undefined;
};
