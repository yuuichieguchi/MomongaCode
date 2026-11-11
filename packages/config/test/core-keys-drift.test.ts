import { describe, expect, it } from 'vitest';
import { CORE_SETTING_KEYS, NON_CORE_SETTING_KEYS, SETTINGS_SCHEMA, defaultContextSettings, defaultMemorySettings, defaultToolsSettings } from '@momonga/config';
import { OUTPUT_FORMATTERS } from '@momonga/protocol';

type SchemaNode = { type?: string; properties?: Record<string, SchemaNode>; items?: { enum?: readonly unknown[] } };

const CORE_SECTIONS = ['context', 'tools', 'memory'] as const;

const leavesOf = (node: SchemaNode, prefix: string): { key: string; node: SchemaNode }[] =>
  Object.entries(node.properties ?? {}).flatMap(([name, child]) =>
    child.type === 'object' && child.properties !== undefined ? leavesOf(child, `${prefix}.${name}`) : [{ key: `${prefix}.${name}`, node: child }],
  );

const schemaLeaves = (): { key: string; node: SchemaNode }[] => {
  const properties = (SETTINGS_SCHEMA as unknown as SchemaNode).properties ?? {};
  return CORE_SECTIONS.flatMap((section) => leavesOf(properties[section] ?? {}, section));
};

const defaults = (): Record<string, unknown> => ({ context: defaultContextSettings(), tools: defaultToolsSettings(), memory: defaultMemorySettings() });

const valueAt = (root: Record<string, unknown>, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((value, part) => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined), root);

const isSwitch = (node: SchemaNode): boolean => node.type === 'boolean' || node.type === 'array';

describe('every switch of the core sections is core and on, or named non-core (design core-on 3.5, test 6)', () => {
  it('names autoCompact as core and ripgrep, forgetAfterDays and reflection.maxTokens as non-core', () => {
    expect(CORE_SETTING_KEYS).toContain('context.autoCompact');
    expect([...NON_CORE_SETTING_KEYS].sort()).toEqual(['memory.forgetAfterDays', 'memory.reflection.maxTokens', 'tools.bash.backgroundTimeoutMs', 'tools.bash.defaultTimeoutMs', 'tools.bash.maxBackgroundTimeoutMs', 'tools.bash.maxTimeoutMs', 'tools.bash.onTimeout', 'tools.operations.timeoutMs', 'tools.ripgrep', 'tools.search.timeoutMs']);
  });

  it('names the eleven keys of the token policy overlay as core', () => {
    expect(CORE_SETTING_KEYS).toEqual(
      expect.arrayContaining([
        'context.adaptiveBudget',
        'context.autoCompact',
        'context.cachePrefix',
        'context.outputFormatters',
        'context.loopGuidance',
        'context.observedCapacity',
        'context.unboundedOutputReserve',
        'tools.deferral',
        'tools.conciseDescriptions',
        'memory.repositoryFacts',
        'memory.reflection.enabled',
      ]),
    );
  });

  it('places every key of context, tools and memory in exactly one of the two lists', () => {
    const named = [...CORE_SETTING_KEYS, ...NON_CORE_SETTING_KEYS];
    expect(new Set(named).size).toBe(named.length);
    expect([...named].sort()).toEqual(schemaLeaves().map((leaf) => leaf.key).sort());
  });

  it('gives every boolean or list switch the value that turns its feature on, unless it is named non-core', () => {
    const offSwitches = schemaLeaves()
      .filter((leaf) => isSwitch(leaf.node) && !NON_CORE_SETTING_KEYS.includes(leaf.key))
      .filter((leaf) => {
        const value = valueAt(defaults(), leaf.key);
        return leaf.node.type === 'boolean' ? value !== true : JSON.stringify(value) !== JSON.stringify(leaf.node.items?.enum ?? []);
      })
      .map((leaf) => leaf.key);
    expect(offSwitches).toEqual([]);
  });

  it('defaults the formatter list to every formatter in OUTPUT_FORMATTERS order', () => {
    expect(defaultContextSettings().outputFormatters).toEqual([...OUTPUT_FORMATTERS]);
  });
});
