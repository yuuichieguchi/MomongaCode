import { withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import { watchRun } from '../src/run/headless.ts';
import { runView } from './fake-backend.ts';
import { eventFrame, watchedRun } from './headless-fakes.ts';

const OPTIONS = [
  { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'o3', name: 'Reject once', kind: 'reject_once' },
];

const call = (seq: number): RunEventFrame => eventFrame(seq, { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Edit', kind: 'edit', title: 'Edit a.txt', rawInput: {} });
const asked = (seq: number): RunEventFrame => eventFrame(seq, { type: 'tool.permission.requested', approvalId: 'ap-1', callId: 'c1', subjectDigest: 'd', reason: 'edits require approval', options: OPTIONS, shown: { title: 'approval', input: {} } });

const attached = async (context: TestContext, outcome: RunEventFrame): Promise<string> => {
  const run = watchedRun(withTempDir(context, { asHome: true }), [call(1), asked(2), outcome], runView({ id: 'run-1', status: 'COMPLETED' }));
  await watchRun(run.ports, run.paths, { client: run.client, runId: 'run-1', format: 'text', verbose: false, interrupt: new AbortController().signal, onInterrupt: 'detach' });
  return run.stderr.join('');
};

describe('attach shows the end of every approval it showed as waiting', () => {
  it('names the answer an approval was resolved with', async (context) => {
    const said = await attached(context, eventFrame(3, { type: 'tool.permission.resolved', approvalId: 'ap-1', optionId: 'o3' }));
    expect(said).toContain('momonga: waiting for approval ap-1: Edit a.txt');
    expect(said).toContain('momonga: approval ap-1 resolved: reject_once (Reject once); it takes no other answer');
  });

  it('names the surface that answered when the event records it', async (context) => {
    const said = await attached(context, eventFrame(3, { type: 'tool.permission.resolved', approvalId: 'ap-1', optionId: 'o1', resolvedBy: 'tui' }));
    expect(said).toContain('momonga: approval ap-1 resolved by the terminal UI: allow_once (Allow once); it takes no other answer');
  });

  for (const [reason, text] of [
    ['expired', 'expired'],
    ['withdrawn', 'withdrawn: the run ended'],
    ['superseded', 'superseded by a newer request'],
  ] as const) {
    it(`names why an approval ended unanswered: ${reason}`, async (context) => {
      const said = await attached(context, eventFrame(3, { type: 'tool.permission.cancelled', approvalId: 'ap-1', reason }));
      expect(said).toContain(`momonga: approval ap-1 ${text}; it takes no answer`);
    });
  }
});
