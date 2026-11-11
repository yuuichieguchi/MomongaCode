export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart'] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export const HOOK_COMMAND_TYPE = 'command' as const;

export const HOOK_BLOCKING_EXIT_CODE = 2;

export const HOOK_DEFAULT_TIMEOUT_SECONDS: { readonly default: number } & Readonly<Partial<Record<HookEvent, number>>> = { default: 600, UserPromptSubmit: 30 };

export const hookTimeoutSecondsOf = (event: HookEvent, value?: number): number => value ?? HOOK_DEFAULT_TIMEOUT_SECONDS[event] ?? HOOK_DEFAULT_TIMEOUT_SECONDS.default;

export const STOP_HOOK_MAX_CONTINUATIONS = 8;

export const STOP_HOOK_FEEDBACK_PREFIX = '[Stop hook feedback]\n';

export type HookCommand = { type: typeof HOOK_COMMAND_TYPE; command: string; timeout?: number };

export type HookMatcherGroup = { matcher?: string; hooks: HookCommand[] };

export type HooksSettings = Partial<Record<HookEvent, HookMatcherGroup[]>>;

export const HOOK_OUTCOMES = ['success', 'blocked', 'error', 'timed_out', 'cancelled'] as const;

export type HookOutcome = (typeof HOOK_OUTCOMES)[number];

export const HOOK_PRE_TOOL_DECISIONS = ['allow', 'ask', 'deny'] as const;

export type HookPreToolDecision = (typeof HOOK_PRE_TOOL_DECISIONS)[number];

export type HookStart = { event: HookEvent; command: string; callId?: string };

export type HookExecution = {
  hookEvent: HookEvent;
  command: string;
  outcome: HookOutcome;
  exitCode?: number;
  callId?: string;
  decision?: HookPreToolDecision | 'block';
  message?: string;
  systemMessage?: string;
  updatedInput?: Record<string, unknown>;
  stopReason?: string;
  halted?: true;
  durationMs: number;
};

export const hookTimeoutMs = (event: HookEvent, command: { timeout?: number }): number =>
  hookTimeoutSecondsOf(event, command.timeout) * 1000;

const LITERAL_MATCHER = /^[A-Za-z0-9_|]+$/;

export const hookMatcherError = (matcher: string): string | undefined => {
  if (matcher === '' || matcher === '*' || LITERAL_MATCHER.test(matcher)) return undefined;
  try {
    new RegExp(matcher);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

export const hookMatcherMatches = (matcher: string | undefined, value: string): boolean => {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (LITERAL_MATCHER.test(matcher)) return matcher.split('|').includes(value);
  return new RegExp(matcher).test(value);
};

export const HOOK_MATCHER_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse', 'SessionStart'];

export const HOOK_STOPPED_CODE = 'hook_stopped';

export const USER_PROMPT_BLOCKED_CODE = 'user_prompt_blocked';
