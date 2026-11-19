import { describe, expect, it, vi } from 'vitest';
import { countDeadlineLoops, countRenames } from './support/single-mechanism-scan.ts';
import { parseSource, perFile, productSources, relativeOf } from './support/source-scan.ts';
import type { Counts, ParsedSource } from './support/source-scan.ts';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const counted = (text: string, count: (source: ParsedSource) => Counts): Counts => count(parseSource('sample.ts', text));

const THE_ONE_WAIT: Readonly<Record<string, string>> = {
  'packages/foundation/src/wait-until.ts': 'waitUntil: the one loop that probes, reads the clock and sleeps',
};

const THE_ONE_PUBLISH: Readonly<Record<string, string>> = {
  'packages/foundation/src/atomic-file.ts': 'the one atomic write: the rename that publishes a finished temporary file',
  'packages/foundation/src/node-file-system.ts': 'the one production FileSystem adapter: the rename of the port',
  'packages/foundation/src/rotating-log.ts': 'rotation of a log file, which publishes nothing: the file keeps its content and changes its name',
};

const PRESENT_DEADLINE_LOOPS: Readonly<Record<string, Counts>> = {
  'packages/cli/src/client/runtime-client.ts': { 'deadline loop': 1 },
  'packages/cli/src/daemon/generations.ts': { 'deadline loop': 1 },
  'packages/cli/src/poll.ts': { 'deadline loop': 1 },
  'packages/gateway/src/core/retry.ts': { 'deadline loop': 1 },
  'packages/gateway/src/plan/refresh.ts': { 'deadline loop': 1 },
  'packages/gateway/src/plan/revoke.ts': { 'deadline loop': 1 },
  'packages/gateway/src/probe/run-probe.ts': { 'deadline loop': 1 },
  'packages/runtime/src/process/background-jobs.ts': { 'deadline loop': 1 },
};

const PRESENT_RENAMES: Readonly<Record<string, Counts>> = {
  'packages/cli/src/history-store.ts': { 'rename': 1 },
  'packages/foundation/src/platform/bundled-executable.ts': { 'rename': 1 },
  'packages/foundation/src/platform/replace-executable.ts': { 'rename': 4 },
  'packages/sandbox/src/placeholder-journal.ts': { 'rename': 1 },
  'packages/tools/src/ripgrep-distribution.ts': { 'rename': 2 },
  'packages/verify/src/z3-distribution.ts': { 'rename': 1 },
};

const ACCOUNT_RENAMES: Readonly<Record<string, { counts: Counts; reason: string }>> = {
  'packages/cli/src/tui/backend.ts': { counts: { 'rename': 1 }, reason: 'the backend passes the /login account rename to the gateway client: it renames a plan account, no file' },
  'packages/cli/src/tui/plan-flows.ts': { counts: { 'rename': 2 }, reason: 'the /login picker renames a plan account and renames it back when its connection cannot be pointed to it: no file' },
  'packages/gateway/src/plan/api.ts': { counts: { 'rename': 1 }, reason: 'the accountRename route renames a plan account in the plan sessions: no file' },
};

const PRESENT_CALLS_NAMED_RENAME: Readonly<Record<string, Counts>> = {
  ...PRESENT_RENAMES,
  ...Object.fromEntries(Object.entries(ACCOUNT_RENAMES).map(([file, { counts }]) => [file, counts])),
};

const outside = (table: Readonly<Record<string, string>>): string[] => productSources().filter((file) => !(relativeOf(file) in table));

describe('one wait: a loop that sleeps until a deadline is waitUntil', () => {
  it('finds a loop that both waits and reads the clock, whatever form the loop and the wait take', () => {
    expect(counted('for (;;) {\n  if (await probe()) break;\n  if (timing.now() >= deadline) throw new Error();\n  await timing.sleep(5);\n}', countDeadlineLoops)).toEqual({ 'deadline loop': 1 });
    expect(counted('while (clock.monotonicMs() < end) {\n  await sleep(timing, 5, signal);\n}', countDeadlineLoops)).toEqual({ 'deadline loop': 1 });
    expect(counted('do {\n  await new Promise((done) => timing.setTimeout(done, wait));\n} while (!deadline.expired);', countDeadlineLoops)).toEqual({ 'deadline loop': 1 });
    expect(counted("import { setTimeout as delay } from 'node:timers/promises';\nwhile (Date.now() < end) {\n  await delay(5);\n}", countDeadlineLoops)).toEqual({ 'deadline loop': 1 });
  });

  it('counts nested loops once, and no loop that only waits or only reads the clock', () => {
    expect(counted('for (;;) {\n  while (timing.now() < end) await timing.sleep(5);\n}', countDeadlineLoops)).toEqual({ 'deadline loop': 1 });
    expect(counted('for (const item of items) {\n  await timing.sleep(timing.now());\n}', countDeadlineLoops)).toEqual({});
    expect(counted('while (queue.length > 0) {\n  await timing.sleep(5);\n}\nwhile (timing.now() < end) step();', countDeadlineLoops)).toEqual({});
  });

  it('keeps the loop only in the one wait, apart from the listed present loops', () => {
    expect(perFile(outside(THE_ONE_WAIT), countDeadlineLoops)).toEqual(PRESENT_DEADLINE_LOOPS);
  });
});

describe('one atomic write: a rename publishes a file only in writeFileAtomically', () => {
  it('finds a rename on any object and under any name it is imported by', () => {
    expect(counted('await files.rename(a, b);\nfs.renameSync(a, b);', countRenames)).toEqual({ rename: 1, renameSync: 1 });
    expect(counted("import { rename as move } from 'node:fs/promises';\nawait move(a, b);", countRenames)).toEqual({ rename: 1 });
    expect(counted('interface Files {\n  rename(from: string, to: string): Promise<void>;\n}\nconst renamed = rename;', countRenames)).toEqual({});
  });

  it('keeps the rename only in the one atomic write, apart from the listed present renames and the plan account renames, which move no file', () => {
    expect(perFile(outside(THE_ONE_PUBLISH), countRenames)).toEqual(PRESENT_CALLS_NAMED_RENAME);
  });

  it('gives every permitted file its reason', () => {
    expect([...Object.values(THE_ONE_WAIT), ...Object.values(THE_ONE_PUBLISH)].filter((reason) => reason.trim() === '')).toEqual([]);
  });
});
