import { FileRuleError, checkExceptionGrammar, checkFilePatternGrammar, HOST_SUFFIX_PREFIX, parseHostEntry, parseHostPattern } from '@momonga/foundation';
import type { FileRuleAccess, FileRuleSpec } from '@momonga/foundation';
import { AGENT_TOOL_NAME, COMMAND_TOOL_NAME, OPERATION_RULE_TOOLS, TOOL_NAMES } from '@momonga/protocol';
import type { PATH_TOOL_NAMES } from '@momonga/protocol';

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
} as const satisfies Record<(typeof PATH_TOOL_NAMES)[number], { tool: FileRuleSpec['tool']; access: FileRuleAccess }>;

export type PathToolName = keyof typeof PATH_TOOL_RULES;

export const PATH_TOOLS = Object.keys(PATH_TOOL_RULES) as PathToolName[];

export const EDIT_TOOLS: ReadonlySet<string> = new Set(PATH_TOOLS.filter((tool) => PATH_TOOL_RULES[tool].tool === 'Edit'));

export const isPathTool = (tool: string): tool is PathToolName => Object.hasOwn(PATH_TOOL_RULES, tool);

export { OPERATION_RULE_TOOLS };

export const NETWORK_RULE_SUBJECT = 'Network';


const MCP_TOOL_PREFIX = 'mcp__';

const MCP_NAME_SEPARATOR = '__';
const MCP_EVERY_TOOL = '*';
const MCP_SERVER_RULE_FORMS = `the rule for every tool of a server is ${MCP_TOOL_PREFIX}<server>${MCP_NAME_SEPARATOR}${MCP_EVERY_TOOL} or ${MCP_TOOL_PREFIX}<server>`;

const OPERATION_TOOLS: readonly string[] = OPERATION_RULE_TOOLS;
const SPECIFIER_TOOLS: readonly string[] = [...PATH_TOOLS, COMMAND_TOOL_NAME, AGENT_TOOL_NAME, ...OPERATION_TOOLS, NETWORK_RULE_SUBJECT];
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

const mcpToolOf = (text: string, tool: string): string => {
  const parts = tool.slice(MCP_TOOL_PREFIX.length).split(MCP_NAME_SEPARATOR);
  const server = parts[0] ?? '';
  const toolName = parts.slice(1).join(MCP_NAME_SEPARATOR);
  const refuse = (reason: string): never => {
    throw new RuleParseError(text, tool.includes(MCP_EVERY_TOOL) ? `${reason}; ${MCP_SERVER_RULE_FORMS}` : reason);
  };
  if (server === '' || !MCP_NAME.test(server) || /^_|_$/.test(server)) return refuse('invalid MCP server name');
  if (parts.length > 1 && toolName === MCP_EVERY_TOOL) return `${MCP_TOOL_PREFIX}${server}`;
  if (parts.length > 1 && (toolName === '' || !MCP_NAME.test(toolName))) return refuse('invalid MCP tool name');
  return tool;
};

const networkSpecifierProblem = (specifier: string): string | undefined => {
  if (parseHostPattern(specifier) !== undefined) return undefined;
  const suffixed = specifier.startsWith(HOST_SUFFIX_PREFIX);
  if (suffixed && parseHostEntry(specifier.slice(HOST_SUFFIX_PREFIX.length)) !== undefined) return `${HOST_SUFFIX_PREFIX}<suffix> takes a host name without a port`;
  return `not a host name or an IP address, optionally followed by :port, or ${HOST_SUFFIX_PREFIX}<suffix> for the names under a suffix`;
};

const validateSpecifier = (text: string, tool: string, specifier: string): void => {
  if (!SPECIFIER_TOOLS.includes(tool)) throw new RuleParseError(text, `${tool} does not take a specifier`);
  if (specifier.trim() === '') throw new RuleParseError(text, 'empty specifier');
  if (specifier.includes('\0')) throw new RuleParseError(text, 'specifier contains a NUL byte');
  if (tool === NETWORK_RULE_SUBJECT) {
    const problem = networkSpecifierProblem(specifier);
    if (problem !== undefined) throw new RuleParseError(text, problem);
    return;
  }
  if (tool === COMMAND_TOOL_NAME) {
    if (!hasBalancedParentheses(specifier)) throw new RuleParseError(text, 'unbalanced parentheses in specifier');
    if (specifier.endsWith(COMMAND_PREFIX_SUFFIX) && specifier.slice(0, -COMMAND_PREFIX_SUFFIX.length).trim() === '') throw new RuleParseError(text, 'empty command prefix');
    return;
  }
  if (tool === AGENT_TOOL_NAME) return;
  if (OPERATION_TOOLS.includes(tool)) {
    if (/[()]/.test(specifier)) throw new RuleParseError(text, 'parentheses are not allowed in an operation specifier');
    return;
  }
  if (!hasBalancedParentheses(specifier)) throw new RuleParseError(text, 'unbalanced parentheses in specifier');
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
  const written = open === -1 ? text : text.slice(0, open);
  if (open !== -1 && !text.endsWith(')')) throw new RuleParseError(text, 'missing closing parenthesis');
  const specifier = open === -1 ? undefined : text.slice(open + 1, -1);

  if (written.startsWith(MCP_TOOL_PREFIX)) {
    const tool = mcpToolOf(text, written);
    if (specifier !== undefined) throw new RuleParseError(text, 'MCP rules do not take a specifier');
    return { tool, specifier };
  }
  if (written === NETWORK_RULE_SUBJECT) {
    if (specifier === undefined) throw new RuleParseError(text, `a ${NETWORK_RULE_SUBJECT} rule names a host: ${NETWORK_RULE_SUBJECT}(<host>) or ${NETWORK_RULE_SUBJECT}(${HOST_SUFFIX_PREFIX}<suffix>)`);
  } else if (!TOOL_NAMES.includes(written)) {
    throw new RuleParseError(text, 'unknown tool');
  }
  if (specifier !== undefined) validateSpecifier(text, written, specifier);
  return { tool: written, specifier };
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
