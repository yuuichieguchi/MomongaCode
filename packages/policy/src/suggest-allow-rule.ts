import { analyzeCommand } from './shell.ts';
import { absoluteFrom, canonicalizePath } from './path-match.ts';
import type { PermissionSubject, PolicyTool } from './types.ts';

const UNMATCHABLE_PATH_CHARACTERS = /[*?[\]{}!+@()\\\0]/;
const PREFIX_SUFFIX = ':*';

const hasBalancedParentheses = (value: string): boolean => {
  let depth = 0;
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
};

const suggestForCommand = (command: string): string | undefined => {
  const text = command.trim();
  if (text === '' || text.endsWith(PREFIX_SUFFIX) || !hasBalancedParentheses(text)) return undefined;
  const analysis = analyzeCommand(text);
  if (analysis === null || analysis.nested.length > 0 || analysis.redirects.length > 0 || analysis.reads.length > 0) return undefined;
  const [segment] = analysis.segments;
  if (analysis.segments.length !== 1 || segment === undefined || segment.opaque || segment.unanalyzable || segment.text !== text) return undefined;
  return `Bash(${text})`;
};

const suggestForPath = (tool: PolicyTool, subject: Extract<PermissionSubject, { kind: 'path' }>, cwd: string): string | undefined => {
  const [target] = subject.paths;
  if (subject.paths.length !== 1 || target === undefined) return undefined;
  const real = canonicalizePath(absoluteFrom(target, cwd));
  if (real === null || UNMATCHABLE_PATH_CHARACTERS.test(real)) return undefined;
  return `${tool.name}(/${real})`;
};

export const suggestAllowRule = (
  tool: PolicyTool,
  subject: PermissionSubject,
  ctx: { cwd: string; home: string },
): string | undefined => {
  switch (subject.kind) {
    case 'command':
      return suggestForCommand(subject.command);
    case 'path':
      return suggestForPath(tool, subject, ctx.cwd);
    case 'mcp':
      return `mcp__${subject.server}__${subject.tool}`;
    case 'none':
      return tool.name;
  }
};
