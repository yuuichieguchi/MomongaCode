import fs from 'node:fs';
import path from 'node:path';
import { transform } from 'esbuild';
import type { Loader } from 'esbuild';

export type ModuleGraph = ReadonlyMap<string, readonly string[]>;

type GraphInputs = Readonly<Record<string, { imports: readonly { path: string; kind: string; external?: boolean }[] }>>;

const STATIC_IMPORT = 'import-statement';

export const staticImportGraphOf = (inputs: GraphInputs): ModuleGraph =>
  new Map(
    Object.entries(inputs).map(([name, input]) => [
      name,
      input.imports.filter((imported) => imported.kind === STATIC_IMPORT && imported.external !== true && imported.path in inputs).map((imported) => imported.path),
    ]),
  );

const LOADERS: Readonly<Record<string, Loader>> = { '.ts': 'ts', '.mts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.jsx': 'jsx' };

const TOP_LEVEL_AWAIT_REFUSAL = 'Top-level await is currently not supported with the "cjs" output format';

export const hasTopLevelAwait = async (file: string): Promise<boolean> => {
  const loader = LOADERS[path.extname(file)];
  if (loader === undefined) return false;
  const text = fs.readFileSync(file, 'utf8');
  if (!/\bawait\b/.test(text)) return false;
  try {
    await transform(text, { loader, format: 'cjs', target: 'node24', logLevel: 'silent' });
    return false;
  } catch (error) {
    if (error instanceof Error && error.message.includes(TOP_LEVEL_AWAIT_REFUSAL)) return true;
    throw error;
  }
};

export const asyncModulesOf = (graph: ModuleGraph, awaiting: ReadonlySet<string>): Set<string> => {
  const importers = new Map<string, string[]>();
  for (const [importer, imported] of graph) for (const name of imported) importers.set(name, [...(importers.get(name) ?? []), importer]);
  const reached = new Set(awaiting);
  const pending = [...awaiting];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    for (const importer of importers.get(name) ?? []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      pending.push(importer);
    }
  }
  return reached;
};

export const importCyclesAmong = (graph: ModuleGraph, members: ReadonlySet<string>): string[][] => {
  const edgesOf = (name: string): string[] => (graph.get(name) ?? []).filter((imported) => members.has(imported));
  const order = new Map<string, number>();
  const lowest = new Map<string, number>();
  const stacked = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const close = (root: string): void => {
    const component: string[] = [];
    for (let name = stack.pop(); name !== undefined; name = stack.pop()) {
      stacked.delete(name);
      component.push(name);
      if (name === root) break;
    }
    if (component.length > 1 || edgesOf(root).includes(root)) cycles.push(component.sort());
  };
  for (const start of members) {
    if (order.has(start)) continue;
    const frames: { name: string; edges: string[]; next: number }[] = [];
    const open = (name: string): void => {
      order.set(name, order.size);
      lowest.set(name, order.size - 1);
      stack.push(name);
      stacked.add(name);
      frames.push({ name, edges: edgesOf(name), next: 0 });
    };
    open(start);
    for (let frame = frames.at(-1); frame !== undefined; frame = frames.at(-1)) {
      const imported = frame.edges[frame.next];
      if (imported === undefined) {
        frames.pop();
        const low = lowest.get(frame.name) as number;
        if (low === order.get(frame.name)) close(frame.name);
        const parent = frames.at(-1);
        if (parent !== undefined) lowest.set(parent.name, Math.min(lowest.get(parent.name) as number, low));
        continue;
      }
      frame.next += 1;
      if (!order.has(imported)) open(imported);
      else if (stacked.has(imported)) lowest.set(frame.name, Math.min(lowest.get(frame.name) as number, order.get(imported) as number));
    }
  }
  return cycles.sort((left, right) => (left[0] as string).localeCompare(right[0] as string));
};

export const mutuallyAwaitingCyclesOf = async (inputs: GraphInputs, root: string): Promise<string[][]> => {
  const graph = staticImportGraphOf(inputs);
  const awaiting = new Set<string>();
  for (const name of graph.keys()) if (await hasTopLevelAwait(path.join(root, name))) awaiting.add(name);
  return importCyclesAmong(graph, asyncModulesOf(graph, awaiting));
};
