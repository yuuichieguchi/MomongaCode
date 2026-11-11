import { EXIT_FAILURE, EXIT_OK, EXIT_WAITING_FOR_APPROVAL } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import type { RunView } from '../src/client/views.ts';
import { watchRun } from '../src/run/headless.ts';
import type { OutputFormat, WatchOptions } from '../src/run/headless.ts';
import { runView } from './fake-backend.ts';
import { eventFrame, textDelta, watchedRun } from './headless-fakes.ts';
import type { Watched } from './headless-fakes.ts';

const ANSWER = [textDelta(1, 'm1', 'I looked at'), textDelta(2, 'm1', ' the file.'), textDelta(3, 'm2', 'It adds two numbers.')];

const watched = (context: TestContext, frames: readonly RunEventFrame[], ended: RunView, staysOpen = false): Watched => watchedRun(withTempDir(context, { asHome: true }), frames, ended, { staysOpen });

const watch = (run: Watched, format: OutputFormat, extra: Partial<WatchOptions> = {}): Promise<number> =>
  watchRun(run.ports, run.paths, { client: run.client, runId: 'run-1', format, verbose: false, interrupt: new AbortController().signal, onInterrupt: 'cancel', ...extra });

describe('the text format of a headless run', () => {
  it('writes the answer of a run that completed to standard output, once the run has ended', async (context) => {
    const run = watched(context, ANSWER, runView({ id: 'run-1', status: 'COMPLETED' }));

    expect(await watch(run, 'text')).toBe(EXIT_OK);

    expect(run.stdout.join('')).toBe('I looked at the file.\nIt adds two numbers.\n');
    expect(run.stderr).toEqual([]);
  });

  it('writes nothing to standard output for a run that stopped: its texts go to standard error, with the state', async (context) => {
    const run = watched(context, ANSWER, runView({ id: 'run-1', status: 'STOPPED', stopReason: 'conditions_unmet' }));

    expect(await watch(run, 'text')).toBe(EXIT_FAILURE);

    expect(run.stdout).toEqual([]);
    expect(run.stderr.join('')).toBe('I looked at the file.\nIt adds two numbers.\nmomonga: run run-1 STOPPED (conditions_unmet)\n');
  });

  it.for(['FAILED', 'CANCELLED'] as const)('writes the texts of a run that ended %s to standard error', async (status, context) => {
    const run = watched(context, ANSWER, runView({ id: 'run-1', status }));

    await watch(run, 'text');

    expect(run.stdout).toEqual([]);
    expect(run.stderr.join('')).toContain('It adds two numbers.\n');
    expect(run.stderr.join('')).toContain(`momonga: run run-1 ${status}`);
  });

  it('writes the texts so far to standard error when it leaves a run that waits for approval', async (context) => {
    const quiescent = eventFrame(4, { type: 'run.quiescent', held: [{ callId: 'c1', approvalId: 'ap-1', tool: 'GitPush', reason: 'a push needs a person', sinceSeq: 3 }] });
    const run = watched(context, [...ANSWER, quiescent], runView({ id: 'run-1', status: 'WAITING_HUMAN' }), true);

    expect(await watch(run, 'text', { leaveWhenQuiescent: true })).toBe(EXIT_WAITING_FOR_APPROVAL);

    expect(run.stdout).toEqual([]);
    expect(run.stderr.join('')).toContain('I looked at the file.\nIt adds two numbers.\n');
  });

  it('escapes what the model wrote in the answer, keeping its line breaks', async (context) => {
    const run = watched(context, [textDelta(1, 'm1', 'first\nx\u001b]0;pwn\u0007y')], runView({ id: 'run-1', status: 'COMPLETED' }));

    await watch(run, 'text');

    expect(run.stdout.join('')).toBe('first\nx\\u001b]0;pwn\\u0007y\n');
  });

  it('carries the answer and the state in the json format whatever the end', async (context) => {
    const run = watched(context, ANSWER, runView({ id: 'run-1', status: 'STOPPED', stopReason: 'conditions_unmet' }));

    await watch(run, 'json');

    expect(JSON.parse(run.stdout.join(''))).toMatchObject({ type: 'result', status: 'STOPPED', stop_reason: 'conditions_unmet', is_error: true, result: 'It adds two numbers.' });
  });
});

describe('a failed operation in a headless run', () => {
  const commit = eventFrame(1, { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'GitCommit', kind: 'other', title: 'Commit "notes"', rawInput: {} });
  const failedCommit = eventFrame(2, {
    type: 'tool.completed',
    callId: 'c1',
    status: 'failed',
    output: 'git commit exited 1\nnothing added to commit but untracked files present\n',
    effect: { operation: 'GitCommit', target: 'HEAD', outcome: 'failed' },
  });

  it('prints the reason the operation gave, on standard error', async (context) => {
    const run = watched(context, [commit, failedCommit], runView({ id: 'run-1', status: 'COMPLETED' }));

    await watch(run, 'text');

    expect(run.stderr.join('')).toBe('momonga: tool Commit "notes" failed\n  git commit exited 1\n  nothing added to commit but untracked files present\n');
  });

  it('prints one line for a failed tool that is not an operation', async (context) => {
    const bash = eventFrame(1, { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash npm test', rawInput: {} });
    const failed = eventFrame(2, { type: 'tool.completed', callId: 'c1', status: 'failed', output: 'many lines\nof a test log\n', exitCode: 1 });
    const run = watched(context, [bash, failed], runView({ id: 'run-1', status: 'COMPLETED' }));

    await watch(run, 'text');

    expect(run.stderr.join('')).toBe('momonga: tool Bash npm test failed\n');
  });
});
