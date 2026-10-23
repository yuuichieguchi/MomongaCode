import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '@momonga/tools';
import type { AnyTool, ToolSource } from '@momonga/tools';
import { makeTool } from './harness.ts';

type ListOptions = { signal?: AbortSignal } | undefined;

describe('registry snapshot signal', () => {
  it('snapshot forwards the signal to listWithNotices', async () => {
    const seen: ListOptions[] = [];
    const registry = createToolRegistry();
    registry.addSource({
      id: 'mcp-a',
      list: async () => [],
      listWithNotices: async (options?: { signal?: AbortSignal }) => {
        seen.push(options);
        return { tools: [makeTool('remote_a')], notices: [] };
      },
    } as ToolSource);
    const controller = new AbortController();

    const toolSet = await registry.snapshot({ signal: controller.signal });

    expect(toolSet.tools.map((tool) => tool.name)).toEqual(['remote_a']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBe(controller.signal);
  });

  it('snapshot forwards the signal to list', async () => {
    const seen: ListOptions[] = [];
    const registry = createToolRegistry();
    registry.addSource({
      id: 'plain',
      list: async (options?: { signal?: AbortSignal }): Promise<AnyTool[]> => {
        seen.push(options);
        return [];
      },
    } as ToolSource);
    const controller = new AbortController();

    await registry.snapshot({ signal: controller.signal });

    expect(seen[0]?.signal).toBe(controller.signal);
  });

  it('snapshot rethrows the abort reason instead of a failed-to-list notice', async () => {
    const controller = new AbortController();
    const reason = new Error('the run was cancelled');
    const registry = createToolRegistry();
    registry.addSource({
      id: 'mcp-a',
      list: async () => [],
      listWithNotices: async () => {
        controller.abort(reason);
        throw new Error('listing aborted');
      },
    });

    await expect(registry.snapshot({ signal: controller.signal })).rejects.toBe(reason);
  });

  it('snapshot checks the signal before each source', async () => {
    const controller = new AbortController();
    const reason = new Error('the run was cancelled');
    const calls: string[] = [];
    const registry = createToolRegistry();
    registry.addSource({
      id: 'first',
      list: async () => {
        calls.push('first');
        controller.abort(reason);
        return [];
      },
    });
    registry.addSource({
      id: 'second',
      list: async () => {
        calls.push('second');
        return [];
      },
    });

    await expect(registry.snapshot({ signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toEqual(['first']);
  });

  it('a source failure without an aborted signal still becomes a notice', async () => {
    const registry = createToolRegistry();
    registry.addSource({
      id: 'mcp-a',
      list: async () => {
        throw new Error('connection refused');
      },
    });

    const toolSet = await registry.snapshot({ signal: new AbortController().signal });

    expect(toolSet.notices).toEqual(['Tool source "mcp-a" failed to list tools: connection refused']);
  });
});
