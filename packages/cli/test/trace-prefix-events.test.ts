import { describe, expect, it } from 'vitest';
import type { RunTraceView, UsageReport } from '@momonga/protocol';
import { renderTrace } from '../src/commands/trace.ts';

const usage = { total: { input_tokens: 1, output_tokens: 1 }, responses: [] } as unknown as UsageReport;

const SIGNATURE = 'Bash {"command":"npm test"}';

const trace: RunTraceView = {
  runId: 'run-1',
  summary: { steps: 3, chatCalls: 3, toolCalls: 2, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheReadNotReportedCalls: 0, errorCount: 0, durationMs: 30, chatResults: [] },
  spans: [],
  calls: [
    { step: 1, attempt: 1 },
    { step: 2, attempt: 1, prefix: { preservedItems: 4, toolsChanged: true, causes: ['tools_loaded', 'eviction'] } },
    { step: 3, attempt: 1, prefix: { preservedItems: 9, toolsChanged: false, causes: [] } },
  ],
  events: [
    { step: 1, type: 'tool.loaded', names: ['Grep', 'Glob'] },
    { step: 2, type: 'loop.warned', signature: SIGNATURE },
  ],
};

const lineOf = (text: string, prefix: string): string => text.split('\n').find((line) => line.startsWith(prefix)) ?? '';

describe('momonga trace shows the prefix causes, tool.loaded and loop.warned', () => {
  it('names the prefix causes on the line of the call they precede', () => {
    const text = renderTrace(trace, usage);
    const second = lineOf(text, 'step 2, attempt 1:');
    expect(second).toContain('tools_loaded');
    expect(second).toContain('eviction');
  });

  it('names no cause on a call whose prefix was kept', () => {
    const text = renderTrace(trace, usage);
    for (const cause of ['tools_loaded', 'eviction']) expect(lineOf(text, 'step 3, attempt 1:')).not.toContain(cause);
  });

  it('shows each tool.loaded with the names of the loaded tools', () => {
    expect(renderTrace(trace, usage)).toMatch(/loaded tools: Grep, Glob/);
  });

  it('shows each loop.warned with the signature of the repeated call', () => {
    const text = renderTrace(trace, usage);
    const warned = text.split('\n').find((line) => line.includes('loop warned')) ?? '';
    expect(warned).toContain(SIGNATURE);
  });
});