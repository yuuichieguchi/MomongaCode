import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { normalizeMemoryText } from '@momonga/memory';
import { assistantTextOf, summaryTokenCapFor } from '@momonga/protocol';
import type { CreateResponseBody } from '@momonga/protocol';
import { memoryTextProblem } from '@momonga/tools';
import type { RuntimeStore } from '@momonga/store';
import type { GatewayPort, SettingsPort } from '../ports.ts';
import { RUNTIME_DEFAULTS } from '../process/defaults.ts';
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
};

export type ReflectorTurn = 'idle' | 'busy' | 'ran';

export type Reflector = { runOne(signal: AbortSignal): Promise<ReflectorTurn> };

const DEDUPLICATED_STATES: readonly string[] = ['active', 'candidate', 'rejected'];

export const createReflector = (options: ReflectorOptions): Reflector => {
  const { store, gateway, settings, clock } = options;
  let running = false;

  const complete = async (runId: string, body: CreateResponseBody, signal: AbortSignal): Promise<ModelResult> => {
    let terminal: ModelResult | undefined;
    const events = gateway.stream(body, {
      idempotencyKey: sha256Hex(canonicalJson([runId, 'reflect'])),
      deadlineAt: clock.now() + RUNTIME_DEFAULTS.runTimeoutMs,
      signal,
    });
    for await (const event of events) terminal = terminalResultOf(event) ?? terminal;
    if (terminal === undefined) throw new Error(`the reflection call of run ${runId} ended without a terminal event`);
    return terminal;
  };

  const reflect = async (runId: string, signal: AbortSignal): Promise<void> => {
    const run = store.getRun(runId);
    if (run === undefined) throw new Error(`run ${runId} of a reflection job does not exist`);
    const session = store.getSession(run.sessionId);
    if (session === undefined) throw new Error(`session ${run.sessionId} of run ${runId} does not exist`);
    if (store.reflection.runOrigin(runId) !== 'trusted') throw new Error(`run ${runId} was not recorded as trusted, so it cannot be reflected on`);
    store.reflection.begin(runId);
    const { cwd: project, modelAlias: alias } = session;
    const [capabilities, memorySettings, verification] = await Promise.all([
      gateway.capabilities(alias, { signal }),
      settings.memory(session),
      settings.verification(session),
    ]);
    const events = readAllRunEvents(store, runId);
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
    const terminal = await complete(runId, body, signal);
    if (terminal.kind === 'failed') throw new Error(`the reflection call of run ${runId} failed: ${terminal.code ?? 'error'}: ${terminal.message}`);
    const { usage } = terminal.response;
    if (usage === null) throw new Error(`the reflection response of run ${runId} carries no usage`);
    const charge = () =>
      store.contextCharges.record({
        purpose: 'reflection',
        runId,
        project,
        model: alias,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalTokens: usage.total_tokens,
      });
    const parsed = parseReflectionReply(assistantTextOf(terminal.response.output));
    if ('error' in parsed) {
      charge();
      store.reflection.finish(runId, parsed.error);
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
    charge();
    for (const { ordinal, candidate, evidence } of accepted) {
      store.memories.saveCandidate({ scope: 'project', origin: 'trusted', project, text: candidate.text, runId, ordinal, kind: candidate.kind, evidence });
    }
    store.reflection.finish(runId);
  };

  return {
    runOne: async (signal) => {
      if (running) return 'busy';
      if (!options.isIdle()) return 'busy';
      const job = store.reflection.next();
      if (job === undefined) return 'idle';
      running = true;
      try {
        await reflect(job.runId, signal);
        return 'ran';
      } finally {
        running = false;
      }
    },
  };
};
