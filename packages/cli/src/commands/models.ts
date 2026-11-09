import type { MomongaPaths, OutboundFetch } from '@momonga/foundation';
import { currentSocketResolver } from '@momonga/foundation';
import { LOCAL_SERVER_CANDIDATES, agentReadiness, isProbingCapabilities } from '@momonga/protocol';
import { localManagedPorts } from '../local-managed-ports.ts';
import type { AliasCapabilities, LocalServerDetection, MomongaModelEntry, PlanAccountView, PlanCatalogEntry } from '@momonga/protocol';
import type { PlanGatewayClient } from '../client/gateway-client.ts';
import { createGatewayClient } from '../client/gateway-client.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import { stderrStopNotice } from '../daemon/stop-notice.ts';
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
  await ensureDaemon(ports, paths, { onNotice: stderrStopNotice(ports) });
  const gateway = createGatewayClient({ resolveSocket: currentSocketResolver(paths, 'gateway') });
  try {
    const models = await gateway.models();
    ports.stdout.write(`${json ? JSON.stringify(models) : formatModels(models)}\n`);
    return 0;
  } finally {
    await gateway.close();
  }
};

const detectedLines = (server: LocalServerDetection): string[] => {
  if (server.shape === 'managed') {
    return [`found the managed server ${server.id} at ${server.binary}`, ...(server.refused === undefined ? [] : [`  ${server.refused.message}${server.refused.remedy === undefined ? '' : ` (${server.refused.remedy})`}`])];
  }
  return [
    `found at ${server.baseUrl} (${server.shape} API)`,
    ...(server.models.length === 0 ? ['  no models listed'] : server.models.map((model) => `  ${model.id}  tools: ${model.tools}`)),
  ];
};

export const formatDetected = (servers: readonly LocalServerDetection[], settingsFile: string): string => {
  if (servers.length === 0) return `no local model server answered; declare a target in ${settingsFile} (models.targets and models.aliases) or name an address with momonga models detect <url>`;
  return escapedLines([
    ...servers.flatMap(detectedLines),
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
    ...localManagedPorts(),
  });
  ports.stdout.write(`${options.json ? JSON.stringify(found) : formatDetected(found, paths.settingsFile)}\n`);
  return 0;
};

type Writer = { write(text: string): void };

export type CatalogPorts = { stdout: Writer; stderr: Writer; plan: PlanGatewayClient };

const EXIT_USAGE = 2;

const catalogAccount = async (ports: CatalogPorts, account: string | undefined): Promise<PlanAccountView | undefined> => {
  const listed = await ports.plan.accounts();
  const candidates = account === undefined ? listed.accounts.filter((entry) => entry.active) : listed.accounts.filter((entry) => entry.label === account);
  const [only, ...others] = candidates;
  if (only !== undefined && others.length === 0) return only;
  ports.stderr.write(
    `${escapedLines([
      only === undefined
        ? account === undefined
          ? 'no signed-in account has a model list; sign in with momonga auth login'
          : `no saved account is labelled ${JSON.stringify(account)}; momonga auth status lists them`
        : `several accounts could answer (${candidates.map((entry) => `${entry.label} of ${entry.profile}`).join(', ')}); name the account`,
    ])}\n`,
  );
  return undefined;
};

const catalogRow = (entry: PlanCatalogEntry): string =>
  entry.usable ? `${entry.slug}  ${entry.displayName}  context ${entry.contextWindow}  max output ${entry.maxOutputTokens}` : `${entry.slug}  ${entry.displayName}  unusable: ${entry.reason}`;

export const modelsCatalog = async (ports: CatalogPorts, options: { json: boolean; account?: string }): Promise<number> => {
  const account = await catalogAccount(ports, options.account);
  if (account === undefined) return EXIT_USAGE;
  const catalog = await ports.plan.accountModels(account.label, { profile: account.profile, refresh: true });
  ports.stdout.write(`${options.json ? JSON.stringify(catalog) : escapedLines(catalog.models.map(catalogRow))}\n`);
  return 0;
};

export const modelsAdd = async (ports: CatalogPorts, options: { slug: string; account?: string }): Promise<number> => {
  const account = await catalogAccount(ports, options.account);
  if (account === undefined) return EXIT_USAGE;
  const added = await ports.plan.addTarget(account.label, { profile: account.profile, slug: options.slug });
  ports.stdout.write(`${escapedLines([`Added ${added.target} (alias ${added.alias})`])}\n`);
  return 0;
};
