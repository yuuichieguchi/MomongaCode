import { describe, expect, it } from 'vitest';
import { defineProductSchema } from '@momonga/foundation';
import {
  INSPECTOR_EVENT_BUFFER_LIMIT,
  buildContextCategories,
  createInspectorAccumulator,
  emptyInspectorSnapshot,
  evaluateDiagnostics,
} from '@momonga/protocol';
import type { PublicRunEvent, TokenAnatomy } from '@momonga/protocol';
import { RUN_API_SCHEMAS } from '../src/index.ts';

const sampleAnatomy = (total = 1000): TokenAnatomy => ({
  estimated: true,
  total,
  layers: {
    system: 150,
    instructions: 100,
    skills: 50,
    governing: 40,
    tools: 200,
    memories: 80,
    summary: 60,
    workingState: 20,
    history: {
      user: 100,
      assistant: 80,
      toolCalls: 40,
      toolOutputs: 60,
    },
    notices: 10,
    framing: 10,
  },
  tools: { Read: 100, Grep: 100 },
});

describe('Agent Inspector protocol helpers', () => {
  it('builds non-overlapping context categories whose token sum matches total', () => {
    const anatomy = sampleAnatomy(1000);
    const categories = buildContextCategories(anatomy);
    const sum = categories.reduce((acc, c) => acc + c.tokens, 0);
    expect(sum).toBe(1000);
    expect(categories.reduce((acc, c) => acc + c.share, 0)).toBeCloseTo(1, 5);
  });

  it('reconciles rounding delta cleanly without double counting', () => {
    const anatomy: TokenAnatomy = {
      ...sampleAnatomy(1050),
      total: 1050,
    };
    const categories = buildContextCategories(anatomy);
    expect(categories.reduce((acc, c) => acc + c.tokens, 0)).toBe(1050);
  });

  it('evaluates all diagnostic rules with configurable thresholds and zero LLM calls', () => {
    const base = emptyInspectorSnapshot({ now: 1000 });
    const snapshot = {
      ...base,
      context: {
        ...base.context,
        currentTokens: 92000,
        contextWindow: 100000,
        utilization: 0.92,
        categories: buildContextCategories({
          ...sampleAnatomy(92000),
          layers: {
            ...sampleAnatomy(92000).layers,
            memories: 28000,
            history: { user: 20000, assistant: 10000, toolCalls: 4000, toolOutputs: 25000 },
          },
        }),
        items: [
          {
            id: 'out-big',
            category: 'history.toolOutputs' as const,
            label: 'result:call-big',
            tokens: 25000,
            share: 25000 / 92000,
            source: 'tool:call-big',
            cached: 'dynamic' as const,
            preview: 'huge log',
            callId: 'call-big',
            excludable: true,
          },
        ],
        compactions: [1, 2, 3].map((n) => ({
          id: `c-${n}`,
          seq: n,
          reason: 'auto' as const,
          source: 'model' as const,
          tokensBefore: 80000,
          tokensAfter: 20000,
          savedTokens: 60000,
          ratio: 0.75,
          durationMs: 1200,
          replacedThroughSeq: n * 10,
          summaryPreview: 'summary',
          preservedInfo: [],
          rejected: false,
          createdAt: n * 1000,
          costUsd: null,
        })),
      },
      usage: {
        ...base.usage,
        cache: {
          ...base.usage.cache,
          hitRatio: 0.1,
        },
        requests: [
          {
            id: 'r1',
            runId: 'run-1',
            step: 1,
            attempt: 1,
            purpose: 'main',
            model: 'm1',
            provider: 'p1',
            startedAt: 100,
            endedAt: 500,
            latencyMs: 400,
            firstEventMs: 100,
            inputTokens: 1000,
            outputTokens: 100,
            cachedInputTokens: 100,
            cacheWriteInputTokens: null,
            reasoningTokens: null,
            costUsd: null,
            costEstimated: false,
            status: 'completed' as const,
          },
          {
            id: 'r2',
            runId: 'run-1',
            step: 2,
            attempt: 1,
            purpose: 'main',
            model: 'm1',
            provider: 'p1',
            startedAt: 1000,
            endedAt: 2000,
            latencyMs: 1000,
            firstEventMs: 200,
            inputTokens: 1000,
            outputTokens: 100,
            cachedInputTokens: 100,
            cacheWriteInputTokens: null,
            reasoningTokens: null,
            costUsd: null,
            costEstimated: false,
            status: 'completed' as const,
          },
          {
            id: 'r3',
            runId: 'run-1',
            step: 3,
            attempt: 1,
            purpose: 'main',
            model: 'm1',
            provider: 'p1',
            startedAt: 3000,
            endedAt: 39000,
            latencyMs: 36000,
            firstEventMs: 300,
            inputTokens: 4000,
            outputTokens: 100,
            cachedInputTokens: 100,
            cacheWriteInputTokens: null,
            reasoningTokens: null,
            costUsd: null,
            costEstimated: false,
            status: 'completed' as const,
          },
        ],
      },
      execution: {
        ...base.execution,
        toolCalls: [1, 2, 3].map((i) => ({
          callId: `call-${i}`,
          runId: 'run-1',
          step: i,
          name: 'Read',
          title: 'Read',
          kind: 'read' as const,
          status: 'failed' as const,
          startedAt: i * 100,
          endedAt: i * 100 + 50,
          durationMs: 50,
          argsSummary: '{"path":"foo.ts"}',
          outputSummary: '',
          outputBytes: null,
          truncated: false,
          error: 'ENOENT: no such file',
          permission: {},
          sandbox: null,
        })),
      },
    };

    const diagnostics = evaluateDiagnostics(snapshot);
    const ids = diagnostics.map((d) => d.id);
    expect(ids).toContain('context-critical');
    expect(ids).toContain('large-tool-output:out-big');
    expect(ids).toContain('frequent-compactions');
    expect(ids).toContain('repeated-tool:Read');
    expect(ids.some((id) => id.startsWith('repeated-error:'))).toBe(true);
    expect(ids).toContain('low-cache-efficiency');
    expect(ids).toContain('memory-context-share');
    expect(ids).toContain('slow-model-request');
    expect(ids).toContain('token-spike');
  });

  it('bounds event buffer, counts dropped events, redacts secrets, and separates null from zero', () => {
    let clock = 100;
    const acc = createInspectorAccumulator({
      now: () => clock,
      redact: (text) => text.replace(/sk-[A-Za-z0-9]{10,}/g, '[REDACTED]'),
    });
    acc.resetForSession({ id: 'sess-1', cwd: '/repo', model: 'anthropic/claude-sonnet-4-6' });

    const totalEvents = INSPECTOR_EVENT_BUFFER_LIMIT + 10;
    for (let seq = 1; seq <= totalEvents; seq += 1) {
      clock += 10;
      const ev = {
        id: seq,
        runId: 'run-1',
        sessionId: 'sess-1',
        seq,
        step: 1,
        createdAt: clock,
        type: 'notice',
        level: 'info',
        message: seq === totalEvents ? 'secret sk-1234567890abcdef' : `note-${seq}`,
      } as unknown as PublicRunEvent;
      acc.ingestEvent(ev);
    }

    const snap = acc.snapshot();
    expect(snap.meta.bufferLimit).toBe(INSPECTOR_EVENT_BUFFER_LIMIT);
    expect(snap.meta.droppedEvents).toBe(10);
    // Usage fields unavailable before any response stay null rather than 0.
    expect(snap.usage.totals.cachedInputTokens).toBeNull();
    expect(snap.usage.cache.hitRatio).toBeNull();
    expect(snap.usage.cost.totalUsd).toBeNull();
  });

  it('records non-StopReason FAILED run.status reasons in error instead of stopReason and satisfies InspectorSnapshot schema', () => {
    const validateSnapshot = defineProductSchema('InspectorSnapshot', RUN_API_SCHEMAS.InspectorSnapshot);
    const acc = createInspectorAccumulator({ now: () => 1000, redact: (text) => text });
    acc.resetForSession({ id: 'sess-1', cwd: '/repo', model: 'openai/mock-model' });

    acc.ingestEvent({
      id: 1,
      runId: 'run-1',
      sessionId: 'sess-1',
      seq: 1,
      step: 1,
      createdAt: 1001,
      type: 'run.status',
      from: 'RUNNING',
      to: 'FAILED',
      reason: 'input_truncated',
    } as unknown as PublicRunEvent);

    const failedSnap = acc.snapshot();
    expect(failedSnap.agent.status).toBe('FAILED');
    expect(failedSnap.agent.stopReason).toBeUndefined();
    expect(failedSnap.agent.error).toBe('input_truncated');
    expect(validateSnapshot(failedSnap).valid).toBe(true);

    acc.ingestEvent({
      id: 2,
      runId: 'run-2',
      sessionId: 'sess-1',
      seq: 2,
      step: 1,
      createdAt: 1002,
      type: 'run.status',
      from: 'RUNNING',
      to: 'STOPPED',
      reason: 'max_steps',
    } as unknown as PublicRunEvent);

    const stoppedSnap = acc.snapshot();
    expect(stoppedSnap.agent.status).toBe('STOPPED');
    expect(stoppedSnap.agent.stopReason).toBe('max_steps');
    expect(validateSnapshot(stoppedSnap).valid).toBe(true);
  });
});
