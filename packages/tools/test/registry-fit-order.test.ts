import { describe, expect, it } from 'vitest';
import type { AnyTool, ToolSet } from '@momonga/tools';
import { makeTool, toolSetOf } from './harness.ts';

const toolsByName = (): Record<string, AnyTool> => ({
  Zeta: makeTool('Zeta', { tier: 'optional' }),
  Alpha: makeTool('Alpha', { tier: 'optional' }),
  Bash: makeTool('Bash', { tier: 'common' }),
  Make: makeTool('Make', { tier: 'common' }),
  BashOutput: makeTool('BashOutput', { tier: 'optional', companionOf: 'Bash' }),
  KillBash: makeTool('KillBash', { tier: 'optional', companionOf: 'Bash' }),
  Read: makeTool('Read', { tier: 'essential' }),
});

const setIn = (order: readonly string[]): Promise<ToolSet> => {
  const byName = toolsByName();
  return toolSetOf(...order.map((name) => byName[name]!));
};

const REGISTRATION = ['Zeta', 'KillBash', 'Alpha', 'Make', 'BashOutput', 'Bash', 'Read'];
const REVERSED = [...REGISTRATION].reverse();
const KEEP_ORDER = ['Read', 'Bash', 'BashOutput', 'KillBash', 'Make', 'Alpha', 'Zeta'];

describe('the order of a tool set', () => {
  it('is tier, then a companion right after its host, then name in code-point order, whatever the registration order', async () => {
    expect((await setIn(REGISTRATION)).tools.map((tool) => tool.name)).toEqual(KEEP_ORDER);
    expect((await setIn(REVERSED)).tools.map((tool) => tool.name)).toEqual(KEEP_ORDER);
  });

  it('gives the same digest for the same tools registered in two orders', async () => {
    expect((await setIn(REGISTRATION)).digest).toBe((await setIn(REVERSED)).digest);
  });

  it('offers the model the same order, each tool carrying its dense fit rank', async () => {
    for (const order of [REGISTRATION, REVERSED]) {
      const offered = (await setIn(order)).forModel({ mode: 'default', rules: [] }) as ReadonlyArray<{ name: string; fitRank?: number }>;
      expect(offered.map((tool) => tool.name)).toEqual(KEEP_ORDER);
      expect(offered.map((tool) => tool.fitRank)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });
});
