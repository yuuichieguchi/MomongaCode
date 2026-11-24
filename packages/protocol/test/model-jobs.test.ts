import { describe, expect, it } from 'vitest';
import {
  CHOICE_VERDICT_SCHEMA,
  MODEL_JOBS,
  canDoJob,
  classifierAllows,
  modelJobRefusal,
  modelsForJob,
} from '../src/index.ts';
import type { ModelJob, ModelOutputKind } from '../src/index.ts';

describe('model-jobs', () => {
  const textModel: { canon: string; outputKind?: ModelOutputKind } = { canon: 'openai/gpt-5', outputKind: 'text' };
  const implicitTextModel: { canon: string; outputKind?: ModelOutputKind } = { canon: 'ollama/llama3' };
  const choiceModel: { canon: string; outputKind?: ModelOutputKind } = { canon: 'openrouter/typesafe/jev-1.14', outputKind: 'choice' };

  const textOnlyJobs: readonly ModelJob[] = ['start', 'fallback', 'compaction', 'reflection', 'analysis', 'subagent', 'session', 'billing'];
  const choiceJobs: readonly ModelJob[] = ['classifier', 'memoryReview'];

  it('allows text models (explicit or omitted outputKind) for every job', () => {
    for (const job of MODEL_JOBS) {
      expect(canDoJob(textModel, job)).toBe(true);
      expect(canDoJob(implicitTextModel, job)).toBe(true);
    }
  });

  it('allows choice models only for classifier and memoryReview', () => {
    for (const job of textOnlyJobs) expect(canDoJob(choiceModel, job)).toBe(false);
    for (const job of choiceJobs) expect(canDoJob(choiceModel, job)).toBe(true);
  });

  it('filters model lists by job eligibility', () => {
    const all = [choiceModel, textModel, implicitTextModel];
    expect(modelsForJob(all, 'session')).toEqual([textModel, implicitTextModel]);
    expect(modelsForJob(all, 'start')).toEqual([textModel, implicitTextModel]);
    expect(modelsForJob(all, 'classifier')).toEqual(all);
    expect(modelsForJob(all, 'memoryReview')).toEqual(all);
  });

  it('formats exact refusal messages for every non-judging job (J5-A, J8-1, J20-B)', () => {
    expect(modelJobRefusal('typesafe/jev-1.14', 'start')).toBe('typesafe/jev-1.14 only judges approvals; it cannot be the model for new sessions.');
    expect(modelJobRefusal('typesafe/jev-1.14', 'fallback')).toBe('typesafe/jev-1.14 only judges approvals; it cannot be the model for fallback.');
    expect(modelJobRefusal('typesafe/jev-1.14', 'compaction')).toBe('typesafe/jev-1.14 only judges approvals; it cannot be the model for summaries.');
    expect(modelJobRefusal('typesafe/jev-1.14', 'reflection')).toBe('typesafe/jev-1.14 only judges approvals; it cannot be the model for reflection.');
    expect(modelJobRefusal('typesafe/jev-1.14', 'analysis')).toBe('typesafe/jev-1.14 only judges approvals; it cannot be the model for analysis.');
    expect(modelJobRefusal('typesafe/jev-1.14', 'subagent')).toBe('typesafe/jev-1.14 only judges approvals; it cannot be the model for subagents.');
    expect(modelJobRefusal('typesafe/jev-1.14', 'session')).toBe('typesafe/jev-1.14 only judges approvals; it cannot be the model for a session.');
    expect(modelJobRefusal('typesafe/jev-1.14', 'billing')).toBe('typesafe/jev-1.14 only judges approvals; it cannot be the model for a billing rule.');
  });

  it('exposes CHOICE_VERDICT_SCHEMA without rationale and evaluates classifierAllows without rationale', () => {
    expect(CHOICE_VERDICT_SCHEMA.required).toEqual(['verdict', 'confidence']);
    expect(Object.keys(CHOICE_VERDICT_SCHEMA.properties)).toEqual(['verdict', 'confidence']);
    expect(classifierAllows({ verdict: 'safe', confidence: 'high' })).toBe(true);
    expect(classifierAllows({ verdict: 'safe', confidence: 'medium' })).toBe(false);
    expect(classifierAllows({ verdict: 'unsafe', confidence: 'high' })).toBe(false);
  });
});
