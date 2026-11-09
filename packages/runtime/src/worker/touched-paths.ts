import path from 'node:path';
import { nestedInstructionCandidates } from '@momonga/context';
import type { InstructionReader, TouchedPath } from '@momonga/context';
import { isLiveFact, pathScopeMatcherOf } from '@momonga/memory';
import type { PathScopeMatcher } from '@momonga/memory';
import type { GoverningFactView } from '@momonga/protocol';

export type TouchedEntry = { path: string; firstEventId: number };

export type TouchedCursor = { eventId: number; path: string };

export type TouchedSource = (after: TouchedCursor | null, limit: number) => Promise<readonly TouchedEntry[]>;

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const readFrom = async (
  source: TouchedSource,
  from: TouchedCursor | null,
  pageRows: number,
  visit: (page: readonly TouchedEntry[]) => void | Promise<void>,
): Promise<TouchedCursor | null> => {
  let cursor = from;
  for (;;) {
    const page = await source(cursor, pageRows);
    await visit(page);
    const last = page.at(-1);
    if (last === undefined) return cursor;
    cursor = { eventId: last.firstEventId, path: last.path };
    if (page.length < pageRows) return cursor;
    await yieldToLoop();
  }
};

export type GoverningActivation = {
  advance(facts: readonly GoverningFactView[], now: number): Promise<void>;
  witnesses(): string[];
};

export const createGoverningActivation = (options: { project: string; source: TouchedSource; pageRows: number }): GoverningActivation => {
  const { project, source, pageRows } = options;
  const matchers = new Map<string, PathScopeMatcher>();
  const tested = new Set<string>();
  const activated = new Map<string, string>();
  let watermark: TouchedCursor | null = null;
  const matcherOf = (fact: GoverningFactView): PathScopeMatcher => {
    const known = matchers.get(fact.id);
    if (known !== undefined) return known;
    if (fact.scope.level !== 'project') throw new Error(`governing fact ${fact.id} has no paths to match`);
    const created = pathScopeMatcherOf(project, fact.scope.paths);
    matchers.set(fact.id, created);
    return created;
  };
  return {
    advance: async (facts, now) => {
      const open = facts.filter(
        (fact) => fact.scope.level === 'project' && fact.scope.project === project && fact.scope.paths.length > 0 && isLiveFact(fact, now) && !activated.has(fact.id),
      );
      if (open.length === 0) return;
      const unseen = open.some((fact) => !tested.has(fact.id));
      const reached = await readFrom(source, unseen ? null : watermark, pageRows, (page) => {
        for (const entry of page) {
          for (const fact of open) if (!activated.has(fact.id) && matcherOf(fact)(entry.path)) activated.set(fact.id, entry.path);
        }
      });
      watermark = reached ?? watermark;
      for (const fact of open) tested.add(fact.id);
    },
    witnesses: () => [...activated.values()],
  };
};

export type InstructionProbes = {
  advance(): Promise<void>;
  witnesses(): TouchedPath[];
};

export const createInstructionProbes = (options: { reader: InstructionReader; projectRoot: string; source: TouchedSource; pageRows: number }): InstructionProbes => {
  const { reader, source, pageRows } = options;
  const projectRoot = path.posix.normalize(options.projectRoot).replace(/\/+$/, '');
  const probed = new Set<string>();
  const present = new Set<string>();
  let roots: readonly string[] | undefined;
  let watermark: TouchedCursor | null = null;
  const rootsOf = async (): Promise<readonly string[]> => {
    if (roots !== undefined) return roots;
    const real = await reader.realpath(projectRoot);
    if (real === undefined) throw new Error(`project root ${projectRoot} does not exist`);
    roots = [...new Set([projectRoot, real])];
    return roots;
  };
  return {
    advance: async () => {
      const known = await rootsOf();
      watermark = await readFrom(source, watermark, pageRows, async (page) => {
        for (const entry of page) {
          for (const candidate of nestedInstructionCandidates(known, projectRoot, [{ path: entry.path, kind: 'directory' }])) {
            if (probed.has(candidate)) continue;
            probed.add(candidate);
            if (await reader.exists(candidate)) present.add(candidate);
          }
        }
      });
    },
    witnesses: () => [...present].map((file): TouchedPath => ({ path: path.posix.dirname(file), kind: 'directory' })),
  };
};

export type ClaimTouched = { governing: GoverningActivation; probes: InstructionProbes };
