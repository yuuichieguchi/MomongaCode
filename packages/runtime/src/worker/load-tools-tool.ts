import { defineTool, ToolExecutionError } from '@momonga/tools';
import type { AnyTool, ToolSet } from '@momonga/tools';
import { LOAD_TOOLS_TOOL_NAME } from './tool-offer.ts';
import type { ToolLoading } from './tool-admission.ts';

type LoadToolsInput = { names: string[] };

const LOAD_TOOLS_TIMEOUT_MS = 30_000;

export const createLoadToolsTool = (loading: ToolLoading): AnyTool => {
  const claimed = new Set<string>();
  return defineTool<LoadToolsInput>({
    name: LOAD_TOOLS_TOOL_NAME,
    tier: 'essential',
    description: 'Loads the full definitions of deferred tools from the catalog.',
    kind: 'read',
    sideEffect: 'read_only',
    inputSchema: {
      type: 'object',
      properties: { names: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Names of the tools to load' } },
      required: ['names'],
      additionalProperties: false,
    },
    timeoutMs: LOAD_TOOLS_TIMEOUT_MS,
    title: (input) => `Load ${input.names.join(', ')}`,
    subject: () => ({ kind: 'none', tool: LOAD_TOOLS_TOOL_NAME }),
    execute: async (input) => {
      const catalog = loading.catalog();
      const unknown = input.names.filter((name) => !catalog.includes(name));
      if (unknown.length > 0) throw new ToolExecutionError(`${unknown.join(', ')} is not in the catalog of ${LOAD_TOOLS_TOOL_NAME}`);
      const fresh = [...new Set(input.names)].filter((name) => !loading.isLoaded(name) && !claimed.has(name));
      if (fresh.length === 0) return { status: 'completed', output: `${input.names.join(', ')} already loaded; the definitions are already available.` };
      for (const name of fresh) claimed.add(name);
      try {
        const admission = await loading.admit(fresh);
        if (!admission.admitted) throw new ToolExecutionError(admission.reason);
      } catch (error) {
        for (const name of fresh) claimed.delete(name);
        throw error;
      }
      return { status: 'completed', output: `Loaded ${fresh.join(', ')}; the definitions are available from the next request.`, toolsLoaded: fresh };
    },
  });
};

export const withLoadTools = (toolSet: ToolSet, loader: AnyTool): ToolSet => ({
  ...toolSet,
  tools: [...toolSet.tools, loader],
  get: (name) => (name === loader.name ? loader : toolSet.get(name)),
});
