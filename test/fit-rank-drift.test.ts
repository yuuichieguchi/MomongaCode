import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { childOf, identifierName, literalValue, memberChain, packageSources, parseSource, parsedProductSource, relativeOf, workspacePackages } from './support/source-scan.ts';
import type { ParsedSource } from './support/source-scan.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const FIELD = 'fitRank';

const keyOf = (node: Parameters<typeof childOf>[0]): string | undefined => {
  const key = childOf(node, 'key');
  return identifierName(key) ?? (typeof literalValue(key) === 'string' ? String(literalValue(key)) : undefined);
};

const producesFitRank = (source: ParsedSource): boolean =>
  source.nodes.some(({ node, parent }) => {
    if (node.type === 'Property' && parent?.type === 'ObjectExpression' && keyOf(node) === FIELD) return true;
    if (node.type === 'AssignmentExpression') return memberChain(childOf(node, 'left'))?.endsWith(`.${FIELD}`) === true;
    return false;
  });

const producesIn = (text: string): boolean => producesFitRank(parseSource('sample.ts', text));

describe('the fit rank of a tool', () => {
  it('counts a written field, a shorthand, a quoted key and an assignment as a producer, and not a read, a rest pattern or a type', () => {
    expect(producesIn('const tool = { ...definition, fitRank: index };')).toBe(true);
    expect(producesIn('const tool = { ...definition, fitRank };')).toBe(true);
    expect(producesIn("const tool = { 'fitRank': index };")).toBe(true);
    expect(producesIn('tool.fitRank = index;')).toBe(true);
    expect(producesIn('const { fitRank, ...rest } = tool;\nconst rank = tool.fitRank;\ntype Ranked = { fitRank: number };')).toBe(false);
  });

  it('is produced in exactly one place, the registry comparator', () => {
    const producers = workspacePackages()
      .flatMap(packageSources)
      .filter((file) => producesFitRank(parsedProductSource(file)))
      .map(relativeOf);
    expect(producers).toEqual(['packages/tools/src/registry.ts']);
  });
});
