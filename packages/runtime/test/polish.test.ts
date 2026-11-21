import { describe, expect, it } from 'vitest';
import {
  buildPolishPrompt,
  DEFAULT_POLISH_AUDIENCE,
  MAX_POLISH_ITERATIONS,
  parseClarityEvaluation,
  shouldStopPolish,
} from '../src/polish.ts';
import type { PolishIssue } from '../src/polish.ts';

const sampleIssue = (severity: PolishIssue['severity']): PolishIssue => ({
  span: 'The handler reconciles state.',
  issue_type: 'excessive_abstraction',
  severity,
  evidence: 'Does not specify which state or failure case is reconciled.',
  revision_instruction: 'Name the concrete session field and failure condition.',
  requires_source_check: true,
});

describe('polish workflow primitives', () => {
  it('parses valid structured clarity evaluations and rejects malformed JSON or fields', () => {
    const valid = parseClarityEvaluation(JSON.stringify({ issues: [sampleIssue('high')] }));
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.issues).toHaveLength(1);

    expect(parseClarityEvaluation('not json').ok).toBe(false);
    expect(parseClarityEvaluation(JSON.stringify({ wrong: [] })).ok).toBe(false);
    expect(
      parseClarityEvaluation(
        JSON.stringify([{ ...sampleIssue('high'), issue_type: 'made_up_type' }]),
      ).ok,
    ).toBe(false);
  });

  it('enforces bounded stopping conditions (no actionable issues, no improvement, max iterations)', () => {
    expect(shouldStopPolish(1, [])).toEqual({ stop: true, reason: 'no_actionable_issues' });
    expect(shouldStopPolish(1, [sampleIssue('low')])).toEqual({ stop: true, reason: 'no_actionable_issues' });
    expect(shouldStopPolish(1, [sampleIssue('high')])).toEqual({ stop: false, reason: 'continue' });
    expect(shouldStopPolish(1, [sampleIssue('high'), sampleIssue('medium')], 2)).toEqual({ stop: true, reason: 'no_improvement' });
    expect(shouldStopPolish(MAX_POLISH_ITERATIONS, [sampleIssue('high')], 3)).toEqual({ stop: true, reason: 'max_iterations' });
  });

  it('builds audience-aware prompts for both answer and file targets', () => {
    const answerPrompt = buildPolishPrompt({ target: { kind: 'answer', text: 'Draft text' } });
    expect(answerPrompt).toContain(DEFAULT_POLISH_AUDIENCE);
    expect(answerPrompt).toContain('Draft text');
    expect(answerPrompt).toContain('Do NOT assign numeric scores');
    expect(answerPrompt).toContain('Semantic Validator');

    const filePrompt = buildPolishPrompt({ target: { kind: 'file', path: 'docs/spec.md' }, audience: '非エンジニア' });
    expect(filePrompt).toContain('docs/spec.md');
    expect(filePrompt).toContain('非エンジニア');
    expect(filePrompt).toMatch(/confirmation/i);
  });
});
