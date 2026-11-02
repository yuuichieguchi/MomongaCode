import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeFm } from '@momonga/testkit';
import type { FakeScriptedReply } from '@momonga/testkit';
import { titleOf } from './support/cases.ts';
import { runCli, startCli } from './support/cli.ts';
import { readDb } from './support/db.ts';
import { supervisorLog } from './support/log-reader.ts';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { baseSettings, sandboxChoiceOf, startStack, startUpstream, writeSettingsFile } from './support/stack.ts';
import { chatCompletions, hangReply, messagesOf, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_MARGIN_MS, E2E_RECOVERY_BOUND_MS, E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const ORIGINAL = 'greeting = "hello"\n';
const EDITED = 'greeting = "hello, momonga"\n';
const FINAL_TEXT = 'Updated the greeting in config.toml.';

type Prepared = { home: E2eHome; project: string; target: string; fake: Awaited<ReturnType<typeof startUpstream>> };

const prepare = async (script: (target: string, project: string) => FakeScriptedReply[]): Promise<Prepared> => {
  const home = await createE2eHome();
  const project = fs.realpathSync.native(home.project);
  const target = path.join(project, 'config.toml');
  fs.writeFileSync(target, ORIGINAL);
  const fake = await startUpstream(home, { home, script: script(target, project) });
  writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));
  return { home, project, target, fake };
};

const editTask = (target: string, project: string): FakeScriptedReply[] => [
  toolCallReply('Glob', { pattern: '*.toml', path: project }, 'call_glob'),
  toolCallReply('Read', { file_path: target }, 'call_read'),
  toolCallReply('Edit', { file_path: target, old_string: '"hello"', new_string: '"hello, momonga"' }, 'call_edit'),
  textReply(FINAL_TEXT),
];

const jsonLines = (text: string): Record<string, unknown>[] =>
  text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`not a JSON object line: ${line}`);
      return Object.fromEntries(Object.entries(parsed));
    });

const pidOfRole = async (home: E2eHome, role: 'gateway' | 'runtime'): Promise<number | undefined> => {
  const status = await runCli(home, ['daemon', 'status']);
  const match = new RegExp(`${role}: ready \\(pid (\\d+)\\)`).exec(status.stdout);
  return match === null ? undefined : Number(match[1]);
};

describe('cli: momonga -p', () => {
  it(titleOf('cli-print'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, target, fake } = await prepare(editTask);

    const result = await runCli(home, ['-p', 'Update the greeting', '--permission-mode', 'acceptEdits']);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${FINAL_TEXT}\n`);
    expect(fs.readFileSync(target, 'utf8')).toBe(EDITED);
    const calls = chatCompletions(fake);
    expect(calls).toHaveLength(4);
    expect(messagesOf(calls[3]).filter((message) => message.role === 'tool')).toHaveLength(3);
  });

  it(titleOf('cli-formats'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, target } = await prepare(editTask);

    const json = await runCli(home, ['-p', 'Update the greeting', '--permission-mode', 'acceptEdits', '--output-format', 'json']);
    expect(json.code).toBe(0);
    const [result, ...extra] = jsonLines(json.stdout);
    expect(extra).toEqual([]);
    expect(result).toMatchObject({ type: 'result', subtype: 'success', is_error: false, result: FINAL_TEXT, status: 'COMPLETED', num_turns: 4 });
    expect(fs.readFileSync(target, 'utf8')).toBe(EDITED);
  });

  it('stream-json prints the init line, every run event in order and the result', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepare(editTask);

    const streamed = await runCli(home, ['-p', 'Update the greeting', '--permission-mode', 'acceptEdits', '--output-format', 'stream-json']);

    expect(streamed.code).toBe(0);
    const lines = jsonLines(streamed.stdout);
    expect(lines[0]).toMatchObject({ type: 'system', subtype: 'init', permission_mode: 'acceptEdits' });
    expect(lines.at(-1)).toMatchObject({ type: 'result', subtype: 'success', result: FINAL_TEXT });
    const events = lines.slice(1, -1);
    const sequence = events.map((event) => event['seq']);
    expect(sequence).toEqual(sequence.map((_, index) => index + 1));
    expect(events.filter((event) => event['type'] === 'tool.completed')).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: 'run.status', to: 'COMPLETED' });
  });

  it(titleOf('cli-approve'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, target } = await prepare(editTask);

    const running = startCli(home, ['-p', 'Update the greeting']);
    const listed = await until(
      async () => {
        const result = await runCli(home, ['approve']);
        return /^\S+\s+Edit /m.test(result.stdout) ? result : undefined;
      },
      { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'a pending Edit approval to be listed by momonga approve' },
    );
    const approvalId = listed.stdout.split('\n')[0]?.split(/\s+/)[0] ?? '';
    expect(approvalId).not.toBe('');
    for (const kind of ['allow_once', 'allow_always', 'reject_once', 'reject_always']) expect(listed.stdout).toContain(kind);
    expect(fs.readFileSync(target, 'utf8')).toBe(ORIGINAL);

    const resolved = await runCli(home, ['approve', approvalId, 'allow_once']);
    expect(resolved.code).toBe(0);
    expect(resolved.stdout).toContain('resolved: allow_once');

    const finished = await running.result;
    expect(finished.code).toBe(0);
    expect(finished.stdout).toBe(`${FINAL_TEXT}\n`);
    expect(finished.stderr).toContain(`momonga approve ${approvalId} allow_once`);
    expect(fs.readFileSync(target, 'utf8')).toBe(EDITED);
  });

  it(titleOf('cli-cancel'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepare(() => [hangReply('thinking about it')]);

    const running = startCli(home, ['-p', 'Take your time']);
    await until(() => chatCompletions(fake).length > 0, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the upstream to receive the request' });
    const cancelled = await runCli(home, ['cancel']);
    expect(cancelled.code).toBe(0);
    expect(cancelled.stdout).toMatch(/cancelling run|already CANCELLED/);

    const finished = await running.result;
    expect(finished.code).toBe(130);
    expect(finished.stderr).toContain('CANCELLED');
  });

  it(titleOf('cli-attach'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepare(editTask);
    const first = await runCli(home, ['-p', 'Update the greeting', '--permission-mode', 'acceptEdits', '--output-format', 'stream-json']);
    const events = jsonLines(first.stdout).slice(1, -1);
    const runId = String(events[0]?.['runId']);

    const replay = await runCli(home, ['attach', runId]);
    expect(replay.code).toBe(0);
    expect(replay.stdout).toBe(`${FINAL_TEXT}\n`);

    const latest = await runCli(home, ['attach', '--output-format', 'stream-json']);
    expect(jsonLines(latest.stdout).filter((line) => line['type'] !== 'result').map((line) => line['seq'])).toEqual(events.map((event) => event['seq']));

    const seen = events.length - 2;
    const tail = await runCli(home, ['attach', runId, '--after', String(seen), '--output-format', 'stream-json']);
    expect(jsonLines(tail.stdout).filter((line) => line['type'] !== 'result').map((line) => line['seq'])).toEqual(events.slice(seen).map((event) => event['seq']));

    const trace = await runCli(home, ['trace']);
    expect(trace.stderr).toBe('');
    expect(trace.code).toBe(0);
    expect(trace.stdout).toContain(`run ${runId}: `);
    expect(trace.stdout).toMatch(/4 model calls, 3 tool calls/);
    const traceJson = jsonLines((await runCli(home, ['trace', runId, '--json'])).stdout)[0];
    expect(traceJson).toMatchObject({ runId, summary: { toolCalls: 3 }, usage: { total: { total_tokens: 60 } } });
  });

  it(titleOf('cli-interrupt'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepare(() => [hangReply('thinking about it')]);

    const running = startCli(home, ['-p', 'Take your time']);
    await until(() => chatCompletions(fake).length > 0, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the upstream to receive the request' });
    running.interrupt();

    const finished = await running.result;
    expect(finished.code).toBe(130);
    expect(finished.stderr).toContain('CANCELLED');
    const [row] = readDb<{ status: string }>(home.paths.databases.runtime, 'SELECT status FROM runs');
    expect(row?.status).toBe('CANCELLED');
  });

  it(titleOf('cli-race'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepare(() => [textReply('one'), textReply('two')]);

    const [first, second] = await Promise.all([runCli(home, ['-p', 'a']), runCli(home, ['-p', 'b'])]);

    expect([first.code, second.code]).toEqual([0, 0]);
    expect([first.stdout, second.stdout].sort()).toEqual(['one\n', 'two\n']);
    const supervisorPid = Number(/pid (\d+)/.exec((await runCli(home, ['daemon', 'status'])).stdout)?.[1]);
    const spawns = supervisorLog(home.paths, supervisorPid).filter((record) => record.msg === 'child.spawn');
    expect(spawns.map((record) => record['child']).sort()).toEqual(['gateway', 'runtime']);
  });

  it(titleOf('cli-daemon'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepare(() => [textReply('first'), textReply('second')]);

    const idle = await runCli(home, ['daemon', 'status']);
    expect(idle.code).toBe(1);
    expect(idle.stdout).toBe('momonga daemon is not running\n');

    expect((await runCli(home, ['-p', 'one'])).stdout).toBe('first\n');
    const running = await runCli(home, ['daemon', 'status']);
    expect(running.code).toBe(0);
    expect(running.stdout).toMatch(/momonga daemon running: pid \d+, version 0\.0\.0, phase running/);
    const pid = Number(/pid (\d+)/.exec(running.stdout)?.[1]);

    const stopped = await runCli(home, ['daemon', 'stop']);
    expect(stopped.stdout).toBe('momonga daemon stopped\n');
    expect((await runCli(home, ['daemon', 'stop'])).stdout).toBe('momonga daemon is not running\n');
    expect(() => process.kill(pid, 0)).toThrow();

    expect((await runCli(home, ['-p', 'two'])).stdout).toBe('second\n');
    const again = await runCli(home, ['daemon', 'status']);
    expect(Number(/pid (\d+)/.exec(again.stdout)?.[1])).not.toBe(pid);
  });

  it(titleOf('cli-version-restart'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home, script: [textReply('from the new daemon')] });
    const oldPid = stack.supervisor.pid;
    expect(stack.health.version).toBe('e2e');

    const result = await runCli(home, ['-p', 'hello']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('from the new daemon\n');
    expect((await stack.supervisor.exited).code).toBe(0);
    const status = await runCli(home, ['daemon', 'status']);
    expect(status.stdout).toMatch(/version 0\.0\.0/);
    expect(Number(/pid (\d+)/.exec(status.stdout)?.[1])).not.toBe(oldPid);
  });

  it(titleOf('cli-reconnect'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepare(() => [textReply('survived the restart')]);
    expect((await runCli(home, ['daemon', 'status'])).code).toBe(1);
    const hold = fake.hold();

    const running = startCli(home, ['-p', 'Say hello', '--output-format', 'stream-json']);
    await hold.waitForRequest();
    const runtimePid = await until(() => pidOfRole(home, 'runtime'), { deadlineMs: E2E_MARGIN_MS, description: 'the runtime pid in daemon status' });
    process.kill(runtimePid, 'SIGKILL');
    await until(
      async () => {
        const pid = await pidOfRole(home, 'runtime');
        return pid !== undefined && pid !== runtimePid;
      },
      { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the supervisor to restart the runtime' },
    );
    hold.release();

    const finished = await running.result;
    expect(finished.code).toBe(0);
    expect(finished.stderr).toContain('lost the event stream, reconnecting');
    const lines = jsonLines(finished.stdout);
    const sequence = lines.slice(1, -1).map((event) => event['seq']);
    expect(sequence).toEqual(sequence.map((_, index) => index + 1));
    expect(lines.at(-1)).toMatchObject({ type: 'result', subtype: 'success', result: 'survived the restart' });
    expect(chatCompletions(fake)).toHaveLength(1);
  });

  it(titleOf('cli-env'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepare(() => [textReply('ok')]);

    const result = await runCli(home, ['-p', 'hi', '--output-format', 'stream-json'], { env: { OPENAI_API_KEY: 'sk-test-0123456789abcdef', DEPLOY_TOKEN: 'plain-token-value', MOMONGA_VISIBLE: 'kept' } });

    expect(result.code).toBe(0);
    expect(jsonLines(result.stdout)[0]).toMatchObject({ type: 'system', subtype: 'init', stripped_env_keys: [] });
    const [row] = readDb<{ env_json: string }>(home.paths.databases.runtime, 'SELECT env_json FROM sessions');
    const env: unknown = JSON.parse(row?.env_json ?? 'null');
    expect(env).toMatchObject({ MOMONGA_VISIBLE: 'kept', HOME: home.home });
    expect(Object.keys(env as Record<string, string>)).not.toContain('OPENAI_API_KEY');
    expect(Object.keys(env as Record<string, string>)).not.toContain('DEPLOY_TOKEN');
  });
});

describe('cli: gateway probe', () => {
  it(titleOf('cli-probe'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const fakeFm = await createFakeFm({ dir: home.root });
    const probed = await runCli(home, ['gateway', 'probe', 'fm', '--fm-binary', fakeFm.binaryPath, '--samples', '2']);

    expect(probed.stderr).toBe('');
    expect(probed.code).toBe(0);
    expect(probed.stdout).toMatch(/^probed fm: model .+, context window \d+/m);
    expect(probed.stdout).toMatch(/tool calling: (native|constrained|none)/);
    expect(fs.existsSync(path.join(home.paths.probe, 'fm.json'))).toBe(true);

    const unlicensed = path.join(home.root, 'unlicensed-fm');
    fs.writeFileSync(unlicensed, '#!/bin/sh\nexit 69\n', { mode: 0o755 });
    const refused = await runCli(home, ['gateway', 'probe', 'fm', '--fm-binary', unlicensed]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('remedy: sudo fm license');

    const unknown = await runCli(home, ['gateway', 'probe', 'nope', '--fm-binary', fakeFm.binaryPath]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('model target nope is not an fm target');
  });
});

