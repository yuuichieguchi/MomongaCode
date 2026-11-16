import { describe, expect, it } from 'vitest';
import { pinnedFloorFor } from '@momonga/context';
import type { Capabilities } from '@momonga/protocol';
import { DEFAULT_KEEP_RECENT_STEPS, DEFAULT_KEEP_RECENT_TURNS, protectionRungsOf } from '../packages/context/src/levels.ts';
import type { HistoryShape } from '../packages/context/src/levels.ts';
import {
  ACCEPTANCE_MAX_OUTPUT,
  ACCEPTANCE_TASK,
  ACCEPTANCE_WINDOW,
  ESCALATION_NOTICE_PREFIX,
  acceptanceTarget,
  budgetFor,
  dryRun,
  isCompactionRequest,
  journalOfRows,
  ofType,
  planScript,
  seenOutputTokens,
  summaryRoute,
  summaryTextOf,
  upstreamRepliesOf,
  wireTokensOfBody,
} from './support/budget.ts';
import type { JournalEvent, Plan, PlanCaseSpec } from './support/budget.ts';
import { titleOf } from './support/cases.ts';
import type { E2eCaseId } from './support/cases.ts';
import { readDb } from './support/db.ts';
import { createGatewayCountClient } from './support/gateway-count.ts';
import type { GatewayCountClient } from './support/gateway-count.ts';
import { readBackOutputOf, writeHaystack, HAYSTACK_READ_BACK_LINE } from './support/haystack.ts';
import type { Haystack } from './support/haystack.ts';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import { startStack } from './support/stack.ts';
import type { E2eStack } from './support/stack.ts';
import { chatCompletions } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS } from './support/wait.ts';
import { firstGeneration } from '@momonga/testkit';

const PLANNED_CASE_TIMEOUT_MS = 4 * E2E_TEST_TIMEOUT_MS;
const MEMORY_DENY = ['MemorySave', 'MemorySearch'] as const;
const HISTORY_DENY = ['HistorySearch', 'HistoryRead'] as const;
const FULL_DENY = [] as const;
const LEAN_DENY = ['Edit', 'Bash', ...MEMORY_DENY, ...HISTORY_DENY] as const;
const CONSTRAINED_DENY = ['Edit', 'Write', 'Bash', 'UpdatePlan', 'Glob', ...MEMORY_DENY, ...HISTORY_DENY] as const;
const FULL_LINE_CHARS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200] as const;
const LEAN_LINE_CHARS = [90, 80, 70, 60, 50, 40, 30, 20, 10] as const;
const EXPECTED_OUTPUT_RESERVE = 1024;
const AFTER_COMPACTION = 'after compaction';

type PlannedCase = { readonly id: E2eCaseId; readonly title: string; readonly spec: PlanCaseSpec };

const PLANNED_CASES: readonly PlannedCase[] = [
  {
    id: 'a-compaction',
    title: titleOf('a-compaction'),
    spec: { name: 'a-compaction', toolCalling: 'native', deny: FULL_DENY, grid: FULL_LINE_CHARS.map((lineChars) => ({ tool: 'Read', lineChars })), probeFillers: 10 },
  },
  {
    id: 'a-compaction-lean',
    title: titleOf('a-compaction-lean'),
    spec: { name: 'a-compaction-lean', toolCalling: 'native', deny: LEAN_DENY, grid: LEAN_LINE_CHARS.map((lineChars) => ({ tool: 'Read', lineChars })), probeFillers: 16, escalates: true },
  },
  {
    id: 'a-compaction-constrained',
    title: titleOf('a-compaction-constrained'),
    spec: {
      name: 'a-compaction-constrained',
      toolCalling: 'constrained',
      deny: CONSTRAINED_DENY,
      grid: [1, 2, 3].map((limit) => ({ tool: 'ReadOutput', limit })),
      probeFillers: 14,
    },
  },
];

type EventRow = { seq: number; type: string; payload_json: string };
type RunRow = { status: string; stop_reason: string | null; attempts: number; error_json: string | null };

const denySettings = (deny: readonly string[]): Record<string, unknown> => (deny.length === 0 ? {} : { permissions: { deny: [...deny] } });

const journalOf = (home: E2eHome, runId: string): JournalEvent[] =>
  journalOfRows(readDb<EventRow>(home.paths.databases.runtime, 'SELECT seq, type, payload_json FROM events WHERE run_id = ? ORDER BY seq', runId));

const runRowOf = (home: E2eHome, runId: string): RunRow => {
  const row = readDb<RunRow>(home.paths.databases.runtime, 'SELECT status, stop_reason, attempts, error_json FROM runs WHERE id = ?', runId)[0];
  if (row === undefined) throw new Error(`run ${runId} has no row`);
  return row;
};

const runToEnd = async (home: E2eHome): Promise<string> => {
  const runtime = createRuntimeClient(home);
  try {
    const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
    const { run } = await runtime.createRun(session.id, ACCEPTANCE_TASK);
    const stream = runtime.events(run.id);
    await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
    await stream.close();
    return run.id;
  } finally {
    await runtime.close();
  }
};

const inputItemsOf = (body: unknown): Record<string, unknown>[] => {
  if (typeof body !== 'object' || body === null || !('input' in body) || !Array.isArray(body.input)) throw new Error('model.requested body has no input array');
  return body.input as Record<string, unknown>[];
};

const textOfItem = (item: Record<string, unknown>): string => {
  const content = item['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => (typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '')).join('');
};

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const escapedInJson = (text: string): string => JSON.stringify(text).slice(1, -1);

type Observed = {
  readonly journal: JournalEvent[];
  readonly row: RunRow;
  readonly posts: ReturnType<typeof chatCompletions>;
  readonly modelPosts: ReturnType<typeof chatCompletions>;
  readonly requested: JournalEvent[];
  readonly compacted: JournalEvent[];
};

const observe = (stack: E2eStack, runId: string): Observed => {
  const journal = journalOf(stack.home, runId);
  const posts = chatCompletions(stack.fake);
  return {
    journal,
    row: runRowOf(stack.home, runId),
    posts,
    modelPosts: posts.filter((post) => !isCompactionRequest(post.body)),
    requested: ofType(journal, 'model.requested'),
    compacted: ofType(journal, 'context.compacted'),
  };
};

const assertAcceptance = async (
  observed: Observed,
  context: { stack: E2eStack; haystack: Haystack; summary: string; capabilities: Capabilities; count: GatewayCountClient; plan: Plan },
): Promise<void> => {
  const { journal, row, posts, modelPosts, requested, compacted } = observed;
  const { stack, haystack, summary, capabilities, count, plan } = context;

  expect({ status: row.status, stopReason: row.stop_reason }, `the run ended with the error ${row.error_json} on the shape ${JSON.stringify(plan.shape)}`).toEqual({ status: 'COMPLETED', stopReason: null });
  expect(row.attempts).toBe(1);

  const postKinds = posts.map((post) => (isCompactionRequest(post.body) ? 'compact' : 'model'));
  const journalKinds = journal.filter((event) => event.type === 'model.requested' || event.type === 'context.compacted').map((event) => (event.type === 'model.requested' ? 'model' : 'compact'));
  expect(postKinds).toEqual(journalKinds);
  expect(stack.routeHits).toEqual([compacted.length]);

  const completed = ofType(journal, 'tool.completed');
  const grep = completed[0];
  expect(grep?.data['handle']).toBe(haystack.handle);
  expect({ truncated: grep?.data['truncated'] === true, formatted: grep?.data['formatted'] !== undefined }).not.toEqual({ truncated: false, formatted: false });
  const grepInline = String(grep?.data['output']);
  expect(grepInline).toContain(haystack.handle);
  expect(grepInline.includes(haystack.grepOutput)).toBe(false);
  expect(await seenOutputTokens(count, { callId: String(grep?.data['callId']), tool: 'Grep' }, grepInline)).toBeLessThanOrEqual(plan.sizing.itemCap);

  expect(compacted.length).toBeGreaterThanOrEqual(1);
  const firstCompaction = compacted[0] as JournalEvent;
  const eviction = ofType(journal, 'context.truncated').find(
    (event) => event.data['kind'] === 'omitted' && event.data['handle'] === haystack.handle && event.data['callId'] === grep?.data['callId'],
  );
  expect(eviction).toBeDefined();
  const evictionSeq = (eviction as JournalEvent).seq;
  expect(evictionSeq).toBeLessThan(firstCompaction.seq);
  const firstWithoutGrep = requested.find((event) => event.seq > (grep as JournalEvent).seq && !JSON.stringify(event.data['body']).includes(escapedInJson(grepInline)));
  expect(firstWithoutGrep).toBeDefined();
  expect(evictionSeq).toBeLessThan((firstWithoutGrep as JournalEvent).seq);
  for (const post of posts) expect(JSON.stringify(post.body).includes(escapedInJson(haystack.grepOutput))).toBe(false);

  expect(completed[1]?.data['output']).toBe(readBackOutputOf(haystack, HAYSTACK_READ_BACK_LINE));

  const taskSeq = ofType(journal, 'user.message')[0]?.seq ?? Number.POSITIVE_INFINITY;
  expect(compacted.some((event) => (event.data['replacedThroughSeq'] as number) > taskSeq)).toBe(true);
  for (const event of compacted) expect(event.data['summary']).toBe(summary);

  const { W, R } = budgetFor(capabilities, 0);
  expect(W).toBe(ACCEPTANCE_WINDOW);
  expect(R).toBe(EXPECTED_OUTPUT_RESERVE);
  for (const post of posts) expect(wireTokensOfBody(post.body)).toBeLessThanOrEqual(W - R);
  expect(modelPosts).toHaveLength(requested.length);
  for (const [index, event] of requested.entries()) {
    const counted = await count.count(event.data['body']);
    expect(counted.input_tokens).toBe(wireTokensOfBody(modelPosts[index]?.body));
  }
  expect(plan.sizing.pinned).toBe(wireTokensOfBody(modelPosts[0]?.body));
  expect(plan.runs.map((run) => run.perturbation)).toEqual([0, -2, 2]);

  for (const event of requested) {
    const items = inputItemsOf(event.data['body']);
    items.forEach((item, index) => {
      if (item['type'] !== 'function_call_output') return;
      expect(items.slice(0, index).some((earlier) => earlier['type'] === 'function_call' && earlier['call_id'] === item['call_id'])).toBe(true);
    });
    expect(items.filter((item) => item['type'] === 'message' && item['role'] === 'user' && textOfItem(item) === ACCEPTANCE_TASK)).toHaveLength(1);
  }
  for (const post of modelPosts) expect(occurrences(JSON.stringify(post.body), ACCEPTANCE_TASK)).toBe(1);

  const notices = ofType(journal, 'notice').map((event) => String(event.data['message']));
  expect(notices.filter((message) => message.includes(AFTER_COMPACTION))).toEqual([]);
  expect(journal.filter((event) => event.type === 'run.status' && event.data['to'] === 'STOPPED')).toEqual([]);
};

const assertLeanProperties = (observed: Observed, haystack: Haystack, plan: Plan, capabilities: Capabilities): void => {
  const notices = ofType(observed.journal, 'notice');
  const floor = pinnedFloorFor(capabilities);
  const planned = plan.runs.find((run) => run.perturbation === 0);
  expect(planned).toBeDefined();
  const messages = notices.map((event) => String(event.data['message']));
  expect(
    messages.filter((message) => message.includes('leaves no room for these tools, so they were left out: ')),
    `Bash is denied and no background job runs, so BashOutput and KillBash are not offered; the measured pinned prefix is ${plan.sizing.pinned} tokens against the floor ${floor} (ceiling ${plan.sizing.ceiling} minus the larger of the minimum room and a quarter of the ceiling), so every offered tool fits and none is left out`,
  ).toEqual([]);
  const before = planned?.facts.requestsBeforeEscalation ?? 0;
  const wireCounts = planned?.wireCounts ?? [];
  const unevicted = planned?.unevictedAtEscalation;
  const shape = plan.shape.tool === 'Read' ? `Read with ${plan.shape.lineChars}-character lines` : `ReadOutput with limit ${plan.shape.limit}`;
  expect(
    planned?.facts.escalationNotices,
    `Bash is denied and no background job runs, so BashOutput and KillBash are not offered and the lean deny list leaves Glob and UpdatePlan offered, so the pinned prefix is ${plan.sizing.pinned} tokens against the ceiling ${plan.sizing.ceiling}, which leaves ${plan.sizing.ceiling - plan.sizing.pinned} tokens of room; the planner took ${shape}, the first shape in the grid for which (g1) the unevicted input of ${unevicted} tokens, the request before the escalation (${wireCounts[before - 1]} tokens) plus the escalating step's own growth, exceeds the fit limit after that request's report, and (g2) the level-0 pass is the one ContextOverflowError, so the recent steps are kept whole until then, and reducing them to one is then journaled exactly once`,
  ).toHaveLength(1);
  expect(messages, "the real run journals exactly the notices of the planner's dry run, which offers the same tools under the same deny list").toEqual(planned?.facts.notices);
  const plannedShape: HistoryShape = { positions: Array.from({ length: before }, (_unused, step) => ({ turn: 0, step })), turnCount: 1, currentTurn: 0, lastStep: before - 1 };
  const rungs = protectionRungsOf(plannedShape, DEFAULT_KEEP_RECENT_TURNS, DEFAULT_KEEP_RECENT_STEPS);
  const keptWhole = rungs[0]?.protection.keepSteps;
  const reducedTo = rungs.at(-1)?.protection.keepSteps;
  expect(rungs, `the ${before} planned requests before the escalation leave the default recent steps to reduce`).toHaveLength(2);
  const escalationText = `${ESCALATION_NOTICE_PREFIX} ${keptWhole} to ${reducedTo} because the context budget was exceeded`;
  expect(planned?.facts.escalationNotices, 'the planner kept the default recent steps whole and the escalation reduced them to the lowest rung').toEqual([escalationText]);
  expect(messages.filter((message) => message.startsWith(ESCALATION_NOTICE_PREFIX)), 'the real run journals the escalation notice with the step counts of the plan').toEqual([escalationText]);
  const escalation = notices.find((event) => String(event.data['message']) === planned?.facts.escalationNotices[0]) as JournalEvent;
  const escalatedBefore = observed.journal.find((event) => event.type === 'model.requested' && event.seq > escalation.seq);
  expect(escalatedBefore?.data['step'], 'the first model request after the escalation notice is the step the planner journaled after it').toBe(planned?.facts.escalationStep);
  const firstCompaction = observed.compacted[0] as JournalEvent;
  const firstEviction = ofType(observed.journal, 'context.truncated').find((event) => event.data['kind'] === 'omitted' && event.data['handle'] === haystack.handle);
  expect(firstEviction).toBeDefined();
  const between = observed.requested.filter((event) => event.seq > (firstEviction as JournalEvent).seq && event.seq < firstCompaction.seq);
  expect(between.length).toBeGreaterThanOrEqual(1);
};

const assertConstrainedWire = (observed: Observed): void => {
  for (const post of observed.modelPosts) {
    const body = post.body as Record<string, unknown>;
    expect(body['tools']).toBeUndefined();
    expect(body['response_format']).toBeDefined();
  }
};

describe('a: within-turn truncation and compaction at W=4096', () => {
  it.for(PLANNED_CASES)('$title', { timeout: PLANNED_CASE_TIMEOUT_MS }, async ({ id, spec }) => {
    const home = await createE2eHome();
    const haystack = await writeHaystack(home.project);
    const summary = summaryTextOf(haystack.handle);
    const target = acceptanceTarget(spec.toolCalling);

    const planningHome = await createE2eHome();
    await startStack({ home: planningHome, model: target, routes: [summaryRoute(summary)] });
    const planningCount = createGatewayCountClient(firstGeneration(planningHome.paths).sockets.gateway);
    const capabilities = await planningCount.capabilities();
    const plan = await planScript({ spec, home, haystack, gatewaySocket: firstGeneration(planningHome.paths).sockets.gateway, summary }, capabilities);

    const stack = await startStack({ home, model: target, settings: denySettings(spec.deny), script: plan.replies, routes: [summaryRoute(summary)] });
    const count = createGatewayCountClient(firstGeneration(home.paths).sockets.gateway);
    expect(await count.capabilities()).toEqual(capabilities);
    const runId = await runToEnd(home);
    const observed = observe(stack, runId);

    await assertAcceptance(observed, { stack, haystack, summary, capabilities, count, plan });
    if (id === 'a-compaction-lean') assertLeanProperties(observed, haystack, plan, capabilities);
    if (spec.toolCalling === 'constrained') assertConstrainedWire(observed);
  });

  it(titleOf('a-constrained-tool-room'), { timeout: PLANNED_CASE_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    await writeHaystack(home.project);
    const target = acceptanceTarget('constrained');
    const stack = await startStack({ home, model: target, script: upstreamRepliesOf([{ kind: 'final', text: 'Done.' }], 'constrained') });
    const capabilities = await createGatewayCountClient(firstGeneration(home.paths).sockets.gateway).capabilities();
    const runId = await runToEnd(home);
    const row = runRowOf(home, runId);
    expect({ status: row.status, stopReason: row.stop_reason }).toEqual({ status: 'COMPLETED', stopReason: null });
    const notices = ofType(journalOf(home, runId), 'notice').map((event) => String(event.data['message']));
    expect(notices.some((message) => message.includes('leaves no room for these tools, so they were left out: '))).toBe(true);
    const posts = chatCompletions(stack.fake);
    expect(posts).toHaveLength(1);
    expect(wireTokensOfBody(posts[0]?.body)).toBeLessThanOrEqual(capabilities.contextWindow - budgetFor(capabilities, 0).R);
  });
});
