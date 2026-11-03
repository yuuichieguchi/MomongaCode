import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadUserModels } from '@momonga/config';
import {
  GUIDELINE_CANDIDATES,
  buildContextReport,
  formatImproveOutcome,
  improveGuideline,
  liveBoundsFor,
  loadContextDataset,
} from '@momonga/eval';
import type { BenchmarkResult, ContextModel, GuidelineCompletion, GuidelineCompletionRequest, ImproveOutcome, Transcript } from '@momonga/eval';
import type { MomongaPaths } from '@momonga/foundation';
import { ESTIMATED_CHARACTERS_PER_TOKEN, LOWEST_REASONING_EFFORT, assistantTextOf, summaryTokenCapFor } from '@momonga/protocol';
import type { Capabilities, CreateResponseBody, GuidelineView, StreamEvent } from '@momonga/protocol';
import type { RuntimeClient } from '../client/runtime-client.ts';
import { createGatewayClient as createCliGatewayClient } from '../client/gateway-client.ts';
import { CONTEXT_BOOTSTRAP_SEED } from '../constants.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import { nodeContextEffects } from '../eval/context-effects.ts';
import { runContextLive } from '../eval/context-host.ts';
import type { ContextHostEffects } from '../eval/context-host.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';

export class ContextImproveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContextImproveError';
  }
}

export type ContextImproveOptions = {
  dataset: string;
  model: ContextModel;
  alias: string;
  seed: number;
  adopt: boolean;
  interrupt?: AbortSignal;
};

const RECORD_WINDOW_SHARE = 4;

const recordCharsFor = (capabilities: Capabilities): number =>
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

const completerFor = async (ports: CliPorts, paths: MomongaPaths, alias: string, capabilities: Capabilities, interrupt: AbortSignal | undefined): Promise<{ complete: Completer; close(): Promise<void> }> => {
  const { RUNTIME_DEFAULTS, createGatewayClient } = await import('@momonga/runtime');
  const gateway = createGatewayClient({ socketPath: paths.sockets.gateway, clock: ports.clock, version: ports.version });
  const signal = interrupt ?? new AbortController().signal;
  const complete: Completer = async (request) => {
    const body: CreateResponseBody = {
      model: alias,
      instructions: request.instructions,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: request.input }] }],
      ...(request.format === undefined ? {} : { text: { format: request.format } }),
      tool_choice: 'none',
      reasoning: { effort: LOWEST_REASONING_EFFORT },
      max_output_tokens: summaryTokenCapFor(capabilities),
      store: false,
      stream: true,
      metadata: { purpose: 'guideline', ...(request.seed === undefined ? {} : { seed: String(request.seed) }) },
    };
    const events: StreamEvent[] = [];
    for await (const event of gateway.stream(body, { idempotencyKey: randomUUID(), deadlineAt: ports.clock.now() + RUNTIME_DEFAULTS.runTimeoutMs, signal })) events.push(event);
    const response = terminalResponseOf(events);
    if (response.usage === null) throw new ContextImproveError('the model response carries no usage, so its tokens cannot be charged');
    return {
      text: assistantTextOf(response.output),
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: response.usage.total_tokens },
    };
  };
  return { complete, close: () => gateway.destroy() };
};

const adoptionReport = (outcome: ImproveOutcome, dataset: string): Record<string, unknown> => {
  const { winner } = outcome;
  if (winner === undefined) throw new ContextImproveError('there is no winner to describe');
  return {
    source: 'context improve',
    dataset,
    model: outcome.model,
    alias: outcome.alias,
    seed: outcome.seed,
    candidateIndex: winner.index,
    contrastive: outcome.contrastive,
    baseline: outcome.baseline,
    contrastiveFailures: winner.contrastiveFailures,
    gate: winner.comparison.gate,
    tokens: outcome.tokens,
  };
};

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
    const { RUNTIME_DEFAULTS } = await import('@momonga/runtime');
    const limits = { maxTotalTokens: RUNTIME_DEFAULTS.limits.maxTotalTokens, defaultTimeoutMs: RUNTIME_DEFAULTS.runTimeoutMs };
    const capabilities = await gatewayInfo.capabilitiesOf(options.alias);
    const adopted = (await client.guidelines()).current;
    const current = adopted === null ? undefined : { version: adopted.version, text: adopted.text };
    const models = loadUserModels({ home: ports.home });
    const completer = await completerFor(ports, paths, options.alias, capabilities, options.interrupt);
    try {
      const outcome = await improveGuideline(
        {
          seed: options.seed,
          bootstrapSeed: CONTEXT_BOOTSTRAP_SEED,
          model: options.model,
          alias: options.alias,
          capTokens: liveBoundsFor(dataset, limits).datasetTokens * (1 + GUIDELINE_CANDIDATES),
          current,
          structuredOutput: capabilities.structuredOutput,
          recordChars: recordCharsFor(capabilities),
        },
        {
          benchmark: async (guideline): Promise<BenchmarkResult> => {
            const transcripts = await runContextLive(hostEffects(ports), {
              dataset,
              seed: options.seed,
              alias: options.alias,
              models,
              limits,
              ...(guideline === undefined ? {} : { guideline }),
              ...(options.interrupt === undefined ? {} : { interrupt: options.interrupt }),
            });
            const report = buildContextReport({ dataset, transcripts, model: options.model, seed: CONTEXT_BOOTSTRAP_SEED, datasetSeed: options.seed });
            return { report, transcripts, tokens: tokensOf(transcripts) };
          },
          complete: completer.complete,
          charge: async (usage) => {
            await client.recordContextCharge({ purpose: 'guideline', project: ports.cwd, model: options.alias, ...usage });
          },
        },
      );
      ports.stdout.write(`${formatImproveOutcome(outcome)}\n`);
      const { winner } = outcome;
      if (winner !== undefined && options.adopt) {
        const row = await client.adoptGuideline({ text: winner.text, parent: winner.parent, report: adoptionReport(outcome, dataset.name) });
        ports.stdout.write(`adopted version ${row.version}\n`);
      } else if (winner !== undefined) {
        ports.stdout.write('nothing was adopted: this was a preview; run again with --adopt to store the winner\n');
      } else {
        ports.stdout.write('nothing was adopted\n');
      }
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
  [`version ${row.version}${current ? ' (current)' : ''}, parent ${row.parent ?? 'none'}, adopted ${new Date(row.adoptedAt).toISOString()}`, ...row.text.split('\n').map((line) => `  ${line}`)].join('\n');

export const guidelineList = async (ports: CliPorts, paths: MomongaPaths): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client: RuntimeClient = connectRuntime(paths);
  try {
    const { current, guidelines } = await client.guidelines();
    ports.stdout.write(`${guidelines.length === 0 ? 'no guideline has been adopted' : guidelines.map((row) => formatGuideline(row, row.version === current?.version)).join('\n')}\n`);
    return 0;
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
