import { describe, expect, it } from 'vitest';
import { emptyInspectorSnapshot } from '@momonga/protocol';
import type { InspectorSnapshot, MemoryView } from '@momonga/protocol';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import { start, type } from '../tui-harness.tsx';

const WIDE = { columns: 120, rows: 45 };
const NARROW = { columns: 50, rows: 18 };
const READY = 'mode: manual (shift+tab)';
const CLOSED = (text: string): boolean => !text.includes('AGENT INSPECTOR') && text.includes(READY);

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
    expect(overview).toContain('> esc to return');
    expect(overview).toContain('anthropic/claude-sonnet-4-6');
    expect(overview).toContain('42,800 / 128,000 tokens');
    expect(overview).toContain('$0.082');
    expect(overview).toContain('74.8%');
    expect(overview).toContain('[PASS] npm test');

    // Switch to Context tab -> Section bar -> Explorer -> list row -> Detail -> toggle exclude.
    started.app.stdin.write('2');
    await untilFrame(started.app, '[2:Context]');
    started.app.stdin.write(KEYS.down);
    await untilFrame(started.app, '> Section:');
    started.app.stdin.write(KEYS.right);
    await untilFrame(started.app, '[explorer]');
    started.app.stdin.write(KEYS.down);
    await untilFrame(started.app, '> history.toolOutputs');
    started.app.stdin.write(KEYS.enter);
    await untilFrame(started.app, 'DETAIL VIEW');
    started.app.stdin.write(KEYS.backspace);
    await untilFrame(started.app, 'Explorer');
    started.app.stdin.write('x');
    await started.backend.called('inspector-exclude:call-big:true');
    await untilFrame(started.app, '[EXCL]');

    // Switch to Memory tab -> Section bar -> Active list row -> Pin -> back to Section bar -> Trace.
    started.app.stdin.write('3');
    await untilFrame(started.app, 'JWT middleware lives in src/auth.ts');
    started.app.stdin.write(KEYS.down);
    await untilFrame(started.app, '> Section:');
    started.app.stdin.write(KEYS.down);
    await untilFrame(started.app, '> verified');
    started.app.stdin.write('p');
    await started.backend.called('inspector-memory-control:mem-1:pin');
    started.app.stdin.write(KEYS.up);
    await untilFrame(started.app, '> Section:');
    started.app.stdin.write(KEYS.right);
    await untilFrame(started.app, 'Query: "auth middleware"');

    // Switch to Usage & Execution tabs.
    started.app.stdin.write('4');
    await untilFrame(started.app, 'Reasoning tokens  : N/A');
    started.app.stdin.write('5');
    await untilFrame(started.app, '[OK  ] Grep');

    // Close with Esc and confirm original session prompt & mode footer remain intact.
    started.app.stdin.write(KEYS.escape);
    await untilFrame(started.app, CLOSED);
    expect(started.app.lastFrame()).not.toContain('AGENT INSPECTOR');
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
    await untilFrame(started.app, CLOSED);
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

    // Move focus down into the memory list before retiring.
    started.app.stdin.write(KEYS.down);
    await untilFrame(started.app, '> Section:');
    started.app.stdin.write(KEYS.down);
    await untilFrame(started.app, '> verified');

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
    await untilFrame(started.app, CLOSED);
  });

  it('navigates 2D spatially across tabs, section bars, and lists with arrow keys', async () => {
    const started = await start({ inspectorSnapshot: richSnapshot() }, {}, WIDE);
    await untilFrame(started.app, READY);

    await type(started.app, '/inspect', '> /inspect');
    started.app.stdin.write(KEYS.enter);
    const initial = await untilFrame(started.app, '[1:Overview]');
    expect(initial).toContain('[left/right] Switch tab');

    // On Overview (no sections), Down does nothing.
    started.app.stdin.write(KEYS.down);
    // Left/Right on Tab bar switches tabs cleanly (including wrap).
    started.app.stdin.write(KEYS.right);
    await untilFrame(started.app, '>  1:Overview  [2:Context]');
    started.app.stdin.write(KEYS.right);
    await untilFrame(started.app, '[3:Memory]');
    started.app.stdin.write(KEYS.left);
    await untilFrame(started.app, '[2:Context]');

    // Down from Tab bar enters Section bar; Left/Right switches sections.
    started.app.stdin.write(KEYS.down);
    const sectionBar = await untilFrame(started.app, '> Section: [breakdown]');
    expect(sectionBar).toContain('[left/right] Switch section');
    started.app.stdin.write(KEYS.right);
    await untilFrame(started.app, '> Section: breakdown  [explorer]');
    started.app.stdin.write(KEYS.left);
    await untilFrame(started.app, '> Section: [breakdown]');

    // Down into list, Left/Right inside list does not jump tabs or sections, Up twice returns to Tab bar.
    started.app.stdin.write(KEYS.down);
    await untilFrame(started.app, '> System Prompt');
    started.app.stdin.write(KEYS.right);
    expect(started.app.lastFrame()).toContain('> System Prompt');
    started.app.stdin.write(KEYS.up);
    await untilFrame(started.app, '> Section: [breakdown]');
    started.app.stdin.write(KEYS.up);
    await untilFrame(started.app, '>  1:Overview  [2:Context]');

    started.app.stdin.write(KEYS.escape);
    await untilFrame(started.app, CLOSED);
  });

  it('shows window-relative percentages with Free space, stops selection on visible rows, and drills down on Enter', async () => {
    const snap = richSnapshot();
    const withZeroRow = {
      ...snap,
      context: {
        ...snap.context,
        categories: [
          ...snap.context.categories,
          { key: 'framing' as const, label: 'Framing', tokens: 0, share: 0 },
        ],
      },
    };
    const started = await start({ inspectorSnapshot: withZeroRow }, {}, WIDE);
    await untilFrame(started.app, READY);

    await type(started.app, '/inspect context', '> /inspect context');
    started.app.stdin.write(KEYS.enter);
    const breakdown = await untilFrame(started.app, 'Tool Results');
    // 24,000 / 128,000 = 18.8%, Free space = 85,200 (66.6%); zero-token row hidden.
    expect(breakdown).toContain('18.8%');
    expect(breakdown).toContain('Free space');
    expect(breakdown).toContain('85,200');
    expect(breakdown).toContain('66.6%');
    expect(breakdown).not.toContain('Framing');

    // Enter list and press Down past the end -> stops on the last visible positive category (User Messages).
    started.app.stdin.write(KEYS.down);
    await untilFrame(started.app, '> Section: [breakdown]');
    started.app.stdin.write(KEYS.down);
    await untilFrame(started.app, '> System Prompt');
    started.app.stdin.write(KEYS.down);
    started.app.stdin.write(KEYS.down);
    await untilFrame(started.app, '> Tool Results');
    started.app.stdin.write(KEYS.down);
    started.app.stdin.write(KEYS.down);
    started.app.stdin.write(KEYS.down);
    const clamped = await untilFrame(started.app, '> User Messages');
    expect(clamped).not.toContain('> Free space');

    // Move back up to Tool Results and press Enter -> opens Explorer filtered to history.toolOutputs.
    started.app.stdin.write(KEYS.up);
    await untilFrame(started.app, '> Tool Results');
    started.app.stdin.write(KEYS.enter);
    const explorer = await untilFrame(started.app, 'filter=history.toolOutputs');
    expect(explorer).toContain('> history.toolOutputs');

    started.app.stdin.write(KEYS.escape);
    await untilFrame(started.app, CLOSED);
  });

  it('keeps selection aligned with newest-first rows in Usage requests', async () => {
    const base = richSnapshot();
    const twoRequests = {
      ...base,
      usage: {
        ...base.usage,
        requests: [
          { ...base.usage.requests[0]!, id: 'req-older', step: 1, model: 'older-model' },
          { ...base.usage.requests[0]!, id: 'req-newer', step: 2, model: 'newer-model' },
        ],
      },
    };
    const started = await start({ inspectorSnapshot: twoRequests }, {}, WIDE);
    await untilFrame(started.app, READY);

    await type(started.app, '/inspect usage', '> /inspect usage');
    started.app.stdin.write(KEYS.enter);
    await untilFrame(started.app, '[4:Usage]');
    started.app.stdin.write(KEYS.down);
    await untilFrame(started.app, '> Section: [tokens]');
    started.app.stdin.write(KEYS.left);
    await untilFrame(started.app, '[requests]');
    started.app.stdin.write(KEYS.down);
    await untilFrame(started.app, '> s2.1');
    started.app.stdin.write(KEYS.enter);
    const detail = await untilFrame(started.app, 'DETAIL VIEW');
    expect(detail).toContain('ID       : req-newer');

    started.app.stdin.write(KEYS.escape);
    await untilFrame(started.app, '[4:Usage]');
  });

  it('keeps the input box with typed draft dimmed and preserves it while Agent Inspector is open', async () => {
    const started = await start({ inspectorSnapshot: richSnapshot() }, {}, WIDE);
    await untilFrame(started.app, READY);

    await type(started.app, 'draft text', '> draft text');
    started.app.stdin.write(KEYS.ctrlX);
    started.app.stdin.write('i');
    const openFrame = await untilFrame(started.app, 'MOMONGACODE / AGENT INSPECTOR');
    expect(openFrame).toContain('> draft text');

    started.app.stdin.write(KEYS.escape);
    await untilFrame(started.app, (frame) => !frame.includes('AGENT INSPECTOR') && frame.includes('> draft text'));
  });
});
