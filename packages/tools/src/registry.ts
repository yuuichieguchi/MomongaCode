import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { deniedByNamedRule, modelVisibleTools } from '@momonga/policy';
import type { PermissionRule, PermissionSubject } from '@momonga/policy';
import { TOOL_NAME_PATTERN } from '@momonga/protocol';
import type { FitRankedFunctionTool, PermissionMode, ReferenceKind } from '@momonga/protocol';
import { compileToolSchemas } from './validate.ts';
import { TOOL_TIERS } from './types.ts';
import type { AnyTool } from './types.ts';

export type ToolSourceListing = { tools: AnyTool[]; notices: string[]; authorizationRequired?: string[] };

export type ToolListOptions = { signal?: AbortSignal };

export type SnapshotOptions = ToolListOptions & { only?: readonly string[] };

export type ToolSource = {
  id: string;
  list(options?: ToolListOptions): Promise<AnyTool[]>;
  listWithNotices?(options?: ToolListOptions): Promise<ToolSourceListing>;
};

export type ToolSet = {
  readonly digest: string;
  readonly tools: readonly AnyTool[];
  readonly notices: readonly string[];
  readonly authorizationRequired: readonly string[];
  get(name: string): AnyTool | undefined;
  readonly companions: ReadonlyMap<string, string>;
  readerOf(kind: ReferenceKind): string | undefined;
  forModel(options: { mode: PermissionMode; rules: PermissionRule[]; conciseDescriptions?: boolean }): FitRankedFunctionTool[];
};

export type ToolRegistry = {
  register(tool: AnyTool): void;
  addSource(source: ToolSource): void;
  snapshot(options?: SnapshotOptions): Promise<ToolSet>;
};

const assertRegistrable = (tool: AnyTool): void => {
  if (!TOOL_NAME_PATTERN.test(tool.name)) throw new Error(`invalid tool name ${JSON.stringify(tool.name)}: must match ${TOOL_NAME_PATTERN.source}`);
  if (tool.inputSchema['type'] !== 'object') throw new Error(`tool ${JSON.stringify(tool.name)} input schema must have root type "object"`);
  compileToolSchemas(tool);
};

const digestEntryOf = (tool: AnyTool): unknown[] => [
  tool.name,
  tool.description,
  tool.kind,
  tool.sideEffect,
  tool.inputSchema,
  tool.conciseDescription ?? null,
  tool.conciseParameterDescriptions ?? null,
];

const hasConciseVariant = (tool: AnyTool): boolean => tool.conciseDescription !== undefined || tool.conciseParameterDescriptions !== undefined;

const conciseDescriptionOf = (tool: AnyTool): string => {
  if (tool.conciseDescription === undefined) throw new Error(`tool ${JSON.stringify(tool.name)} has a concise variant without a concise description`);
  return tool.conciseDescription;
};

const digestOf = (tools: readonly AnyTool[]): string => sha256Hex(canonicalJson(tools.map(digestEntryOf)));

const conciseSchemaOf = (tool: AnyTool): Record<string, unknown> => {
  const concise = tool.conciseParameterDescriptions ?? {};
  const properties = tool.inputSchema['properties'];
  if (properties === undefined || properties === null || typeof properties !== 'object') return tool.inputSchema;
  const replaced = Object.fromEntries(
    Object.entries(properties).map(([field, schema]) => {
      if (typeof (schema as { description?: unknown }).description !== 'string') return [field, schema];
      const text = concise[field];
      if (text === undefined) throw new Error(`tool ${JSON.stringify(tool.name)} has a concise variant without a concise text for parameter ${JSON.stringify(field)}`);
      return [field, { ...(schema as Record<string, unknown>), description: text }];
    }),
  );
  return { ...tool.inputSchema, properties: replaced };
};

const tierRankOf = (tool: AnyTool): number => TOOL_TIERS.indexOf(tool.tier ?? 'common');

const compareNames = (left: string, right: string): number => {
  const leftPoints = [...left].map((character) => character.codePointAt(0)!);
  const rightPoints = [...right].map((character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};

type PlacedTool = { tool: AnyTool; tier: number; chain: readonly string[] };

const placementsOf = (tools: readonly AnyTool[]): PlacedTool[] => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const placementOf = (tool: AnyTool, seen: ReadonlySet<string>): { tier: number; chain: string[] } => {
    const host = tool.companionOf === undefined ? undefined : byName.get(tool.companionOf);
    if (host === undefined || seen.has(host.name)) return { tier: tierRankOf(tool), chain: [tool.name] };
    const placed = placementOf(host, new Set([...seen, tool.name]));
    return { tier: placed.tier, chain: [...placed.chain, tool.name] };
  };
  return tools.map((tool) => ({ tool, ...placementOf(tool, new Set<string>()) }));
};

const comparePlacements = (left: PlacedTool, right: PlacedTool): number => {
  if (left.tier !== right.tier) return left.tier - right.tier;
  for (let index = 0; index < Math.min(left.chain.length, right.chain.length); index += 1) {
    const difference = compareNames(left.chain[index]!, right.chain[index]!);
    if (difference !== 0) return difference;
  }
  return left.chain.length - right.chain.length;
};

const placedInFitOrder = (tools: readonly AnyTool[]): PlacedTool[] => placementsOf(tools).sort(comparePlacements);

const buildToolSet = (tools: readonly AnyTool[], notices: readonly string[], authorizationRequired: readonly string[]): ToolSet => {
  const placed = placedInFitOrder(tools);
  const frozenTools = Object.freeze(placed.map(({ tool }) => tool));
  const tierOf = new Map(placed.map(({ tool, tier }) => [tool.name, TOOL_TIERS[tier]!]));
  const frozenNotices = Object.freeze([...notices]);
  const byName = new Map(frozenTools.map((tool) => [tool.name, tool]));
  return {
    digest: digestOf(frozenTools),
    tools: frozenTools,
    notices: frozenNotices,
    authorizationRequired: Object.freeze([...authorizationRequired]),
    get: (name) => byName.get(name),
    readerOf: (kind) => frozenTools.find((tool) => tool.reads === kind)?.name,
    companions: new Map(frozenTools.flatMap((tool) => (tool.companionOf === undefined ? [] : [[tool.name, tool.companionOf] as const]))),
    forModel: ({ mode, rules, conciseDescriptions }) => {
      const visible = new Set(modelVisibleTools([...frozenTools], { mode, rules }).map((tool) => tool.name));
      const concise = conciseDescriptions === true;
      const denied = (subject: PermissionSubject): boolean => subject.kind !== 'path' && deniedByNamedRule(rules, subject);
      return frozenTools
        .filter((tool) => visible.has(tool.name))
        .map((tool) => (tool.offeredWithout === undefined ? tool : tool.offeredWithout(denied)))
        .filter((tool) => tool !== null)
        .map((tool, index) => {
          const useConcise = concise && hasConciseVariant(tool);
          return {
            type: 'function',
            name: tool.name,
            description: useConcise ? conciseDescriptionOf(tool) : tool.description,
            parameters: useConcise ? conciseSchemaOf(tool) : tool.inputSchema,
            strict: false,
            fitRank: index,
            fitTier: tierOf.get(tool.name)!,
          };
        });
    },
  };
};

export const extendToolSet = (toolSet: ToolSet, tool: AnyTool): ToolSet => {
  if (toolSet.get(tool.name) !== undefined) throw new Error(`duplicate tool name ${JSON.stringify(tool.name)}`);
  assertRegistrable(tool);
  const rebuilt = buildToolSet([...toolSet.tools, tool], toolSet.notices, toolSet.authorizationRequired);
  return { ...rebuilt, digest: toolSet.digest };
};

export const createToolRegistry = (): ToolRegistry => {
  const builtins: AnyTool[] = [];
  const sources: ToolSource[] = [];

  return {
    register: (tool) => {
      if (builtins.some((existing) => existing.name === tool.name)) throw new Error(`duplicate tool name ${JSON.stringify(tool.name)}`);
      assertRegistrable(tool);
      builtins.push(tool);
    },
    addSource: (source) => {
      sources.push(source);
    },
    snapshot: async (options) => {
      const signal = options?.signal;
      const tools: AnyTool[] = [...builtins];
      const taken = new Set(tools.map((tool) => tool.name));
      const notices: string[] = [];
      const authorizationRequired: string[] = [];
      for (const source of sources) {
        signal?.throwIfAborted();
        const listOptions: ToolListOptions = signal === undefined ? {} : { signal };
        let listed: AnyTool[];
        try {
          if (source.listWithNotices === undefined) {
            listed = await source.list(listOptions);
          } else {
            const listing = await source.listWithNotices(listOptions);
            listed = listing.tools;
            authorizationRequired.push(...(listing.authorizationRequired ?? []));
            for (const notice of listing.notices) notices.push(`Tool source ${JSON.stringify(source.id)}: ${notice}`);
          }
        } catch (error) {
          if (signal?.aborted === true) throw signal.reason;
          notices.push(`Tool source ${JSON.stringify(source.id)} failed to list tools: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        for (const tool of listed) {
          if (taken.has(tool.name)) {
            notices.push(`Tool source ${JSON.stringify(source.id)}: skipped ${JSON.stringify(tool.name)} because a tool with that name already exists`);
            continue;
          }
          try {
            assertRegistrable(tool);
          } catch (error) {
            notices.push(`Tool source ${JSON.stringify(source.id)}: skipped ${JSON.stringify(tool.name)}: ${(error as Error).message}`);
            continue;
          }
          taken.add(tool.name);
          tools.push(tool);
        }
      }
      const only = options?.only;
      if (only === undefined) return buildToolSet(tools, notices, authorizationRequired);
      const allowed = new Set(only);
      const unresolved = only.filter((name) => !tools.some((tool) => tool.name === name));
      if (unresolved.length > 0) notices.push(`Tools ${unresolved.map((name) => JSON.stringify(name)).join(', ')} are not available and were left out`);
      return buildToolSet(
        tools.filter((tool) => allowed.has(tool.name)),
        notices,
        authorizationRequired,
      );
    },
  };
};
