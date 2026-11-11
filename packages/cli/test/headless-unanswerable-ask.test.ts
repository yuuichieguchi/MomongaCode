import { EXIT_OK, EXIT_WAITING_FOR_APPROVAL } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import type { RunView } from '../src/client/views.ts';
import { watchRun } from '../src/run/headless.ts';
import type { OutputFormat, WatchOptions } from '../src/run/headless.ts';
import { runView } from './fake-backend.ts';
import { eventFrame, watchedRun } from './headless-fakes.ts';
import type { Watched } from './headless-fakes.ts';

const OPTIONS = [
  { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'o2', name: 'Reject', kind: 'reject_once' },
];

const call = (seq: number, runId = 'run-1'): RunEventFrame => eventFrame(seq, { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash npm test', rawInput: {} }, runId);
const asked = (seq: number, runId = 'run-1'): RunEventFrame =>
  eventFrame(seq, { type: 'tool.permission.requested', approvalId: 'ap-1', callId: 'c1', subjectDigest: 'd', reason: 'shell commands require approval', options: OPTIONS }, runId);
const waits = (seq: number, runId = 'run-1'): RunEventFrame => eventFrame(seq, { type: 'run.status', from: 'RUNNING', to: 'WAITING_HUMAN' }, runId);
const resolved = (seq: number): RunEventFrame => eventFrame(seq, { type: 'tool.permission.resolved', approvalId: 'ap-1', optionId: 'o1' });
const goesOn = (seq: number): RunEventFrame => eventFrame(seq, { type: 'run.status', from: 'WAITING_HUMAN', to: 'QUEUED' });

const WAITING = runView({ id: 'run-1', status: 'WAITING_HUMAN' });

const watched = (context: TestContext, frames: readonly RunEventFrame[], ended: RunView = WAITING, staysOpen = true): Watched => watchedRun(withTempDir(context, { asHome: true }), frames, ended, { staysOpen });

const watch = (run: Watched, extra: Partial<WatchOptions> = {}, format: OutputFormat = 'text'): Promise<number> =>
  watchRun(run.ports, run.paths, { client: run.client, runId: 'run-1', format, verbose: false, interrupt: new AbortController().signal, onInterrupt: 'cancel', ...extra });

describe('a headless run that asks what no one can answer there', () => {
  it('ends its wait with the exit of a run that waits for approval, names the approval and the commands that answer and follow it, and leaves the run in the daemon', async (context) => {
    const run = watched(context, [call(1), asked(2), waits(3)]);

    expect(await watch(run, { leaveWhenAsked: true })).toBe(EXIT_WAITING_FOR_APPROVAL);

    const said = run.stderr.join('');
    expect(said).toContain('momonga: waiting for approval ap-1: Bash npm test\n  shell commands require approval\n  momonga approve ap-1 allow_once\n  momonga approve ap-1 reject_once\n');
    expect(said).toContain('momonga: run run-1 waits for an answer this command cannot give, and stays in the daemon');
    expect(said).toContain('  ap-1  momonga approve ap-1');
    expect(said).toContain('momonga attach run-1');
    expect(run.cancelled).toEqual([]);
    expect(run.stdout).toEqual([]);
  });

  it('ends its wait whichever of the request and the wait of the run arrives first', async (context) => {
    const run = watched(context, [call(1), waits(2), asked(3)]);

    expect(await watch(run, { leaveWhenAsked: true })).toBe(EXIT_WAITING_FOR_APPROVAL);
  });

  it('ends its wait when a subagent asks', async (context) => {
    const child = 'run-child';
    const delegated = eventFrame(1, { type: 'tool.waiting', callId: 'c0', awaits: { kind: 'run', runId: child, sessionId: 'session-2', agent: 'explore' } });
    const run = watched(context, [delegated]);
    const childFrames = [call(1, child), asked(2, child), waits(3, child)];
    const rootStream = run.client.streamEvents.bind(run.client);
    Object.assign(run.client, {
      streamEvents: async function* (runId: string, options: { signal?: AbortSignal }) {
        if (runId !== child) {
          yield* rootStream(runId, options);
          return;
        }
        for (const each of childFrames) yield each;
        options.signal?.throwIfAborted();
        await new Promise<never>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal?.reason as Error), { once: true }));
      },
    });

    expect(await watch(run, { leaveWhenAsked: true })).toBe(EXIT_WAITING_FOR_APPROVAL);

    expect(run.stderr.join('')).toContain('  ap-1  momonga approve ap-1');
  });

  it('names the command that answers a request for input of an MCP server', async (context) => {
    const input = eventFrame(2, { type: 'tool.elicitation.requested', inputId: 'in-1', callId: 'c1', server: 'remote', requests: [{ key: 'k', mode: 'url', message: 'Sign in', url: 'https://example.test/' }] });
    const run = watched(context, [call(1), input, waits(3)]);

    expect(await watch(run, { leaveWhenAsked: true })).toBe(EXIT_WAITING_FOR_APPROVAL);

    expect(run.stderr.join('')).toContain('  in-1  momonga elicit in-1');
  });

  it('prints the result with the state of the run in a JSON format', async (context) => {
    const run = watched(context, [call(1), asked(2), waits(3)]);

    expect(await watch(run, { leaveWhenAsked: true }, 'json')).toBe(EXIT_WAITING_FOR_APPROVAL);

    expect(JSON.parse(run.stdout.join(''))).toMatchObject({ type: 'result', status: 'WAITING_HUMAN', is_error: true });
  });

  it('goes on when the request was answered before the run waited for it', async (context) => {
    const run = watched(context, [call(1), asked(2), resolved(3), eventFrame(4, { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' })], runView({ id: 'run-1', status: 'COMPLETED' }), false);

    expect(await watch(run, { leaveWhenAsked: true })).toBe(EXIT_OK);
  });

  it('does not leave for a call a mandate holds while the person asked the run to wait: that wait has its own rule', async (context) => {
    const held = eventFrame(3, { type: 'tool.held', callId: 'c1', approvalId: 'ap-1', reason: 'a push needs a person', footprint: { reads: [], writes: [] } });
    const done = [resolved(5), goesOn(6), eventFrame(7, { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' })];
    const run = watched(context, [call(1), asked(2), held, waits(4), ...done], runView({ id: 'run-1', status: 'COMPLETED' }), false);

    expect(await watch(run, { leaveWhenAsked: true })).toBe(EXIT_OK);
  });
});

describe('attach, which a person runs to follow a run', () => {
  it('keeps following a run that asks: the person answers from another terminal', async (context) => {
    const frames = [call(1), asked(2), waits(3), resolved(4), goesOn(5), eventFrame(6, { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' })];
    const run = watched(context, frames, runView({ id: 'run-1', status: 'COMPLETED' }), false);

    expect(await watch(run)).toBe(EXIT_OK);
  });
});
