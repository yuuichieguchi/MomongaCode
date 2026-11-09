import type { PublicRunEvent } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import type { RunEventFrame } from '../../src/client/runtime-client.ts';
import type { RunView, SessionView } from '../../src/client/views.ts';
import { App } from '../../src/tui/app.tsx';
import type { AppProps } from '../../src/tui/app.tsx';
import type { FollowHandlers } from '../../src/tui/backend.ts';
import { initialTranscript, reduceEvent } from '../../src/tui/transcript.ts';
import { SESSION, fakeBackend, runView } from '../fake-backend.ts';
import type { FakeBackend } from '../fake-backend.ts';
import { FRAME_BOUND_MS, KEYS, renderObservable, untilFrame, untilOutput } from '../ink-helpers.ts';

const PROMPT = 'list the files';
const STREAMED = 'Found two files, now checking';
const DIALOG = 'Permission requested: Bash remove beta.ts';
const VISIBLE = [`> ${PROMPT}`, '✓ Bash ls', STREAMED, '! Bash remove beta.ts', DIALOG, 'Allow once', 'Reject once'];

const options = [
  { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'o3', name: 'Reject once', kind: 'reject_once' },
];

const runEvents: readonly Record<string, unknown>[] = [
  { type: 'run.status', from: 'QUEUED', to: 'RUNNING' },
  { type: 'user.message', text: PROMPT },
  { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash ls', rawInput: { command: 'ls' } },
  { type: 'tool.started', callId: 'c1', idemKey: 'k1' },
  { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'alpha.ts\nbeta.ts' },
  { type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'Found two files,' },
  { type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: ' now checking' },
  { type: 'tool.call', callId: 'c2', providerCallId: 'p2', name: 'Bash', kind: 'execute', title: 'Bash remove beta.ts', rawInput: { command: 'unlink beta.ts' } },
  { type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c2', subjectDigest: 'd', reason: 'commands require approval', options },
];

const FRAMES: readonly RunEventFrame[] = runEvents.map((event, index) => {
  const id = index + 1;
  return { id, event: String(event['type']), data: { runId: 'run-1', sessionId: SESSION.id, step: 1, createdAt: 1, id, seq: id, ...event } as PublicRunEvent };
});

const ACTIVE_RUN: RunView = runView({ status: 'WAITING_HUMAN', lastSeq: FRAMES.length });

type ResumingBackend = FakeBackend & {
  resumeSession(sessionId: string): Promise<{ session: SessionView; runs: readonly RunView[] }>;
};

const followRecorded = (backend: FakeBackend): { backend: FakeBackend; following: Promise<void> } => {
  const following = Promise.withResolvers<void>();
  return {
    backend: {
      ...backend,
      follow: (runId, handlers) => {
        const result = backend.follow(runId, handlers);
        following.resolve();
        return result;
      },
    },
    following: following.promise,
  };
};

const replayingBackend = (): { backend: ResumingBackend; followed: { runId: string; handlers: FollowHandlers }[] } => {
  const base = fakeBackend();
  const followed: { runId: string; handlers: FollowHandlers }[] = [];
  const backend: ResumingBackend = {
    ...base,
    openSession: () => Promise.reject(new Error('a resumed TUI must not create a new session')),
    startRun: () => Promise.reject(new Error('a resumed TUI must not start a run')),
    resumeSession: async (sessionId) => {
      base.calls.push(`resume:${sessionId}`);
      return { session: { ...SESSION, id: sessionId, activeRunId: ACTIVE_RUN.id, latestRunId: ACTIVE_RUN.id, lastEventId: FRAMES.length }, runs: [ACTIVE_RUN] };
    },
    follow: (runId, handlers) =>
      new Promise<RunView>(() => {
        followed.push({ runId, handlers });
        for (const replayed of FRAMES) handlers.onEvent(replayed);
      }),
  };
  return { backend, followed };
};

const resumeProps = { resume: { sessionId: SESSION.id } } as unknown as Partial<AppProps>;

const liveScreen = async (): Promise<{ all: string; last: string }> => {
  const { backend, following } = followRecorded(fakeBackend());
  const app = renderObservable(<App backend={backend} initialMode={undefined} onExit={() => undefined} />);
  try {
    await untilFrame(app, 'mode: default');
    app.stdin.write(PROMPT);
    await untilFrame(app, `> ${PROMPT}`);
    app.stdin.write(KEYS.enter);
    await untilOutput(app, `> ${PROMPT}`);
    await following;
    for (const live of FRAMES) backend.emit(live);
    await untilFrame(app, DIALOG);
    return { all: app.frames.join('\n'), last: app.lastFrame() ?? '' };
  } finally {
    app.unmount();
  }
};

describe('the TUI rebuilds its screen from the daemon replay alone', () => {
  it('folds the replayed user.message event into the transcript as the user entry', () => {
    const rebuilt = FRAMES.reduce((transcript, replayed) => reduceEvent(transcript, replayed.data), initialTranscript);
    expect(rebuilt.entries.map((entry) => entry.kind)).toEqual(['user', 'tool', 'assistant', 'tool']);
    expect(rebuilt.entries[0]).toEqual({ kind: 'user', text: PROMPT });
    expect(rebuilt.approval?.approvalId).toBe('ap1');
  });

  it('shows the prompt, tool lines, streaming message and open dialog after a fresh start with no state from the old process', { timeout: 2 * FRAME_BOUND_MS }, async () => {
    const live = await liveScreen();
    for (const expected of VISIBLE) expect(live.all).toContain(expected);

    const { backend, followed } = replayingBackend();
    const fresh = renderObservable(<App backend={backend} initialMode={undefined} {...resumeProps} onExit={() => undefined} />);
    try {
      await untilFrame(fresh, DIALOG);
      expect(backend.calls).toContain(`resume:${SESSION.id}`);
      expect(backend.calls).not.toContain('openSession');
      expect(backend.started).toEqual([]);
      expect(followed.map((entry) => entry.runId)).toEqual([ACTIVE_RUN.id]);
      const rebuilt = fresh.frames.join('\n');
      for (const expected of VISIBLE) expect(rebuilt).toContain(expected);
      expect(rebuilt.split(`> ${PROMPT}`).length - 1).toBe(1);
      expect(fresh.lastFrame()).toBe(live.last);
    } finally {
      fresh.unmount();
    }
  });

  it('answers the replayed dialog through the daemon with the approval id from the replay', { timeout: 2 * FRAME_BOUND_MS }, async () => {
    const { backend } = replayingBackend();
    const fresh = renderObservable(<App backend={backend} initialMode={undefined} {...resumeProps} onExit={() => undefined} />);
    try {
      await untilFrame(fresh, DIALOG);
      fresh.stdin.write(KEYS.down);
      fresh.stdin.write(KEYS.enter);
      await backend.called('approve:ap1:o3');
    } finally {
      fresh.unmount();
    }
  });
});
