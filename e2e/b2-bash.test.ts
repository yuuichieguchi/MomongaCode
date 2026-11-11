import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { skipCase, titleOf } from './support/cases.ts';
import { readDb } from './support/db.ts';
import { createE2eHome, markersOf } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { TOOL_GROUPS_SQL } from './support/ledger.ts';
import { groupAlive, hostPidOf, isAlive } from './support/process.ts';
import { createRuntimeClient, framesOfType } from './support/runtime-client.ts';
import { REFUSED_WRITE_TEXT, SANDBOX_ENDS_WITH_RUNTIME, platformSandbox, productSandbox, sandboxOrSkip } from './support/sandbox.ts';
import { DEFAULT_E2E_DEPS, startStack } from './support/stack.ts';
import { childOf } from './support/supervisor-client.ts';
import { chatCompletions, messagesOf, precedingAssistantCallId, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_MARGIN_MS, E2E_RECOVERY_BOUND_MS, E2E_RESTART_POLICY, E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const UNKNOWN_EFFECT_SENTENCE = 'The effect of the interrupted command is unknown';

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : JSON.stringify(content);

const linesOf = (file: string): string[] | undefined => {
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
};

const toolGroupsOf = (home: E2eHome): number[] =>
  readDb<{ pgid: number }>(home.paths.databases.runtime, TOOL_GROUPS_SQL).map((row) => Number(row.pgid));

const processTable = (): { pid: number; pgid: number }[] =>
  execFileSync('/bin/ps', ['-ax', '-o', 'pid=,pgid='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const [pid, pgid] = line.trim().split(/\s+/).map(Number);
      return pid === undefined || pgid === undefined || Number.isNaN(pid) || Number.isNaN(pgid) ? [] : [{ pid, pgid }];
    });

const membersOf = (pgid: number): number[] => processTable().filter((entry) => entry.pgid === pgid).map((entry) => entry.pid);

const groupOfPid = (pid: number): number | undefined => processTable().find((entry) => entry.pid === pid)?.pgid;

const innerPidIn = (file: string): number | undefined => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  return /^\d+$/.test(text) ? Number(text) : undefined;
};

const insideMemberOf = (pgid: number): number | undefined => membersOf(pgid).find((pid) => pid !== pgid);

const hostPidIn = (file: string, pgid: number): number | undefined => {
  const inner = innerPidIn(file);
  const insideMember = insideMemberOf(pgid);
  return inner === undefined || insideMember === undefined ? undefined : hostPidOf(inner, insideMember);
};

const ESCAPE_GROUP = `perl -e 'use POSIX qw(setsid); setsid(); exec "sleep", "60"'`;

const killRuntimeDuringBash = async (command: (files: { effect: string; shell: string; background: string; escaped: string }) => string, context: Parameters<typeof sandboxOrSkip>[0]) => {
  sandboxOrSkip(context);
  const home = await createE2eHome();
  const files = {
    effect: path.join(home.project, 'effect.log'),
    shell: path.join(home.project, 'shell.pid'),
    background: path.join(home.project, 'background.pid'),
    escaped: path.join(home.project, 'escaped.pid'),
  };
  const stack = await startStack({
    home,
    needsBash: true,
    deps: { ...DEFAULT_E2E_DEPS, restart: E2E_RESTART_POLICY },
    script: [toolCallReply('Bash', { command: command(files) }), textReply('done')],
  });
  const runtime = createRuntimeClient(home);
  const { session } = await runtime.createSession();
  const { run } = await runtime.createRun(session.id, 'Say hello');
  await until(() => linesOf(files.effect)?.length === 1, { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'effect.log has one line' });
  const [pgid] = await until(
    () => {
      const groups = toolGroupsOf(home);
      return groups.length > 0 ? groups : undefined;
    },
    { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'idempotency row with a pgid' },
  );
  const oldRuntimePid = childOf(await stack.client.health(), 'runtime').pid;
  if (oldRuntimePid === undefined || pgid === undefined) throw new Error('the runtime or the tool group is unknown');
  const kill = (): void => {
    process.kill(oldRuntimePid, 'SIGKILL');
  };
  const completed = async (): Promise<void> => {
    await until(async () => (await runtime.getRun(run.id)).run.status === 'WAITING_HUMAN', { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `run ${run.id} WAITING_HUMAN after recovery` });
    const pending = await runtime.approvals(run.id);
    expect(pending.map((approval) => approval.kind)).toEqual(['unknown_effect']);
    const [unknownAsk] = pending;
    if (unknownAsk === undefined) throw new Error('expected one approval about the unknown effect');
    await runtime.resolveApproval(unknownAsk.id, 'allow_once');
    await until(async () => (await runtime.getRun(run.id)).run.status === 'COMPLETED', { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `run ${run.id} COMPLETED after the answer` });
  };
  return { home, files, pgid, runId: run.id, runtime, stack, kill, completed };
};

describe('b2: Bash under the platform sandbox', () => {
  it.skipIf(skipCase('b2-seatbelt'))(titleOf('b2-seatbelt'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const outside = path.join(home.root, 'outside.txt');
    const stack = await startStack({
      home,
      needsBash: true,
      script: [toolCallReply('Bash', { command: `echo x > ${outside}; echo rc=$?` }), textReply('done')],
    });
    expect(stack.sandbox).toBe(platformSandbox());
    const runtime = createRuntimeClient(home);
    try {
      expect((await runtime.health()).sandbox).toBe(platformSandbox());
      const { session } = await runtime.createSession();
      const { run } = await runtime.createRun(session.id, 'Say hello');
      const stream = runtime.events(run.id);
      const frames = await stream.toEnd(E2E_RECOVERY_BOUND_MS);
      await stream.close();

      expect(frames.at(-1)?.data.type).toBe('run.status');
      expect(frames.at(-1)?.data.to).toBe('COMPLETED');
      expect((await runtime.getRun(run.id)).run.status).toBe('COMPLETED');

      const calls = chatCompletions(stack.fake);
      expect(calls).toHaveLength(2);
      expect(messagesOf(calls[0]).filter((message) => message.role === 'tool')).toEqual([]);
      const toolMessages = messagesOf(calls[1]).filter((message) => message.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      const assistantCallId = precedingAssistantCallId(messagesOf(calls[1]), toolMessages[0]);
      expect(assistantCallId).toMatch(/^call_[0-9a-f]{32}$/);
      expect(toolMessages[0]?.tool_call_id).toBe(assistantCallId);
      const toolText = textOf(toolMessages[0]?.content);
      expect(toolText).toContain(REFUSED_WRITE_TEXT[productSandbox()]);
      expect(toolText).toContain('rc=1');
      expect(toolText).not.toContain('rc=0');
      expect(fs.existsSync(outside)).toBe(false);
      expect(fs.existsSync(path.join(home.project, 'outside.txt'))).toBe(false);
      expect(framesOfType(frames, 'tool.reconciled')).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(skipCase('b2-recovery'))(titleOf('b2-recovery'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const effectLog = path.join(home.project, 'effect.log');
    const stack = await startStack({
      home,
      needsBash: true,
      deps: { ...DEFAULT_E2E_DEPS, restart: E2E_RESTART_POLICY },
      script: [toolCallReply('Bash', { command: `echo effect >> ${effectLog}; sleep 30` }), textReply('done')],
    });
    expect(stack.sandbox).toBe(platformSandbox());
    const runtime = createRuntimeClient(home);
    try {
      expect((await runtime.health()).sandbox).toBe(platformSandbox());
      const { session } = await runtime.createSession();
      const { run } = await runtime.createRun(session.id, 'Say hello');

      await until(() => linesOf(effectLog)?.length === 1, { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'effect.log has one line' });
      const toolGroups = await until(
        () => {
          const groups = toolGroupsOf(home);
          return groups.length > 0 ? groups : undefined;
        },
        { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'idempotency row with a pgid' },
      );
      expect(toolGroups).toHaveLength(1);
      const pgid = toolGroups[0] as number;
      expect(groupAlive(pgid)).toBe(true);
      expect(fs.readdirSync(markersOf(home).tools).length).toBeGreaterThanOrEqual(1);

      const before = await stack.client.health();
      const oldRuntimePid = childOf(before, 'runtime').pid;
      const oldGatewayPid = childOf(before, 'gateway').pid;
      if (oldRuntimePid === undefined) throw new Error('runtime has no pid');
      expect(chatCompletions(stack.fake)).toHaveLength(1);

      process.kill(oldRuntimePid, 'SIGKILL');
      if (!SANDBOX_ENDS_WITH_RUNTIME[productSandbox()]) expect(groupAlive(pgid)).toBe(true);

      await until(async () => (await runtime.getRun(run.id)).run.status === 'WAITING_HUMAN', {
        deadlineMs: E2E_RUN_COMPLETED_BOUND_MS,
        description: `run ${run.id} WAITING_HUMAN after recovery`,
      });
      expect(chatCompletions(stack.fake)).toHaveLength(1);
      const pending = await runtime.approvals(run.id);
      expect(pending.map((approval) => approval.kind)).toEqual(['unknown_effect']);
      const [unknownAsk] = pending;
      if (unknownAsk === undefined) throw new Error('expected one approval about the unknown effect');
      expect(unknownAsk.options.map((option) => option.optionId)).toEqual(['allow_once']);
      await runtime.resolveApproval(unknownAsk.id, 'allow_once');

      await until(async () => (await runtime.getRun(run.id)).run.status === 'COMPLETED', {
        deadlineMs: E2E_RUN_COMPLETED_BOUND_MS,
        description: `run ${run.id} COMPLETED after the answer`,
      });

      expect(groupAlive(pgid)).toBe(false);
      const stream = runtime.events(run.id);
      const frames = await stream.toEnd(E2E_MARGIN_MS);
      await stream.close();
      const reconciled = framesOfType(frames, 'tool.reconciled');
      expect(reconciled.map((frame) => frame.data.outcome)).toEqual(['unknown']);
      expect(frames.at(-1)?.data.to).toBe('COMPLETED');
      expect(linesOf(effectLog)).toEqual(['effect']);

      const calls = chatCompletions(stack.fake);
      expect(calls).toHaveLength(2);
      expect(messagesOf(calls[0]).filter((message) => message.role === 'tool')).toEqual([]);
      const lastMessage = messagesOf(calls[1]).at(-1);
      expect(lastMessage?.role).toBe('tool');
      const recoveredCallId = precedingAssistantCallId(messagesOf(calls[1]), lastMessage);
      expect(recoveredCallId).toMatch(/^call_[0-9a-f]{32}$/);
      expect(lastMessage?.tool_call_id).toBe(recoveredCallId);
      expect(reconciled[0]?.data.callId).toBe(recoveredCallId);
      expect(textOf(lastMessage?.content)).toContain(UNKNOWN_EFFECT_SENTENCE);
      expect(fs.readdirSync(markersOf(home).tools)).toEqual([]);

      const after = await stack.client.health();
      const runtimeAfter = childOf(after, 'runtime');
      expect(runtimeAfter.restarts).toBe(1);
      expect(runtimeAfter.pid).not.toBe(oldRuntimePid);
      expect(childOf(after, 'gateway').pid).toBe(oldGatewayPid);
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(skipCase('b2-reap-group'))(titleOf('b2-reap-group'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    const killed = await killRuntimeDuringBash(
      (files) => `echo $$ > ${files.shell}; sleep 60 & echo $! > ${files.background}; echo effect >> ${files.effect}; sleep 60`,
      context,
    );
    try {
      const shell = await until(() => hostPidIn(killed.files.shell, killed.pgid), { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the host pid of the shell' });
      const background = await until(() => hostPidIn(killed.files.background, killed.pgid), { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the host pid of the background sleep' });
      const members = membersOf(killed.pgid);
      expect(members).toEqual(expect.arrayContaining([shell, background]));
      expect(members.length).toBeGreaterThanOrEqual(3);

      killed.kill();
      await killed.completed();

      expect(groupAlive(killed.pgid)).toBe(false);
      expect(membersOf(killed.pgid)).toEqual([]);
      for (const pid of members) expect(isAlive(pid)).toBe(false);
      expect(linesOf(killed.files.effect)).toEqual(['effect']);
    } finally {
      await killed.runtime.close();
    }
  });

  it.skipIf(skipCase('b2-reap-escapee'))(titleOf('b2-reap-escapee'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    const killed = await killRuntimeDuringBash(
      (files) => `${ESCAPE_GROUP} & echo $! > ${files.escaped}; echo effect >> ${files.effect}; sleep 60`,
      context,
    );
    try {
      const escaped = await until(() => hostPidIn(killed.files.escaped, killed.pgid), { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the host pid of the escaping process' });
      await until(() => groupOfPid(escaped) === escaped, { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the escaping process leading a group of its own' });
      expect(isAlive(escaped)).toBe(true);
      expect(membersOf(killed.pgid)).not.toContain(escaped);

      killed.kill();
      await killed.completed();

      expect(groupAlive(killed.pgid)).toBe(false);
      expect(isAlive(escaped)).toBe(false);
    } finally {
      await killed.runtime.close();
    }
  });

  it.skipIf(skipCase('b2-reap-escapee-dropped'))(titleOf('b2-reap-escapee-dropped'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    const killed = await killRuntimeDuringBash(
      (files) => `(exec 3>&-; exec ${ESCAPE_GROUP}) & echo $! > ${files.escaped}; echo effect >> ${files.effect}; sleep 60`,
      context,
    );
    let escaped: number | undefined;
    try {
      escaped = await until(() => hostPidIn(killed.files.escaped, killed.pgid), { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the host pid of the escaping process' });
      await until(() => groupOfPid(escaped as number) === escaped, { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the escaping process leading a group of its own' });

      killed.kill();
      await killed.completed();

      expect(groupAlive(killed.pgid)).toBe(false);
      expect(isAlive(escaped)).toBe(!SANDBOX_ENDS_WITH_RUNTIME[productSandbox()]);
    } finally {
      if (escaped !== undefined && isAlive(escaped)) process.kill(escaped, 'SIGKILL');
      await killed.runtime.close();
    }
  });
});
