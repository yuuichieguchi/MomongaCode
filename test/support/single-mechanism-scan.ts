import { calleeName, childOf, countInto, hostModuleOf, identifierName, memberChain, unwrapped } from './source-scan.ts';
import type { Counts, ParsedSource, SourceNode } from './source-scan.ts';

const LOOPS = new Set(['WhileStatement', 'DoWhileStatement', 'ForStatement']);

const WAITS = new Set(['sleep', 'setTimeout']);

const CLOCK_CALLS = new Set(['now', 'monotonicMs', 'remainingMs', 'hrtime']);

const CLOCK_READS = new Set(['expired']);

const RENAMES = new Set(['rename', 'renameSync']);

const importedNameOf = (source: ParsedSource, call: SourceNode): string | undefined => {
  const binding = source.imports.get(identifierName(unwrapped(childOf(call, 'callee'))) ?? '');
  return binding !== undefined && hostModuleOf(binding.module) !== undefined ? binding.imported : undefined;
};

const calledName = (source: ParsedSource, call: SourceNode): string | undefined => importedNameOf(source, call) ?? calleeName(call);

const within = (outer: SourceNode, inner: SourceNode): boolean => outer.start <= inner.start && inner.end <= outer.end;

const waitsAndReadsTheClock = (source: ParsedSource, loop: SourceNode): boolean => {
  const inside = source.nodes.map(({ node }) => node).filter((node) => within(loop, node));
  const waits = inside.some((node) => node.type === 'CallExpression' && WAITS.has(calledName(source, node) ?? ''));
  const readsTheClock = inside.some((node) => {
    if (node.type === 'CallExpression') return CLOCK_CALLS.has(calledName(source, node) ?? '');
    if (node.type !== 'MemberExpression') return false;
    const chain = memberChain(node);
    return chain !== undefined && CLOCK_READS.has(chain.slice(chain.lastIndexOf('.') + 1));
  });
  return waits && readsTheClock;
};

export const countDeadlineLoops = (source: ParsedSource): Counts => {
  const counts: Counts = {};
  const loops = source.nodes.map(({ node }) => node).filter((node) => LOOPS.has(node.type) && waitsAndReadsTheClock(source, node));
  for (const loop of loops) {
    if (!loops.some((other) => other !== loop && within(other, loop))) countInto(counts, 'deadline loop');
  }
  return counts;
};

export const countRenames = (source: ParsedSource): Counts => {
  const counts: Counts = {};
  for (const { node } of source.nodes) {
    const name = node.type === 'CallExpression' ? calledName(source, node) : undefined;
    if (name !== undefined && RENAMES.has(name)) countInto(counts, name);
  }
  return counts;
};
