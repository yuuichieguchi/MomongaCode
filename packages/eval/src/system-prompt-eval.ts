import {
  buildSystemPrompt,
  buildSystemPromptSections,
  COMPACT_CONTEXT_WINDOW_THRESHOLD,
  ESTIMATED_CHARACTERS_PER_TOKEN,
  OUTPUT_STYLES,
  TOOL_OUTPUT_TAG,
} from '@momonga/protocol';
import type { OutputStyle, ReasoningEffort, SystemPromptContext } from '@momonga/protocol';

export type PromptConstraintViolation = {
  readonly code: string;
  readonly message: string;
};

export type SystemPromptAudit = {
  readonly estimatedTokens: number;
  readonly stableTokens: number;
  readonly violations: readonly PromptConstraintViolation[];
};

export const MAX_STANDARD_SYSTEM_PROMPT_TOKENS = 700;
export const MAX_COMPACT_SYSTEM_PROMPT_TOKENS = 550;

export const estimatePromptTokens = (text: string): number => Math.ceil(text.length / ESTIMATED_CHARACTERS_PER_TOKEN);

export const auditSystemPrompt = (context: SystemPromptContext): SystemPromptAudit => {
  const sections = buildSystemPromptSections(context);
  const full = buildSystemPrompt(context);
  const estimatedTokens = estimatePromptTokens(full);
  const stableTokens = estimatePromptTokens(sections.stable);
  const violations: PromptConstraintViolation[] = [];

  const compact = context.concise === true || (context.capabilities?.contextWindow !== undefined && context.capabilities.contextWindow <= COMPACT_CONTEXT_WINDOW_THRESHOLD);
  const maxTokens = compact ? MAX_COMPACT_SYSTEM_PROMPT_TOKENS : MAX_STANDARD_SYSTEM_PROMPT_TOKENS;
  if (estimatedTokens > maxTokens) {
    violations.push({ code: 'token_budget_exceeded', message: `estimated ${estimatedTokens} tokens exceeds budget ${maxTokens}` });
  }

  if (!sections.stable.includes('1. System instructions')) {
    violations.push({ code: 'missing_system_tier', message: 'stable section must declare system instructions as tier 1' });
  }
  if (!sections.stable.includes('2. The user\'s direct messages')) {
    violations.push({ code: 'missing_user_tier', message: 'stable section must declare user direct messages as tier 2' });
  }
  if (!sections.stable.includes('4. ')) {
    violations.push({ code: 'missing_external_data_tier', message: 'stable section must declare external data as tier 4' });
  }

  if (context.tools === 'none') {
    if (full.includes(`<${TOOL_OUTPUT_TAG}`)) {
      violations.push({ code: 'tool_tag_in_tool_less', message: 'tool-less prompt must not include tool output envelope' });
    }
    if (sections.toolsAndAdaptation !== '') {
      violations.push({ code: 'tool_section_in_tool_less', message: 'tool-less prompt must have empty toolsAndAdaptation section' });
    }
  } else {
    if (!sections.environment.includes(`<${TOOL_OUTPUT_TAG}`)) {
      violations.push({ code: 'missing_boundary_envelope', message: 'tool prompt must include tool output boundary envelope' });
    }
    if (context.activeTools !== undefined) {
      const active = new Set(context.activeTools);
      for (const toolName of ['ReadOutput', 'RulePropose', 'UpdatePlan']) {
        if (!active.has(toolName) && sections.toolsAndAdaptation.includes(toolName)) {
          violations.push({ code: 'inactive_tool_leaked', message: `inactive tool ${toolName} appeared in prompt` });
        }
        if (active.has(toolName) && !sections.toolsAndAdaptation.includes(toolName)) {
          violations.push({ code: 'active_tool_missing', message: `active tool ${toolName} missing from prompt` });
        }
      }
    }
    const mentionsParallel = /in parallel/i.test(sections.toolsAndAdaptation);
    if (context.capabilities?.parallelToolCalls === true && !mentionsParallel) {
      violations.push({ code: 'missing_parallel_guidance', message: 'parallelToolCalls=true must include parallel read guidance' });
    }
    if (context.capabilities?.parallelToolCalls !== true && mentionsParallel) {
      violations.push({ code: 'unexpected_parallel_guidance', message: 'parallelToolCalls!=true must not include parallel read guidance' });
    }
  }

  if (sections.stable.includes(context.cwd) || sections.stable.includes(context.fence)) {
    violations.push({ code: 'volatile_in_stable_prefix', message: 'stable prefix must not contain session cwd or fence' });
  }

  return { estimatedTokens, stableTokens, violations };
};

export const standardAuditMatrix = (fence: string): readonly SystemPromptContext[] => {
  const base = { cwd: '/work/project', platform: 'darwin', fence };
  const contexts: SystemPromptContext[] = [
    { ...base, tools: 'none' },
    { ...base, activeTools: ['ReadOutput', 'UpdatePlan'], capabilities: { parallelToolCalls: true, contextWindow: 200_000 }, effort: 'high' },
    { ...base, activeTools: ['ReadOutput'], capabilities: { parallelToolCalls: false, contextWindow: 16_384 }, effort: 'low' },
    { ...base, activeTools: [], capabilities: { contextWindow: 128_000 }, concise: true },
  ];
  for (const style of OUTPUT_STYLES) {
    contexts.push({ ...base, activeTools: ['ReadOutput', 'RulePropose', 'UpdatePlan'], outputStyle: style as OutputStyle });
  }
  for (const effort of ['none', 'low', 'medium', 'high', 'xhigh'] as ReasoningEffort[]) {
    contexts.push({ ...base, activeTools: ['ReadOutput'], effort });
  }
  return contexts;
};
