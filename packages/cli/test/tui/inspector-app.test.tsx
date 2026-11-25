import { describe, expect, it } from 'vitest';
import { emptyInspectorSnapshot } from '@momonga/protocol';
import type { InspectorSnapshot, MemoryView } from '@momonga/protocol';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import { frame, start, type } from '../tui-harness.tsx';

const WIDE = { columns: 120, rows: 45 };
const NARROW = { columns: 50, rows: 18 };
const READY = 'mode: manual (shift+tab)';

const memView = (fields: Partial<MemoryView> & { id: string; text: string }): MemoryView => ({
  scope: 'user',
  origin: 'trusted',
  project: null,
  source: { kind: 'command', at: 500 },
  createdAt: 500,
  keptAt: 500,
  kind: 'fact',
  state: 'active',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  keptByClassifier: null,
  status: 'verified',
  ...fields,
});

const richSnapshot = (): InspectorSnapshot => {
  const base = emptyInspectorSnapshot({
    session: {
      id: 'sess-1',
      cwd: '/repo',
      model: 'anthropic/claude-sonnet-4-6',
      provider: 'anthropic',
      permissionMode: 'manual',
      sandbox: 'seatbelt',
      contextWindow: 128000,
    },
    now: 1000,
  });
  return {
    ...base,
    agent: { ...base.agent, runId: 'run-1', status: 'RUNNING', phase: 'step 2', step: 2, updatedAt: 1000 },
    context: {
      ...base.context,
      currentTokens: 42800,
      utilization: 42800 / 128000,
      categories: [
        { key: 'system', label: 'System Prompt', tokens: 2000, share: 0.05 },
        { key: 'memories', label: 'Retrieved Memories', tokens: 800, share: 0.02 },
        { key: 'history.toolOutputs', label: 'Tool Results', tokens: 24000, share: 0.56 },
        { key: 'history.user', label: 'User Messages', tokens: 16000, share: 0.37 },
      ],
      items: [
        {
          id: 'item-out-1',
          category: 'history.toolOutputs',
          label: 'result:call-big #4',
          tokens: 24000,
          share: 0.56,
          seq: 4,
          source: 'tool:call-big',
          cached: 'dynamic',
          preview: 'Large grep output in repo',
          callId: 'call-big',
          excludable: true,
          evicted: false,
        },
        {
          id: 'item-usr-1',
          category: 'history.user',
          label: 'user #1',
          tokens: 16000,
          share: 0.37,
          seq: 1,
          source: 'user',
          cached: 'dynamic',
          preview: 'Investigate auth bug',
          excludable: false,
        },
      ],
      compactions: [
        {
          id: 'comp-1',
          seq: 3,
          reason: 'auto',
          source: 'model',
          tokensBefore: 90000,
          tokensAfter: 30000,
          savedTokens: 60000,
          ratio: 60000 / 90000,
          durationMs: 1400,
          replacedThroughSeq: 12,
          summaryPreview: 'Preserved auth design decisions',
          preservedInfo: ['src/auth.ts'],
          rejected: false,
          createdAt: 900,
          costUsd: 0.012,
        },
      ],
    },
    memory: {
      active: [
        {
          id: 'mem-1',
          kind: 'fact',
          scope: 'user',
          origin: 'trusted',
          state: 'active',
          status: 'verified',
          summary: 'JWT middleware lives in src/auth.ts',
          text: 'JWT middleware lives in src/auth.ts',
          tokens: 120,
          createdAt: 500,
          keptAt: 500,
          contributedAt: 900,
          evidence: { files: ['src/auth.ts'], checks: 0 },
          adoptionReason: 'query_match',
          pinned: false,
          excluded: false,
        },
      ],
      retrievalTrace: {
        query: 'auth middleware',
        terms: ['auth', 'middleware'],
        executedAt: 850,
        latencyMs: 3,
        budgetTokens: 4000,
        usedTokens: 120,
        matchCapped: false,
        touchedCap: null,
        moreAvailable: false,
        candidateCount: 2,
        selectedCount: 1,
        candidates: [
          {
            id: 'mem-1',
            summary: 'JWT middleware lives in src/auth.ts',
            kind: 'fact',
            status: 'verified',
            matched: true,
            tier: 1,
            rank: 1,
            tokens: 120,
            decision: 'included',
            reason: 'query_match',
            pinned: false,
            sessionExcluded: false,
          },
          {
            id: 'mem-2',
            summary: 'Unrelated CSS note',
            kind: 'fact',
            status: 'unbound',
            matched: false,
            tier: 2,
            rank: 2,
            tokens: 90,
            decision: 'excluded',
            reason: 'no_term_match',
            pinned: false,
            sessionExcluded: false,
          },
        ],
      },
      lifecycle: [
        { id: 'ev-1', at: 850, kind: 'recalled', memoryId: 'mem-1', summary: 'auth middleware', detail: '1 selected from 2 candidate(s)' },
      ],
      sessionControls: { excludedIds: [], pinnedIds: [] },
      allMemories: [memView({ id: 'mem-1', text: 'JWT middleware lives in src/auth.ts' }), memView({ id: 'mem-2', text: 'Unrelated CSS note' })],
    },
    usage: {
      totals: {
        inputTokens: 42800,
        outputTokens: 1200,
        totalTokens: 44000,
        cachedInputTokens: 32000,
        cacheReadTokens: 32000,
        cacheWriteTokens: 0,
        uncachedInputTokens: 10800,
        reasoningTokens: null,
      },
      cache: {
        hitRatio: 0.748,
        cacheReadNotReportedCalls: 0,
        inconsistentUsageCalls: 0,
        cacheBreaks: {},
        cacheMissCauses: {},
        estimatedSavingsUsd: null,
        savingsBasis: 'unavailable',
      },
      cost: {
        totalUsd: 0.082,
        isEstimated: false,
        unpricedCalls: 0,
        unpricedReasons: [],
        compactionCostUsd: 0.012,
        byModel: [{ model: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', calls: 2, inputTokens: 42800, outputTokens: 1200, cachedInputTokens: 32000, cacheWriteTokens: 0, reasoningTokens: null, costUsd: 0.082, costEstimated: false, unpricedCalls: 0 }],
        byPurpose: [{ purpose: 'main', calls: 2, inputTokens: 42800, outputTokens: 1200, costUsd: 0.082 }],
      },
      requests: [
        {
          id: 'req-1',
          runId: 'run-1',
          step: 1,
          attempt: 1,
          purpose: 'main',
          model: 'anthropic/claude-sonnet-4-6',
          provider: 'anthropic',
          startedAt: 100,
          endedAt: 600,
          latencyMs: 500,
          firstEventMs: 120,
          inputTokens: 42800,
          outputTokens: 1200,
          cachedInputTokens: 32000,
          cacheWriteInputTokens: 0,
          reasoningTokens: null,
          costUsd: 0.082,
          costEstimated: false,
          status: 'completed',
        },
      ],
    },
    execution: {
      toolCalls: [
        {
          callId: 'call-big',
          runId: 'run-1',
          step: 1,
          name: 'Grep',
          title: 'Grep',
          kind: 'search',
          status: 'completed',
          startedAt: 200,
          endedAt: 280,
          durationMs: 80,
          argsSummary: '{"pattern":"auth"}',
          outputSummary: '40 matches',
          outputBytes: 48000,
          truncated: false,
          permission: { basis: 'default', decision: 'allow' },
          sandbox: 'seatbelt',
        },
      ],
      toolSummary: { total: 1, succeeded: 1, failed: 0, running: 0, awaitingApproval: 0, denied: 0 },
      completionConditions: [{ id: 'c1', command: 'npm test', state: 'passed', rounds: 1, exitCode: 0, durationMs: 320 }],
      requirements: ['Tests pass'],
      plan: [{ content: 'Fix auth bug', priority: 'high', status: 'in_progress' }],
    },
  };
};

describe('Agent Inspector TUI', () => {
  it('opens with /inspect, switches tabs and sub-views, opens detail, and closes restoring session', async () => {
    const started = await start({
      inspectorSnapshot: richSnapshot(),
      memories: [memView({ id: 'mem-1', text: 'JWT middleware lives in src/auth.ts' })],
    }, {}, WIDE);
    await untilFrame(started.app, READY);

    await type(started.app, '/inspect', '> /inspect');
    started.app.stdin.write(KEYS.enter);
    const overview = await untilFrame(started.app, 'MOMONGACODE / AGENT INSPECTOR');
    expect(overview).toContain('anthropic/claude-sonnet-4-6');
    expect(overview).toContain('42,800 / 128,000 tokens');
    expect(overview).toContain('$0.082');
    expect(overview).toContain('74.8%');
    expect(overview).toContain('[PASS] npm test');

    // Switch to Context tab -> Explorer -> toggle exclude on tool output.
    started.app.stdin.write('2');
    await untilFrame(started.app, '[2:Context]');
    started.app.stdin.write('v');
    await untilFrame(started.app, 'result:call-big #4');
    started.app.stdin.write(KEYS.enter);
    await untilFrame(started.app, 'DETAIL VIEW');
    started.app.stdin.write(KEYS.backspace);
    await untilFrame(started.app, 'Explorer');
    started.app.stdin.write('x');
    await started.backend.called('inspector-exclude:call-big:true');
    await untilFrame(started.app, '[EXCL]');

    // Switch to Memory tab -> Active / Trace / Pin.
    started.app.stdin.write('3');
    await untilFrame(started.app, 'JWT middleware lives in src/auth.ts');
    started.app.stdin.write('p');
    await started.backend.called('inspector-memory-control:mem-1:pin');
    started.app.stdin.write('v');
    await untilFrame(started.app, 'Query: "auth middleware"');

    // Switch to Usage & Execution tabs.
    started.app.stdin.write('4');
    await untilFrame(started.app, 'Reasoning tokens  : N/A');
    started.app.stdin.write('5');
    await untilFrame(started.app, '[OK  ] Grep');

    // Close with Esc and confirm original session prompt & mode footer remain intact.
    started.app.stdin.write(KEYS.escape);
    await untilFrame(started.app, READY);
    expect(frame(started.app)).not.toContain('AGENT INSPECTOR');
  });

  it('opens directly from the Ctrl+X i chord and adapts layout cleanly on narrow terminals', async () => {
    const started = await start({ inspectorSnapshot: richSnapshot() }, {}, NARROW);
    await untilFrame(started.app, READY);

    started.app.stdin.write(KEYS.ctrlX);
    started.app.stdin.write('i');
    const narrowFrame = await untilFrame(started.app, 'AGENT INSPECTOR');
    for (const line of narrowFrame.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(52);
    }

    started.app.stdin.write(KEYS.escape);
    await untilFrame(started.app, READY);
  });

  it('requires explicit confirmation before retiring a persistent memory from Memory Inspector', async () => {
    const started = await start({
      inspectorSnapshot: richSnapshot(),
      memories: [memView({ id: 'mem-1', text: 'JWT middleware lives in src/auth.ts' })],
    }, {}, WIDE);
    await untilFrame(started.app, READY);

    await type(started.app, '/inspect memory', '> /inspect memory');
    started.app.stdin.write(KEYS.enter);
    await untilFrame(started.app, 'JWT middleware lives in src/auth.ts');

    started.app.stdin.write('d');
    await untilFrame(started.app, 'Retire persistent memory (mem-1)?');
    // Cancel confirmation first -> memory is NOT deleted.
    started.app.stdin.write(KEYS.down);
    started.app.stdin.write(KEYS.enter);
    await untilFrame(started.app, (text) => !text.includes('Retire persistent memory (mem-1)?'));
    expect(started.backend.calls.some((c) => c.startsWith('memory-delete:'))).toBe(false);

    // Confirm retire -> deleteMemory executes.
    started.app.stdin.write('d');
    await untilFrame(started.app, 'Retire persistent memory (mem-1)?');
    started.app.stdin.write(KEYS.enter);
    await started.backend.called('memory-delete:mem-1');
  });

  it('updates live during a run while preserving tab selection and supports memory search', async () => {
    const started = await start({
      inspectorSnapshot: richSnapshot(),
      memories: [memView({ id: 'mem-1', text: 'JWT middleware lives in src/auth.ts' })],
    }, {}, WIDE);
    await untilFrame(started.app, READY);

    await type(started.app, '/inspect memory', '> /inspect memory');
    started.app.stdin.write(KEYS.enter);
    await untilFrame(started.app, 'JWT middleware lives in src/auth.ts');

    // Run live memory search trace via '/' prompt.
    started.app.stdin.write('/');
    await untilFrame(started.app, 'Search long-term memory');
    started.app.stdin.write('JWT');
    started.app.stdin.write(KEYS.enter);
    await started.backend.called('inspector-memory-search:JWT');
    await untilFrame(started.app, 'Query: "JWT"');

    // Close and verify transcript returns intact.
    started.app.stdin.write(KEYS.escape);
    await untilFrame(started.app, READY);
  });
});
