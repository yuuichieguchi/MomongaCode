import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { finishApprovingPrompts, launchRuntime, modelSettings, prepareStack, readDb, scriptedToolCall, sessionEnvFor, startGateway, waitForStatus } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const HOST_KIND = process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap';
const BYPASS = { permissionMode: 'bypassPermissions', bypassAllowed: true };
const FINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'STOPPED'];

const textReply = (text: string) => ({ kind: 'stream' as const, chunks: [{ delta: { role: 'assistant', content: text }, finishReason: 'stop' }] });

const gitIn = (temp: RunHome, ...args: string[]): string => {
  const result = spawnSync('git', args, { cwd: temp.project, env: { ...sessionEnvFor(temp.home) }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
};

const emptyRepository = (temp: RunHome): void => {
  fs.writeFileSync(path.join(temp.home, '.gitconfig'), '[user]\n\tname = Momonga Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n', { mode: 0o600 });
  gitIn(temp, 'init', '-q');
};

const stagedRepository = (temp: RunHome): void => {
  emptyRepository(temp);
  fs.writeFileSync(path.join(temp.project, 'notes.txt'), 'notes\n');
  gitIn(temp, 'add', 'notes.txt');
};

type Completed = { status: string; output: string; effect?: { operation: string; outcome: string } };

const completedCalls = (temp: RunHome, runId: string): Completed[] =>
  readDb<{ payload_json: string }>(temp.paths.databases.runtime, "SELECT payload_json FROM events WHERE run_id = ? AND type = 'tool.completed' ORDER BY seq", runId).map((row) => {
    const { status, output, effect } = JSON.parse(row.payload_json) as Completed;
    return { status, output, ...(effect === undefined ? {} : { effect }) };
  });

describe('GitCommit through the runtime process, composed as the product composes it', () => {
  it.each([HOST_KIND, 'none'])('makes the first commit of a repository from its staged file under sandbox %s', async (sandbox) => {
    const stack = await prepareStack({ script: [scriptedToolCall('GitCommit', { message: 'add notes' }), textReply('committed')] });
    stack.settings({ sandbox });
    stagedRepository(stack.temp);
    await startGateway(stack.temp);
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession(BYPASS);
    const run = await launched.createRun(session.id, { input: 'commit the staged file' });
    expect(await finishApprovingPrompts(launched, stack.temp, run.id)).toBe('COMPLETED');
    expect(completedCalls(stack.temp, run.id)).toMatchObject([{ status: 'completed', effect: { operation: 'GitCommit', outcome: 'applied' } }]);
    expect(gitIn(stack.temp, 'log', '-1', '--format=%s')).toBe('add notes');
  });

  it('writes, stages and commits a file under a mandate that allows the three tools, in a repository with no commit', async () => {
    const stack = await prepareStack({
      script: [
        scriptedToolCall('Write', { file_path: 'notes.txt', content: 'notes\n' }),
        scriptedToolCall('GitStage', { paths: ['notes.txt'] }, 'call_2'),
        scriptedToolCall('GitCommit', { message: 'add notes' }, 'call_3'),
        textReply('committed'),
      ],
    });
    stack.settings({
      sandbox: HOST_KIND,
      mandates: { 'stage-commit': { allow: ['Edit(*)', 'GitStage(*)', 'GitCommit(*)', 'GitBranch(*)'] } },
      ...modelSettings(stack.fake.socketPath, undefined, { billing: 'local' }),
    });
    emptyRepository(stack.temp);
    await startGateway(stack.temp);
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession();
    const run = await launched.createRun(session.id, { input: 'write, stage and commit notes.txt', mandate: { profile: 'stage-commit' } });
    await waitForStatus(stack.temp, run.id, FINAL);
    expect(completedCalls(stack.temp, run.id)).toMatchObject([
      { status: 'completed' },
      { status: 'completed', effect: { operation: 'GitStage', outcome: 'applied' } },
      { status: 'completed', effect: { operation: 'GitCommit', outcome: 'applied' } },
    ]);
    expect(gitIn(stack.temp, 'log', '-1', '--format=%s')).toBe('add notes');
    expect(gitIn(stack.temp, 'status', '--porcelain')).toBe('');
  });
});
