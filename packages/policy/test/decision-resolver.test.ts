import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { askedBy, decide } from '@momonga/policy';
import type { Decision, PermissionRule, PermissionSubject, PolicyFilesystem, PolicyHostPorts, PolicyTool } from '@momonga/policy';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, ruleIn, touch } from './helpers.ts';
import type { Layout } from './helpers.ts';

const READ: PolicyTool = { name: 'Read', kind: 'read', sideEffect: 'read_only' };
const EDIT: PolicyTool = { name: 'Edit', kind: 'edit', sideEffect: 'write', subjectKind: 'path' };
const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' };

const RESOLVING = ['canonicalise', 'volumeProbe', 'locate'] as const;

type Counts = Record<(typeof RESOLVING)[number], Map<string, number>>;

const counting = (base: PolicyFilesystem): { fs: PolicyFilesystem; counts: Counts } => {
  const counts: Counts = { canonicalise: new Map(), volumeProbe: new Map(), locate: new Map() };
  const counted = (port: (typeof RESOLVING)[number], absolute: string): void => {
    counts[port].set(absolute, (counts[port].get(absolute) ?? 0) + 1);
  };
  return {
    counts,
    fs: {
      ...base,
      canonicalise: (absolute) => {
        counted('canonicalise', absolute);
        return base.canonicalise(absolute);
      },
      volumeProbe: (directory) => {
        counted('volumeProbe', directory);
        return base.volumeProbe(directory);
      },
      locate: (absolute) => {
        counted('locate', absolute);
        return base.locate(absolute);
      },
    },
  };
};

const repeated = (counts: Counts): string[] => RESOLVING.flatMap((port) => [...counts[port]].filter(([, count]) => count > 1).map(([absolute, count]) => `${port} ${absolute} x${count}`));

const rulesNaming = (layout: Layout, count: number): PermissionRule[] =>
  Array.from({ length: count }, (_unused, index) => [
    ruleIn(layout)('allow', `Read(./dir/keep-${index}/**)`),
    ruleIn(layout)('ask', `Edit(./dir/ask-${index}/**)`),
    ruleIn(layout)('deny', `Read(./dir/deny-${index}/**)`),
  ]).flat();

type Case = { label: string; tool: PolicyTool; subject: (file: string) => PermissionSubject };

const CASES: Case[] = [
  { label: 'a read that names one path three times', tool: READ, subject: (file) => ({ kind: 'path', tool: 'Read', paths: [file, file, file], access: 'read' }) },
  { label: 'an edit that names one path twice', tool: EDIT, subject: (file) => ({ kind: 'path', tool: 'Edit', paths: [file, file], access: 'write' }) },
  { label: 'a command that reads one path three times and writes it once', tool: BASH, subject: (file) => ({ kind: 'command', tool: 'Bash', command: `cat ${file} ${file} && cat ${file} > ${file}` }) },
];

describe('P-R1: a decision resolves each distinct path once', () => {
  for (const c of CASES) {
    it.each([0, 1, 4, 12])(`${c.label} against %i rule groups asks each resolving port at most once per path`, async (groups) => {
      const layout = makeLayout();
      const file = touch(path.join(layout.project, 'dir', 'f.txt'));
      const rules = rulesNaming(layout, groups);
      const { fs, counts } = counting(fakeFs());
      const fileRules = await fileRulesFor(rules, [layout.project]);
      const decision = await decide({
        tool: c.tool,
        subject: c.subject(file),
        mode: 'manual',
        rules,
        roots: [layout.project],
        home: layout.home,
        cwd: layout.project,
        fs,
        searchPath: TEST_SEARCH_PATH,
        isWritable: isWritableFor([layout.project]),
        protectedSet: EMPTY_PROTECTED_SET,
        fileRules,
      });
      expect(['allow', 'ask', 'deny']).toContain(decision.kind);
      expect(RESOLVING.reduce((total, port) => total + counts[port].size, 0)).toBeGreaterThan(0);
      expect(repeated(counts)).toEqual([]);
    });
  }
});

const neverAnswers = <T>(): Promise<T> => new Promise<T>(() => undefined);

const stalledHost = (asked: string[]): PolicyHostPorts => {
  const stall =
    (port: string) =>
    <T>(): Promise<T> => {
      asked.push(port);
      return neverAnswers<T>();
    };
  return {
    platform: process.platform,
    canonicalise: stall('canonicalise'),
    volumeProbe: stall('volumeProbe'),
    locate: stall('locate'),
    resolveProgram: stall('resolveProgram'),
    readEntry: stall('readEntry'),
    readNoFollow: stall('readNoFollow'),
    readHead: stall('readHead'),
    isSearchable: stall('isSearchable'),
    gitlinks: stall('gitlinks'),
    configPrograms: stall('configPrograms'),
  };
};

describe('a file system that never answers', () => {
  it.each(CASES)('$label: the loop keeps turning, and decide rejects with the reason of the signal and gives no decision', async (c) => {
    const layout = makeLayout();
    const file = touch(path.join(layout.project, 'dir', 'f.txt'));
    const asked: string[] = [];
    const controller = new AbortController();
    const fileRules = await fileRulesFor([], [layout.project]);
    const settled: Array<{ decision: Decision } | { error: unknown }> = [];
    const pending = decide({
      tool: c.tool,
      subject: c.subject(file),
      mode: 'manual',
      rules: [],
      roots: [layout.project],
      home: layout.home,
      cwd: layout.project,
      fs: { ...askedBy(stalledHost(asked), controller.signal), expandGlob: () => ({ matches: [] }) },
      searchPath: TEST_SEARCH_PATH,
      isWritable: isWritableFor([layout.project]),
      protectedSet: EMPTY_PROTECTED_SET,
      fileRules,
    }).then(
      (decision) => settled.push({ decision }),
      (error: unknown) => settled.push({ error }),
    );
    const timerFired = await new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 0));
    expect(timerFired).toBe(true);
    expect(asked.length).toBeGreaterThan(0);
    expect(settled).toEqual([]);
    const reason = new Error('the asker gave up');
    controller.abort(reason);
    await pending;
    expect(settled).toEqual([{ error: reason }]);
  });
});
