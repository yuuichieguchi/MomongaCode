import { loadUserSettings, probeRecordKeyOf, registeredServer, upstreamEndpointOf } from '@momonga/config';
import type { EndpointProbeKey, ResolvedModel, ResolvedModels, ResolvedSettings } from '@momonga/config';
import { createBinaryHashCache, managedInstancePaths } from '@momonga/foundation';
import type { ManagedInstancePaths, MomongaPaths, OutboundNetwork } from '@momonga/foundation';
import { displayMapOf, modelRefErrorOf, resolveTypedModelRef, typedModelText } from '@momonga/protocol';
import type { DialectDefinition, ProbeReportDialect } from '@momonga/protocol';
import { ensureDaemon, stopDaemon } from '../daemon/ensure-daemon.ts';
import { stderrStopNotice } from '../daemon/stop-notice.ts';
import type { CliPorts } from '../ports.ts';
import { withOutboundNetwork } from '../network.ts';
import { escapedLines } from '../terminal-writer.ts';

type OllamaModel = Extract<ResolvedModel, { adapter: 'ollama' }>;

type ManagedModel = Extract<ResolvedModel, { adapter: 'managed' }>;

type ChatCompletionsModel = Extract<ResolvedModel, { adapter: 'chat-completions' }>;

type ProbeableModel = OllamaModel | ManagedModel | ChatCompletionsModel;

export class NotAProbeableModel extends Error {
  constructor(display: string, configured: readonly string[]) {
    super(`The model "${display}" cannot be probed: it is not served by a managed server, an OpenAI-compatible server or an Ollama server. Configured models: ${configured.join(', ')}.`);
    this.name = 'NotAProbeableModel';
  }
}

export type ProbeOptions = { samples?: number; interrupt: AbortSignal };

export type ProbeSubject = { canon: string; display: string; model: ProbeableModel };

const isProbeable = (model: ResolvedModel): model is ProbeableModel => model.adapter === 'managed' || model.adapter === 'chat-completions' || model.adapter === 'ollama';

export const probeSubjectOf = (models: ResolvedModels, text: string): ProbeSubject => {
  const resolution = resolveTypedModelRef(typedModelText(text), models.views);
  if (resolution.kind !== 'found') throw modelRefErrorOf(text, resolution, models.views);
  const { canon } = resolution.model;
  const displays = displayMapOf(models.views);
  const display = displays.get(canon) ?? canon;
  const model = models.models.get(canon);
  if (model === undefined || !isProbeable(model)) throw new NotAProbeableModel(display, models.views.map((view) => displays.get(view.canon) ?? view.canon));
  return { canon, display, model };
};

export const cliProbeInstance = (paths: MomongaPaths, provider: string): ManagedInstancePaths => managedInstancePaths(paths, { owner: 'cli', purpose: 'probe', provider });

const restartDaemon = async (ports: CliPorts, paths: MomongaPaths): Promise<void> => {
  const { stopped } = await stopDaemon(ports, paths, undefined, stderrStopNotice(ports));
  if (stopped) {
    await ensureDaemon(ports, paths, { onNotice: stderrStopNotice(ports) });
    ports.stdout.write('restarted the daemon so that the gateway reads the record\n');
  }
};

export const probeModel = async (ports: CliPorts, paths: MomongaPaths, text: string, options: ProbeOptions): Promise<number> => {
  const { settings } = await loadUserSettings({ home: ports.home });
  const subject = probeSubjectOf(settings.models, text);
  const { model } = subject;
  if (model.adapter === 'managed') return probeManaged(ports, paths, subject, model, settings, options);
  if (model.adapter === 'chat-completions') return withOutboundNetwork(ports, options.interrupt, (network) => probeChatCompletions(ports, paths, subject, model, options, settings.models.dialects, network));
  return withOutboundNetwork(ports, options.interrupt, (network) => probeOllama(ports, paths, subject, model, options, settings.models.dialects, network));
};

const apiKeyOf = async (ports: CliPorts, target: ChatCompletionsModel, interrupt: AbortSignal): Promise<string | undefined> => {
  if (target.apiKeySecret !== undefined) return ports.secretStore().read(target.apiKeySecret, interrupt);
  if (target.apiKeyEnv === undefined) return undefined;
  const value = ports.env[target.apiKeyEnv];
  if (value === undefined || value === '') throw new Error(`the environment variable ${target.apiKeyEnv} is unset or empty, so the model cannot be probed`);
  return value;
};

const outputBoundText = (report: { outputBoundField?: string }, declared: string | undefined): string => {
  const measured = report.outputBoundField === 'none' ? 'neither max_completion_tokens nor max_tokens is honoured' : (report.outputBoundField ?? 'not measured');
  const contradicts = declared !== undefined && report.outputBoundField !== undefined && report.outputBoundField !== declared;
  return `output bound: ${measured}${contradicts ? `; the settings declare ${declared}, which stays in force over this measurement` : ''}`;
};

type EndpointProbe = Awaited<ReturnType<typeof import('@momonga/gateway').probeEndpointTarget>>;

const dialectText = (dialect: ProbeReportDialect): string => {
  if (dialect.selected !== null) return `${dialect.selected} (${dialect.shape} envelope)`;
  const tried = dialect.tried.map((attempt) => `${attempt.id} ${attempt.result}${attempt.detail === undefined ? '' : `: ${attempt.detail}`}`).join('; ');
  return `none accepted${tried === '' ? '' : ` (${tried})`}`;
};

export const probeEndpointText = (name: string, endpoint: string, recordPath: string, report: EndpointProbe['report'], toolCalling: EndpointProbe['toolCalling'], declaredOutputBound?: string): string => {
  const reasoning = report.reasoning;
  const parallel = report.parallelToolCalls;
  return `${escapedLines([
    `probed ${name}: model ${report.modelId} at ${endpoint}, context window ${report.contextWindow.value} (${report.contextWindow.method})`,
    `  tool calling: ${toolCalling} (native ${report.nativeTools.validRate}, constrained ${report.constrained.validRate})`,
    `  structured output: ${report.constrained.accepted ? 'json_schema' : 'none'}, stop sequences: ${report.stopSequences}, usage reported: ${report.usageReported}, ${outputBoundText(report, declaredOutputBound)}`,
    `  parallel tool calls: ${parallel === undefined ? 'not measured' : `${parallel.accepted && parallel.multiCallRate >= 0.9} (${parallel.multiCallRate} of replies carried several calls)`}`,
    `  reasoning: ${reasoning === undefined ? 'not measured' : reasoning.control === 'reasoning_effort' ? `reasoning_effort, lowest ${reasoning.lowest}` : `cannot be controlled${reasoning.headroomTokens === undefined ? '' : `, leaves room for ${reasoning.headroomTokens} tokens`}`}`,
    `  max concurrency: ${report.maxConcurrency}`,
    `  schema dialect: ${dialectText(report.schemaDialect)}`,
    `  recorded in ${recordPath}`,
  ])}\n`;
};

type OllamaProbe = Awaited<ReturnType<typeof import('@momonga/gateway').probeOllamaTarget>>;

const imageInputTextOf = (report: OllamaProbe['report']): string => {
  if (!report.imageInputAccepted) return 'false';
  if (report.imageTokens === undefined) return 'true (vision reported, but the image token cost could not be measured, so image input stays off unless imageTokens is declared)';
  return `true (${report.imageTokens.pixelsPerToken.toFixed(1)} pixels per token, ${report.imageTokens.minTokens} to ${report.imageTokens.maxTokens} tokens)`;
};

export const probeOllamaText = (name: string, endpoint: string, recordPath: string, report: OllamaProbe['report'], contextWindow: number): string =>
  `${escapedLines([
    `probed ${name}: model ${report.modelId} at ${endpoint}, Ollama ${report.serverVersion}`,
    `  trained context length ${report.contextWindow.value} (${report.contextWindow.method}), configured context window ${contextWindow}`,
    `  tool calling: ${report.nativeTools.accepted ? 'native' : 'none'}, image input: ${imageInputTextOf(report)}, thinking: ${report.thinkingSupported}`,
    `  schema dialect: ${dialectText(report.schemaDialect)}`,
    `  recorded in ${recordPath}`,
  ])}\n`;

export const probeFmText = (target: string, recordPath: string, report: EndpointProbe['report'], toolCalling: EndpointProbe['toolCalling'], declaredOutputBound?: string): string =>
  `${escapedLines([
    `probed ${target}: model ${report.modelId}, context window ${report.contextWindow.value} (${report.contextWindow.method})`,
    `  tool calling: ${toolCalling} (native ${report.nativeTools.validRate}, constrained ${report.constrained.validRate})`,
    `  stop sequences: ${report.stopSequences}, usage reported: ${report.usageReported}, ${outputBoundText(report, declaredOutputBound)}, max concurrency: ${report.maxConcurrency}`,
    `  schema dialect: ${dialectText(report.schemaDialect)}`,
    `  recorded in ${recordPath}`,
  ])}\n`;

const endpointRecordKeyOf = (subject: ProbeSubject, target: OllamaModel | ChatCompletionsModel): EndpointProbeKey => {
  const key = probeRecordKeyOf(subject.canon, target.adapter === 'chat-completions' ? { ...target, toolCalling: 'auto' } : target);
  if (key?.kind !== 'endpoint') throw new Error(`the model ${subject.display} has no endpoint probe record key`);
  return key.key;
};

const probeChatCompletions = async (
  ports: CliPorts,
  paths: MomongaPaths,
  subject: ProbeSubject,
  target: ChatCompletionsModel,
  options: ProbeOptions,
  userDialects: Record<string, DialectDefinition>,
  network: OutboundNetwork,
): Promise<number> => {
  const { probeEndpointTarget, reachableEndpoint } = await import('@momonga/gateway');
  const { report, toolCalling, key } = await probeEndpointTarget({
    probeRecordDir: paths.probe,
    upstream: reachableEndpoint(upstreamEndpointOf(target), network),
    key: endpointRecordKeyOf(subject, target),
    model: target.model,
    ...(target.capabilities.schemaDialect === undefined ? {} : { declaredDialect: target.capabilities.schemaDialect }),
    userDialects,
    apiKey: await apiKeyOf(ports, target, options.interrupt),
    signal: options.interrupt,
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
  ports.stdout.write(probeEndpointText(subject.display, key.endpoint, paths.probe, report, toolCalling, target.capabilities.outputBoundField));
  await restartDaemon(ports, paths);
  return 0;
};

const probeOllama = async (
  ports: CliPorts,
  paths: MomongaPaths,
  subject: ProbeSubject,
  target: OllamaModel,
  options: ProbeOptions,
  userDialects: Record<string, DialectDefinition>,
  network: OutboundNetwork,
): Promise<number> => {
  const { probeOllamaTarget, reachableEndpoint } = await import('@momonga/gateway');
  const { report, key } = await probeOllamaTarget({
    probeRecordDir: paths.probe,
    upstream: reachableEndpoint(upstreamEndpointOf(target), network),
    key: endpointRecordKeyOf(subject, target),
    model: target.model,
    contextWindow: target.capabilities.contextWindow,
    ...(target.capabilities.schemaDialect === undefined ? {} : { declaredDialect: target.capabilities.schemaDialect }),
    userDialects,
    signal: options.interrupt,
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
  ports.stdout.write(probeOllamaText(subject.display, key.endpoint, paths.probe, report, target.capabilities.contextWindow));
  await restartDaemon(ports, paths);
  return 0;
};

const probeManaged = async (ports: CliPorts, paths: MomongaPaths, subject: ProbeSubject, configured: ManagedModel, settings: ResolvedSettings, options: ProbeOptions): Promise<number> => {
  const { probeManagedFm, systemProcessFiles } = await import('@momonga/gateway');
  const description = registeredServer(settings.models.servers, configured.server);
  if (description === undefined) throw new Error(`the model ${subject.display} names the managed server ${configured.server}, which is not registered`);
  const { report, toolCalling, recordFile } = await probeManagedFm({
    paths,
    platform: ports.platform,
    instance: cliProbeInstance(paths, configured.provider),
    description,
    target: subject.canon,
    binary: configured.binary,
    readyTimeoutMs: configured.readyTimeoutMs,
    env: ports.env,
    userDialects: settings.models.dialects,
    signal: options.interrupt,
    hashes: createBinaryHashCache(),
    isUsableBinary: systemProcessFiles.isUsableBinary,
    readStopGraceMs: () => settings.gateway.managedServerStopGraceMs,
    model: configured.model,
    onWarning: (message) => ports.stderr.write(`${escapedLines([`momonga: ${message}`])}\n`),
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
  ports.stdout.write(probeFmText(subject.display, recordFile, report, toolCalling, configured.outputBoundField));
  return 0;
};
