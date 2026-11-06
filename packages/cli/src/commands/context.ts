import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadUserModels } from '@momonga/config';
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
} from '@momonga/eval';
import type { BenchmarkResult, GuidelineCompletion, GuidelineCompletionRequest, ImproveInput, Transcript } from '@momonga/eval';
import { codeDigestOfRunningProcess } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { ESTIMATED_CHARACTERS_PER_TOKEN, LOWEST_REASONING_EFFORT, assistantTextOf, requireStructuredOutput, summaryTokenCapFor } from '@momonga/protocol';
import type { AliasCapabilities, CreateResponseBody, GuidelineView, GuidelinesResponse, StreamEvent } from '@momonga/protocol';
import type { RuntimeClient } from '../client/runtime-client.ts';
import { createGatewayClient as createCliGatewayClient } from '../client/gateway-client.ts';
import { CONTEXT_BOOTSTRAP_SEED } from '../constants.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import { nodeContextEffects } from '../eval/context-effects.ts';
import { runContextLive, unownedHomesNotice, unreadableHomesNotice } from '../eval/context-host.ts';
import type { ContextHostEffects } from '../eval/context-host.ts';
import type { CliPorts, Sink } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';

export class ContextImproveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContextImproveError';
  }
}

export type ContextImproveOptions = {
  dataset: string;
  alias: string;
  tokenCap: number;
  seed: number;
  outcome: string;
  interrupt?: AbortSignal;
};

const RECORD_WINDOW_SHARE = 4;

const recordCharsFor = (capabilities: AliasCapabilities): number =>
  ESTIMATED_CHARACTERS_PER_TOKEN * Math.max(0, Math.floor((capabilities.contextWindow - capabilities.maxOutputTokens) / RECORD_WINDOW_SHARE));

const terminalResponseOf = (events: readonly StreamEvent[]): Extract<StreamEvent, { type: 'response.completed' }>['response'] => {
  for (const event of events) {
    if (event.type === 'response.completed') return event.response;
    if (event.type === 'response.incomplete') throw new ContextImproveError(`the model reply was cut short: ${event.response.incomplete_details?.reason ?? 'no reason given'}`);
    if (event.type === 'response.failed') throw new ContextImproveError(`the model call failed: ${event.response.error.code}: ${event.response.error.message}`);
    if (event.type === 'error') throw new ContextImproveError(`the model call failed: ${event.error.code}: ${event.error.message}`);
  }
  throw new ContextImproveError('the model stream ended without a terminal event');
};

const tokensOf = (transcripts: readonly Transcript[]): number =>
  transcripts.reduce((sum, transcript) => sum + transcript.run.usage.totalTokens + (transcript.noiseTokens ?? 0), 0);

type Completer = (request: GuidelineCompletionRequest) => Promise<GuidelineCompletion>;

const completerFor = async (ports: CliPorts, paths: MomongaPaths, alias: string, capabilities: AliasCapabilities, interrupt: AbortSignal | undefined): Promise<{ complete: Completer; close(): Promise<void> }> => {
  const { RUNTIME_DEFAULTS, billedDetailOf, carriesOutput, createGatewayClient } = await import('@momonga/runtime');
  const gateway = createGatewayClient({ socketPath: paths.sockets.gateway, clock: ports.clock, version: ports.version });
  const signal = interrupt ?? new AbortController().signal;
  const complete: Completer = async (request) => {
    const body: CreateResponseBody = {
      model: alias,
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
    const events: StreamEvent[] = [];
    const startedAt = ports.clock.now();
    let firstEventMs: number | undefined;
    for await (const event of gateway.stream(body, { idempotencyKey: randomUUID(), deadlineAt: startedAt + RUNTIME_DEFAULTS.runTimeoutMs, signal, role: 'analysis' })) {
      if (firstEventMs === undefined && carriesOutput(event)) firstEventMs = ports.clock.now() - startedAt;
      events.push(event);
    }
    const timing = { ...(firstEventMs === undefined ? {} : { firstEventMs }), durationMs: ports.clock.now() - startedAt };
    const response = terminalResponseOf(events);
    if (response.usage === null) throw new ContextImproveError('the model response carries no usage, so its tokens cannot be charged');
    return {
      text: assistantTextOf(response.output),
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: response.usage.total_tokens },
      detail: billedDetailOf(response.usage, response.momonga, timing, response.id),
    };
  };
  return { complete, close: () => gateway.destroy() };
};

export type AnalysisModelInput = {
  roles: ModelRoles;
  alias: string;
  capabilitiesOf: (alias: string) => Promise<AliasCapabilities>;
};

export const analysisModelFor = async (input: AnalysisModelInput): Promise<{ alias: string; capabilities: AliasCapabilities }> => {
  const roleAlias = input.roles.analysis;
  const alias = roleAlias ?? input.alias;
  const capabilities = await input.capabilitiesOf(alias);
  const structured = requireStructuredOutput(capabilities, roleAlias === undefined ? 'the --alias option' : 'models.roles.analysis', alias);
  if (!structured.ok) throw new ContextImproveError(structured.reason);
  return { alias, capabilities };
};

export type ImproveInputSource = {
  seed: number;
  analysis: { alias: string; capabilities: AliasCapabilities };
  tokenCap: number;
  current: ImproveInput['current'];
};

export const improveInputFor = ({ seed, analysis, tokenCap, current }: ImproveInputSource): ImproveInput => ({
  seed,
  bootstrapSeed: CONTEXT_BOOTSTRAP_SEED,
  alias: analysis.alias,
  tokenCap,
  current,
  recordChars: recordCharsFor(analysis.capabilities),
});

export const contextImprove = async (
  ports: CliPorts,
  paths: MomongaPaths,
  options: ContextImproveOptions,
  hostEffects: (ports: CliPorts) => ContextHostEffects = nodeContextEffects,
): Promise<number> => {
  const dataset = await loadContextDataset(ports.files, path.resolve(ports.cwd, options.dataset));
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  const gatewayInfo = createCliGatewayClient({ socketPath: paths.sockets.gateway });
  try {
    const { REFLECTION_ATTEMPTS_BOUND_MS, REFLECTION_PICKUP_BOUND_MS, REFLECTION_POLL_MS, RUNTIME_DEFAULTS } = await import('@momonga/runtime');
    const limits = { maxTotalTokens: RUNTIME_DEFAULTS.limits.maxTotalTokens, defaultTimeoutMs: RUNTIME_DEFAULTS.runTimeoutMs };
    const reflection = { pendingBoundMs: REFLECTION_PICKUP_BOUND_MS, attemptBoundMs: REFLECTION_ATTEMPTS_BOUND_MS, pollMs: REFLECTION_POLL_MS };
    const codeDigest = await codeDigestOfRunningProcess();
    const models = loadUserModels({ home: ports.home });
    const analysis = await analysisModelFor({ roles: models.resolved.roles, alias: options.alias, capabilitiesOf: (alias) => gatewayInfo.capabilitiesOf(alias) });
    const adopted = (await client.guidelines()).current;
    const current = adopted === null ? undefined : { version: adopted.version, text: adopted.text };
    const completer = await completerFor(ports, paths, analysis.alias, analysis.capabilities, options.interrupt);
    try {
      const outcome = await improveGuideline(
        improveInputFor({ seed: options.seed, analysis, tokenCap: options.tokenCap, current }),
        {
          benchmark: async (guideline): Promise<BenchmarkResult> => {
            const transcripts = await runContextLive(hostEffects(ports), {
              dataset,
              seed: options.seed,
              alias: options.alias,
              models,
              limits,
              reflection,
              codeDigest,
              ...(guideline === undefined ? {} : { guideline }),
              onUnreadableHomes: (count) => ports.stderr.write(unreadableHomesNotice(count)),
              onUnownedHomes: (roots) => ports.stderr.write(unownedHomesNotice(roots)),
              ...(options.interrupt === undefined ? {} : { interrupt: options.interrupt }),
            });
            const report = buildContextReport({ dataset, transcripts, seed: CONTEXT_BOOTSTRAP_SEED, datasetSeed: options.seed });
            return { report, transcripts, tokens: tokensOf(transcripts) };
          },
          complete: completer.complete,
          charge: async (usage, detail) => {
            await client.recordContextCharge({ purpose: 'guideline', project: ports.cwd, model: analysis.alias, ...usage, ...(detail === undefined ? {} : { detail }) });
          },
        },
      );
      const outcomeFile = path.resolve(ports.cwd, options.outcome);
      await ports.files.writeText(outcomeFile, encodeOutcomeFile(outcomeFileOf(outcome, { name: dataset.name, digest: datasetDigestOf(dataset, options.seed) })));
      ports.stdout.write(`${formatImproveOutcome(outcome)}\n`);
      ports.stdout.write(`the outcome was written to ${outcomeFile}\n`);
      ports.stdout.write(
        outcome.winner === undefined
          ? 'nothing was adopted\n'
          : `nothing was adopted: read the text of the winner above, then store exactly that text with: momonga context guideline adopt ${outcomeFile}\n`,
      );
      return outcome.status === 'winner' || outcome.status === 'empty' ? 0 : 1;
    } finally {
      await completer.close();
    }
  } finally {
    await client.close();
    await gatewayInfo.close();
  }
};

const formatGuideline = (row: GuidelineView, current: boolean): string =>
  [`version ${row.version}${current ? ' (current)' : ''}, parent ${row.parent ?? 'none'}, adopted ${new Date(row.adoptedAt).toISOString()}`, formatGuidelineText(row.text)].join('\n');

export const formatGuidelines = ({ current, guidelines }: GuidelinesResponse): string =>
  guidelines.length === 0 ? 'no guideline has been adopted' : guidelines.map((row) => formatGuideline(row, row.version === current?.version)).join('\n');

export const guidelineList = async (ports: CliPorts, paths: MomongaPaths): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client: RuntimeClient = connectRuntime(paths);
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
  await ensureDaemon(ports, paths);
  const client: RuntimeClient = connectRuntime(paths);
  try {
    return await adoptOutcome(ports.stdout, client, outcomeText);
  } finally {
    await client.close();
  }
};

export const guidelineRollback = async (ports: CliPorts, paths: MomongaPaths, version: number): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    const row = await client.rollbackGuideline(version);
    ports.stdout.write(`rolled back to the text of version ${version} as version ${row.version}\n`);
    return 0;
  } finally {
    await client.close();
  }
};
