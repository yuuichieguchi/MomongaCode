import fs from 'node:fs';
import { sha256Hex } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { ACCEPTANCE_MAX_OUTPUT, ACCEPTANCE_WINDOW, ESCALATION_NOTICE_PREFIX, GREP_AND_READ_BACK_CALLS, PERTURBATIONS, escalationBudgetVerdict, fitLimitAfterReport, budgetFor, dryRun, factsOf, verdictOf, isCompactionRequest, journalOfRows, ofType, plannedSteps, summaryRoute, summaryTextOf, upstreamRepliesOf, wireTokensOfBody, acceptanceTarget, overflowStepRange } from './budget.ts';
import { capacityFor } from '../../packages/context/src/budget.ts';
import { createTokenMeter } from '@momonga/context';
import { ESTIMATED_CHARACTERS_PER_TOKEN, ESTIMATED_ERROR_SHAPE, countReplyOf } from '@momonga/protocol';
import type { InputItem } from '@momonga/protocol';
import type { FillerShape, JournalEvent, PlanCaseSpec } from './budget.ts';
import type { Capabilities } from '@momonga/protocol';
import { readDb } from './db.ts';
import { createGatewayCountClient } from './gateway-count.ts';
import { HAYSTACK_FILE_NAME, HAYSTACK_LINE_COUNT, NEEDLE, HAYSTACK_READ_BACK_LINE, HAYSTACK_TARGET_CHARS, grepLinesFor, grepPrefixOf, writeHaystack } from './haystack.ts';
import { createE2eHome } from './home.ts';
import type { E2eHome } from './home.ts';
import { createRuntimeClient } from './runtime-client.ts';
import { startStack } from './stack.ts';
import { chatCompletions, messagesOf, reportedTokensOf, reportedTokensOfRequest, textReply } from './upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS } from './wait.ts';
import { firstGeneration } from '@momonga/testkit';

const ROUTED_TASK = 'answer from the route';
const COMPARED_TYPES: ReadonlySet<string> = new Set(['user.message', 'model.requested', 'tool.completed', 'context.truncated', 'context.compacted', 'notice', 'run.status']);

type EventRow = { seq: number; type: string; payload_json: string };

const runTask = async (home: E2eHome, task: string): Promise<string> => {
  const runtime = createRuntimeClient(home);
  try {
    const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
    const { run } = await runtime.createRun(session.id, task);
    const stream = runtime.events(run.id);
    await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
    await stream.close();
    return run.id;
  } finally {
    await runtime.close();
  }
};

const journalOf = (home: E2eHome, runId: string): JournalEvent[] =>
  journalOfRows(readDb<EventRow>(home.paths.databases.runtime, 'SELECT seq, type, payload_json FROM events WHERE run_id = ? ORDER BY seq', runId));

const TOOL_OUTPUT_HEAD_CHARS = 80;

const comparable = (journal: readonly JournalEvent[]): string[] =>
  journal
    .filter((event) => COMPARED_TYPES.has(event.type))
    .map((event) => {
      if (event.type === 'run.status') return `run.status:${String(event.data['to'])}`;
      if (event.type === 'notice') return `notice:${String(event.data['message'])}`;
      if (event.type === 'tool.completed') return `tool.completed:${String(event.data['status'])}:${String(event.data['output']).slice(0, TOOL_OUTPUT_HEAD_CHARS)}`;
      return event.type;
    });

describe('haystack builder', () => {
  it.for([22, 74, 90, 200])('builds 100 lines with the read-back line 50 for a %i-character directory', (length) => {
    const file = `/${'d'.repeat(length - 1)}/haystack.txt`;
    const lines = grepLinesFor(file);
    expect(lines).toHaveLength(HAYSTACK_LINE_COUNT);
    expect(HAYSTACK_READ_BACK_LINE).toBe(50);
    lines.forEach((line, index) => expect(line.startsWith(grepPrefixOf(file, index + 1))).toBe(true));
    const prefixTotal = lines.reduce((total, _line, index) => total + grepPrefixOf(file, index + 1).length, 0);
    const joined = lines.join('\n').length;
    expect(joined).toBe(Math.max(HAYSTACK_TARGET_CHARS, prefixTotal + HAYSTACK_LINE_COUNT - 1));
  });

  it('never pads negatively: a path too long for the target keeps only the prefixes', () => {
    const file = `/${'d'.repeat(400)}/haystack.txt`;
    const lines = grepLinesFor(file);
    lines.forEach((line, index) => expect(line).toBe(grepPrefixOf(file, index + 1)));
  });

  it('writes the haystack as Grep shows it from the project cwd, hashed into the handle', async () => {
    const home = await createE2eHome();
    const haystack = await writeHaystack(home.project);
    expect(haystack.grepLines[0]?.startsWith(grepPrefixOf(HAYSTACK_FILE_NAME, 1))).toBe(true);
    expect(haystack.grepOutput).toHaveLength(HAYSTACK_TARGET_CHARS);
    expect(haystack.handle).toBe(sha256Hex(haystack.grepOutput));
    const fileLines = fs.readFileSync(haystack.file, 'utf8').split('\n').slice(0, HAYSTACK_LINE_COUNT);
    expect(fileLines.map((text, index) => `${grepPrefixOf(HAYSTACK_FILE_NAME, index + 1).slice(0, -NEEDLE.length)}${text}`)).toEqual(haystack.grepLines);
  });
});

const HANDLE = 'a'.repeat(64);
const SYNTHETIC_GREP_OUTPUT = '/p/haystack.txt:1:needle one\n/p/haystack.txt:2:needle two';
const SYNTHETIC_HAYSTACK = { file: '/p/haystack.txt', grepLines: SYNTHETIC_GREP_OUTPUT.split('\n'), grepOutput: SYNTHETIC_GREP_OUTPUT, handle: HANDLE };

const syntheticJournal = (evictionSeq: number, compactions: readonly { seq: number; through: number }[]): JournalEvent[] =>
  [
    { seq: 1, type: 'user.message', data: { text: 'task' } },
    { seq: 3, type: 'tool.completed', data: { callId: 'g', truncated: true, handle: HANDLE, output: `/p/haystack.txt:1:needle one\n[output truncated; handle ${HANDLE}]` } },
    { seq: 5, type: 'tool.completed', data: { callId: 'r' } },
    { seq: 7, type: 'tool.completed', data: { callId: 'f1' } },
    { seq: evictionSeq, type: 'context.truncated', data: { callId: 'g', handle: HANDLE, kind: 'omitted' } },
    ...compactions.map(({ seq, through }) => ({ seq, type: 'context.compacted', data: { replacedThroughSeq: through } })),
  ].sort((left, right) => left.seq - right.seq);

describe('planner acceptance criteria', () => {
  it('accepts a journaled Grep eviction before one within-turn compaction of a completed run', () => {
    const facts = factsOf(syntheticJournal(8, [{ seq: 10, through: 7 }]), SYNTHETIC_HAYSTACK, 'COMPLETED', undefined);
    expect(facts.fillersBeforeFirstCompaction).toBe(1);
    expect(verdictOf(facts)).toBeUndefined();
  });

  it.for([
    { label: 'the eviction comes after the first compaction', evictionSeq: 11, compactions: [{ seq: 10, through: 7 }], status: 'COMPLETED', verdict: '(b)' },
    { label: 'the cut lies before the task', evictionSeq: 8, compactions: [{ seq: 10, through: 0 }], status: 'COMPLETED', verdict: '(c) no compaction cut' },
    { label: 'no compaction ran', evictionSeq: 8, compactions: [], status: 'STOPPED', verdict: '(c) no context.compacted' },
    { label: 'three compactions ran', evictionSeq: 8, compactions: [{ seq: 10, through: 7 }, { seq: 12, through: 9 }, { seq: 14, through: 11 }], status: 'COMPLETED', verdict: '(d) 3' },
    { label: 'the run stopped', evictionSeq: 8, compactions: [{ seq: 10, through: 7 }], status: 'STOPPED', verdict: '(d) the run ended STOPPED' },
  ])('rejects a dry run where $label', ({ evictionSeq, compactions, status, verdict }) => {
    expect(verdictOf(factsOf(syntheticJournal(evictionSeq, compactions), SYNTHETIC_HAYSTACK, status, undefined))).toMatch(new RegExp(`^${verdict.replace(/[()]/g, '\\$&')}`));
  });

  describe('a case that must escalate', () => {
    const withEscalation = (journal: JournalEvent[]): JournalEvent[] =>
      [
        ...journal,
        { seq: 6, type: 'notice', data: { message: `${ESCALATION_NOTICE_PREFIX} 4 to 1 because the context budget was exceeded` } },
        { seq: 9, type: 'model.requested', data: { step: 7 } },
      ].sort((left, right) => left.seq - right.seq);

    it('reads the step of the request that follows the notice from the measured journal', () => {
      const facts = factsOf(withEscalation(syntheticJournal(8, [{ seq: 10, through: 7 }])), SYNTHETIC_HAYSTACK, 'COMPLETED', undefined);
      expect(facts.escalationStep).toBe(7);
      expect(facts.fillersBeforeEscalation).toBe(0);
      expect(verdictOf(facts, true)).toBeUndefined();
    });

    it('counts the Grep and the read-back as the two calls that are not fillers', () => {
      expect(GREP_AND_READ_BACK_CALLS).toBe(2);
      const journal = [
        ...syntheticJournal(8, [{ seq: 10, through: 7 }]),
        { seq: 11, type: 'tool.completed', data: { callId: 'f2' } },
        { seq: 12, type: 'notice', data: { message: `${ESCALATION_NOTICE_PREFIX} 4 to 1 because the context budget was exceeded` } },
      ].sort((left, right) => left.seq - right.seq);
      expect(factsOf(journal, SYNTHETIC_HAYSTACK, 'COMPLETED', undefined).fillersBeforeEscalation).toBe(4 - GREP_AND_READ_BACK_CALLS);
    });

    describe('the escalation has to follow from the budget', () => {
      const capabilities: Capabilities = {
        contextWindow: ACCEPTANCE_WINDOW,
        maxOutputTokens: ACCEPTANCE_MAX_OUTPUT,
        imageInput: false,
        maxConcurrency: 4,
        schemaDialect: 'json-schema-2020-12',
        source: 'config',
        stopSequences: true,
        streaming: true,
        structuredOutput: 'none',
        tokenCounting: 'estimated',
        toolCalling: 'native',
        usageReported: true,
      };
      const unobservedPins = { capabilities, token: {} };
      type Evidence = Parameters<typeof escalationBudgetVerdict>[0];
      const evidence = (overrides: Partial<Evidence>): Evidence => ({
        facts: { requestsBeforeEscalation: 4 } as Evidence['facts'],
        wireCounts: [1000, 1900, 2000, 2400, 2600],
        perturbation: 0,
        unevictedAtEscalation: 2900,
        overflows: [{ inputTokens: 2900, inputBudget: 2990 - 150, level: 0 }],
        ...overrides,
      });

      it('fits at most 2853 tokens after a report of 2400 at W=4096, where the bound is ceil(0.3 x the tokens past it) against I0 = 2990', async () => {
        expect(await fitLimitAfterReport(unobservedPins, 2400)).toBe(2853);
      });

      it('(g1, g2) accepts an escalation whose unevicted input does not fit and whose level-0 pass was refused', async () => {
        expect(await escalationBudgetVerdict(evidence({}), unobservedPins)).toBeUndefined();
      });

      it('(g2) accepts a kept level-0 pass that lowered the load below the unevicted 2900+150', async () => {
        expect(await escalationBudgetVerdict(evidence({ overflows: [{ inputTokens: 2700, inputBudget: 2990 - 300, level: 0 }] }), unobservedPins)).toBeUndefined();
      });

      it('(g1) judges the unevicted input by the escalating step’s own growth, not by the largest growth seen before', async () => {
        expect(await escalationBudgetVerdict(evidence({ unevictedAtEscalation: 2500 }), unobservedPins)).toMatch(/^\(g1\) escalated although the unevicted input/);
      });

      it('(g1) rejects a dry run whose escalating step left no measurable growth', async () => {
        expect(await escalationBudgetVerdict(evidence({ unevictedAtEscalation: undefined }), unobservedPins)).toMatch(/^\(g1\) /);
      });

      it('(g2) rejects a dry run with no level-0 ContextOverflowError captured before the escalation', async () => {
        expect(await escalationBudgetVerdict(evidence({ overflows: [] }), unobservedPins)).toMatch(/^\(g2\) 0 level-0 ContextOverflowErrors/);
      });

      it('(g2) rejects a kept level-0 pass that raised the load: 2890+290 against the unevicted 2900+150', async () => {
        expect(await escalationBudgetVerdict(evidence({ overflows: [{ inputTokens: 2890, inputBudget: 2990 - 290, level: 0 }] }), unobservedPins)).toMatch(
          /^\(g2\) the level-0 pass was kept although it does not lower the load/,
        );
      });
    });

    it('rejects a dry run that did not escalate, whatever the path length did to the counts', () => {
      const facts = factsOf(syntheticJournal(8, [{ seq: 10, through: 7 }]), SYNTHETIC_HAYSTACK, 'COMPLETED', undefined);
      expect(facts.escalationStep).toBeUndefined();
      expect(verdictOf(facts, true)).toMatch(/^\(f\) 0 escalation notices/);
      expect(verdictOf(facts)).toBeUndefined();
    });
  });
});

describe('acceptance (a) support', () => {
  it('startStack forwards routes, exposes routeHits and applies the per-case target', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const route = { match: (body: unknown) => JSON.stringify(body).includes(ROUTED_TASK), reply: textReply('routed') };
    const stack = await startStack({ home, model: acceptanceTarget('native'), routes: [route], script: [textReply('scripted')] });
    const count = createGatewayCountClient(firstGeneration(home.paths).sockets.gateway);
    const capabilities = await count.capabilities();
    expect({ contextWindow: capabilities.contextWindow, maxOutputTokens: capabilities.maxOutputTokens, toolCalling: capabilities.toolCalling }).toEqual({
      contextWindow: 4096,
      maxOutputTokens: 1024,
      toolCalling: 'native',
    });
    const runId = await runTask(home, ROUTED_TASK);
    expect(stack.routeHits).toEqual([1]);
    const requests = chatCompletions(stack.fake);
    expect(requests).toHaveLength(1);
    expect(messagesOf(requests[0]).some((message) => JSON.stringify(message.content).includes(ROUTED_TASK))).toBe(true);
    const journal = journalOf(home, runId);
    expect(ofType(journal, 'run.status').at(-1)?.data['to']).toBe('COMPLETED');
    expect(JSON.stringify(journal.map((event) => event.data))).toContain('routed');
    expect(JSON.stringify(journal.map((event) => event.data))).not.toContain('scripted');
  });

  const FIDELITY: readonly { label: string; spec: PlanCaseSpec; shape: FillerShape; fillers: number }[] = [
    { label: 'native, full tools', spec: { name: 'fidelity-native', toolCalling: 'native', deny: [], grid: [], probeFillers: 0 }, shape: { tool: 'Read', lineChars: 90 }, fillers: 6 },
    {
      label: 'native, Read, Grep and ReadOutput',
      spec: { name: 'fidelity-lean', toolCalling: 'native', deny: ['Edit', 'Bash', 'UpdatePlan', 'Glob', 'HistorySearch', 'HistoryRead'], grid: [], probeFillers: 0 },
      shape: { tool: 'Read', lineChars: 90 },
      fillers: 12,
    },
    {
      label: 'constrained, Grep and ReadOutput',
      spec: { name: 'fidelity-constrained', toolCalling: 'constrained', deny: ['Edit', 'Write', 'Bash', 'UpdatePlan', 'Glob', 'MemorySave', 'MemorySearch', 'HistorySearch', 'HistoryRead'], grid: [], probeFillers: 0 },
      shape: { tool: 'ReadOutput', limit: 1 },
      fillers: 10,
    },
  ];

  it('plans every candidate under the perturbations 0, -2 and +2', () => {
    expect(PERTURBATIONS).toEqual([0, -2, 2]);
  });

  it.for([0, -2, 2])('the dry run hands the runtime counts shifted by exactly %i tokens', { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async (perturbation) => {
    const home = await createE2eHome();
    const haystack = await writeHaystack(home.project);
    const summary = summaryTextOf(haystack.handle);
    const planningHome = await createE2eHome();
    await startStack({ home: planningHome, model: acceptanceTarget('native'), routes: [summaryRoute(summary)] });
    const spec: PlanCaseSpec = { name: 'perturbation', toolCalling: 'native', deny: [], grid: [], probeFillers: 0 };
    const steps = plannedSteps(home.project, haystack, { tool: 'Read', lineChars: 90 }, 2);

    const run = await dryRun({ plan: { spec, home, haystack, gatewaySocket: firstGeneration(planningHome.paths).sockets.gateway, summary }, steps, perturbation, fillers: 2 });

    expect(run.perturbation).toBe(perturbation);
    expect(run.counts.length).toBeGreaterThan(0);
    expect(run.observedCounts).toEqual(run.counts.map((count) => count.input_tokens + perturbation));
  });

  it.for(FIDELITY)('the in-process dry run reproduces the real stack ($label)', { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async ({ spec, shape, fillers }) => {
    const home = await createE2eHome();
    const haystack = await writeHaystack(home.project);
    const summary = summaryTextOf(haystack.handle);
    const target = acceptanceTarget(spec.toolCalling);
    const planningHome = await createE2eHome();
    await startStack({ home: planningHome, model: target, routes: [summaryRoute(summary)] });
    const steps = plannedSteps(home.project, haystack, shape, fillers);
    const predicted = await dryRun({ plan: { spec, home, haystack, gatewaySocket: firstGeneration(planningHome.paths).sockets.gateway, summary }, steps, perturbation: 0, fillers });

    const stack = await startStack({
      home,
      model: target,
      settings: spec.deny.length === 0 ? {} : { permissions: { deny: [...spec.deny] } },
      script: upstreamRepliesOf(steps, spec.toolCalling),
      routes: [summaryRoute(summary)],
    });
    const count = createGatewayCountClient(firstGeneration(home.paths).sockets.gateway);
    const capabilities = await count.capabilities();
    expect(capabilities.toolCalling).toBe(spec.toolCalling);
    const runId = await runTask(home, 'Search the haystack');
    const journal = journalOf(home, runId);
    const modelPosts = chatCompletions(stack.fake).filter((post) => !isCompactionRequest(post.body));

    expect(predicted.claims).toBe(1);
    expect(readDb<{ attempts: number; error_json: string | null }>(home.paths.databases.runtime, 'SELECT attempts, error_json FROM runs WHERE id = ?', runId)).toEqual([{ attempts: 1, error_json: null }]);
    const completed = ofType(journal, 'tool.completed');
    expect(predicted.journal.filter((event) => event.type === 'tool.completed').map((event) => event.data['output'])).toEqual(completed.map((event) => event.data['output']));
    expect(comparable(predicted.journal)).toEqual(comparable(journal));
    expect(predicted.wireCounts).toEqual(modelPosts.map((post) => wireTokensOfBody(post.body)));
    expect(predicted.pinned).toBe(wireTokensOfBody(modelPosts[0]?.body));
    const requested = ofType(journal, 'model.requested');
    for (const [index, event] of requested.entries()) expect((await count.count(event.data['body'])).input_tokens).toBe(wireTokensOfBody(modelPosts[index]?.body));
    for (const post of modelPosts) expect(reportedTokensOfRequest(post.body)).toBeLessThanOrEqual(capabilities.contextWindow - budgetFor(capabilities, 0, 0).R);
  });
});

describe('the step range is sized under the pins of the stack it predicts', () => {
  const stackCapabilities: Capabilities = {
    contextWindow: ACCEPTANCE_WINDOW,
    maxOutputTokens: ACCEPTANCE_MAX_OUTPUT,
    imageInput: false,
    maxConcurrency: 4,
    schemaDialect: 'json-schema-2020-12',
    source: 'config',
    stopSequences: true,
    streaming: true,
    structuredOutput: 'none',
    tokenCounting: 'estimated',
    toolCalling: 'native',
    usageReported: true,
  };
  const textOf = (tokens: number): InputItem => ({ type: 'message', role: 'user', content: 'x'.repeat(ESTIMATED_CHARACTERS_PER_TOKEN * tokens) });
  const stackMeterFits = async (observedCapacity: boolean, base: number, step: number, steps: number): Promise<boolean> => {
    const meter = createTokenMeter({
      counter: {
        count: async (request) => {
          if (typeof request.input === 'string') throw new Error('the stack meter of this test counts message items');
          const characters = request.input.reduce((sum, item) => sum + (item.type === 'message' && typeof item.content === 'string' ? item.content.length : 0), 0);
          return countReplyOf(Math.ceil(characters / ESTIMATED_CHARACTERS_PER_TOKEN), 'estimated', ESTIMATED_ERROR_SHAPE);
        },
      },
      model: 'm',
      capabilities: stackCapabilities,
      observedCapacity,
    });
    const items: InputItem[] = [textOf(base)];
    const first = await meter.count({ input: items, tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: reportedTokensOf(base) });
    for (let index = 1; index <= steps; index += 1) {
      items.push(textOf(step));
      const view = await meter.count({ input: items, tools: [] });
      if (view.inputTokens > capacityFor(stackCapabilities, view.underAt)) return false;
      meter.observe({ inputDigest: view.inputDigest, inputTokens: reportedTokensOf(base + index * step) });
    }
    return true;
  };

  it.for([true, false])('with observed capacity %s the last of three steps of the lowest size stops fitting in the stack meter fed the upstream reports, and one token less fits', async (observedCapacity) => {
    const base = 1200;
    const range = await overflowStepRange({ capabilities: stackCapabilities, token: observedCapacity ? { observedCapacity: true } : {} }, base, 3);
    expect(await stackMeterFits(observedCapacity, base, range.lowest, 3)).toBe(false);
    expect(await stackMeterFits(observedCapacity, base, range.lowest - 1, 3)).toBe(true);
    expect(await stackMeterFits(observedCapacity, base, range.highest, 2)).toBe(true);
  });
});
