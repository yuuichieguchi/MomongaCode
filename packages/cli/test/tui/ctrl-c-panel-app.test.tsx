import { describe, expect, it } from 'vitest';
import { EXIT_ARM_MS } from '../../src/tui/app.tsx';
import type { FakeBackend } from '../fake-backend.ts';
import { runView } from '../fake-backend.ts';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import { frame, runStarted, start } from '../tui-harness.tsx';
import { manualClock } from './screen-clock.ts';

const HINT = 'Press ctrl+c again to exit';
const OPTIONS = [
  { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'o3', name: 'Reject once', kind: 'reject_once' },
];

const callStarted = (backend: FakeBackend): void => {
  backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'sleep 60', rawInput: { command: 'sleep 60' } }));
};

const panels = [
  {
    name: 'the approval panel',
    open: (backend: FakeBackend): void => {
      callStarted(backend);
      backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'asks', options: OPTIONS, shown: { title: 'approval', input: {} } }));
    },
  },
  {
    name: 'the effect-unknown panel',
    open: (backend: FakeBackend): void => {
      callStarted(backend);
      backend.emit(frame({ type: 'tool.unknown.requested', approvalId: 'ap1', callIds: ['c1'], options: OPTIONS }));
    },
  },
] as const;

const opened = async (open: (backend: FakeBackend) => void, clock?: ReturnType<typeof manualClock>) => {
  const started = await start({}, clock === undefined ? {} : { now: clock.now, timers: clock.timers });
  await untilFrame(started.app, 'mode: manual');
  await runStarted(started.backend, started.app, 'go');
  open(started.backend);
  await untilFrame(started.app, (shown) => shown.includes('ctrl+c: cancel the run'));
  return started;
};

const cancels = (backend: FakeBackend): number => backend.calls.filter((call) => call === 'cancel:run-1').length;

describe.each(panels)('ctrl+c while $name is open', ({ open }) => {
  it('cancels the run, shows the exit hint, and exits at the second press within the window', async () => {
    const { app, backend, exited, outcomes } = await opened(open);
    app.stdin.write(KEYS.ctrlC);
    await backend.called('cancel:run-1');
    await untilFrame(app, HINT);
    expect(outcomes).toEqual([]);
    backend.finish(runView({ status: 'CANCELLED' }));
    await untilFrame(app, (shown) => shown.includes('CANCELLED') && shown.includes(HINT));
    app.stdin.write(KEYS.ctrlC);
    expect(await exited).toEqual({ reopen: 'session-1' });
  });

  it('exits at the second press while the cancel request is still unanswered', async () => {
    const { app, backend, exited } = await opened(open);
    const answer = Promise.withResolvers<void>();
    const cancel = backend.cancel;
    backend.cancel = async (runId) => {
      await cancel(runId);
      await answer.promise;
    };
    app.stdin.write(KEYS.ctrlC);
    await backend.called('cancel:run-1');
    await untilFrame(app, HINT);
    app.stdin.write(KEYS.ctrlC);
    expect(await exited).toEqual({ reopen: 'session-1' });
    expect(cancels(backend)).toBe(1);
    answer.resolve();
  });

  it(`does not exit at a second press after ${EXIT_ARM_MS} ms and shows the hint again`, async () => {
    const clock = manualClock();
    const { app, backend, outcomes } = await opened(open, clock);
    app.stdin.write(KEYS.ctrlC);
    await backend.called('cancel:run-1');
    await untilFrame(app, HINT);
    backend.finish(runView({ status: 'CANCELLED' }));
    await untilFrame(app, (shown) => shown.includes('CANCELLED'));
    clock.advance(EXIT_ARM_MS);
    await untilFrame(app, (shown) => !shown.includes(HINT));
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, HINT);
    expect(outcomes).toEqual([]);
    app.unmount();
  });
});
