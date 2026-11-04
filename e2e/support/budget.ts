import { canonicalJson, createRedactor, systemClock } from '@momonga/foundation';
import { createFsInstructionReader } from '@momonga/context';
import { COMPACTION_INSTRUCTIONS_MARKER, wireOf, wireTokensOf } from '@momonga/gateway';
import type { ChatWire } from '@momonga/gateway';
import { ESTIMATED_ERROR_BOUND_RATIO, marginFloorFor, summaryItemTokensFor, summaryTokenCapFor } from '@momonga/protocol';
import type { Capabilities, CountTokensResult, FunctionCallItem, RunEvent } from '@momonga/protocol';
import { RUNTIME_DEFAULTS, buildSystemPrompt, createGatewayClient, createHistoryPort, createMemoryPort } from '@momonga/runtime';
import type { GatewayPort } from '@momonga/runtime';
import { createUnsandboxed } from '@momonga/sandbox';
import type { FakeRoute, FakeScriptedReply } from '@momonga/testkit';
import { usageOf } from '@momonga/testkit';
import { createBuiltinTools } from '@momonga/tools';
import { budgetFor, itemCapFor } from '../../packages/context/src/budget.ts';
import { errorBoundFor } from '../../packages/gateway/src/core/estimate.ts';
import { makeEnv, unavailableEvidenceRun } from '../../packages/runtime/test/worker/harness.ts';
import type { ScriptStep } from '../../packages/runtime/test/worker/fake-gateway.ts';
import { outputStep, textStep } from '../../packages/runtime/test/worker/scripts.ts';
import { HAYSTACK_LINE_COUNT, HAYSTACK_READ_BACK_LINE, NEEDLE, writeFiller } from './haystack.ts';
import type { Haystack } from './haystack.ts';
import type { E2eHome } from './home.ts';
import { E2E_MODEL_ALIAS } from './gateway-count.ts';
import { SESSION_PATH } from './runtime-client.ts';
import { SUPERVISOR_APP_VERSION } from './stack.ts';
import { envelopeFinalReply, envelopeToolCallsReply, textReply, toolCallReply, wireTokensOfRequest } from './upstream.ts';

export { budgetFor, errorBoundFor, wireOf, wireTokensOf };

export const ACCEPTANCE_TASK = 'Search the haystack';
export const FINAL_TEXT = 'searched';
export const ACCEPTANCE_WINDOW = 4096;
export const ACCEPTANCE_MAX_OUTPUT = 1024;
export const ITEM_ROOM_RATIO = 0.5;
export const COMPACTION_MIN_GAIN = 2;
export const HIGH_MARK_RATIO = 0.7;
export const EVICT_LOW_WATER = 0.5;
export const MIN_ITEM_CAP = 64;
export const PERTURBATIONS: readonly number[] = [0, -2, 2];
export const REPORTED_BELOW_ESTIMATE_TOKENS = Math.floor(marginFloorFor(ACCEPTANCE_WINDOW) / 2);
export const SCRIPTED_OUTPUT_TOKENS = 5;
export const MAX_COMPACTIONS = 2;
export const DRY_RUN_MAX_CLAIMS = 8;
export const GREP_AND_READ_BACK_CALLS = 2;
export const ESCALATION_NOTICE_PREFIX = 'recent steps of the current turn were reduced from';

export type ToolCallingMode = 'native' | 'constrained';

export type FillerShape = { readonly tool: 'Read'; readonly lineChars: number } | { readonly tool: 'ReadOutput'; readonly limit: number };

export type PlanCaseSpec = {
  readonly name: string;
  readonly toolCalling: ToolCallingMode;
  readonly deny: readonly string[];
  readonly grid: readonly FillerShape[];
  readonly probeFillers: number;
  readonly escalates?: true;
};

export type ScriptCall = { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> };

export type PlannedStep = { readonly kind: 'call'; readonly call: ScriptCall } | { readonly kind: 'final'; readonly text: string };

export type JournalEvent = { readonly seq: number; readonly type: string; readonly data: Readonly<Record<string, unknown>> };

export type Sizing = {
  readonly W: number;
  readonly R: number;
  readonly pinned: number;
  readonly ceiling: number;
  readonly room: number;
  readonly itemCap: number;
  readonly inlineChars: number;
  readonly summaryCap: number;
  readonly summaryItem: number;
  readonly highMark: number;
  readonly lowMark: number;
  readonly gainThreshold: number;
};

export type AcceptanceFacts = {
  readonly status: string;
  readonly stopReason: string | undefined;
  readonly taskSeq: number;
  readonly grepTruncatedWithHandle: boolean;
  readonly grepEvictionSeq: number | undefined;
  readonly compactionSeqs: readonly number[];
  readonly withinTurnCompaction: boolean;
  readonly fillersBeforeFirstCompaction: number | undefined;
  readonly notices: readonly string[];
  readonly escalationNotices: readonly string[];
  readonly escalationStep: number | undefined;
  readonly fillersBeforeEscalation: number | undefined;
  readonly requestsBeforeEscalation: number | undefined;
};

export type DryRun = {
  readonly perturbation: number;
  readonly fillers: number;
  readonly facts: AcceptanceFacts;
  readonly claims: number;
  readonly wireCounts: readonly number[];
  readonly pinned: number | undefined;
};

export type PlanAttempt = { readonly shape: FillerShape; readonly runs: readonly DryRun[]; readonly verdict: string };

export type Plan = {
  readonly spec: PlanCaseSpec;
  readonly shape: FillerShape;
  readonly steps: readonly PlannedStep[];
  readonly replies: FakeScriptedReply[];
  readonly sizing: Sizing;
  readonly runs: readonly DryRun[];
  readonly attempts: readonly PlanAttempt[];
};

export type PlanInput = {
  readonly spec: PlanCaseSpec;
  readonly home: E2eHome;
  readonly haystack: Haystack;
  readonly gatewaySocket: string;
  readonly summary: string;
};

export const acceptanceTarget = (toolCalling: ToolCallingMode) => ({
  capabilities: { contextWindow: ACCEPTANCE_WINDOW, maxOutputTokens: ACCEPTANCE_MAX_OUTPUT },
  toolCalling,
});

export const summaryTextOf = (handle: string): string =>
  `The user asked to search the haystack for the needle. Grep found it on every line; the full output is kept under handle ${handle}. Line 50 was read back and several small files were read. Next step: report the result.`;

const systemTextOf = (body: unknown): string => {
  if (typeof body !== 'object' || body === null || !('messages' in body) || !Array.isArray(body.messages)) return '';
  const first: unknown = body.messages[0];
  if (typeof first !== 'object' || first === null || !('role' in first) || first.role !== 'system' || !('content' in first)) return '';
  const content = first.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => (typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '')).join('');
};

export const isCompactionRequest = (body: unknown): boolean => systemTextOf(body).includes(COMPACTION_INSTRUCTIONS_MARKER);

export const summaryRoute = (summary: string): FakeRoute => ({ match: isCompactionRequest, reply: textReply(summary) });

export const wireTokensOfBody = wireTokensOfRequest;

export const sizingFor = (capabilities: Capabilities, pinned: number): Sizing => {
  const { W, R } = budgetFor(capabilities, 0);
  const ceiling = Math.floor((W - R - marginFloorFor(W)) / (1 + ESTIMATED_ERROR_BOUND_RATIO));
  const room = ceiling - pinned;
  const itemCap = Math.max(MIN_ITEM_CAP, Math.min(itemCapFor(capabilities), Math.floor(ITEM_ROOM_RATIO * room)));
  const summaryCap = summaryTokenCapFor(capabilities, room);
  const summaryItem = summaryItemTokensFor(summaryCap);
  const highMark = pinned + HIGH_MARK_RATIO * room;
  return {
    W,
    R,
    pinned,
    ceiling,
    room,
    itemCap,
    inlineChars: 3 * itemCap,
    summaryCap,
    summaryItem,
    highMark,
    lowMark: pinned + EVICT_LOW_WATER * (highMark - pinned),
    gainThreshold: COMPACTION_MIN_GAIN * summaryItem,
  };
};

const grepCall = (haystack: Haystack): ScriptCall => ({ name: 'Grep', arguments: { pattern: NEEDLE, path: haystack.file, output_mode: 'content' } });

const readBackCall = (haystack: Haystack): ScriptCall => ({
  name: 'ReadOutput',
  arguments: { handle: haystack.handle, offset: HAYSTACK_READ_BACK_LINE, limit: 1 },
});

const fillerCall = (project: string, haystack: Haystack, shape: FillerShape, index: number): ScriptCall => {
  if (shape.tool === 'Read') return { name: 'Read', arguments: { file_path: writeFiller(project, index, shape.lineChars) } };
  const offset = ((index - 1) * shape.limit) % (HAYSTACK_LINE_COUNT - shape.limit) + 1;
  return { name: 'ReadOutput', arguments: { handle: haystack.handle, offset, limit: shape.limit } };
};

export const plannedSteps = (project: string, haystack: Haystack, shape: FillerShape, fillers: number): PlannedStep[] => [
  { kind: 'call', call: grepCall(haystack) },
  { kind: 'call', call: readBackCall(haystack) },
  ...Array.from({ length: fillers }, (_, index): PlannedStep => ({ kind: 'call', call: fillerCall(project, haystack, shape, index + 1) })),
  { kind: 'final', text: FINAL_TEXT },
];

export const upstreamRepliesOf = (steps: readonly PlannedStep[], toolCalling: ToolCallingMode): FakeScriptedReply[] =>
  steps.map((step, index) => {
    if (step.kind === 'final') return toolCalling === 'native' ? textReply(step.text) : envelopeFinalReply(step.text);
    return toolCalling === 'native'
      ? toolCallReply(step.call.name, step.call.arguments, `call_scripted_${index + 1}`)
      : envelopeToolCallsReply([step.call]);
  });

const scriptedUsage = () => usageOf(0, SCRIPTED_OUTPUT_TOKENS);

export const dryRunStepsOf = (steps: readonly PlannedStep[], toolCalling: ToolCallingMode): ScriptStep[] =>
  steps.map((step, index) => {
    if (step.kind === 'final') return textStep(step.text, { usage: scriptedUsage() });
    const item: FunctionCallItem = {
      type: 'function_call',
      id: `fc_scripted_${index + 1}`,
      call_id: `scripted_${index + 1}`,
      name: step.call.name,
      arguments: toolCalling === 'native' ? JSON.stringify(step.call.arguments) : canonicalJson(step.call.arguments),
      status: 'completed',
    };
    return outputStep([item], scriptedUsage());
  });

const recordOf = (value: unknown): Readonly<Record<string, unknown>> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

export const journalOfRunEvents = (events: readonly RunEvent[]): JournalEvent[] =>
  events.map((event) => ({ seq: event.seq, type: event.type, data: recordOf(event) }));

export const journalOfRows = (rows: readonly { seq: number; type: string; payload_json: string }[]): JournalEvent[] =>
  rows.map((row) => ({ seq: row.seq, type: row.type, data: recordOf(JSON.parse(row.payload_json)) }));

export const ofType = (journal: readonly JournalEvent[], type: string): JournalEvent[] => journal.filter((event) => event.type === type);

export const factsOf = (journal: readonly JournalEvent[], haystack: Haystack, status: string, stopReason: string | undefined): AcceptanceFacts => {
  const task = ofType(journal, 'user.message')[0];
  const taskSeq = task?.seq ?? -1;
  const completed = ofType(journal, 'tool.completed');
  const grep = completed[0];
  const compactions = ofType(journal, 'context.compacted');
  const firstCompaction = compactions[0]?.seq;
  const grepEviction = ofType(journal, 'context.truncated').find(
    (event) => event.data['kind'] === 'omitted' && event.data['handle'] === haystack.handle && event.data['callId'] === grep?.data['callId'],
  );
  const escalations = ofType(journal, 'notice').filter((event) => String(event.data['message']).startsWith(ESCALATION_NOTICE_PREFIX));
  const afterEscalation = escalations[0] === undefined ? undefined : ofType(journal, 'model.requested').find((event) => event.seq > (escalations[0] as JournalEvent).seq);
  const escalationStep = afterEscalation?.data['step'];
  return {
    escalationNotices: escalations.map((event) => String(event.data['message'])),
    escalationStep: typeof escalationStep === 'number' ? escalationStep : undefined,
    fillersBeforeEscalation:
      escalations[0] === undefined ? undefined : Math.max(0, completed.filter((event) => event.seq < (escalations[0] as JournalEvent).seq).length - GREP_AND_READ_BACK_CALLS),
    requestsBeforeEscalation: escalations[0] === undefined ? undefined : ofType(journal, 'model.requested').filter((event) => event.seq < (escalations[0] as JournalEvent).seq).length,
    status,
    stopReason,
    taskSeq,
    grepTruncatedWithHandle: grep?.data['truncated'] === true && grep.data['handle'] === haystack.handle,
    grepEvictionSeq: grepEviction?.seq,
    compactionSeqs: compactions.map((event) => event.seq),
    withinTurnCompaction: compactions.some((event) => typeof event.data['replacedThroughSeq'] === 'number' && event.data['replacedThroughSeq'] > taskSeq),
    fillersBeforeFirstCompaction: firstCompaction === undefined ? undefined : Math.max(0, completed.filter((event) => event.seq < firstCompaction).length - GREP_AND_READ_BACK_CALLS),
    notices: ofType(journal, 'notice').map((event) => String(event.data['message'])),
  };
};

export const verdictOf = (facts: AcceptanceFacts, escalates = false): string | undefined => {
  if (escalates && facts.escalationNotices.length !== 1) return `(f) ${facts.escalationNotices.length} escalation notices, expected exactly one`;
  if (!facts.grepTruncatedWithHandle) return '(a) the Grep output was not tool-truncated with its handle';
  if (facts.compactionSeqs.length === 0) return `(c) no context.compacted (status ${facts.status} ${facts.stopReason ?? ''})`.trim();
  const firstCompaction = facts.compactionSeqs[0] as number;
  if (facts.grepEvictionSeq === undefined || facts.grepEvictionSeq > firstCompaction) return '(b) no journaled eviction of the Grep output before the first compaction';
  if (!facts.withinTurnCompaction) return '(c) no compaction cut lies inside the turn';
  if (facts.compactionSeqs.length > MAX_COMPACTIONS) return `(d) ${facts.compactionSeqs.length} compactions, more than ${MAX_COMPACTIONS}`;
  if (facts.status !== 'COMPLETED') return `(d) the run ended ${facts.status} ${facts.stopReason ?? ''}`.trim();
  return undefined;
};

export const escalationBudgetVerdict = (facts: Pick<AcceptanceFacts, 'requestsBeforeEscalation'>, wireCounts: readonly number[], sizing: Pick<Sizing, 'ceiling'>): string | undefined => {
  const before = facts.requestsBeforeEscalation;
  if (before === undefined || before < 3) return `(g) too few requests before the escalation (${before ?? 'none'}) to measure the growth of a step`;
  const previous = wireCounts[before - 1] as number;
  const growth = Math.max(0, ...wireCounts.slice(1, before).map((count, index) => count - (wireCounts[index] as number)));
  if (previous + growth > sizing.ceiling) return undefined;
  return `(g) escalated although the request before it (${previous} tokens) plus one more step (${growth}) stays within the ceiling ${sizing.ceiling}`;
};

type DryRunInput = { readonly plan: PlanInput; readonly steps: readonly PlannedStep[]; readonly perturbation: number; readonly fillers: number };

const TERMINAL: ReadonlySet<string> = new Set(['COMPLETED', 'STOPPED', 'FAILED', 'CANCELLED']);

export type DryRunRecord = DryRun & { readonly journal: readonly JournalEvent[]; readonly bodies: readonly unknown[]; readonly counts: readonly CountTokensResult[]; readonly observedCounts: readonly number[] };

export const dryRun = async ({ plan, steps, perturbation, fillers }: DryRunInput): Promise<DryRunRecord> => {
  const env = await makeEnv();
  const client = createGatewayClient({ socketPath: plan.gatewaySocket, clock: env.clock, version: SUPERVISOR_APP_VERSION });
  try {
    const fake = env.gateway;
    fake.script = dryRunStepsOf(steps, plan.spec.toolCalling);
    const counts: CountTokensResult[] = [];
    const observedCounts: number[] = [];
    const reportingStream = async function* (body: Parameters<GatewayPort['stream']>[0], options: Parameters<GatewayPort['stream']>[1]) {
      const counted = await client.countTokens(body as Parameters<GatewayPort['countTokens']>[0], { signal: options.signal });
      const reported = Math.max(0, counted.input_tokens + perturbation - REPORTED_BELOW_ESTIMATE_TOKENS);
      for await (const event of fake.stream(body, options)) {
        if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          yield { ...event, response: { ...event.response, usage: usageOf(reported, SCRIPTED_OUTPUT_TOKENS) } };
        } else {
          yield event;
        }
      }
    };
    const gateway: GatewayPort = {
      stream: reportingStream,
      cancel: (key, options) => fake.cancel(key, options),
      compact: (request, options) => client.compact(request, options),
      capabilities: (alias, options) => client.capabilities(alias, options),
      model: (alias, options) => client.model(alias, options),
      countTokens: async (request, options) => {
        const result = await client.countTokens(request, options);
        const perturbed = { ...result, input_tokens: Math.max(0, result.input_tokens + perturbation) };
        if (request.momonga === undefined) {
          counts.push(result);
          observedCounts.push(perturbed.input_tokens);
        }
        return perturbed;
      },
    };
    env.settings.extraRules.push(...plan.spec.deny.map((rule) => ({ effect: 'deny' as const, rule })));
    const session = env.store.createSession({
      cwd: plan.home.project,
      env: { HOME: plan.home.home, PATH: SESSION_PATH, TMPDIR: plan.home.sessionTmp },
      permissionMode: 'bypassPermissions',
      bypassAllowed: true,
      modelAlias: E2E_MODEL_ALIAS,
    });
    const created = env.store.createRunAndEnqueue(session.id, { input: ACCEPTANCE_TASK, timeoutMs: RUNTIME_DEFAULTS.runTimeoutMs, limits: {}, pins: {} });
    if (created.kind !== 'created') throw new Error(`dry run: the run was not created (${created.kind})`);
    const runId = created.run.id;
    const worker = env.worker('planner', {
      gateway,
      systemPrompt: buildSystemPrompt,
      home: plan.home.home,
      instructionReader: createFsInstructionReader(),
      defaults: RUNTIME_DEFAULTS.limits,
      toolList: () => createBuiltinTools(),
      memories: createMemoryPort({ store: env.store, settings: env.settings, evidenceRun: unavailableEvidenceRun }),
      history: createHistoryPort({
        store: env.store,
        settings: env.settings,
        clock: systemClock,
        home: plan.home.home,
        redactor: createRedactor({ credentials: [] }),
        enforcement: 'exact-paths',
      }),
      tools: { sandbox: createUnsandboxed() },
    });
    for (let round = 0; round < DRY_RUN_MAX_CLAIMS && !TERMINAL.has(env.run(runId).status); round += 1) {
      if ((await env.runOnce(worker)) === 'idle') break;
    }
    if (env.fatals.length > 0) throw env.fatals[0];
    const run = env.run(runId);
    const journal = journalOfRunEvents(env.events(runId));
    const bodies = ofType(journal, 'model.requested').map((event) => event.data['body']);
    const signal = AbortSignal.timeout(30_000);
    const wireCounts: number[] = [];
    for (const body of bodies) wireCounts.push((await client.countTokens(body as Parameters<GatewayPort['countTokens']>[0], { signal })).input_tokens);
    return {
      perturbation,
      fillers,
      facts: factsOf(journal, plan.haystack, run.status, run.stopReason),
      claims: run.attempts,
      wireCounts,
      pinned: wireCounts[0] ?? counts[0]?.input_tokens,
      journal,
      bodies,
      counts,
      observedCounts,
    };
  } finally {
    await client.destroy();
  }
};

const describeShape = (shape: FillerShape): string => (shape.tool === 'Read' ? `Read L=${shape.lineChars}` : `ReadOutput limit=${shape.limit}`);

const describeRun = (run: DryRun): string =>
  `${run.perturbation >= 0 ? '+' : ''}${run.perturbation} n=${run.fillers} claims=${run.claims} ${run.facts.status}${run.facts.stopReason === undefined ? '' : ` ${run.facts.stopReason}`} compactions=${run.facts.compactionSeqs.length} grepEviction=${run.facts.grepEvictionSeq ?? '-'} wire=[${run.wireCounts.join(', ')}]${run.facts.notices.length === 0 ? '' : ` notices=${JSON.stringify(run.facts.notices)}`}`;

export const describeSizing = (sizing: Sizing): string =>
  `P=${sizing.pinned} C=${sizing.ceiling} room=${sizing.room} itemCap=${sizing.itemCap} inline=${sizing.inlineChars} summaryCap=${sizing.summaryCap} item=${sizing.summaryItem} highMark=${sizing.highMark} lowMark=${sizing.lowMark} threshold=${sizing.gainThreshold}`;

export class NoPlanError extends Error {
  readonly attempts: readonly PlanAttempt[];
  constructor(spec: PlanCaseSpec, sizing: Sizing | undefined, attempts: readonly PlanAttempt[]) {
    const lines = attempts.map((attempt) => `  ${describeShape(attempt.shape)}: ${attempt.verdict}\n${attempt.runs.map((run) => `    ${describeRun(run)}`).join('\n')}`);
    super(
      `planner: no candidate script for ${spec.name} shows (a) to (d) under the -2/+2 perturbation; ${sizing === undefined ? 'P unmeasured' : describeSizing(sizing)}; grid ${spec.grid.map(describeShape).join(', ')}\n${lines.join('\n')}`,
    );
    this.name = 'NoPlanError';
    this.attempts = attempts;
  }
}

const singleClaimVerdict = (run: DryRun): string | undefined => (run.claims === 1 ? undefined : `(e) the dry run took ${run.claims} claims`);

export const planScript = async (input: PlanInput, capabilities: Capabilities): Promise<Plan> => {
  const attempts: PlanAttempt[] = [];
  let sizing: Sizing | undefined;
  for (const shape of input.spec.grid) {
    const probeSteps = plannedSteps(input.home.project, input.haystack, shape, input.spec.probeFillers);
    const probe = await dryRun({ plan: input, steps: probeSteps, perturbation: 0, fillers: input.spec.probeFillers });
    if (probe.pinned !== undefined) sizing ??= sizingFor(capabilities, probe.pinned);
    const needed = probe.facts.fillersBeforeFirstCompaction;
    if (needed === undefined) {
      attempts.push({ shape, runs: [probe], verdict: `probe: ${verdictOf(probe.facts, input.spec.escalates === true) ?? 'no compaction'}` });
      continue;
    }
    const escalatesAt = probe.facts.fillersBeforeEscalation;
    if (input.spec.escalates === true && escalatesAt === undefined) {
      attempts.push({ shape, runs: [probe], verdict: `probe: ${verdictOf(probe.facts, true) ?? 'no escalation'}` });
      continue;
    }
    const fillers = Math.max(needed, escalatesAt ?? 0) + 1;
    const steps = plannedSteps(input.home.project, input.haystack, shape, fillers);
    const runs: DryRun[] = [];
    let verdict: string | undefined;
    for (const perturbation of PERTURBATIONS) {
      const run = await dryRun({ plan: input, steps, perturbation, fillers });
      runs.push(run);
      const budgetVerdict = input.spec.escalates === true && sizing !== undefined ? escalationBudgetVerdict(run.facts, run.wireCounts, sizing) : undefined;
      verdict = verdictOf(run.facts, input.spec.escalates === true) ?? singleClaimVerdict(run) ?? budgetVerdict;
      if (verdict !== undefined) {
        verdict = `perturbation ${perturbation}: ${verdict}`;
        break;
      }
    }
    attempts.push({ shape, runs: [probe, ...runs], verdict: verdict ?? 'accepted' });
    if (verdict === undefined) {
      if (sizing === undefined) throw new Error('planner: the accepted dry run measured no pinned count');
      return { spec: input.spec, shape, steps, replies: upstreamRepliesOf(steps, input.spec.toolCalling), sizing, runs, attempts };
    }
  }
  throw new NoPlanError(input.spec, sizing, attempts);
};
