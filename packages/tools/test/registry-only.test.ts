import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '@momonga/tools';
import { makeTool } from './harness.ts';

const registryOf = (...names: string[]) => {
  const registry = createToolRegistry();
  for (const name of names) registry.register(makeTool(name));
  return registry;
};

describe('snapshot with an allow list', () => {
  it('keeps only the named tools and reports the names that match nothing', async () => {
    const set = await registryOf('Read', 'Grep', 'Bash').snapshot({ only: ['Read', 'Grep', 'Ghost'] });
    expect(set.tools.map((tool) => tool.name)).toEqual(['Grep', 'Read']);
    expect(set.notices).toEqual(['Tools "Ghost" are not available and were left out']);
    expect(set.get('Bash')).toBeUndefined();
  });

  it('gives a different digest than the full set', async () => {
    const registry = registryOf('Read', 'Grep');
    expect((await registry.snapshot({ only: ['Read'] })).digest).not.toBe((await registry.snapshot()).digest);
  });

  it('yields an empty set when nothing matches', async () => {
    const set = await registryOf('Read').snapshot({ only: ['Ghost'] });
    expect(set.tools).toEqual([]);
  });
});
