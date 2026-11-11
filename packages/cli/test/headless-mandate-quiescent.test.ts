import { EXIT_OK, EXIT_WAITING_FOR_APPROVAL } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import type { RunView } from '../src/client/views.ts';
import { watchRun } from '../src/run/headless.ts';
import { runView } from './fake-backend.ts';
import { eventFrame, textDelta, watchedRun } from './headless-fakes.ts';
import type { Watched } from './headless-fakes.ts';

const HELD = [{ callId: 'c1', approvalId: 'ap-1', tool: 'GitPush', reason: 'a push needs a person', sinceSeq: 1 }];

const quiescent = (seq: number, resolved: { onQuiescent?: 'report' | 'wait' }): RunEventFrame => eventFrame(seq, { type: 'run.quiescent', held: HELD, ...resolved });

const approvedAndDone: readonly RunEventFrame[] = [
  eventFrame(3, { type: 'tool.held.resolved', callId: 'c1', approvalId: 'ap-1', outcome: 'executed', status: 'completed', output: 'pushed' }),
  textDelta(4, 'm1', 'All done.'),
];

const watched = (context: TestContext, frames: readonly RunEventFrame[], ended: RunView, staysOpen: boolean): Watched => watchedRun(withTempDir(context, { asHome: true }), frames, ended, { staysOpen });

const headlessWatch = (run: Watched): Promise<number> =>
  watchRun(run.ports, run.paths, { client: run.client, runId: 'run-1', format: 'text', verbose: false, interrupt: new AbortController().signal, onInterrupt: 'cancel', leaveWhenQuiescent: true, leaveWhenAsked: true });

describe('a headless run at quiescence acts on the value its mandate resolved to, which the run reports with the event', () => {
  it('stays with the run when the mandate says wait, and ends with the run once a person has answered', async (context) => {
    const run = watched(context, [quiescent(2, { onQuiescent: 'wait' }), ...approvedAndDone], runView({ id: 'run-1', status: 'COMPLETED' }), false);

    expect(await headlessWatch(run)).toBe(EXIT_OK);

    expect(run.stderr.join('')).toContain('momonga: the run waits for you: 1 call held for approval, and nothing else can proceed');
    expect(run.stderr.join('')).not.toContain('stays in the daemon');
    expect(run.stdout.join('')).toBe('All done.\n');
  });

  it('leaves with the exit of a run that waits for approval when the mandate says report', async (context) => {
    const run = watched(context, [quiescent(2, { onQuiescent: 'report' })], runView({ id: 'run-1', status: 'WAITING_HUMAN' }), true);

    expect(await headlessWatch(run)).toBe(EXIT_WAITING_FOR_APPROVAL);

    expect(run.stderr.join('')).toContain('momonga: run run-1 stays in the daemon');
  });

  it('leaves when the mandate states neither: reporting is the rule of a headless run', async (context) => {
    const run = watched(context, [quiescent(2, {})], runView({ id: 'run-1', status: 'WAITING_HUMAN' }), true);

    expect(await headlessWatch(run)).toBe(EXIT_WAITING_FOR_APPROVAL);
  });
});
