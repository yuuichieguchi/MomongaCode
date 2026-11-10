import { FileRuleError, checkExceptionGrammar, checkFilePatternGrammar } from '@momonga/foundation';
import type { FileRuleAccess, FileRuleSpec } from '@momonga/foundation';

export type RuleEffect = 'allow' | 'ask' | 'deny';
export type RuleOrigin = 'user' | 'project' | 'local' | 'cli';

const RULE_LAYERS = ['governance'] as const;

export type RuleLayer = (typeof RULE_LAYERS)[number];

export type PermissionRule = {
  text: string;
  tool: string;
  specifier?: string;
  effect: RuleEffect;
  origin: RuleOrigin;
  source: string;
  settingsRoot: string;
  home: string;
  cwd: string;
  exceptions?: readonly string[];
  layer?: RuleLayer;
};

export type ParseRuleOptions = {
  effect: RuleEffect;
  origin: RuleOrigin;
  source: string;
  settingsRoot: string;
  home: string;
  cwd: string;
  layer?: RuleLayer;
};

export class RuleParseError extends Error {
  constructor(text: string, reason: string) {
    super(`invalid permission rule ${JSON.stringify(text)}: ${reason}`);
    this.name = 'RuleParseError';
  }
}

export const NEGATION_PREFIX = '!';

export const COMMAND_PREFIX_SUFFIX = ':*';

export const PATH_TOOL_RULES = {
  Read: { tool: 'Read', access: 'read' },
  Write: { tool: 'Edit', access: 'write' },
  Edit: { tool: 'Edit', access: 'write' },
  Glob: { tool: 'Glob', access: 'read' },
  Grep: { tool: 'Grep', access: 'read' },
} as const satisfies Record<string, { tool: FileRuleSpec['tool']; access: FileRuleAccess }>;

export type PathToolName = keyof typeof PATH_TOOL_RULES;

export const PATH_TOOLS = Object.keys(PATH_TOOL_RULES) as PathToolName[];

export const EDIT_TOOLS: ReadonlySet<string> = new Set(PATH_TOOLS.filter((tool) => PATH_TOOL_RULES[tool].tool === 'Edit'));

export const isPathTool = (tool: string): tool is PathToolName => Object.hasOwn(PATH_TOOL_RULES, tool);

export const OPERATION_RULE_TOOLS = ['GitBranch', 'GitCommit', 'GitPush', 'PullRequestStatus', 'PullRequestCreate', 'PullRequestMerge', 'PullRequestComment'] as const;

const OPERATION_TOOLS: readonly string[] = OPERATION_RULE_TOOLS;
const SPECIFIER_TOOLS: readonly string[] = [...PATH_TOOLS, 'Bash', ...OPERATION_TOOLS];
const PLAIN_TOOLS: readonly string[] = [...SPECIFIER_TOOLS, 'BashOutput', 'KillBash', 'ReadOutput', 'UpdatePlan', 'MemorySave', 'MemorySearch', 'HistorySearch', 'HistoryRead', 'RulePropose'];
const MCP_NAME = /^[A-Za-z0-9_-]+$/;

export const hasBalancedParentheses = (value: string): boolean => {
  let depth = 0;
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
};

const validateMcpTool = (text: string, tool: string): void => {
  const name = tool.slice('mcp__'.length);
  const parts = name.split('__');
  const server = parts[0] ?? '';
  const toolName = parts.slice(1).join('__');
  if (server === '' || !MCP_NAME.test(server)) throw new RuleParseError(text, 'invalid MCP server name');
  if (parts.length > 1 && (toolName === '' || !MCP_NAME.test(toolName))) throw new RuleParseError(text, 'invalid MCP tool name');
  if (/^_|_$/.test(server)) throw new RuleParseError(text, 'invalid MCP server name');
};

const validateSpecifier = (text: string, tool: string, specifier: string): void => {
  if (!SPECIFIER_TOOLS.includes(tool)) throw new RuleParseError(text, `${tool} does not take a specifier`);
  if (specifier.trim() === '') throw new RuleParseError(text, 'empty specifier');
  if (specifier.includes('\0')) throw new RuleParseError(text, 'specifier contains a NUL byte');
  if (tool === 'Bash') {
    if (!hasBalancedParentheses(specifier)) throw new RuleParseError(text, 'unbalanced parentheses in specifier');
    if (specifier.endsWith(COMMAND_PREFIX_SUFFIX) && specifier.slice(0, -COMMAND_PREFIX_SUFFIX.length).trim() === '') throw new RuleParseError(text, 'empty command prefix');
    return;
  }
  if (OPERATION_TOOLS.includes(tool)) {
    if (/[()]/.test(specifier)) throw new RuleParseError(text, 'parentheses are not allowed in an operation specifier');
    return;
  }
  if (/[()]/.test(specifier)) throw new RuleParseError(text, 'parentheses are not allowed in a path specifier');
  const negated = specifier.startsWith(NEGATION_PREFIX);
  const body = negated ? specifier.slice(NEGATION_PREFIX.length) : specifier;
  try {
    if (negated) checkExceptionGrammar(body);
    checkFilePatternGrammar(body);
  } catch (error) {
    if (error instanceof FileRuleError && error.reason === 'empty_negation') throw new RuleParseError(text, 'empty specifier');
    if (error instanceof FileRuleError) throw new RuleParseError(text, `${error.reason}: ${error.message}`);
    throw error;
  }
};

export const checkRuleText = (text: string): { tool: string; specifier: string | undefined } => {
  const open = text.indexOf('(');
  const tool = open === -1 ? text : text.slice(0, open);
  if (open !== -1 && !text.endsWith(')')) throw new RuleParseError(text, 'missing closing parenthesis');
  const specifier = open === -1 ? undefined : text.slice(open + 1, -1);

  if (tool.startsWith('mcp__')) {
    validateMcpTool(text, tool);
    if (specifier !== undefined) throw new RuleParseError(text, 'MCP rules do not take a specifier');
  } else if (!PLAIN_TOOLS.includes(tool)) {
    throw new RuleParseError(text, 'unknown tool');
  }
  if (specifier !== undefined) validateSpecifier(text, tool, specifier);
  return { tool, specifier };
};

export type GovernanceRuleEntry = { id: string; behavior: 'deny' | 'ask'; rule: string };

export const parseGovernanceRule = (entry: GovernanceRuleEntry, context: { home: string; project: string }): PermissionRule =>
  parseRule(entry.rule, {
    effect: entry.behavior,
    origin: 'user',
    source: `governing fact ${entry.id}`,
    settingsRoot: context.project,
    home: context.home,
    cwd: context.project,
    layer: 'governance',
  });

export const parseRule = (text: string, options: ParseRuleOptions): PermissionRule => {
  const { tool, specifier } = checkRuleText(text);
  const { effect, origin, source, settingsRoot, home, cwd, layer } = options;
  const base = { text, tool, effect, origin, source, settingsRoot, home, cwd, ...(layer === undefined ? {} : { layer }) };
  return specifier === undefined ? base : { ...base, specifier };
};
