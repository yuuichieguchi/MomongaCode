export const PATH_TOOL_NAMES = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;

export const COMMAND_TOOL_NAME = 'Bash';

export const OPERATION_RULE_TOOLS = ['GitBranch', 'GitStage', 'GitCommit', 'GitFetch', 'GitUpdate', 'GitPush', 'PullRequestStatus', 'PullRequestComments', 'PullRequestCreate', 'PullRequestMerge', 'PullRequestComment', 'IssueRead', 'IssueComment'] as const;

export const BUILTIN_TOOL_NAMES = [...PATH_TOOL_NAMES, COMMAND_TOOL_NAME, 'BashOutput', 'KillBash', 'ReadOutput', 'UpdatePlan'] as const;

export const MEMORY_SAVE_TOOL_NAME = 'MemorySave';

export const MEMORY_SEARCH_TOOL_NAME = 'MemorySearch';

export const HISTORY_SEARCH_TOOL_NAME = 'HistorySearch';

export const HISTORY_READ_TOOL_NAME = 'HistoryRead';

export const RULE_PROPOSE_TOOL_NAME = 'RulePropose';

export const AGENT_TOOL_NAME = 'Agent';

export const LOAD_TOOLS_TOOL_NAME = 'LoadTools';

export const ACTIVATE_SKILL_TOOL_NAME = 'activate_skill';

export const TOOL_NAMES: readonly string[] = [
  ...BUILTIN_TOOL_NAMES,
  ...OPERATION_RULE_TOOLS,
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_SEARCH_TOOL_NAME,
  HISTORY_SEARCH_TOOL_NAME,
  HISTORY_READ_TOOL_NAME,
  RULE_PROPOSE_TOOL_NAME,
  AGENT_TOOL_NAME,
  LOAD_TOOLS_TOOL_NAME,
  ACTIVATE_SKILL_TOOL_NAME,
];
