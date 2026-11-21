import { describe, expect, it } from 'vitest';
import { TEST_FENCE } from '@momonga/testkit';
import { auditSystemPrompt, MAX_COMPACT_SYSTEM_PROMPT_TOKENS, MAX_STANDARD_SYSTEM_PROMPT_TOKENS, standardAuditMatrix } from '../src/system-prompt-eval.ts';

describe('system prompt constraint-aware audit (CAPO-style)', () => {
  it('passes every configuration in the standard audit matrix with zero violations', () => {
    for (const context of standardAuditMatrix(TEST_FENCE)) {
      const audit = auditSystemPrompt(context);
      expect(audit.violations).toEqual([]);
    }
  });

  it('keeps compact prompts strictly smaller than standard prompts and within budget', () => {
    const standard = auditSystemPrompt({
      cwd: '/work/project',
      platform: 'darwin',
      fence: TEST_FENCE,
      activeTools: ['ReadOutput', 'RulePropose', 'UpdatePlan'],
      capabilities: { parallelToolCalls: true, contextWindow: 200_000 },
    });
    const compact = auditSystemPrompt({
      cwd: '/work/project',
      platform: 'darwin',
      fence: TEST_FENCE,
      activeTools: ['ReadOutput', 'RulePropose', 'UpdatePlan'],
      capabilities: { parallelToolCalls: true, contextWindow: 16_384 },
    });

    expect(standard.estimatedTokens).toBeLessThanOrEqual(MAX_STANDARD_SYSTEM_PROMPT_TOKENS);
    expect(compact.estimatedTokens).toBeLessThanOrEqual(MAX_COMPACT_SYSTEM_PROMPT_TOKENS);
    expect(compact.estimatedTokens).toBeLessThan(standard.estimatedTokens);
  });
});
