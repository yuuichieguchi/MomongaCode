import fs from 'node:fs';
import path from 'node:path';
import { ROOT, childOf, childrenOf, countInto, hostModuleOf, identifierName, isNode, literalValue, memberChain, parseSource, relativeOf, unwrapped } from './source-scan.ts';
import type { Counts, ParsedSource, SourceNode } from './source-scan.ts';

export const TIME_SYNC_KINDS = ['timer wait', 'wall-clock reading', 'holder that ends by itself'] as const;

export type TimeSyncKind = (typeof TIME_SYNC_KINDS)[number];

const HOST_TIMERS = new Set(['setTimeout', 'setImmediate', 'setInterval']);

const WALL_CLOCKS = new Set(['Date.now', 'performance.now']);

const COMPARISONS = new Set(['-', '<', '>', '<=', '>=']);

const FAKE_TIME = /\bcreateFake(?:Clock|Timers)\(/;

const VITEST_DEFAULT_FAKES = ['setTimeout', 'setImmediate', 'setInterval', 'Date', 'performance'] as const;

const CASE_CALLS = new Set(['it', 'test', 'it.only', 'test.only', 'it.concurrent', 'test.concurrent']);

const isCaseBody = (node: SourceNode, parent: SourceNode | undefined, key: string): boolean =>
  (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') && parent?.type === 'CallExpression' && key === 'arguments' && CASE_CALLS.has(memberChain(childOf(parent, 'callee')) ?? '');

const fakesOfCall = (call: SourceNode): readonly string[] => {
  if (memberChain(childOf(call, 'callee')) !== 'vi.useFakeTimers') return [];
  const options = unwrapped(childrenOf(call, 'arguments')[0]);
  if (options === undefined) return VITEST_DEFAULT_FAKES;
  if (options.type !== 'ObjectExpression') return [];
  const list = childrenOf(options, 'properties').find((property) => identifierName(childOf(property, 'key')) === 'toFake');
  if (list === undefined) return VITEST_DEFAULT_FAKES;
  const names = unwrapped(childOf(list, 'value'));
  return names?.type === 'ArrayExpression' ? childrenOf(names, 'elements').flatMap((element) => { const name = literalValue(element); return typeof name === 'string' ? [name] : []; }) : [];
};

const fakedWithin = (root: SourceNode, crossCases: boolean): Set<string> => {
  const faked = new Set<string>();
  const visit = (node: SourceNode, parent: SourceNode | undefined, key: string): void => {
    if (node !== root && !crossCases && isCaseBody(node, parent, key)) return;
    if (node.type === 'CallExpression') for (const name of fakesOfCall(node)) faked.add(name);
    for (const [childKey, value] of Object.entries(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item, node, childKey);
      } else if (isNode(value)) {
        visit(value, node, childKey);
      }
    }
  };
  visit(root, undefined, 'root');
  return faked;
};

const SELF_ENDING_HOLDER = /\bexec\s+(?:\/bin\/)?sleep\s+\d/;

const isHostName = (source: ParsedSource, name: string): boolean => {
  if (source.locals.has(name)) return false;
  const binding = source.imports.get(name);
  if (binding === undefined) return true;
  const module = hostModuleOf(binding.module);
  return module === 'node:timers' || module === 'node:perf_hooks';
};

const promiseTimerOf = (source: ParsedSource, call: SourceNode): boolean => {
  const callee = unwrapped(childOf(call, 'callee'));
  const name = identifierName(callee);
  if (name === undefined) return false;
  const binding = source.imports.get(name);
  return binding !== undefined && hostModuleOf(binding.module) === 'node:timers/promises' && HOST_TIMERS.has(binding.imported);
};

const hostTimerOf = (source: ParsedSource, call: SourceNode, faked: ReadonlySet<string>): boolean => {
  const callee = unwrapped(childOf(call, 'callee'));
  const chain = memberChain(callee);
  if (chain === undefined || !HOST_TIMERS.has(chain) || faked.has(chain)) return false;
  return callee?.type === 'MemberExpression' || isHostName(source, chain);
};

const isPromiseExecutor = (node: SourceNode, parent: SourceNode | undefined, key: string): boolean =>
  parent !== undefined && parent.type === 'NewExpression' && key === 'arguments' && identifierName(childOf(parent, 'callee')) === 'Promise' && childrenOf(parent, 'arguments')[0] === node;

const isWallClockCall = (source: ParsedSource, node: SourceNode | undefined, faked: ReadonlySet<string>): boolean => {
  const plain = unwrapped(node);
  if (plain?.type !== 'CallExpression') return false;
  const chain = memberChain(childOf(plain, 'callee'));
  if (chain === undefined || !WALL_CLOCKS.has(chain)) return false;
  const owner = chain.slice(0, chain.indexOf('.'));
  return !faked.has(owner) && isHostName(source, owner);
};

const stringsOf = (node: SourceNode): string[] => {
  if (node.type === 'Literal' && typeof literalValue(node) === 'string') return [literalValue(node) as string];
  if (node.type === 'TemplateElement') {
    const value = node['value'];
    return typeof value === 'object' && value !== null && 'raw' in value && typeof value.raw === 'string' ? [value.raw] : [];
  }
  return [];
};

export const countTimeSync = (source: ParsedSource): Counts => {
  const counts: Counts = {};
  const fakeTime = FAKE_TIME.test(source.text);
  const fileFaked = fakedWithin(source.program, false);
  const visit = (node: SourceNode, parent: SourceNode | undefined, key: string, insideExecutor: boolean, outerFaked: ReadonlySet<string>): void => {
    const executor = insideExecutor || isPromiseExecutor(node, parent, key);
    const faked = isCaseBody(node, parent, key) ? new Set([...outerFaked, ...fakedWithin(node, true)]) : outerFaked;
    if (node.type === 'CallExpression' && (promiseTimerOf(source, node) || (executor && hostTimerOf(source, node, faked)))) countInto(counts, 'timer wait');
    if (node.type === 'BinaryExpression' && COMPARISONS.has(String(node['operator'])) && (isWallClockCall(source, childOf(node, 'left'), faked) || isWallClockCall(source, childOf(node, 'right'), faked))) countInto(counts, 'wall-clock reading');
    if (fakeTime && stringsOf(node).some((text) => SELF_ENDING_HOLDER.test(text))) countInto(counts, 'holder that ends by itself');
    for (const [childKey, value] of Object.entries(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item, node, childKey, executor, faked);
      } else if (isNode(value)) {
        visit(value, node, childKey, executor, faked);
      }
    }
  };
  visit(source.program, undefined, 'program', false, fileFaked);
  return counts;
};

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'fixtures']);

const filesUnder = (directory: string, accept: (name: string) => boolean): string[] =>
  fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : filesUnder(full, accept);
        return accept(entry.name) ? [full] : [];
      })
    : [];

const isSource = (name: string): boolean => /\.tsx?$/.test(name) && !name.endsWith('.generated.ts') && !name.endsWith('.d.ts');

export const testCodeFiles = (): string[] =>
  [
    ...fs.readdirSync(path.join(ROOT, 'packages')).flatMap((name) => filesUnder(path.join(ROOT, 'packages', name, 'test'), isSource)),
    ...filesUnder(path.join(ROOT, 'test'), isSource),
    ...filesUnder(path.join(ROOT, 'e2e'), isSource),
    ...filesUnder(path.join(ROOT, 'scripts'), (name) => name.endsWith('.test.ts')),
  ].sort();

export const timeSyncOfTests = (): Record<string, Counts> =>
  Object.fromEntries(
    testCodeFiles()
      .map((file) => [relativeOf(file), countTimeSync(parseSource(file))] as const)
      .filter(([, counts]) => Object.keys(counts).length > 0),
  );
