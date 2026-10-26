import { describe, expect, it } from 'vitest';
import { PERTURBATIONS, budgetFor, dryRun, factsOf, verdictOf, isCompactionRequest, journalOfRows, ofType, plannedSteps, summaryRoute, summaryTextOf, upstreamRepliesOf, wireTokensOfBody, acceptanceTarget } from './budget.ts';
import type { FillerShape, JournalEvent, PlanCaseSpec } from './budget.ts';
import { readDb } from './db.ts';
import { createGatewayCountClient } from './gateway-count.ts';
import { HAYSTACK_LINE_COUNT, HAYSTACK_READ_BACK_LINE, HAYSTACK_TARGET_CHARS, grepLinesFor, grepPrefixOf, writeHaystack } from './haystack.ts';
import { createE2eHome } from './home.ts';
import type { E2eHome } from './home.ts';
import { createRuntimeClient } from './runtime-client.ts';
import { startStack } from './stack.ts';
import { chatCompletions, messagesOf, textReply } from './upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS } from './wait.ts';

const ROUTED_TASK = 'answer from the route';
const COMPARED_TYPES: ReadonlySet<string> = new Set(['user.message', 'model.requested', 'tool.completed', 'context.truncated', 'context.compacted', 'notice', 'run.status']);

type EventRow = { seq: number; type: string; payload_json: string };

const runTask = async (home: E2eHome, task: string): Promise<string> => {
  const runtime = createRuntimeClient(home);
  try {
    const { session } = await runtime.createSession();
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

const comparable = (journal: readonly JournalEvent[]): string[] =>
  journal
    .filter((event) => COMPARED_TYPES.has(event.type))
    .map((event) => (event.type === 'run.status' ? `run.status:${String(event.data['to'])}` : event.type === 'notice' ? `notice:${String(event.data['message'])}` : event.type));

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
});

const HANDLE = 'a'.repeat(64);
const SYNTHETIC_HAYSTACK = { file: '/p/haystack.txt', grepLines: [], grepOutput: '', handle: HANDLE };

const syntheticJournal = (evictionSeq: number, compactions: readonly { seq: number; through: number }[]): JournalEvent[] =>
  [
    { seq: 1, type: 'user.message', data: { text: 'task' } },
    { seq: 3, type: 'tool.completed', data: { callId: 'g', truncated: true, handle: HANDLE } },
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
});

describe('acceptance (a) support', () => {
  it('startStack forwards routes, exposes routeHits and applies the per-case target', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const route = { match: (body: unknown) => JSON.stringify(body).includes(ROUTED_TASK), reply: textReply('routed') };
    const stack = await startStack({ home, sandbox: 'none', target: acceptanceTarget('native'), routes: [route], script: [textReply('scripted')] });
    const count = createGatewayCountClient(home.paths.sockets.gateway);
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
      spec: { name: 'fidelity-lean', toolCalling: 'native', deny: ['Write', 'Edit', 'Bash', 'UpdatePlan', 'Glob'], grid: [], probeFillers: 0 },
      shape: { tool: 'Read', lineChars: 90 },
      fillers: 12,
    },
    {
      label: 'constrained, Grep and ReadOutput',
      spec: { name: 'fidelity-constrained', toolCalling: 'constrained', deny: ['Read', 'Write', 'Edit', 'Bash', 'UpdatePlan', 'Glob'], grid: [], probeFillers: 0 },
      shape: { tool: 'ReadOutput', limit: 1 },
      fillers: 10,
    },
  ];

  it('plans every candidate under the perturbations 0, -2 and +2', () => {
    expect(PERTURBATIONS).toEqual([0, -2, 2]);
  });

  it.for([0, -2, 2])('the dry run hands the runtime counts shifted by exactly %i tokens', { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async (perturbation) => {
    const home = await createE2eHome();
    const haystack = writeHaystack(home.project);
    const summary = summaryTextOf(haystack.handle);
    const planningHome = await createE2eHome();
    await startStack({ home: planningHome, sandbox: 'none', target: acceptanceTarget('native'), routes: [summaryRoute(summary)] });
    const spec: PlanCaseSpec = { name: 'perturbation', toolCalling: 'native', deny: [], grid: [], probeFillers: 0 };
    const steps = plannedSteps(home.project, haystack, { tool: 'Read', lineChars: 90 }, 2);

    const run = await dryRun({ plan: { spec, home, haystack, gatewaySocket: planningHome.paths.sockets.gateway, summary }, steps, perturbation, fillers: 2 });

    expect(run.perturbation).toBe(perturbation);
    expect(run.counts.length).toBeGreaterThan(0);
    expect(run.observedCounts).toEqual(run.counts.map((count) => count.input_tokens + perturbation));
  });

  it.for(FIDELITY)('the in-process dry run reproduces the real stack ($label)', { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async ({ spec, shape, fillers }) => {
    const home = await createE2eHome();
    const haystack = writeHaystack(home.project);
    const summary = summaryTextOf(haystack.handle);
    const target = acceptanceTarget(spec.toolCalling);
    const planningHome = await createE2eHome();
    await startStack({ home: planningHome, sandbox: 'none', target, routes: [summaryRoute(summary)] });
    const steps = plannedSteps(home.project, haystack, shape, fillers);
    const predicted = await dryRun({ plan: { spec, home, haystack, gatewaySocket: planningHome.paths.sockets.gateway, summary }, steps, perturbation: 0, fillers });

    const stack = await startStack({
      home,
      sandbox: 'none',
      target,
      settings: spec.deny.length === 0 ? {} : { permissions: { deny: [...spec.deny] } },
      script: upstreamRepliesOf(steps, spec.toolCalling),
      routes: [summaryRoute(summary)],
    });
    const count = createGatewayCountClient(home.paths.sockets.gateway);
    const capabilities = await count.capabilities();
    expect(capabilities.toolCalling).toBe(spec.toolCalling);
    const runId = await runTask(home, 'Search the haystack');
    const journal = journalOf(home, runId);
    const modelPosts = chatCompletions(stack.fake).filter((post) => !isCompactionRequest(post.body));

    expect(predicted.claims).toBe(1);
    expect(readDb<{ attempts: number }>(home.paths.databases.runtime, 'SELECT attempts FROM runs WHERE id = ?', runId)[0]?.attempts).toBe(1);
    expect(comparable(predicted.journal)).toEqual(comparable(journal));
    expect(predicted.wireCounts).toEqual(modelPosts.map((post) => wireTokensOfBody(post.body)));
    expect(predicted.pinned).toBe(wireTokensOfBody(modelPosts[0]?.body));
    const requested = ofType(journal, 'model.requested');
    for (const [index, event] of requested.entries()) expect((await count.count(event.data['body'])).input_tokens).toBe(wireTokensOfBody(modelPosts[index]?.body));
    const completed = ofType(journal, 'tool.completed');
    expect(predicted.journal.filter((event) => event.type === 'tool.completed').map((event) => event.data['output'])).toEqual(completed.map((event) => event.data['output']));
    for (const post of modelPosts) expect(wireTokensOfBody(post.body)).toBeLessThanOrEqual(capabilities.contextWindow - budgetFor(capabilities, 0).R);
  });
});
