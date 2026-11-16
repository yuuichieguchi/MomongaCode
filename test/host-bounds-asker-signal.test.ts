import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { ROOT, identifierName, lineOf, packageSources, parentsOf, parseSource, parsedProductSource, relativeOf, workspacePackages } from './support/source-scan.ts';
import type { ParsedSource, SourceNode } from './support/source-scan.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const PACKAGES = path.join(ROOT, 'packages');

const offenders = (pattern: RegExp, allowed: readonly string[] = []): string[] =>
  workspacePackages()
    .flatMap(packageSources)
    .map(relativeOf)
    .filter((file) => !allowed.includes(file) && pattern.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));

const START_BOUND = 'STARTUP_TIMEOUT_MS';
const START_CONTRACT = 'packages/foundation/src/process-contract.ts';
const PASSES_THROUGH = new Set(['BinaryExpression', 'LogicalExpression', 'ConditionalExpression', 'ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'UnaryExpression']);

const startBoundNames = (source: ParsedSource): Set<string> =>
  new Set([...[...source.imports].filter(([, binding]) => binding.imported === START_BOUND).map(([local]) => local), ...(source.locals.has(START_BOUND) ? [START_BOUND] : [])]);

const boundsCallDirectly = (parents: ReadonlyMap<SourceNode, SourceNode | undefined>, start: SourceNode): boolean => {
  let node = start;
  let parent = parents.get(node);
  while (parent !== undefined && PASSES_THROUGH.has(parent.type)) {
    node = parent;
    parent = parents.get(node);
  }
  if (parent === undefined || (parent.type !== 'CallExpression' && parent.type !== 'NewExpression')) return false;
  const args = parent['arguments'];
  return Array.isArray(args) && args.includes(node);
};

const startBoundCalls = (source: ParsedSource): string[] => {
  const names = startBoundNames(source);
  const parents = parentsOf(source);
  return source.references
    .filter(({ node }) => names.has(identifierName(node) ?? ''))
    .filter(({ node }) => boundsCallDirectly(parents, node))
    .map(({ node }) => `${relativeOf(source.file)}:${lineOf(source, node)}`);
};

const startBoundCallsIn = (text: string): number => startBoundCalls(parseSource('sample.ts', text)).length;

describe('a bound that guards a host operation belongs to the operation that asked', () => {
  it('finds the start bound handed to a call as its bound by any spelling: a signal, a timer, an alias, a sum', () => {
    expect(startBoundCallsIn("import { STARTUP_TIMEOUT_MS } from '@momonga/foundation';\nconst signal = AbortSignal.timeout(STARTUP_TIMEOUT_MS);")).toBe(1);
    expect(startBoundCallsIn("import { STARTUP_TIMEOUT_MS as bound } from '@momonga/foundation';\nconst signal = AbortSignal.timeout(bound);")).toBe(1);
    expect(startBoundCallsIn("import { STARTUP_TIMEOUT_MS } from '@momonga/foundation';\ntiming.setTimeout(done, STARTUP_TIMEOUT_MS * 2);")).toBe(1);
    expect(startBoundCallsIn("import { STARTUP_TIMEOUT_MS } from '@momonga/foundation';\nstartChild({ startupTimeoutMs: STARTUP_TIMEOUT_MS });")).toBe(0);
  });

  it('bounds no call with the start bound of the processes outside the start contract', () => {
    const found = workspacePackages()
      .flatMap(packageSources)
      .filter((file) => relativeOf(file) !== START_CONTRACT)
      .flatMap((file) => startBoundCalls(parsedProductSource(file)));
    expect(found).toEqual([]);
  });

  it('names the limit of a request to the runtime in the client', () => {
    const source = fs.readFileSync(path.join(PACKAGES, 'cli/src/client/runtime-client.ts'), 'utf8');
    const options = /createUdsClient\(options\.resolveSocket,\s*\{([^}]*)\}\)/.exec(source)?.[1] ?? '';
    const bounds = [...options.matchAll(/(\w+TimeoutMs):\s*(\w+)/g)].map(([, name, value]) => ({ name, value }));
    expect(bounds.map(({ name }) => name)).toContain('headersTimeoutMs');
    expect(bounds.filter(({ value }) => value !== 'HOST_READ_BOUND_MS')).toEqual([]);
  });
});

describe('whether a socket path fits is measured by a bind, never read from a table of platform numbers', () => {
  it('keeps no per-platform socket path limit in the product or the testkit', () => {
    expect(offenders(/\bsocketPathLimit\b|\bSOCKET_PATH_LIMIT\b|\bLINUX_SOCKET_PATH_LIMIT\b/)).toEqual([]);
  });
});
