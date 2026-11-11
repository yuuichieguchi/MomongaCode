import { describe, expect, it } from 'vitest';
import type { RunTraceView, TokenAnatomy, UsageReport } from '@momonga/protocol';
import { renderTrace } from '../src/commands/trace.ts';

const ANATOMY: TokenAnatomy = {
  estimated: true,
  total: 300,
  layers: {
    system: 20,
    tools: 100,
    instructions: 30,
    skills: 0,
    governing: 0,
    memories: 10,
    summary: 0,
    workingState: 0,
    history: { user: 40, assistant: 30, toolCalls: 20, toolOutputs: 40 },
    notices: 10,
  },
  tools: { Read: 40, Write: 60 },
};

const usage = { total: { input_tokens: 1, output_tokens: 1 }, responses: [] } as unknown as UsageReport;

const viewWith = (calls: unknown[]): RunTraceView =>
  ({
    runId: 'run-1',
    summary: { steps: 2, chatCalls: 0, sideCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, errorCount: 0, durationMs: 30, chatResults: [] },
    spans: [],
    calls,
  }) as unknown as RunTraceView;

describe('renderTrace shows what each model call was made of', () => {
  it('prints the layers of every call, marked as estimates, with the tools by name', () => {
    const text = renderTrace(viewWith([{ step: 1, attempt: 1, anatomy: ANATOMY }]), usage);

    const line = text.split('\n').find((entry) => entry.includes('step 1, attempt 1'));
    expect(line).toBeDefined();
    expect(line).toContain('300 tokens (estimated)');
    expect(line).toContain('system 20');
    expect(line).toContain('tools 100 (Read 40, Write 60)');
    expect(line).toContain('instructions 30');
    expect(line).toContain('memories 10');
    expect(line).toContain('history.user 40');
    expect(line).toContain('history.assistant 30');
    expect(line).toContain('history.toolCalls 20');
    expect(line).toContain('history.toolOutputs 40');
    expect(line).toContain('notices 10');
    expect(line).not.toContain('skills');
  });

  it('says the layers were not recorded for a call from before the anatomy existed', () => {
    const text = renderTrace(viewWith([{ step: 1, attempt: 1, anatomy: ANATOMY }, { step: 2, attempt: 1 }]), usage);

    expect(text).toContain('step 2, attempt 1: layers not recorded');
    expect(text.indexOf('step 1, attempt 1')).toBeLessThan(text.indexOf('step 2, attempt 1'));
  });
});
