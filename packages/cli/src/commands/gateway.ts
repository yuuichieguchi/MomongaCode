import { isProbeable, isProbedBy, loadUserSettings, recordKeyOf, registeredServer, upstreamEndpointOf } from '@momonga/config';
import type { EndpointProbeKey, Probeable, ResolvedModel, ResolvedModels, ResolvedSettings } from '@momonga/config';
import { createBinaryHashCache, managedInstancePaths, resolveLayoutLocks, layoutProcessInspector } from '@momonga/foundation';
import type { ManagedInstancePaths, MomongaPaths, OutboundNetwork } from '@momonga/foundation';
import { displayMapOf, modelRefErrorOf, resolveTypedModelRef, typedModelText } from '@momonga/protocol';
import type { DialectDefinition, ProbeReportDialect } from '@momonga/protocol';
import { withinCommandLimit } from '../command-limit.ts';
import { restartGeneration } from '../daemon/ensure-daemon.ts';
import type { DaemonPorts } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { withOutboundNetwork } from '../network.ts';
import { announcePlainHttp } from '../plain-http.ts';
import { escapedLines } from '../terminal-writer.ts';

type OllamaModel = Extract<ResolvedModel, { adapter: 'ollama' }>;

type ManagedModel = Extract<ResolvedModel, { adapter: 'managed' }>;

type ChatCompletionsModel = Extract<ResolvedModel, { adapter: 'chat-completions' }>;

type ProbeableModel = Probeable<ResolvedModel>;

export class NotAProbeableModel extends Error {
  constructor(display: string, configured: readonly string[]) {
    super(`The model "${display}" cannot be probed: it is not served by a managed server, an OpenAI-compatible server or an Ollama server. Configured models: ${configured.join(', ')}.`);
    this.name = 'NotAProbeableModel';
  }
}

export type ProbeOptions = { samples?: number; stepTimeoutMs: number; consented: boolean; interrupt: AbortSignal };

export type ProbeSubject = { canon: string; display: string; model: ProbeableModel };

export const probeSubjectOf = (models: ResolvedModels, text: string): ProbeSubject => {
  const resolution = resolveTypedModelRef(typedModelText(text), models.views);
  if (resolution.kind !== 'found') throw modelRefErrorOf(text, resolution, models.views, 'cli');
  const { canon } = resolution.model;
  const displays = displayMapOf(models.views);
  const display = displays.get(canon) ?? canon;
  const model = models.models.get(canon);
  if (model === undefined || !isProbeable(model)) throw new NotAProbeableModel(display, models.views.map((view) => displays.get(view.canon) ?? view.canon));
  return { canon, display, model };
};

export const managedProbeTimersOf = (ports: CliPorts): { setTimeout: CliPorts['timers']['setTimeout']; clearTimeout: CliPorts['timers']['clearTimeout']; now(): number } => ({
  setTimeout: (callback, ms) => ports.timers.setTimeout(callback, ms),
  clearTimeout: (handle) => ports.timers.clearTimeout(handle),
  now: () => ports.clock.now(),
});

const probePortsOf = (ports: CliPorts): { clock: CliPorts['clock']; timers: CliPorts['timers'] } => ({ clock: ports.clock, timers: ports.timers });

export const cliProbeInstance = (paths: MomongaPaths, provider: string): ManagedInstancePaths => managedInstancePaths(paths, { owner: 'cli', purpose: 'probe', provider });

export const RESTART_STARTED_TEXT = (version: string): string => `started a new daemon (v${version}) so that the gateway reads the record; work in the old one keeps running.`;

export const RESTART_NOTHING_SERVING_TEXT = 'no daemon is running; the record is read when it starts.';

export const restartDaemon = async (ports: Pick<CliPorts, 'stdout'> & DaemonPorts, paths: MomongaPaths, options: Parameters<typeof restartGeneration>[2] = {}): Promise<void> => {
  const outcome = await restartGeneration(ports, paths, options);
  ports.stdout.write(`${outcome.kind === 'started' ? RESTART_STARTED_TEXT(outcome.version) : RESTART_NOTHING_SERVING_TEXT}\n`);
};

export const probeModel = async (ports: CliPorts, paths: MomongaPaths, text: string, options: ProbeOptions): Promise<number> => {
  const { settings } = await loadUserSettings({ home: ports.home, signal: options.interrupt });
  announcePlainHttp(ports, settings.models.plainHttp);
  const subject = probeSubjectOf(settings.models, text);
  const { model } = subject;
  if (isProbedBy(model, 'managed-process')) return probeManaged(ports, paths, subject, model, settings, options);
  if (isProbedBy(model, 'chat-completions-wire')) return withOutboundNetwork(ports, options.interrupt, (network) => probeChatCompletions(ports, paths, subject, model, options, settings.models.dialects, network));
  return withOutboundNetwork(ports, options.interrupt, (network) => probeOllama(ports, paths, subject, model, options, settings.models.dialects, network));
};

const apiKeyOf = async (ports: CliPorts, target: ChatCompletionsModel, interrupt: AbortSignal): Promise<string | undefined> => {
  const { apiKeySecret } = target;
  if (apiKeySecret !== undefined) return withinCommandLimit(interrupt, (signal) => ports.secretStore().read(apiKeySecret, signal));
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

export const probeEndpointText = (
  name: string,
  endpoint: string,
  recordPath: string,
  report: EndpointProbe['report'],
  toolCalling: EndpointProbe['toolCalling'],
  parallelToolCalls: boolean | undefined,
  declaredOutputBound?: string,
): string => {
  const reasoning = report.reasoning;
  const parallel = report.parallelToolCalls;
  return `${escapedLines([
    `probed ${name}: model ${report.modelId} at ${endpoint}, context window ${report.contextWindow.value} (${report.contextWindow.method})`,
    `  tool calling: ${toolCalling} (native ${report.nativeTools.validRate}, constrained ${report.constrained.validRate})`,
    `  structured output: ${report.constrained.accepted ? 'json_schema' : 'none'}, stop sequences: ${report.stopSequences}, usage reported: ${report.usageReported}, ${outputBoundText(report, declaredOutputBound)}`,
    `  parallel tool calls: ${parallel === undefined || parallelToolCalls === undefined ? 'not measured' : `${parallelToolCalls} (${parallel.multiCallRate} of replies carried several calls)`}`,
    `  reasoning: ${reasoning === undefined ? 'not measured' : reasoning.control === 'reasoning_effort' ? `reasoning_effort, lowest ${reasoning.lowest}` : `cannot be controlled${reasoning.headroomTokens === undefined ? '' : `, leaves room for ${reasoning.headroomTokens} tokens`}`}`,
    `  max concurrency: ${concurrencyText(report.maxConcurrency)}`,
    `  schema dialect: ${dialectText(report.schemaDialect)}`,
    `  recorded in ${recordPath}`,
  ])}\n`;
};

const concurrencyText = (measured: EndpointProbe['report']['maxConcurrency']): string =>
  measured === undefined
    ? 'not measured (the server refused no request; maxConcurrency in the settings declares it, one request at a time otherwise)'
    : `${measured.value} (the server refused more at once)`;

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
    `  stop sequences: ${report.stopSequences}, usage reported: ${report.usageReported}, ${outputBoundText(report, declaredOutputBound)}, max concurrency: ${concurrencyText(report.maxConcurrency)}`,
    `  schema dialect: ${dialectText(report.schemaDialect)}`,
    `  recorded in ${recordPath}`,
  ])}\n`;

const endpointRecordKeyOf = (subject: ProbeSubject, target: OllamaModel | ChatCompletionsModel): EndpointProbeKey => {
  const key = recordKeyOf(subject.canon, target);
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
  const { DEFAULT_SAMPLES, capabilitiesFromProbe, decideToolCalling, isMeteredTarget, measurementBoundOf, probeEndpointTarget, reachableEndpoint, saveMeasurementConsent } = await import('@momonga/gateway');
  const key = endpointRecordKeyOf(subject, target);
  const metered = isMeteredTarget(target) ? { display: subject.display, declaredContextWindow: target.capabilities.contextWindow } : undefined;
  if (metered !== undefined && options.consented) {
    await saveMeasurementConsent(paths.probe, key, measurementBoundOf(metered.declaredContextWindow, options.samples ?? DEFAULT_SAMPLES), resolveLayoutLocks(paths).mechanism);
  }
  const { report, toolCalling } = await probeEndpointTarget({
    probeRecordDir: paths.probe,
    ...(metered === undefined ? {} : { metered }),
    ports: probePortsOf(ports),
    lock: resolveLayoutLocks(paths).mechanism,
    upstream: reachableEndpoint(upstreamEndpointOf(target), network),
    key,
    model: target.model,
    ...(target.capabilities.schemaDialect === undefined ? {} : { declaredDialect: target.capabilities.schemaDialect }),
    userDialects,
    apiKey: await apiKeyOf(ports, target, options.interrupt),
    signal: options.interrupt,
    stepTimeoutMs: options.stepTimeoutMs,
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
  ports.stdout.write(probeEndpointText(subject.display, key.endpoint, paths.probe, report, toolCalling, capabilitiesFromProbe(report, decideToolCalling(report)).parallelToolCalls, target.capabilities.outputBoundField));
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
    ports: probePortsOf(ports),
    lock: resolveLayoutLocks(paths).mechanism,
    upstream: reachableEndpoint(upstreamEndpointOf(target), network),
    key: endpointRecordKeyOf(subject, target),
    model: target.model,
    contextWindow: target.capabilities.contextWindow,
    ...(target.capabilities.schemaDialect === undefined ? {} : { declaredDialect: target.capabilities.schemaDialect }),
    userDialects,
    signal: options.interrupt,
    stepTimeoutMs: options.stepTimeoutMs,
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
  const locks = resolveLayoutLocks(paths);
  const { report, toolCalling, recordFile } = await probeManagedFm({
    paths,
    lock: locks.mechanism,
    inspector: layoutProcessInspector(locks.capability),
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
    timers: managedProbeTimersOf(ports),
    stepTimeoutMs: options.stepTimeoutMs,
    model: configured.model,
    onWarning: (message) => ports.stderr.write(`${escapedLines([`momonga: ${message}`])}\n`),
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
  ports.stdout.write(probeFmText(subject.display, recordFile, report, toolCalling, configured.outputBoundField));
  return 0;
};
