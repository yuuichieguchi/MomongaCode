import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect } from 'vitest';
import { killGroupsForCleanup, killPidsForCleanup } from '@momonga/testkit';
import { createSeatbeltSandbox } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import { buildSandboxPolicy, createBuiltinTools } from '@momonga/tools';
import type { BatchInput, CallOutcome, NeedsApprovalOutcome, ResultOutcome, ToolSet } from '@momonga/tools';
import type { PermissionRule } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { call, makeHarness, toolSetOf } from '../harness.ts';

export const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export const RG_BIN = '/opt/homebrew/bin/rg';
export const RG_PATH = `${path.dirname(RG_BIN)}:${BASE_PATH}`;
export const BASE_ENV = { PATH: BASE_PATH, LANG: 'C' };

const trackedGroups = new Set<number>();
const trackedPids = new Set<number>();
const cleanups: Array<() => void> = [];

afterEach(async () => {
  const groups = [...trackedGroups];
  trackedGroups.clear();
  try {
    await killGroupsForCleanup(groups);
  } finally {
    const pids = [...trackedPids];
    trackedPids.clear();
    killPidsForCleanup(pids);
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  }
});

export const trackGroup = (pgid: number): void => void trackedGroups.add(pgid);
export const trackPid = (pid: number): void => void trackedPids.add(pid);
export const onCleanup = (cleanup: () => void): void => void cleanups.push(cleanup);

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export const catN = (lines: readonly string[], start = 1): string =>
  lines.map((line, index) => `${String(start + index).padStart(6)}\t${line}`).join('\n');

export const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index);

export const isAlive = (target: number): boolean => {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const waitFor = async (condition: () => boolean, timeoutMs = 5000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
};

export const resultOf = (outcome: CallOutcome | undefined): ResultOutcome['result'] => {
  expect(outcome?.kind).toBe('result');
  return (outcome as ResultOutcome).result;
};

export const approvalOf = (outcome: CallOutcome | undefined): NeedsApprovalOutcome => {
  expect(outcome?.kind).toBe('needs_approval');
  return outcome as NeedsApprovalOutcome;
};

export type RunExtra = Partial<BatchInput> & { mode?: PermissionMode; rules?: PermissionRule[] };

export type Builtins = Awaited<ReturnType<typeof makeBuiltins>>;

export const makeBuiltins = async (options: { maxInlineOutputChars?: number; realSandbox?: boolean } = {}) => {
  const harness = makeHarness(options.maxInlineOutputChars === undefined ? {} : { maxInlineOutputChars: options.maxInlineOutputChars });
  const { layout } = harness;
  const tmpDir = path.join(layout.root, 'tmp');
  const sandboxTmpRoot = path.join(layout.root, 'sandbox-tmp');
  fs.mkdirSync(tmpDir);
  fs.mkdirSync(sandboxTmpRoot);
  const toolSet: ToolSet = await toolSetOf(...createBuiltinTools());
  const sandboxPolicy: SandboxPolicy = buildSandboxPolicy({ roots: [layout.project], home: layout.home, tmpDir });
  const sandbox: Sandbox | undefined = options.realSandbox === true ? createSeatbeltSandbox({ tmpRoot: sandboxTmpRoot, killGraceMs: 300 }) : undefined;
  let counter = 0;
  const nextCallId = (): string => {
    counter += 1;
    return `call-${counter}`;
  };
  const batch = (name: string, args: unknown, extra: RunExtra = {}, approval?: 'allow_once' | 'allow_always', callId = nextCallId()): BatchInput =>
    harness.input(toolSet, [call(callId, name, args, approval)], {
      env: BASE_ENV,
      sandboxPolicy,
      ...(sandbox === undefined ? {} : { sandbox }),
      ...extra,
    });
  const run = async (
    name: string,
    args: unknown,
    extra: RunExtra = {},
    approval?: 'allow_once' | 'allow_always',
    callId?: string,
  ): Promise<CallOutcome | undefined> => {
    const [outcome] = await harness.executor.runBatch(batch(name, args, extra, approval, callId));
    for (const entry of harness.idempotency.log) if (entry.op === 'attachProcess') trackGroup(entry.pgid);
    return outcome;
  };
  const write = (relative: string, content: string | Buffer): string => {
    const target = path.join(layout.project, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  const markRead = (target: string): void => {
    harness.session.readLedger.set(target, { sha256: sha256(fs.readFileSync(target)), mtimeMs: fs.statSync(target).mtimeMs });
  };
  return { ...harness, toolSet, sandboxPolicy, sandbox, tmpDir, run, batch, write, markRead, nextCallId };
};
