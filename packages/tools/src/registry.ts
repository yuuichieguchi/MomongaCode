import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { modelVisibleTools } from '@momonga/policy';
import type { PermissionRule } from '@momonga/policy';
import type { FunctionTool, PermissionMode } from '@momonga/protocol';
import { compileInputSchema } from './validate.ts';
import { TOOL_TIERS } from './types.ts';
import type { AnyTool } from './types.ts';

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

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
  forModel(options: { mode: PermissionMode; rules: PermissionRule[] }): FunctionTool[];
};

export type ToolRegistry = {
  register(tool: AnyTool): void;
  addSource(source: ToolSource): void;
  snapshot(options?: SnapshotOptions): Promise<ToolSet>;
};

const assertRegistrable = (tool: AnyTool): void => {
  if (!TOOL_NAME.test(tool.name)) throw new Error(`invalid tool name ${JSON.stringify(tool.name)}: must match ${TOOL_NAME.source}`);
  if (tool.inputSchema['type'] !== 'object') throw new Error(`tool ${JSON.stringify(tool.name)} input schema must have root type "object"`);
  compileInputSchema(tool);
};

const digestOf = (tools: readonly AnyTool[]): string =>
  sha256Hex(canonicalJson(tools.map((tool) => [tool.name, tool.description, tool.kind, tool.sideEffect, tool.inputSchema])));

const tierRankOf = (tool: AnyTool): number => TOOL_TIERS.indexOf(tool.tier ?? 'common');

const buildToolSet = (tools: readonly AnyTool[], notices: readonly string[], authorizationRequired: readonly string[]): ToolSet => {
  const frozenTools = Object.freeze([...tools].sort((left, right) => tierRankOf(left) - tierRankOf(right)));
  const frozenNotices = Object.freeze([...notices]);
  const byName = new Map(frozenTools.map((tool) => [tool.name, tool]));
  return {
    digest: digestOf(frozenTools),
    tools: frozenTools,
    notices: frozenNotices,
    authorizationRequired: Object.freeze([...authorizationRequired]),
    get: (name) => byName.get(name),
    forModel: ({ mode, rules }) => {
      const visible = new Set(modelVisibleTools([...frozenTools], { mode, rules }).map((tool) => tool.name));
      return frozenTools
        .filter((tool) => visible.has(tool.name))
        .map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }));
    },
  };
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
