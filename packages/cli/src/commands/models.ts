import type { MomongaPaths } from '@momonga/foundation';
import type { Capabilities, MomongaModelEntry } from '@momonga/protocol';
import { createGatewayClient } from '../client/gateway-client.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { escapedLines } from '../terminal-writer.ts';

const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

const describeCapabilities = (capabilities: Capabilities): string[] => [
  `    context window: ${capabilities.contextWindow}, max output: ${capabilities.maxOutputTokens}`,
  `    tool calling: ${capabilities.toolCalling}, parallel tool calls: ${capabilities.parallelToolCalls === undefined ? 'unknown' : yesNo(capabilities.parallelToolCalls)}, structured output: ${capabilities.structuredOutput}`,
  `    image input: ${yesNo(capabilities.imageInput)}, streaming: ${yesNo(capabilities.streaming)}, stop sequences: ${yesNo(capabilities.stopSequences)}`,
  `    token counting: ${capabilities.tokenCounting}, usage reported: ${yesNo(capabilities.usageReported)}, max concurrency: ${capabilities.maxConcurrency}`,
  `    schema dialect: ${capabilities.schemaDialect}, source: ${capabilities.source}${capabilities.probedAt === undefined ? '' : ` (probed ${capabilities.probedAt})`}`,
];

export const formatModels = (models: readonly MomongaModelEntry[]): string =>
  models.length === 0
    ? 'the gateway lists no model aliases'
    : escapedLines(models.flatMap((model) => [`${model.id}  -> ${model.targets.join(', ')}`, ...describeCapabilities(model.capabilities)]));

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
