import { canonicalJson, computeBackoff, sha256Hex } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { normalizeMemoryText } from '@momonga/memory';
import { LOWEST_REASONING_EFFORT, assistantTextOf, requireStructuredOutput, summaryTokenCapFor } from '@momonga/protocol';
import type { BilledDetail, CallTiming, CreateResponseBody, MomongaResponseExtension, ReflectionDrop, Usage } from '@momonga/protocol';
import { memoryTextProblem } from '@momonga/tools';
import type { ContextChargeInput, RuntimeStore, SaveCandidateInput } from '@momonga/store';
import type { GatewayPort, SettingsPort } from '../ports.ts';
import { REQUEUE_BASE_MS, REQUEUE_MAX_MS } from '../process/constants.ts';
import type { ServiceTimers } from '../service/timers.ts';
import { readPins } from '../worker/pins.ts';
import { isRunVerified } from './verified-run.ts';
import { readAllRunEvents } from '../process/run-events.ts';
import { billedDetailOf, carriesOutput, terminalResultOf } from '../worker/model-stream.ts';
import type { ModelResult } from '../worker/model-stream.ts';
import { MemoryEvidenceError, bindMemoryEvidence, readGitHead } from './evidence.ts';
import type { EvidenceRun } from './evidence.ts';
import { REFLECTION_INSTRUCTIONS, reflectionInputFor } from './reflection-input.ts';
import { REFLECTION_REPLY_SCHEMA, parseReflectionReply } from './reflection-reply.ts';

export type ReflectorOptions = {
  store: Pick<RuntimeStore, 'reflection' | 'memories' | 'contextCharges' | 'getRun' | 'getSession' | 'readRunEvents'>;
  gateway: Pick<GatewayPort, 'stream' | 'capabilities'>;
  settings: Pick<SettingsPort, 'trusted' | 'verification' | 'memory'>;
  clock: Clock;
  isIdle(): boolean;
  evidenceRun: (project: string) => EvidenceRun;
  maxAttempts: number;
  attemptTimeoutMs: number;
  timers: ServiceTimers;
  random: () => number;
};

export type ReflectorTurn = 'idle' | 'busy' | 'ran';

export type Reflector = { runOne(signal: AbortSignal): Promise<ReflectorTurn> };

const DEDUPLICATED_STATES: readonly string[] = ['active', 'candidate', 'rejected'];

const NO_CANDIDATES_REASON = 'the model proposed no candidates';
const ALL_DROPPED_REASON = 'every candidate the model proposed was dropped';
const DUPLICATE_REASON = 'the same text is already a live memory, a candidate waiting for review, or a candidate a person rejected';

type ChargeLedger = { unrecorded?: ContextChargeInput };

export const createReflector = (options: ReflectorOptions): Reflector => {
  const { store, gateway, settings, clock } = options;
  let running = false;
  const retryAt = new Map<string, number>();

  const complete = async (
    runId: string,
    body: CreateResponseBody,
    signal: AbortSignal,
  ): Promise<{ terminal: ModelResult; usage: Usage | null; detail: BilledDetail }> => {
    let terminal: ModelResult | undefined;
    let usage: Usage | null = null;
    let extension: MomongaResponseExtension | undefined;
    let responseId: string | undefined;
    let firstEventMs: number | undefined;
    const startedAt = clock.now();
    const events = gateway.stream(body, {
      idempotencyKey: sha256Hex(canonicalJson([runId, 'reflect'])),
      deadlineAt: clock.now() + options.attemptTimeoutMs,
      signal,
      role: 'reflection',
    });
    for await (const event of events) {
      if (firstEventMs === undefined && carriesOutput(event)) firstEventMs = clock.now() - startedAt;
      terminal = terminalResultOf(event) ?? terminal;
      if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
        usage = event.response.usage;
        extension = event.response.momonga;
        responseId = event.response.id;
      }
    }
    if (terminal === undefined) throw new Error(`the reflection call of run ${runId} ended without a terminal event`);
    const timing: CallTiming = { ...(firstEventMs === undefined ? {} : { firstEventMs }), durationMs: clock.now() - startedAt };
    if (responseId === undefined) throw new Error(`the reflection call of run ${runId} ended without a response`);
    return { terminal, usage, detail: billedDetailOf(usage, extension, timing, responseId) };
  };

  const reflect = async (runId: string, signal: AbortSignal, ledger: ChargeLedger): Promise<void> => {
    store.reflection.begin(runId);
    const run = store.getRun(runId);
    if (run === undefined) throw new Error(`run ${runId} of a reflection job does not exist`);
    const session = store.getSession(run.sessionId);
    if (session === undefined) throw new Error(`session ${run.sessionId} of run ${runId} does not exist`);
    const memorySettings = await settings.memory(session);
    const declined =
      store.reflection.runOrigin(runId) !== 'trusted'
        ? 'the run was not made in a trusted folder'
        : !memorySettings.reflection.enabled
          ? 'reflection is off'
          : !(await isRunVerified({ store, settings }, runId))
            ? 'the run is not a verified success'
            : undefined;
    if (declined !== undefined) {
      store.reflection.finish(runId, declined);
      return;
    }
    const { cwd: project } = session;
    const events = readAllRunEvents(store, runId);
    const started = events.find((event) => event.type === 'run.started');
    if (started === undefined) throw new Error(`run ${runId} has no run.started event`);
    const pins = readPins(started.pins);
    const alias = pins.roles.reflection ?? pins.modelAlias;
    const [capabilities, verification] = await Promise.all([gateway.capabilities(alias, { signal }), settings.verification(session)]);
    const structured = requireStructuredOutput(capabilities, pins.roles.reflection === undefined ? 'the model of the run' : 'models.roles.reflection', alias);
    if (!structured.ok) {
      store.reflection.finish(runId, structured.reason);
      return;
    }
    const body: CreateResponseBody = {
      model: alias,
      instructions: REFLECTION_INSTRUCTIONS,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: reflectionInputFor(events, project, capabilities) }] }],
      text: { format: { type: 'json_schema', name: 'memory_candidates', schema: { ...REFLECTION_REPLY_SCHEMA }, strict: true } },
      tool_choice: 'none',
      reasoning: { effort: LOWEST_REASONING_EFFORT },
      max_output_tokens: Math.min(memorySettings.reflection.maxTokens ?? Number.POSITIVE_INFINITY, summaryTokenCapFor(capabilities)),
      store: false,
      stream: true,
      metadata: { run_id: runId, purpose: 'reflection' },
    };
    const { terminal, usage, detail } = await complete(runId, body, signal);
    if (usage !== null) {
      ledger.unrecorded = {
        detail,
        purpose: 'reflection',
        runId,
        project,
        model: alias,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalTokens: usage.total_tokens,
      };
    }
    if (terminal.kind === 'failed') throw new Error(`the reflection call of run ${runId} failed: ${terminal.code ?? 'error'}: ${terminal.message}`);
    if (usage === null) throw new Error(`the reflection response of run ${runId} carries no usage`);
    const settle = (candidates: readonly SaveCandidateInput[], reason?: string, dropped: readonly ReflectionDrop[] = []): void => {
      store.reflection.complete({ runId, charge: ledger.unrecorded ?? null, candidates, dropped, ...(reason === undefined ? {} : { reason }) });
      delete ledger.unrecorded;
    };
    const parsed = parseReflectionReply(assistantTextOf(terminal.response.output));
    if ('error' in parsed) {
      settle([], parsed.error);
      return;
    }
    const trusted = settings.trusted(session);
    const known = new Set(
      store.memories
        .list({ project })
        .filter((memory) => memory.origin === 'trusted' && DEDUPLICATED_STATES.includes(memory.state))
        .map((memory) => normalizeMemoryText(memory.text)),
    );
    const accepted: { ordinal: number; candidate: (typeof parsed.candidates)[number]; evidence: Awaited<ReturnType<typeof bindMemoryEvidence>> }[] = [];
    const dropped: ReflectionDrop[] = [];
    for (const [ordinal, candidate] of parsed.candidates.entries()) {
      const normalized = normalizeMemoryText(candidate.text);
      const problem = memoryTextProblem(candidate.text);
      if (problem !== undefined) {
        dropped.push({ ordinal, text: null, cause: 'text_rule', reason: problem.message });
        continue;
      }
      if (known.has(normalized)) {
        dropped.push({ ordinal, text: candidate.text, cause: 'duplicate', reason: DUPLICATE_REASON });
        continue;
      }
      try {
        const evidence = await bindMemoryEvidence({
          runId,
          events,
          paths: candidate.paths,
          project,
          trusted,
          verificationCommands: verification.commands,
          head: () => readGitHead({ project, trusted, run: options.evidenceRun(project), signal }),
        });
        known.add(normalized);
        accepted.push({ ordinal, candidate, evidence });
      } catch (error) {
        if (!(error instanceof MemoryEvidenceError)) throw error;
        dropped.push({ ordinal, text: candidate.text, cause: 'evidence', reason: error.message });
      }
    }
    signal.throwIfAborted();
    const nothingKept = accepted.length === 0;
    const reason = !nothingKept ? undefined : parsed.candidates.length === 0 ? NO_CANDIDATES_REASON : ALL_DROPPED_REASON;
    settle(
      accepted.map(({ ordinal, candidate, evidence }) => ({ scope: 'project', origin: 'trusted', project, text: candidate.text, runId, ordinal, kind: candidate.kind, evidence })),
      reason,
      dropped,
    );
  };

  const recordUnrecorded = (ledger: ChargeLedger, cause: unknown): void => {
    if (ledger.unrecorded === undefined) return;
    try {
      store.contextCharges.record(ledger.unrecorded);
    } catch (chargeError) {
      throw new AggregateError([cause, chargeError], 'the reflection failed and the charge of its call could not be recorded');
    }
  };

  return {
    runOne: async (signal) => {
      if (running) return 'busy';
      if (!options.isIdle()) return 'busy';
      const now = clock.now();
      const waiting = new Set([...retryAt].filter(([, due]) => due > now).map(([runId]) => runId));
      const job = store.reflection.next(waiting);
      if (job === undefined) return 'idle';
      running = true;
      const ledger: ChargeLedger = {};
      try {
        const deadline = new AbortController();
        const timer = options.timers.setTimeout(() => deadline.abort(new Error(`the reflection attempt passed its deadline of ${options.attemptTimeoutMs} ms`)), options.attemptTimeoutMs);
        try {
          await reflect(job.runId, AbortSignal.any([signal, deadline.signal]), ledger);
        } finally {
          options.timers.clearTimeout(timer);
        }
        retryAt.delete(job.runId);
        return 'ran';
      } catch (error) {
        if (signal.aborted) {
          recordUnrecorded(ledger, error);
          store.reflection.release(job.runId);
          throw error;
        }
        const attempts = store.reflection.get(job.runId)?.attempts ?? job.attempts;
        const reason = error instanceof Error ? error.message : String(error);
        if (attempts >= options.maxAttempts) {
          retryAt.delete(job.runId);
          store.reflection.fail(job.runId, reason, ledger.unrecorded);
        } else {
          recordUnrecorded(ledger, error);
          retryAt.set(job.runId, clock.now() + computeBackoff({ attempt: attempts - 1, baseMs: REQUEUE_BASE_MS, maxMs: REQUEUE_MAX_MS, random: options.random }));
        }
        throw error;
      } finally {
        running = false;
      }
    },
  };
};
