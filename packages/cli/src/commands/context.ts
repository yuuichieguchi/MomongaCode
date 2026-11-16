import path from 'node:path';
import type { ModelRoles } from '@momonga/config';
import {
  adoptionOf,
  buildContextReport,
  datasetDigestOf,
  encodeOutcomeFile,
  formatGuidelineText,
  formatImproveOutcome,
  guidelineDiff,
  improveGuideline,
  loadContextDataset,
  outcomeFileOf,
  parseOutcomeFile,
  refuseExistingOutput,
} from '@momonga/eval';
import type { BenchmarkResult, GuidelineCompletion, GuidelineCompletionRequest, ImproveInput, ImproveOutcome, Transcript } from '@momonga/eval';
import { codeDigestOfRunningProcess, currentSocketResolver, resolveLayoutLocks } from '@momonga/foundation';
import type { MomongaPaths, KernelLockMechanism } from '@momonga/foundation';
import { ESTIMATED_CHARACTERS_PER_TOKEN, LOWEST_REASONING_EFFORT, jsonReplyOf, summaryTokenCapFor } from '@momonga/protocol';
import type { ChainCapabilities, CreateResponseBody, GuidelineView, GuidelinesResponse, ResponseResource, StreamEvent } from '@momonga/protocol';
import type { RuntimeClient } from '../client/runtime-client.ts';
import { createGatewayClient as createCliGatewayClient } from '../client/gateway-client.ts';
import { CONTEXT_BOOTSTRAP_SEED } from '../constants.ts';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import { nodeContextEffects } from '../eval/context-effects.ts';
import { pinnedModelOf, runContextLive, unownedHomesNotice, unreadableHomesNotice } from '../eval/context-host.ts';
import type { ContextHostEffects } from '../eval/context-host.ts';
import type { CliPorts, Sink } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { isNotListedCapabilities, notListedMessage } from '@momonga/protocol';
import { shellModelsOf } from '../plain-http.ts';

export class ContextImproveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContextImproveError';
  }
}

export type ContextImproveOptions = {
  dataset: string;
  model: string;
  tokenCap: number;
  seed: number;
  outcome: string;
  interrupt: AbortSignal;
};

const RECORD_WINDOW_SHARE = 4;

const recordCharsFor = (capabilities: ChainCapabilities): number =>
  ESTIMATED_CHARACTERS_PER_TOKEN * Math.max(0, Math.floor((capabilities.contextWindow - capabilities.maxOutputTokens) / RECORD_WINDOW_SHARE));

export const terminalResponseOf = (events: readonly StreamEvent[]): ResponseResource => {
  for (const event of events) {
    if (event.type === 'response.completed' || event.type === 'response.incomplete') return event.response;
    if (event.type === 'response.failed') throw new ContextImproveError(`the model call failed: ${event.response.error.code}: ${event.response.error.message}`);
    if (event.type === 'error') throw new ContextImproveError(`the model call failed: ${event.error.code}: ${event.error.message}`);
  }
  throw new ContextImproveError('the model stream ended without a terminal event');
};

const tokensOf = (transcripts: readonly Transcript[]): number =>
  transcripts.reduce((sum, transcript) => sum + transcript.run.usage.totalTokens + (transcript.noiseTokens ?? 0), 0);

type Completer = (request: GuidelineCompletionRequest) => Promise<GuidelineCompletion>;

export const completerFor = async (ports: CliPorts, paths: MomongaPaths, model: string, capabilities: ChainCapabilities, signal: AbortSignal): Promise<{ complete: Completer; close(): Promise<void> }> => {
  const { RUNTIME_DEFAULTS, billedDetailOf, carriesOutput, createGatewayClient, isGenerationRetiredRefusal } = await import('@momonga/runtime');
  const gateway = createGatewayClient({ resolveSocket: currentSocketResolver(paths, 'gateway'), clock: ports.clock, version: ports.version });
  const complete: Completer = async (request) => {
    const body: CreateResponseBody = {
      model,
      instructions: request.instructions,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: request.input }] }],
      text: { format: request.format },
      tool_choice: 'none',
      reasoning: { effort: LOWEST_REASONING_EFFORT },
      max_output_tokens: summaryTokenCapFor(capabilities),
      store: false,
      stream: true,
      metadata: { purpose: 'guideline', ...(request.seed === undefined ? {} : { seed: String(request.seed) }) },
    };
    const startedAt = ports.clock.now();
    const call = { idempotencyKey: ports.uuid(), deadlineAt: startedAt + RUNTIME_DEFAULTS.runTimeoutMs, signal, role: 'analysis' } as const;
    let firstEventMs: number | undefined;
    const collect = async (): Promise<StreamEvent[]> => {
      const collected: StreamEvent[] = [];
      for await (const event of gateway.stream(body, call)) {
        if (firstEventMs === undefined && carriesOutput(event)) firstEventMs = ports.clock.now() - startedAt;
        collected.push(event);
      }
      return collected;
    };
    const events = await collect().catch((error: unknown) => {
      if (!isGenerationRetiredRefusal(error)) throw error;
      return collect();
    });
    const timing = { ...(firstEventMs === undefined ? {} : { firstEventMs }), durationMs: ports.clock.now() - startedAt };
    const response = terminalResponseOf(events);
    if (response.usage === null) throw new ContextImproveError('the model response carries no usage, so its tokens cannot be charged');
    return {
      ...jsonReplyOf(response),
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: response.usage.total_tokens },
      detail: billedDetailOf(response.usage, response.momonga, timing, response.id),
    };
  };
  return { complete, close: () => gateway.destroy() };
};

export type AnalysisModelInput = {
  roles: ModelRoles;
  model: string;
  capabilitiesOf: (model: string) => Promise<ChainCapabilities>;
};

export const analysisModelFor = async (input: AnalysisModelInput): Promise<{ model: string; capabilities: ChainCapabilities }> => {
  const model = input.roles.analysis ?? input.model;
  return { model, capabilities: await input.capabilitiesOf(model) };
};

export type ImproveInputSource = {
  seed: number;
  analysis: { model: string; capabilities: ChainCapabilities };
  tokenCap: number;
  current: ImproveInput['current'];
};

export const improveInputFor = ({ seed, analysis, tokenCap, current }: ImproveInputSource): ImproveInput => ({
  seed,
  bootstrapSeed: CONTEXT_BOOTSTRAP_SEED,
  analysisModel: analysis.model,
  tokenCap,
  current,
  recordChars: recordCharsFor(analysis.capabilities),
});

export const contextImprove = async (
  ports: CliPorts,
  paths: MomongaPaths,
  options: ContextImproveOptions,
  hostEffects: (ports: CliPorts, lock: KernelLockMechanism) => ContextHostEffects = nodeContextEffects,
): Promise<number> => {
  const outcomeFile = path.resolve(ports.cwd, options.outcome);
  await refuseExistingOutput(ports.files, outcomeFile);
  const dataset = await loadContextDataset(ports.files, path.resolve(ports.cwd, options.dataset));
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(ports, paths);
  const gatewayInfo = createCliGatewayClient({ resolveSocket: currentSocketResolver(paths, 'gateway') });
  try {
    const { REFLECTION_ATTEMPTS_BOUND_MS, REFLECTION_PICKUP_BOUND_MS, REFLECTION_POLL_MS, RUNTIME_DEFAULTS } = await import('@momonga/runtime');
    const limits = { maxTotalTokens: RUNTIME_DEFAULTS.limits.maxTotalTokens, defaultTimeoutMs: RUNTIME_DEFAULTS.runTimeoutMs };
    const reflection = { pendingBoundMs: REFLECTION_PICKUP_BOUND_MS, attemptBoundMs: REFLECTION_ATTEMPTS_BOUND_MS, pollMs: REFLECTION_POLL_MS };
    const codeDigest = await codeDigestOfRunningProcess();
    const models = await shellModelsOf(ports, options.interrupt);
    const pinned = pinnedModelOf(models, options.model);
    const analysis = await analysisModelFor({ roles: models.resolved.roles, model: pinned, capabilitiesOf: async (model) => {
        const capabilities = await gatewayInfo.capabilitiesOf(model);
        if (isNotListedCapabilities(capabilities)) throw new Error(notListedMessage(capabilities));
        return capabilities;
      },
    });
    const adopted = (await client.guidelines()).current;
    const current = adopted === null ? undefined : { version: adopted.version, text: adopted.text };
    const completer = await completerFor(ports, paths, analysis.model, analysis.capabilities, options.interrupt);
    try {
      const outcome = await improveGuideline(
        improveInputFor({ seed: options.seed, analysis, tokenCap: options.tokenCap, current }),
        {
          benchmark: async (guideline): Promise<BenchmarkResult> => {
            const transcripts = await runContextLive(hostEffects(ports, resolveLayoutLocks(paths).mechanism), {
              dataset,
              seed: options.seed,
              model: pinned,
              models,
              limits,
              reflection,
              codeDigest,
              planRelaySocket: currentSocketResolver(paths, 'gateway'),
              ...(guideline === undefined ? {} : { guideline }),
              onUnreadableHomes: (count) => ports.stderr.write(unreadableHomesNotice(count)),
              onUnownedHomes: (roots) => ports.stderr.write(unownedHomesNotice(roots)),
              interrupt: options.interrupt,
            });
            const report = buildContextReport({ dataset, transcripts, seed: CONTEXT_BOOTSTRAP_SEED, datasetSeed: options.seed });
            return { report, transcripts, tokens: tokensOf(transcripts) };
          },
          complete: completer.complete,
          charge: async (usage, detail) => {
            await client.recordContextCharge({ purpose: 'guideline', project: ports.cwd, model: analysis.model, ...usage, ...(detail === undefined ? {} : { detail }) });
          },
        },
      );
      ports.stdout.write(`${formatImproveOutcome(outcome)}\n`);
      await ports.files.writeText(outcomeFile, encodeOutcomeFile(outcomeFileOf(outcome, { name: dataset.name, digest: datasetDigestOf(dataset, options.seed) })));
      ports.stdout.write(`the outcome was written to ${outcomeFile}\n`);
      ports.stdout.write(
        outcome.winner === undefined
          ? 'nothing was adopted\n'
          : `nothing was adopted: read the text of the winner above, then store exactly that text with: momonga context guideline adopt ${outcomeFile}\n`,
      );
      return exitOfImproveOutcome(outcome);
    } finally {
      await completer.close();
    }
  } finally {
    await client.close();
    await gatewayInfo.close();
  }
};

export const exitOfImproveOutcome = (outcome: Pick<ImproveOutcome, 'status'>): number => (outcome.status === 'winner' ? 0 : 1);

const formatGuideline = (row: GuidelineView, current: boolean): string =>
  [`version ${row.version}${current ? ' (current)' : ''}, parent ${row.parent ?? 'none'}, adopted ${new Date(row.adoptedAt).toISOString()}`, formatGuidelineText(row.text)].join('\n');

export const formatGuidelines = ({ current, guidelines }: GuidelinesResponse): string =>
  guidelines.length === 0 ? 'no guideline has been adopted' : guidelines.map((row) => formatGuideline(row, row.version === current?.version)).join('\n');

export const guidelineList = async (ports: CliPorts, paths: MomongaPaths): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
  const client: RuntimeClient = connectRuntime(ports, paths);
  try {
    ports.stdout.write(`${formatGuidelines(await client.guidelines())}\n`);
    return 0;
  } finally {
    await client.close();
  }
};

const describeParent = (version: number | null): string => (version === null ? 'no guideline' : `version ${version}`);

export const adoptOutcome = async (stdout: Sink, client: Pick<RuntimeClient, 'guidelines' | 'adoptGuideline'>, outcomeText: string): Promise<number> => {
  const adoption = adoptionOf(parseOutcomeFile(outcomeText));
  const { current } = await client.guidelines();
  const head = current?.version ?? null;
  if (head !== adoption.parent) {
    throw new ContextImproveError(`the outcome was made against ${describeParent(adoption.parent)}, but ${head === null ? 'no guideline is adopted' : `version ${head} is current`}; run context improve again`);
  }
  if ((current?.text ?? null) !== adoption.parentText) {
    throw new ContextImproveError(`the text of version ${head} is not the text the outcome was made against; run context improve again`);
  }
  stdout.write(`adopting this guideline on ${describeParent(head)}:\n${formatGuidelineText(adoption.text)}\nchange:\n${guidelineDiff(current?.text ?? '', adoption.text)}\n`);
  const row = await client.adoptGuideline({ text: adoption.text, parent: adoption.parent, report: adoption.report });
  stdout.write(`adopted version ${row.version}\n`);
  return 0;
};

export const guidelineAdopt = async (ports: CliPorts, paths: MomongaPaths, outcomeFile: string): Promise<number> => {
  const outcomeText = await ports.files.readText(path.resolve(ports.cwd, outcomeFile));
  await ensureCurrentDaemon(ports, paths);
  const client: RuntimeClient = connectRuntime(ports, paths);
  try {
    return await adoptOutcome(ports.stdout, client, outcomeText);
  } finally {
    await client.close();
  }
};

export const guidelineRollback = async (ports: CliPorts, paths: MomongaPaths, version: number): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(ports, paths);
  try {
    const row = await client.rollbackGuideline(version);
    ports.stdout.write(`rolled back to the text of version ${version} as version ${row.version}\n`);
    return 0;
  } finally {
    await client.close();
  }
};
