import type { MomongaPaths, OutboundFetch } from '@momonga/foundation';
import { LOCAL_SERVER_CANDIDATES, agentReadiness, isProbingCapabilities } from '@momonga/protocol';
import type { AliasCapabilities, DetectedLocalServer, MomongaModelEntry } from '@momonga/protocol';
import { createGatewayClient } from '../client/gateway-client.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { escapedLines } from '../terminal-writer.ts';

const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

const toolCallingText = (capabilities: AliasCapabilities): string => {
  const readiness = agentReadiness(capabilities);
  return readiness.state === 'needs_probe' ? `needs probe: ${readiness.remedy}` : String(capabilities.toolCalling);
};

const describeCapabilities = (capabilities: AliasCapabilities): string[] => [
  `    context window: ${capabilities.contextWindow}, max output: ${capabilities.maxOutputTokens}`,
  `    tool calling: ${toolCallingText(capabilities)}, parallel tool calls: ${capabilities.parallelToolCalls === undefined ? 'unknown' : yesNo(capabilities.parallelToolCalls)}, structured output: ${capabilities.structuredOutput}`,
  `    JSON-only mode: ${capabilities.jsonMode ?? 'not measured'}`,
  `    image input: ${yesNo(capabilities.imageInput)}, streaming: ${yesNo(capabilities.streaming)}, stop sequences: ${yesNo(capabilities.stopSequences)}`,
  `    token counting: ${capabilities.tokenCounting}, usage reported: ${yesNo(capabilities.usageReported)}, max concurrency: ${capabilities.maxConcurrency}`,
  `    ${capabilities.schemaDialect === undefined ? '' : `schema dialect: ${capabilities.schemaDialect}, `}source: ${capabilities.source}${capabilities.probedAt === undefined ? '' : ` (probed ${capabilities.probedAt})`}`,
];

export const formatModels = (models: readonly MomongaModelEntry[]): string =>
  models.length === 0
    ? 'the gateway lists no model aliases'
    : escapedLines(
        models.flatMap((model) => [`${model.id}  -> ${model.targets.join(', ')}`, ...(isProbingCapabilities(model.capabilities) ? [`    ${model.capabilities.toolCalling.message}`] : describeCapabilities(model.capabilities))]),
      );

export const listModels = async (ports: CliPorts, paths: MomongaPaths, json: boolean): Promise<number> => {
  await ensureDaemon(ports, paths);
  const gateway = createGatewayClient({ socketPath: paths.sockets.gateway });
  try {
    const models = await gateway.models();
    ports.stdout.write(`${json ? JSON.stringify(models) : formatModels(models)}\n`);
    return 0;
  } finally {
    await gateway.close();
  }
};

export const formatDetected = (servers: readonly DetectedLocalServer[], settingsFile: string): string => {
  if (servers.length === 0) return `no local model server answered; declare a target in ${settingsFile} (models.targets and models.aliases) or name an address with momonga models detect <url>`;
  return escapedLines([
    ...servers.flatMap((server) => [
      `found at ${server.baseUrl} (${server.shape} API)`,
      ...(server.models.length === 0 ? ['  no models listed'] : server.models.map((model) => `  ${model.id}  tools: ${model.tools}`)),
    ]),
    `nothing was written; declare the target you want in ${settingsFile} (models.targets and models.aliases)`,
  ]);
};

export const detectModels = async (
  ports: CliPorts,
  paths: MomongaPaths,
  options: { typed: readonly string[]; json: boolean; interrupt: AbortSignal; fetch: OutboundFetch | typeof fetch },
): Promise<number> => {
  const { detectLocalServers } = await import('@momonga/gateway');
  const found = await detectLocalServers({
    candidates: LOCAL_SERVER_CANDIDATES,
    typed: options.typed,
    signal: options.interrupt,
    fetch: options.fetch,
  });
  ports.stdout.write(`${options.json ? JSON.stringify(found) : formatDetected(found, paths.settingsFile)}\n`);
  return 0;
};
