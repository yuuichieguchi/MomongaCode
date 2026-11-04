import path from 'node:path';
import { loadUserSettings, probeRecordKeyOf, upstreamEndpointOf } from '@momonga/config';
import type { EndpointProbeKey } from '@momonga/config';
import type { MomongaPaths } from '@momonga/foundation';
import { ensureDaemon, stopDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { escapedLines } from '../terminal-writer.ts';

export const DEFAULT_FM_BINARY = '/usr/bin/fm';

export const FM_PROBE_SOCKET_NAME = 'fm-probe.sock';

type OllamaConfig = Extract<Awaited<ReturnType<typeof loadUserSettings>>['settings']['models']['targets'][string], { adapter: 'ollama' }>;

type ChatCompletionsConfig = Extract<Awaited<ReturnType<typeof loadUserSettings>>['settings']['models']['targets'][string], { adapter: 'chat-completions' }>;

export class NotAProbeableTarget extends Error {
  constructor(target: string, known: Readonly<Record<string, { adapter: string }>>) {
    const described = Object.entries(known).map(([name, entry]) => `${name} (${entry.adapter})`);
    super(`model target ${target} is not an fm or chat-completions target, nor an ollama target; configured targets: ${described.length === 0 ? 'none' : described.join(', ')}`);
    this.name = 'NotAProbeableTarget';
  }
}

export type ProbeOptions = { fmBinary: string; samples?: number; interrupt: AbortSignal };

const restartDaemon = async (ports: CliPorts, paths: MomongaPaths): Promise<void> => {
  const { stopped } = await stopDaemon(ports, paths);
  if (stopped) {
    await ensureDaemon(ports, paths);
    ports.stdout.write('restarted the daemon so that the gateway reads the record\n');
  }
};

export const probeTarget = async (ports: CliPorts, paths: MomongaPaths, target: string, options: ProbeOptions): Promise<number> => {
  const { settings } = await loadUserSettings({ home: ports.home });
  const targets = settings.models.targets;
  const configured = targets[target];
  if (configured?.adapter === 'fm') return probeFm(ports, paths, target, options);
  if (configured?.adapter === 'chat-completions') return probeChatCompletions(ports, paths, target, configured, options);
  if (configured?.adapter === 'ollama') return probeOllama(ports, paths, target, configured, options);
  throw new NotAProbeableTarget(target, targets);
};

const apiKeyOf = async (ports: CliPorts, target: ChatCompletionsConfig, interrupt: AbortSignal): Promise<string | undefined> => {
  if (target.apiKeySecret !== undefined) return ports.secretStore().read(target.apiKeySecret, interrupt);
  if (target.apiKeyEnv === undefined) return undefined;
  const value = ports.env[target.apiKeyEnv];
  if (value === undefined || value === '') throw new Error(`the environment variable ${target.apiKeyEnv} is unset or empty, so the target cannot be probed`);
  return value;
};

type EndpointProbe = Awaited<ReturnType<typeof import('@momonga/gateway').probeEndpointTarget>>;

export const probeEndpointText = (name: string, endpoint: string, recordPath: string, report: EndpointProbe['report'], toolCalling: EndpointProbe['toolCalling']): string => {
  const reasoning = report.reasoning;
  const parallel = report.parallelToolCalls;
  return `${escapedLines([
    `probed ${name}: model ${report.modelId} at ${endpoint}, context window ${report.contextWindow.value} (${report.contextWindow.method})`,
    `  tool calling: ${toolCalling} (native ${report.nativeTools.validRate}, constrained ${report.constrained.validRate})`,
    `  structured output: ${report.constrained.accepted ? 'json_schema' : 'none'}, stop sequences: ${report.stopSequences}, usage reported: ${report.usageReported}`,
    `  parallel tool calls: ${parallel === undefined ? 'not measured' : `${parallel.accepted && parallel.multiCallRate >= 0.9} (${parallel.multiCallRate} of replies carried several calls)`}`,
    `  reasoning: ${reasoning === undefined ? 'not measured' : reasoning.control === 'reasoning_effort' ? `reasoning_effort, lowest ${reasoning.lowest}` : `cannot be controlled${reasoning.headroomTokens === undefined ? '' : `, leaves room for ${reasoning.headroomTokens} tokens`}`}`,
    `  max concurrency: ${report.maxConcurrency}`,
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
    `  recorded in ${recordPath}`,
  ])}\n`;

export const probeFmText = (target: string, recordPath: string, report: EndpointProbe['report'], toolCalling: EndpointProbe['toolCalling']): string =>
  `${escapedLines([
    `probed ${target}: model ${report.modelId}, context window ${report.contextWindow.value} (${report.contextWindow.method})`,
    `  tool calling: ${toolCalling} (native ${report.nativeTools.validRate}, constrained ${report.constrained.validRate})`,
    `  stop sequences: ${report.stopSequences}, usage reported: ${report.usageReported}, max concurrency: ${report.maxConcurrency}`,
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
): Promise<number> => {
  const { probeEndpointTarget } = await import('@momonga/gateway');
  const { report, toolCalling, key } = await probeEndpointTarget({
    probeRecordDir: paths.probe,
    upstream: upstreamEndpointOf(target),
    key: endpointRecordKeyOf(name, target),
    model: target.model,
    apiKey: await apiKeyOf(ports, target, options.interrupt),
    signal: options.interrupt,
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
  ports.stdout.write(probeEndpointText(name, key.endpoint, paths.probe, report, toolCalling));
  await restartDaemon(ports, paths);
  return 0;
};

const probeOllama = async (ports: CliPorts, paths: MomongaPaths, name: string, target: OllamaConfig, options: ProbeOptions): Promise<number> => {
  const { probeOllamaTarget } = await import('@momonga/gateway');
  const { report, key } = await probeOllamaTarget({
    probeRecordDir: paths.probe,
    upstream: upstreamEndpointOf(target),
    key: endpointRecordKeyOf(name, target),
    model: target.model,
    contextWindow: target.capabilities.contextWindow,
    signal: options.interrupt,
  });
  ports.stdout.write(probeOllamaText(name, key.endpoint, paths.probe, report, target.capabilities.contextWindow));
  await restartDaemon(ports, paths);
  return 0;
};

export const probeFm = async (ports: CliPorts, paths: MomongaPaths, target: string, options: ProbeOptions): Promise<number> => {
  const { settings } = await loadUserSettings({ home: ports.home });
  const targets = settings.models.targets;
  const configured = targets[target];
  if (configured?.adapter !== 'fm') throw new NotAProbeableTarget(target, targets);
  const { probeManagedFm } = await import('@momonga/gateway');
  const { report, toolCalling } = await probeManagedFm({
    paths,
    target,
    binary: options.fmBinary,
    socketPath: path.join(paths.run, FM_PROBE_SOCKET_NAME),
    env: ports.env,
    signal: options.interrupt,
    onWarning: (message) => ports.stderr.write(`${escapedLines([`momonga: ${message}`])}\n`),
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
  ports.stdout.write(probeFmText(target, paths.probe, report, toolCalling));
  await restartDaemon(ports, paths);
  return 0;
};
