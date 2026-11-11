import { describe, expect, it } from 'vitest';
import { CLI_FAKES_ENTRY } from '../e2e/support/cli-bundles.ts';
import { bundleInputsOf, defaultEntry, repoRoot } from '../scripts/bundle.ts';
import { asyncModulesOf, importCyclesAmong, mutuallyAwaitingCyclesOf } from '../scripts/support/async-cycles.ts';
import { UNBOUNDED_BUILD_WAIT_MS } from '../scripts/support/build-wait.ts';

const graphOf = (edges: Readonly<Record<string, readonly string[]>>): Map<string, readonly string[]> => new Map(Object.entries(edges));

describe('the import cycles that a bundle turns into initialisers awaiting each other', () => {
  it('are the cycles among the modules that hold a top-level await or reach one by static imports', () => {
    const graph = graphOf({
      entry: ['screen', 'plain-a'],
      screen: ['transcript', 'ink'],
      transcript: ['screen'],
      ink: ['yoga'],
      yoga: [],
      'plain-a': ['plain-b'],
      'plain-b': ['plain-a'],
    });
    const asyncModules = asyncModulesOf(graph, new Set(['yoga']));
    expect([...asyncModules].sort()).toEqual(['entry', 'ink', 'screen', 'transcript', 'yoga']);
    expect(importCyclesAmong(graph, asyncModules)).toEqual([['screen', 'transcript']]);
  });

  it('counts a module that imports itself and keeps two separate cycles apart', () => {
    const graph = graphOf({ a: ['a'], b: ['c'], c: ['b'], d: ['a', 'b'] });
    expect(importCyclesAmong(graph, new Set(['a', 'b', 'c', 'd']))).toEqual([['a'], ['b', 'c']]);
  });

  it.for([defaultEntry, CLI_FAKES_ENTRY])('do not exist in the bundle of %s', { timeout: UNBOUNDED_BUILD_WAIT_MS }, async (entry) => {
    expect(await mutuallyAwaitingCyclesOf(await bundleInputsOf(entry), repoRoot)).toEqual([]);
  });
});
