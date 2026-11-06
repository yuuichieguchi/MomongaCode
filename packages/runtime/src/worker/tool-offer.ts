import type { FunctionTool } from '@momonga/protocol';
import type { ToolSet } from '@momonga/tools';
import { isRecord } from './json.ts';

export const LOAD_TOOLS_TOOL_NAME = 'LoadTools';

export type ToolOffer = { tools: FunctionTool[]; catalog: string[] };

export type ToolOfferInput = {
  toolSet: Pick<ToolSet, 'get' | 'companions'>;
  visible: readonly FunctionTool[];
  deferred: readonly string[] | undefined;
  loaded: readonly string[];
  keepCompanionsWithoutHost: boolean;
  required: ReadonlySet<string>;
};

const LOADER_DESCRIPTION = 'Loads the full definitions of the tools in this catalog, one per line. Load a tool before you call it; a loaded tool stays available for the rest of the run.';

const catalogLineOf = (definition: FunctionTool): string => `${definition.name}: ${(definition.description ?? '').split('\n')[0]}`;

const loaderDefinitionOf = (offered: FunctionTool, catalog: readonly FunctionTool[]): FunctionTool => ({
  ...offered,
  description: [LOADER_DESCRIPTION, ...catalog.map(catalogLineOf)].join('\n'),
  parameters: {
    type: 'object',
    properties: { names: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.map((definition) => definition.name) } } },
    required: ['names'],
    additionalProperties: false,
  },
  strict: false,
});

export const offerFor = (input: ToolOfferInput): ToolOffer => {
  const { toolSet, deferred, loaded, keepCompanionsWithoutHost, required } = input;
  if (deferred === undefined) return { tools: [...input.visible], catalog: [] };
  const offeredLoader = input.visible.find((definition) => definition.name === LOAD_TOOLS_TOOL_NAME);
  const visible = input.visible.filter((definition) => definition.name !== LOAD_TOOLS_TOOL_NAME);
  const definitionOf = new Map(visible.map((definition) => [definition.name, definition]));
  const pinned = [...new Set(deferred)];
  const catalogDefinitions = pinned.flatMap((name) => {
    const definition = definitionOf.get(name);
    if (definition === undefined || name === LOAD_TOOLS_TOOL_NAME) return [];
    if (toolSet.get(name)?.tier === 'essential' || toolSet.companions.has(name) || required.has(name)) return [];
    return catalogLineOf(definition).length < JSON.stringify(definition).length ? [definition] : [];
  });
  const catalog = catalogDefinitions.map((definition) => definition.name);
  if (catalog.length === 0) return { tools: [...visible], catalog: [] };
  if (offeredLoader === undefined) throw new Error(`${LOAD_TOOLS_TOOL_NAME} is not among the tools visible to the model, so the catalog cannot be loaded`);
  const inCatalog = new Set(catalog);
  const loadedInCatalog = [...new Set(loaded)].filter((name) => inCatalog.has(name));
  const loadedSet = new Set(loadedInCatalog);

  const anchorOf = (name: string): string | undefined => {
    const seen = new Set<string>();
    for (let current = name; !seen.has(current); ) {
      seen.add(current);
      if (inCatalog.has(current)) return current;
      const host = toolSet.companions.get(current);
      if (host === undefined || keepCompanionsWithoutHost) return undefined;
      current = host;
    }
    return undefined;
  };
  const stands = (name: string): boolean => {
    const anchor = anchorOf(name);
    return anchor === undefined || loadedSet.has(anchor);
  };

  const standing = visible.filter((definition) => !inCatalog.has(definition.name) && stands(definition.name));
  const inPlace = standing.filter((definition) => anchorOf(definition.name) === undefined);
  const afterLoad = (host: string): FunctionTool[] => {
    const hostDefinition = definitionOf.get(host);
    return [
      ...(hostDefinition === undefined ? [] : [hostDefinition]),
      ...standing.filter((definition) => anchorOf(definition.name) === host),
    ];
  };
  return {
    tools: [...inPlace, loaderDefinitionOf(offeredLoader, catalogDefinitions), ...loadedInCatalog.flatMap(afterLoad)],
    catalog,
  };
};

export type OfferedRecord = { type: 'tool.offered'; names: string[] };

export const offeredRecordFor = (recorded: readonly string[] | undefined, names: readonly string[]): OfferedRecord | undefined => {
  const known = new Set(recorded);
  if (recorded !== undefined && names.every((name) => known.has(name))) return undefined;
  return { type: 'tool.offered', names: [...new Set([...known, ...names])].sort() };
};

export type OfferedInBody = { tools: string[]; catalog: string[] };

const catalogOfLoader = (runId: string, loader: Record<string, unknown>): string[] => {
  const { parameters } = loader;
  const properties = isRecord(parameters) ? parameters['properties'] : undefined;
  const names = isRecord(properties) ? properties['names'] : undefined;
  const items = isRecord(names) ? names['items'] : undefined;
  const enumerated = isRecord(items) ? items['enum'] : undefined;
  if (!Array.isArray(enumerated) || enumerated.some((name) => typeof name !== 'string')) {
    throw new Error(`a model.requested event of run ${runId} offers ${LOAD_TOOLS_TOOL_NAME} without a catalog enum`);
  }
  return enumerated as string[];
};

export const offeredInBody = (runId: string, body: unknown): OfferedInBody => {
  if (!isRecord(body) || !Array.isArray(body['tools'])) throw new Error(`a model.requested event of run ${runId} holds a body without a tools list`);
  const tools: string[] = [];
  const catalog: string[] = [];
  for (const tool of body['tools']) {
    if (!isRecord(tool) || typeof tool['name'] !== 'string') throw new Error(`a model.requested event of run ${runId} lists a tool without a name`);
    tools.push(tool['name']);
    if (tool['name'] === LOAD_TOOLS_TOOL_NAME) catalog.push(...catalogOfLoader(runId, tool));
  }
  return { tools, catalog };
};
