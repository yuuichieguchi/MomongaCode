import { loadUserSettings, probeRecordKeyOf, upstreamEndpointOf } from '@momonga/config';
import type { EndpointProbeKey } from '@momonga/config';
import { createBinaryHashCache, managedInstancePaths } from '@momonga/foundation';
import type { MomongaPaths, OutboundNetwork } from '@momonga/foundation';
import { MANAGED_SERVERS, managedServerOf } from '@momonga/protocol';
import type { DialectDefinition, ProbeReportDialect } from '@momonga/protocol';
import { ensureDaemon, stopDaemon } from '../daemon/ensure-daemon.ts';
import { stderrStopNotice } from '../daemon/stop-notice.ts';
import type { CliPorts } from '../ports.ts';
import { processOutboundNetwork } from '../network.ts';
import { escapedLines } from '../terminal-writer.ts';

type OllamaConfig = Extract<Awaited<ReturnType<typeof loadUserSettings>>['settings']['models']['targets'][string], { adapter: 'ollama' }>;

type ManagedConfig = Extract<Awaited<ReturnType<typeof loadUserSettings>>['settings']['models']['targets'][string], { adapter: 'managed' }>;

type ChatCompletionsConfig = Extract<Awaited<ReturnType<typeof loadUserSettings>>['settings']['models']['targets'][string], { adapter: 'chat-completions' }>;

export class NotAProbeableTarget extends Error {
  constructor(target: string, known: Readonly<Record<string, { adapter: string }>>) {
    const described = Object.entries(known).map(([name, entry]) => `${name} (${entry.adapter})`);
    super(`the target "${target}" cannot be probed: it is not a managed server, chat-completions or ollama target; configured targets: ${described.length === 0 ? 'none' : described.join(', ')}`);
    this.name = 'NotAProbeableTarget';
  }
}

export type ProbeOptions = { samples?: number; interrupt: AbortSignal };

const restartDaemon = async (ports: CliPorts, paths: MomongaPaths): Promise<void> => {
  const { stopped } = await stopDaemon(ports, paths, undefined, stderrStopNotice(ports));
  if (stopped) {
    await ensureDaemon(ports, paths, { onNotice: stderrStopNotice(ports) });
    ports.stdout.write('restarted the daemon so that the gateway reads the record\n');
  }
};

export const probeTarget = async (ports: CliPorts, paths: MomongaPaths, target: string, options: ProbeOptions): Promise<number> => {
  const { settings } = await loadUserSettings({ home: ports.home });
  const targets = settings.models.targets;
  const configured = targets[target];
  if (configured?.adapter === 'managed') return probeFm(ports, paths, target, options);
  if (configured?.adapter === 'chat-completions') return probeChatCompletions(ports, paths, target, configured, options, settings.models.dialects, await processOutboundNetwork(ports));
  if (configured?.adapter === 'ollama') return probeOllama(ports, paths, target, configured, options, settings.models.dialects, await processOutboundNetwork(ports));
  throw new NotAProbeableTarget(target, targets);
};

const apiKeyOf = async (ports: CliPorts, target: ChatCompletionsConfig, interrupt: AbortSignal): Promise<string | undefined> => {
  if (target.apiKeySecret !== undefined) return ports.secretStore().read(target.apiKeySecret, interrupt);
  if (target.apiKeyEnv === undefined) return undefined;
  const value = ports.env[target.apiKeyEnv];
  if (value === undefined || value === '') throw new Error(`the environment variable ${target.apiKeyEnv} is unset or empty, so the target cannot be probed`);
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

const endpointRecordKeyOf = (name: string, target: OllamaConfig | ChatCompletionsConfig): EndpointProbeKey => {
  const key = probeRecordKeyOf(name, target.adapter === 'chat-completions' ? { ...target, toolCalling: 'auto' } : target);
  if (key?.kind !== 'endpoint') throw new Error(`the target ${name} has no endpoint probe record key`);
  return key.key;
};

const probeChatCompletions = async (
  ports: CliPorts,
  paths: MomongaPaths,
  name: string,
  target: ChatCompletionsConfig,
  options: ProbeOptions,
  userDialects: Record<string, DialectDefinition>,
  network: OutboundNetwork,
): Promise<number> => {
  const { probeEndpointTarget, reachableEndpoint } = await import('@momonga/gateway');
  const { report, toolCalling, key } = await probeEndpointTarget({
    probeRecordDir: paths.probe,
    upstream: reachableEndpoint(upstreamEndpointOf(target), network),
    key: endpointRecordKeyOf(name, target),
    model: target.model,
    ...(target.capabilities.schemaDialect === undefined ? {} : { declaredDialect: target.capabilities.schemaDialect }),
    userDialects,
    apiKey: await apiKeyOf(ports, target, options.interrupt),
    signal: options.interrupt,
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
  ports.stdout.write(probeEndpointText(name, key.endpoint, paths.probe, report, toolCalling, target.capabilities.outputBoundField));
  await restartDaemon(ports, paths);
  return 0;
};

const probeOllama = async (
  ports: CliPorts,
  paths: MomongaPaths,
  name: string,
  target: OllamaConfig,
  options: ProbeOptions,
  userDialects: Record<string, DialectDefinition>,
  network: OutboundNetwork,
): Promise<number> => {
  const { probeOllamaTarget, reachableEndpoint } = await import('@momonga/gateway');
  const { report, key } = await probeOllamaTarget({
    probeRecordDir: paths.probe,
    upstream: reachableEndpoint(upstreamEndpointOf(target), network),
    key: endpointRecordKeyOf(name, target),
    model: target.model,
    contextWindow: target.capabilities.contextWindow,
    ...(target.capabilities.schemaDialect === undefined ? {} : { declaredDialect: target.capabilities.schemaDialect }),
    userDialects,
    signal: options.interrupt,
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
  ports.stdout.write(probeOllamaText(name, key.endpoint, paths.probe, report, target.capabilities.contextWindow));
  await restartDaemon(ports, paths);
  return 0;
};

export const probeFm = async (ports: CliPorts, paths: MomongaPaths, target: string, options: ProbeOptions): Promise<number> => {
  const { settings } = await loadUserSettings({ home: ports.home });
  const targets = settings.models.targets;
  const configured: ManagedConfig | undefined = targets[target]?.adapter === 'managed' ? (targets[target] as ManagedConfig) : undefined;
  if (configured === undefined) throw new NotAProbeableTarget(target, targets);
  const { probeManagedFm, systemProcessFiles } = await import('@momonga/gateway');
  const description = managedServerOf(MANAGED_SERVERS, configured.server);
  if (description === undefined) throw new NotAProbeableTarget(target, targets);
  const { report, toolCalling, recordFile } = await probeManagedFm({
    paths,
    instance: managedInstancePaths(paths, { owner: 'cli', purpose: 'probe', target }),
    description,
    target,
    binary: configured.binary,
    readyTimeoutMs: configured.readyTimeoutMs,
    env: ports.env,
    userDialects: settings.models.dialects,
    signal: options.interrupt,
    hashes: createBinaryHashCache(),
    isUsableBinary: systemProcessFiles.isUsableBinary,
    readStopGraceMs: () => settings.gateway.managedServerStopGraceMs,
    ...(configured.model === undefined ? {} : { model: configured.model }),
    onWarning: (message) => ports.stderr.write(`${escapedLines([`momonga: ${message}`])}\n`),
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
  ports.stdout.write(probeFmText(target, recordFile, report, toolCalling, configured.outputBoundField));
  return 0;
};
