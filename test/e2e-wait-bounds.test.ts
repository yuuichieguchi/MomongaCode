import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { underivedE2eWaits, underivedWaitsOf, waitParametersOf } from './support/e2e-wait-scan.ts';
import { ROOT, parseSource } from './support/source-scan.ts';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

type Kept = { readonly waits: number; readonly reason: string };

const KEPT: Readonly<Record<string, Kept>> = {
  'e2e/support/cli.test.ts': { waits: 1, reason: 'the subject is the bound of the CLI helper itself: it counts from when the test waits for the result, not from the start' },
  'e2e/support/log-reader.test.ts': { waits: 3, reason: 'the subject is the bound of untilRecord against a log file the case writes itself, in process' },
  'e2e/support/process.test.ts': { waits: 2, reason: 'the subject is the bound of untilProcessesEnded against fake liveness ports' },
  'e2e/support/pty-session.test.ts': { waits: 16, reason: 'the subject is the session helper against in-process streams; no host process is waited on' },
  'e2e/support/wait.test.ts': { waits: 7, reason: 'the subject is until and withinBound themselves, driven by in-process predicates and promises' },
};

const countsOf = (files: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const file of files) counts[file] = (counts[file] ?? 0) + 1;
  return counts;
};

const HELPERS = [
  'export type Stream = { toEnd(deadlineMs: number): Promise<void>; until(match: () => boolean, deadlineMs: number): Promise<void> };',
  'export type Client = { untilChild: (role: string, match: () => boolean, deadlineMs: number) => Promise<void> };',
  'export const withinBound = <T>(promise: Promise<T>, boundMs: number, describe: string): Promise<T> => promise;',
  'export function untilStatus(id: string, status: string, statusDeadlineMs: number): void {}',
  'export const restartWith = (baseMs: number, idleTimeoutMs: number): void => undefined;',
].join('\n');

const parameters = waitParametersOf([{ file: path.join(ROOT, 'e2e', 'support', 'sample.ts'), text: HELPERS }]);

const boundsIn = (text: string): string[] => underivedWaitsOf(parseSource(path.join(ROOT, 'e2e', 'sample.test.ts'), text), parameters).map((wait) => wait.bound);

describe('every wait of the e2e project is bounded by a bound derived from the product', () => {
  it('takes every parameter of a helper named as a deadline, a bound or a timeout as the bound of a wait, and no other', () => {
    expect(Object.fromEntries([...parameters].map(([name, indexes]) => [name, [...indexes]]))).toEqual({ toEnd: [0], until: [1], untilChild: [2], withinBound: [1], untilStatus: [2] });
  });

  it('finds a number or a slack constant standing alone as the bound of a wait', () => {
    const text = [
      "import { STARTUP_TIMEOUT_MS } from '@momonga/supervisor';",
      "import { CLEANUP_KILL_DEADLINE_MS } from '@momonga/testkit';",
      'const MARGIN_MS = 4000;',
      'const DERIVED_MS = STARTUP_TIMEOUT_MS + MARGIN_MS;',
      "await until(check, { deadlineMs: MARGIN_MS, description: 'a' });",
      "await until(check, { deadlineMs: 2 * MARGIN_MS, description: 'b' });",
      "await until(check, { deadlineMs: DERIVED_MS, description: 'c' });",
      'await stream.toEnd(5000);',
      'await stream.toEnd(DERIVED_MS);',
      'await stream.until(match, MARGIN_MS);',
      'await client.untilChild(role, match, 1000);',
      "await withinBound(work, MARGIN_MS, 'd');",
      "untilStatus(id, 'COMPLETED', 3000);",
      "await fake.waitForRequest({ timeoutMs: MARGIN_MS, description: 'g' });",
      'restartWith(200, 100);',
      "await untilProcessesEnded(pids, { deadlineMs: CLEANUP_KILL_DEADLINE_MS, description: 'f' });",
      'const helper = async (deadlineMs: number) => until(check, { deadlineMs, description: "e" });',
      'const extended = (extraBoundMs = 0) => until(check, { deadlineMs: DERIVED_MS + extraBoundMs, description: "h" });',
      'const defaulted = async (id: string, deadlineMs = MARGIN_MS) => until(check, { deadlineMs, description: id });',
    ].join('\n');
    expect(boundsIn(text)).toEqual(['MARGIN_MS', '2 * MARGIN_MS', '5000', 'MARGIN_MS', '1000', 'MARGIN_MS', '3000', 'MARGIN_MS', 'CLEANUP_KILL_DEADLINE_MS', 'MARGIN_MS']);
  });

  it('holds in every file of the e2e project but the self-tests of the wait helpers, whose subject is the bound itself', () => {
    const waits = underivedE2eWaits();
    expect(waits.filter((wait) => KEPT[wait.file] === undefined)).toEqual([]);
    expect(countsOf(waits.map((wait) => wait.file))).toEqual(Object.fromEntries(Object.entries(KEPT).map(([file, kept]) => [file, kept.waits])));
  });
});
