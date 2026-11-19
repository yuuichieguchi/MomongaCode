import { describe, expect, it, vi } from 'vitest';
import { systemTiming } from '@momonga/foundation';
import { App } from '../../src/tui/app.tsx';
import { shellFormOf } from '../../src/tui/commands/shell-commands.ts';
import { NEEDS_SESSION_NOTE } from '../../src/tui/slash.ts';
import type { ShellPort } from '../../src/tui/slash.ts';
import { fakeBackend, runView } from '../fake-backend.ts';
import type { FakeBackendOptions, FakeConversation } from '../fake-backend.ts';
import { FRAME_BOUND_MS, KEYS, renderObservable, untilFrame } from '../ink-helpers.ts';
import { runStarted, type } from '../tui-harness.tsx';
import { WIDE_TEST_SCREEN, fakeScreenTerminal } from './screen-fakes.ts';
import { contextOf } from './slash-context.ts';

const OWN_SESSION = 'bbbbbbbb22222222';
const OTHER_SESSION = 'cccccccc33333333';
const IDLE = /^(?![\s\S]*esc to cancel)[\s\S]*mode: manual \(shift\+tab\)/;

const recordingShell = () => {
  const argvs: string[][] = [];
  const shell: ShellPort = {
    run: async (argv) => {
      argvs.push([...argv]);
      return 0;
    },
  };
  return { shell, argvs };
};

const conversation = (id: string, createdAt: number, runId: string): FakeConversation => ({ session: { id, createdAt }, firstPrompt: `work of ${id}`, runs: [{ id: runId, frames: [] }] });

const open = async (options: FakeBackendOptions, reopen?: { kind: 'id'; id: string }) => {
  const backend = fakeBackend(options);
  const { shell, argvs } = recordingShell();
  const app = renderObservable(
    <App backend={backend} terminal={fakeScreenTerminal(WIDE_TEST_SCREEN)} now={Date.now} timers={systemTiming} initialMode={undefined} shell={shell} {...(reopen === undefined ? {} : { reopen })} onExit={() => undefined} />,
  );
  await untilFrame(app, 'mode: manual');
  return { backend, app, argvs };
};

const typedJobs = async (app: Awaited<ReturnType<typeof open>>['app'], argvs: string[][]): Promise<void> => {
  await type(app, '/jobs', '> /jobs');
  app.stdin.write(KEYS.enter);
  await vi.waitFor(() => expect(argvs).toHaveLength(1), { timeout: FRAME_BOUND_MS });
};

describe('/jobs typed in the terminal UI lists the jobs of the session it is typed in', () => {
  it('passes its own session after a run of its own, not the session of the folder whose run is newest', async () => {
    const { backend, app, argvs } = await open({ session: { id: OWN_SESSION, createdAt: 1 }, conversations: [conversation(OTHER_SESSION, 50, 'run-of-other')] });
    await runStarted(backend, app, 'sleep in the background');
    backend.finish(runView({ id: 'run-1', sessionId: OWN_SESSION, status: 'COMPLETED' }));
    await untilFrame(app, IDLE);

    await typedJobs(app, argvs);

    expect(argvs).toEqual([['jobs', OWN_SESSION]]);
    app.unmount();
  });

  it('passes the session it opened at launch before its first run', async () => {
    const { app, argvs } = await open({ session: { id: OWN_SESSION, createdAt: 100 }, conversations: [conversation(OTHER_SESSION, 50, 'run-of-other')] });
    await untilFrame(app, IDLE);

    await typedJobs(app, argvs);

    expect(argvs).toEqual([['jobs', OWN_SESSION]]);
    app.unmount();
  });

  it('passes the session it was reopened in before any run is made in it here', async () => {
    const { app, argvs } = await open({ conversations: [conversation(OWN_SESSION, 1, 'run-of-own'), conversation(OTHER_SESSION, 50, 'run-of-other')] }, { kind: 'id', id: OWN_SESSION });

    await typedJobs(app, argvs);

    expect(argvs).toEqual([['jobs', OWN_SESSION]]);
    app.unmount();
  });

  it('lists nothing and says a session is needed when no session is open, never another session', async () => {
    const { shell, argvs } = recordingShell();
    const { context, recorded } = contextOf({ shell });

    await shellFormOf('jobs').run('', context);

    expect(argvs).toEqual([]);
    expect(recorded.infos).toEqual([NEEDS_SESSION_NOTE]);
  });

  it.each([
    ['before', `${OTHER_SESSION} --json`, ['jobs', OTHER_SESSION, '--json']],
    ['after', `--json ${OTHER_SESSION}`, ['jobs', '--json', OTHER_SESSION]],
  ])('passes an id typed with it unchanged, %s an option', async (_place, typed, expected) => {
    const { shell, argvs } = recordingShell();
    const { context } = contextOf({ shell, sessions: { ...contextOf().context.sessions, current: () => OWN_SESSION } });

    await shellFormOf('jobs').run(typed, context);
    await vi.waitFor(() => expect(argvs).toHaveLength(1), { timeout: FRAME_BOUND_MS });

    expect(argvs).toEqual([expected]);
  });

  it('passes its own session before an option typed alone', async () => {
    const { shell, argvs } = recordingShell();
    const { context } = contextOf({ shell, sessions: { ...contextOf().context.sessions, current: () => OWN_SESSION } });

    await shellFormOf('jobs').run('--json', context);
    await vi.waitFor(() => expect(argvs).toHaveLength(1), { timeout: FRAME_BOUND_MS });

    expect(argvs).toEqual([['jobs', OWN_SESSION, '--json']]);
  });
});
