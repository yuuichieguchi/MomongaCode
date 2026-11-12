import { computeBackoff, readJsonReply } from '@momonga/foundation';
import type { Clock, RolePort } from '@momonga/foundation';
import { normalizeMemoryText } from '@momonga/memory';
import { LOWEST_REASONING_EFFORT, jsonReplyOf, summaryTokenCapFor } from '@momonga/protocol';
import type { NewBilledDetail, CallTiming, CreateResponseBody, MomongaResponseExtension, ReflectionDrop, TextFormat, Usage } from '@momonga/protocol';
import { memoryTextProblem } from '@momonga/tools';
import type { RunCharge, RuntimeStore, SaveCandidateInput } from '@momonga/store';
import type { GatewayPort, SettingsPort } from '../ports.ts';
import { requestKey } from '../model-key.ts';
import { REQUEUE_BASE_MS, REQUEUE_MAX_MS } from '../process/constants.ts';
import type { ServiceTimers } from '../service/timers.ts';
import { retireDecisionOf } from '../worker/gateway-policy.ts';
import { readPins } from '../worker/pins.ts';
import { billedDetailOf, carriesOutput, terminalResultOf } from '../worker/model-stream.ts';
import type { ModelResult } from '../worker/model-stream.ts';
import { MemoryEvidenceError, bindMemoryEvidence, readGitHead, runFactsOf } from './evidence.ts';
import type { EvidenceRun } from './evidence.ts';
import { REFLECTION_INSTRUCTIONS } from './reflection-input.ts';
import { REFLECTION_REPLY_SCHEMA, validateReflectionReply } from './reflection-reply.ts';
import { EXACT_MODEL } from '../worker/exact-model.ts';
import { outputBoundOf } from '../worker/output-bound.ts';
import { ceilingOf, streamAdmitted, unpaidMessage, withAdmission } from '../worker/admitted-request.ts';
import type { AdmissionProof, BudgetAccount } from '../worker/admitted-request.ts';
import { readRunLimits } from '../worker/limits.ts';
import type { WorkerDefaults } from '../worker/types.ts';

export type ReflectorOptions = {
  platform: NodeJS.Platform;
  store: Pick<RuntimeStore, 'reflection' | 'memories' | 'chargeEndedRun' | 'getRun' | 'getSession' | 'readRunEventsOfTypes' | 'journalFacts' | 'treeSpend' | 'admitModelRequest'>;
  gateway: Pick<GatewayPort, 'stream' | 'capabilities' | 'countTokens' | 'quote'>;
  defaults?: WorkerDefaults;
  settings: Pick<SettingsPort, 'trusted' | 'verification' | 'memory'>;
  clock: Clock;
  role: Pick<RolePort, 'refresh'>;
  isIdle(): boolean;
  evidenceRun: (project: string) => EvidenceRun;
  maxAttempts: number;
  attemptTimeoutMs: number;
  timers: ServiceTimers;
  random: () => number;
};

export const reflectionModelOf = (pins: Record<string, unknown>): string => {
  const read = readPins(pins);
  return read.roles.reflection ?? read.model;
};

export type ReflectorTurn = 'idle' | 'busy' | 'ran';

export type Reflector = { runOne(signal: AbortSignal): Promise<ReflectorTurn> };

const DEDUPLICATED_STATES: readonly string[] = ['active', 'candidate', 'rejected'];

const NO_CANDIDATES_REASON = 'the model proposed no candidates';
const ALL_DROPPED_REASON = 'every candidate the model proposed was dropped';
const DUPLICATE_REASON = 'the same text is already a live memory, a candidate waiting for review, or a candidate a person rejected';

type ChargeLedger = { unrecorded?: RunCharge; facts?: readonly SaveCandidateInput[] };

export const createReflector = (options: ReflectorOptions): Reflector => {
  const { store, gateway, settings, clock } = options;
  let running = false;
  const retryAt = new Map<string, number>();

  const complete = async (
    runId: string,
    body: CreateResponseBody,
    signal: AbortSignal,
    proof: AdmissionProof,
  ): Promise<{ terminal: ModelResult; usage: Usage | null; detail: NewBilledDetail }> => {
    let terminal: ModelResult | undefined;
    let usage: Usage | null = null;
    let extension: MomongaResponseExtension | undefined;
    let responseId: string | undefined;
    let firstEventMs: number | undefined;
    const startedAt = options.timers.monotonicMs();
    const events = streamAdmitted(gateway, proof, body, {
      idempotencyKey: requestKey(runId, 'reflect', body),
      deadlineAt: clock.now() + options.attemptTimeoutMs,
      signal,
      role: 'reflection',
    });
    for await (const event of events) {
      if (firstEventMs === undefined && carriesOutput(event)) firstEventMs = options.timers.monotonicMs() - startedAt;
      terminal = terminalResultOf(event) ?? terminal;
      if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
        usage = event.response.usage;
        extension = event.response.momonga;
        responseId = event.response.id;
      }
    }
    if (terminal === undefined) throw new Error(`the reflection call of run ${runId} ended without a terminal event`);
    const timing: CallTiming = { ...(firstEventMs === undefined ? {} : { firstEventMs }), durationMs: options.timers.monotonicMs() - startedAt };
    if (responseId === undefined) throw new Error(`the reflection call of run ${runId} ended without a response`);
    return { terminal, usage, detail: billedDetailOf(usage, extension, timing, responseId) };
  };

  const reflect = async (runId: string, signal: AbortSignal, ledger: ChargeLedger): Promise<void> => {
    store.reflection.begin(runId);
    const run = store.getRun(runId);
    if (run === undefined) throw new Error(`run ${runId} of a reflection job does not exist`);
    const session = store.getSession(run.sessionId);
    if (session === undefined) throw new Error(`session ${run.sessionId} of run ${runId} does not exist`);
    const memorySettings = await settings.memory(session, signal);
    const { cwd: project } = session;
    const factsOn = memorySettings.repositoryFacts;
    const needsVerdict = memorySettings.reflection.enabled || factsOn;
    const declinedEarly =
      store.reflection.runOrigin(runId) !== 'trusted' ? 'the run was not made in a trusted folder' : !needsVerdict ? 'reflection is off' : undefined;
    if (declinedEarly !== undefined) {
      store.reflection.finish(runId, declinedEarly);
      return;
    }
    const verification = await settings.verification(session, signal);
    const verdict = await store.journalFacts.verdict({ runId, commands: verification.commands, manifests: verification.manifests }, signal);
    const { verified } = verdict;
    const trusted = await settings.trusted(session, signal);
    const knownTexts = (): Set<string> =>
      new Set(
        store.memories
          .list({ project })
          .filter((memory) => memory.origin === 'trusted' && DEDUPLICATED_STATES.includes(memory.state))
          .map((memory) => normalizeMemoryText(memory.text)),
      );
    let known: Set<string> | undefined;
    let head: Promise<string | undefined> | undefined;
    const readHead = (): Promise<string | undefined> => {
      head ??= readGitHead({ project, trusted, run: options.evidenceRun(project), signal });
      return head;
    };
    const dropped: ReflectionDrop[] = [];
    const screen = async (
      ordinal: number,
      text: string,
      kind: SaveCandidateInput['kind'],
      paths: readonly string[],
      onlyCommand?: string,
    ): Promise<SaveCandidateInput | undefined> => {
      known ??= knownTexts();
      const normalized = normalizeMemoryText(text);
      const problem = memoryTextProblem(text);
      if (problem !== undefined) {
        dropped.push({ ordinal, text: null, cause: 'text_rule', reason: problem.message });
        return undefined;
      }
      if (known.has(normalized)) {
        dropped.push({ ordinal, text, cause: 'duplicate', reason: DUPLICATE_REASON });
        return undefined;
      }
      try {
        const evidence = await bindMemoryEvidence({
          platform: options.platform,
          scope: 'project',
          paths,
          project,
          trusted,
          facts: async (resolved) =>
            runFactsOf(
              runId,
              await store.journalFacts.evidence(
              { runId, paths: resolved, ...(onlyCommand === undefined ? {} : { onlyCommand }) },
                signal,
              ),
            ),
          head: readHead,
        });
        known.add(normalized);
        return { scope: 'project', origin: 'trusted', project, text, runId, ordinal, kind, evidence };
      } catch (error) {
        if (!(error instanceof MemoryEvidenceError)) throw error;
        dropped.push({ ordinal, text, cause: 'evidence', reason: error.message });
        return undefined;
      }
    };
    const facts = factsOn && verified ? verdict.facts : [];
    const keptFacts: SaveCandidateInput[] = [];
    for (const [ordinal, fact] of facts.entries()) {
      const screened = await screen(ordinal, fact.text, fact.kind, fact.manifestPaths, fact.command);
      if (screened !== undefined) keptFacts.push(screened);
    }
    ledger.facts = keptFacts;
    if (!memorySettings.reflection.enabled) {
      store.reflection.complete({ runId, charge: null, candidates: keptFacts, dropped, reason: 'reflection is off' });
      return;
    }
    if (!verified) {
      store.reflection.finish(runId, 'the run is not a verified success');
      return;
    }
    const started = store.readRunEventsOfTypes(runId, ['run.started'])[0];
    if (started?.type !== 'run.started') throw new Error(`run ${runId} has no run.started event`);
    const model = reflectionModelOf(started.pins);
    const capabilities = await gateway.capabilities(model, { signal });
    const format: TextFormat = { type: 'json_schema', name: 'memory_candidates', schema: { ...REFLECTION_REPLY_SCHEMA }, strict: true };
    const { input: recordedRun } = await store.journalFacts.reflectionInput({ runId, project, capabilities }, signal);
    const input: CreateResponseBody['input'] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: recordedRun }] }];
    const counted = await gateway.countTokens({ model, input, instructions: REFLECTION_INSTRUCTIONS, momonga: { ...EXACT_MODEL } }, { signal });
    const limits = readRunLimits(run.limits, options.defaults);
    const account: BudgetAccount = {
      limits: { maxTotalTokens: limits.maxTotalTokens, ...(limits.maxCostNano === undefined ? {} : { maxCostNano: limits.maxCostNano }) },
      quote: (quoted) => gateway.quote(quoted, { signal }),
      spend: () => store.treeSpend(runId),
      ledger: { admitModelRequest: (ask) => store.admitModelRequest({ runId, settled: true }, ask) },
      tail: Promise.resolve(),
    };
    const outputWanted = Math.min(memorySettings.reflection.maxTokens ?? Number.POSITIVE_INFINITY, summaryTokenCapFor(capabilities));
    const sent = await withAdmission(
      account,
      { model, size: { inputTokens: counted.input_tokens, marginTokens: counted.error_bound, maxOutputTokens: outputWanted } },
      ({ admitted, proof }) => {
        const body: CreateResponseBody = {
          model,
          instructions: REFLECTION_INSTRUCTIONS,
          input,
          text: { format },
          tool_choice: 'none',
          reasoning: { effort: LOWEST_REASONING_EFFORT },
          ...outputBoundOf(capabilities, admitted.maxOutputTokens),
          store: false,
          stream: true,
          metadata: { run_id: runId, purpose: 'reflection' },
          momonga: { ...EXACT_MODEL, ...ceilingOf(admitted) },
        };
        return complete(runId, body, signal, proof);
      },
    );
    if (sent.kind === 'lease_lost') throw new Error(`the store asked for a lease to admit the reflection call of the ended run ${runId}`);
    if (sent.kind === 'exhausted') {
      const reason = unpaidMessage('reflection', sent.exhausted);
      store.reflection.complete({
        runId,
        charge: null,
        notice: { type: 'notice', level: 'warning', message: `The run was not reflected on, so nothing was learned from it: ${reason}`, code: 'budget_auxiliary_skipped' },
        candidates: keptFacts,
        dropped,
        reason,
      });
      return;
    }
    const { terminal, usage, detail } = sent.value;
    if (usage !== null) {
      ledger.unrecorded = {
        runId,
        charged: { type: 'usage.charged', purpose: 'reflection', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens, ...detail },
      };
    }
    if (terminal.kind === 'failed') throw new Error(`the reflection call of run ${runId} failed: ${terminal.code}: ${terminal.message}`);
    if (usage === null) throw new Error(`the reflection response of run ${runId} carries no usage`);
    const settle = (candidates: readonly SaveCandidateInput[], reason?: string): void => {
      store.reflection.complete({ runId, charge: ledger.unrecorded ?? null, candidates: [...keptFacts, ...candidates], dropped, ...(reason === undefined ? {} : { reason }) });
      delete ledger.unrecorded;
    };
    const parsed = readJsonReply(validateReflectionReply, jsonReplyOf(terminal.response));
    if ('error' in parsed) {
      settle([], parsed.error);
      return;
    }
    known = knownTexts();
    for (const fact of keptFacts) known.add(normalizeMemoryText(fact.text));
    const accepted: SaveCandidateInput[] = [];
    for (const [index, candidate] of parsed.value.candidates.entries()) {
      const screened = await screen(facts.length + index, candidate.text, candidate.kind, candidate.paths);
      if (screened !== undefined) accepted.push(screened);
    }
    signal.throwIfAborted();
    const nothingKept = keptFacts.length + accepted.length === 0;
    const reason = !nothingKept ? undefined : parsed.value.candidates.length === 0 ? NO_CANDIDATES_REASON : ALL_DROPPED_REASON;
    settle(accepted, reason);
  };

  const recordUnrecorded = (ledger: ChargeLedger, cause: unknown): void => {
    if (ledger.unrecorded === undefined) return;
    try {
      store.chargeEndedRun(ledger.unrecorded);
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
        if ((await retireDecisionOf(error, options.role)) === 'retire-yield') {
          recordUnrecorded(ledger, error);
          store.reflection.release(job.runId);
          return 'idle';
        }
        const attempts = store.reflection.get(job.runId)?.attempts ?? job.attempts;
        const reason = error instanceof Error ? error.message : String(error);
        if (attempts >= options.maxAttempts) {
          retryAt.delete(job.runId);
          store.reflection.fail(job.runId, reason, ledger.unrecorded, ledger.facts);
        } else {
          recordUnrecorded(ledger, error);
          retryAt.set(job.runId, clock.now() + computeBackoff({ attempt: attempts - 1, baseMs: REQUEUE_BASE_MS, maxMs: REQUEUE_MAX_MS, random: { float: options.random } }));
        }
        throw error;
      } finally {
        running = false;
      }
    },
  };
};
