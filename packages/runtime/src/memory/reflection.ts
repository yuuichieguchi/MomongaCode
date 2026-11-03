import { canonicalJson, computeBackoff, sha256Hex } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { normalizeMemoryText } from '@momonga/memory';
import { assistantTextOf, summaryTokenCapFor } from '@momonga/protocol';
import type { CreateResponseBody, Usage } from '@momonga/protocol';
import { memoryTextProblem } from '@momonga/tools';
import type { ContextChargeInput, RuntimeStore, SaveCandidateInput } from '@momonga/store';
import type { GatewayPort, SettingsPort } from '../ports.ts';
import { REQUEUE_BASE_MS, REQUEUE_MAX_MS } from '../process/constants.ts';
import { RUNTIME_DEFAULTS } from '../process/defaults.ts';
import { readPins } from '../worker/pins.ts';
import { isRunVerified } from './verified-run.ts';
import { readAllRunEvents } from '../process/run-events.ts';
import { terminalResultOf } from '../worker/model-stream.ts';
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
  random: () => number;
};

export type ReflectorTurn = 'idle' | 'busy' | 'ran';

export type Reflector = { runOne(signal: AbortSignal): Promise<ReflectorTurn> };

const DEDUPLICATED_STATES: readonly string[] = ['active', 'candidate', 'rejected'];

type ChargeLedger = { unrecorded?: ContextChargeInput };

export const createReflector = (options: ReflectorOptions): Reflector => {
  const { store, gateway, settings, clock } = options;
  let running = false;
  const retryAt = new Map<string, number>();

  const complete = async (runId: string, body: CreateResponseBody, signal: AbortSignal): Promise<{ terminal: ModelResult; usage: Usage | null }> => {
    let terminal: ModelResult | undefined;
    let usage: Usage | null = null;
    const events = gateway.stream(body, {
      idempotencyKey: sha256Hex(canonicalJson([runId, 'reflect'])),
      deadlineAt: clock.now() + RUNTIME_DEFAULTS.runTimeoutMs,
      signal,
    });
    for await (const event of events) {
      terminal = terminalResultOf(event) ?? terminal;
      if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') usage = event.response.usage;
    }
    if (terminal === undefined) throw new Error(`the reflection call of run ${runId} ended without a terminal event`);
    return { terminal, usage };
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
    const { modelAlias: alias } = readPins(started.pins);
    const [capabilities, verification] = await Promise.all([gateway.capabilities(alias, { signal }), settings.verification(session)]);
    const structured = capabilities.structuredOutput === 'json_schema';
    const body: CreateResponseBody = {
      model: alias,
      instructions: REFLECTION_INSTRUCTIONS,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: reflectionInputFor(events, project, capabilities) }] }],
      ...(structured ? { text: { format: { type: 'json_schema', name: 'memory_candidates', schema: { ...REFLECTION_REPLY_SCHEMA }, strict: true } } } : {}),
      tool_choice: 'none',
      max_output_tokens: Math.min(memorySettings.reflection.maxTokens ?? Number.POSITIVE_INFINITY, summaryTokenCapFor(capabilities)),
      store: false,
      stream: true,
      metadata: { run_id: runId, purpose: 'reflection' },
    };
    const { terminal, usage } = await complete(runId, body, signal);
    if (usage !== null) {
      ledger.unrecorded = {
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
    const settle = (candidates: readonly SaveCandidateInput[], reason?: string): void => {
      store.reflection.complete({ runId, charge: ledger.unrecorded ?? null, candidates, ...(reason === undefined ? {} : { reason }) });
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
    for (const [ordinal, candidate] of parsed.candidates.entries()) {
      const normalized = normalizeMemoryText(candidate.text);
      if (memoryTextProblem(candidate.text) !== undefined || known.has(normalized)) continue;
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
      }
    }
    settle(accepted.map(({ ordinal, candidate, evidence }) => ({ scope: 'project', origin: 'trusted', project, text: candidate.text, runId, ordinal, kind: candidate.kind, evidence })));
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
        await reflect(job.runId, signal, ledger);
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
