import { describe, expect, it } from 'vitest';
import { auditSystemPrompt, MAX_COMPACT_SYSTEM_PROMPT_TOKENS, MAX_STANDARD_SYSTEM_PROMPT_TOKENS, standardAuditMatrix } from '@momonga/eval';
import { buildSystemPromptSections } from '@momonga/runtime';
import { TEST_FENCE } from '@momonga/testkit';

describe('system prompt constraint-aware audit (CAPO-style)', () => {
  it('passes every configuration in the standard audit matrix with zero violations', () => {
    for (const context of standardAuditMatrix(TEST_FENCE)) {
      const audit = auditSystemPrompt(context, buildSystemPromptSections(context));
      expect(audit.violations).toEqual([]);
    }
  });

  it('keeps compact prompts strictly smaller than standard prompts and within budget', () => {
    const standardCtx = {
      cwd: '/work/project',
      platform: 'darwin',
      fence: TEST_FENCE,
      activeTools: ['ReadOutput', 'RulePropose', 'UpdatePlan'],
      capabilities: { parallelToolCalls: true, contextWindow: 200_000 },
    };
    const compactCtx = {
      cwd: '/work/project',
      platform: 'darwin',
      fence: TEST_FENCE,
      activeTools: ['ReadOutput', 'RulePropose', 'UpdatePlan'],
      capabilities: { parallelToolCalls: true, contextWindow: 16_384 },
    };
    const standard = auditSystemPrompt(standardCtx, buildSystemPromptSections(standardCtx));
    const compact = auditSystemPrompt(compactCtx, buildSystemPromptSections(compactCtx));

    expect(standard.estimatedTokens).toBeLessThanOrEqual(MAX_STANDARD_SYSTEM_PROMPT_TOKENS);
    expect(compact.estimatedTokens).toBeLessThanOrEqual(MAX_COMPACT_SYSTEM_PROMPT_TOKENS);
    expect(compact.estimatedTokens).toBeLessThan(standard.estimatedTokens);
  });
});
