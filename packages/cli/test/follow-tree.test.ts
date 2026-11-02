import { describe, expect, it } from 'vitest';
import type { PublicRunEvent } from '@momonga/protocol';
import type { RunEventFrame, RuntimeClient } from '../src/client/runtime-client.ts';
import type { ChildFrameHandler, FollowOptions } from '../src/run/follow.ts';
import { followRun } from '../src/run/follow.ts';
import type { RunView } from '../src/client/views.ts';
import { runView } from './fake-backend.ts';
import { virtualClock } from './fake-supervisor.ts';

const frameOf = (runId: string, id: number, payload: Record<string, unknown>): RunEventFrame => ({
  id,
  event: String(payload['type']),
  data: { id, runId, sessionId: `session-of-${runId}`, seq: id, step: 1, createdAt: 1, ...payload } as PublicRunEvent,
});

const waiting = (runId: string, id: number, childId: string, agent: string): RunEventFrame =>
  frameOf(runId, id, { type: 'tool.waiting', callId: `call-${childId}`, awaits: { kind: 'run', runId: childId, sessionId: `session-of-${childId}`, agent } });

const text = (runId: string, id: number): RunEventFrame => frameOf(runId, id, { type: 'agent.message.delta', attempt: 0, itemId: 'm', text: runId });

const runIdOf = (frame: RunEventFrame): string => {
  if (!('runId' in frame.data)) throw new Error('the frame is not a run event');
  return frame.data.runId;
};

type Streams = Readonly<Record<string, readonly RunEventFrame[]>>;

const clientOf = (streams: Streams, failing: ReadonlySet<string> = new Set(), children: readonly RunView[] = []): { client: RuntimeClient; opened: { runId: string; lastEventId: number | undefined }[] } => {
  const opened: { runId: string; lastEventId: number | undefined }[] = [];
  const client = {
    streamEvents: async function* (runId: string, options: { lastEventId?: number } = {}) {
      opened.push({ runId, lastEventId: options.lastEventId });
      if (failing.has(runId)) throw new Error(`stream of ${runId} is broken`);
      for (const frame of streams[runId] ?? []) yield frame;
    },
    getRun: async (runId: string) => runView({ id: runId, status: 'COMPLETED' }),
    childRuns: async (runId: string) => children.filter((child) => child.parentRunId === runId),
  } as unknown as RuntimeClient;
  return { client, opened };
};

const optionsOf = (client: RuntimeClient, extra: Partial<FollowOptions>): FollowOptions => ({
  client,
  clock: virtualClock(),
  random: () => 0.5,
  runId: 'parent',
  reconnectBoundMs: 10_000,
  restoreConnection: async () => undefined,
  onEvent: () => undefined,
  ...extra,
});

describe('followRun over the runs a tool call waits on', () => {
  it('follows the child run from its start, hands its frames to the child handler with the agent, and keeps the parent cursor to the parent', async () => {
    const { client, opened } = clientOf({ parent: [text('parent', 1), waiting('parent', 2, 'child', 'reviewer')], child: [text('child', 1), text('child', 2)] });
    const own: string[] = [];
    const children: string[] = [];

    const run = await followRun(
      optionsOf(client, {
        onEvent: (frame) => own.push(`${runIdOf(frame)}:${frame.id}`),
        onChildEvent: (frame, agent) => children.push(`${agent}:${runIdOf(frame)}:${frame.id}`),
      }),
    );

    expect(run.id).toBe('parent');
    expect(own).toEqual(['parent:1', 'parent:2']);
    expect(children).toEqual(['reviewer:child:1', 'reviewer:child:2']);
    expect(opened).toEqual([
      { runId: 'parent', lastEventId: undefined },
      { runId: 'child', lastEventId: undefined },
    ]);
  });

  it('follows a grandchild run through the child run', async () => {
    const { client } = clientOf({
      parent: [waiting('parent', 1, 'child', 'planner')],
      child: [waiting('child', 1, 'grandchild', 'reviewer')],
      grandchild: [text('grandchild', 1)],
    });
    const children: string[] = [];

    await followRun(optionsOf(client, { onChildEvent: (frame, agent) => children.push(`${agent}:${runIdOf(frame)}:${frame.data.type}`) }));

    expect(children).toEqual(['planner:child:tool.waiting', 'reviewer:grandchild:agent.message.delta']);
  });

  it('follows a child once however many times the wait is announced', async () => {
    const { client, opened } = clientOf({ parent: [waiting('parent', 1, 'child', 'reviewer'), waiting('parent', 2, 'child', 'reviewer')], child: [] });

    await followRun(optionsOf(client, { onChildEvent: () => undefined }));

    expect(opened.filter((entry) => entry.runId === 'child')).toHaveLength(1);
  });

  it('opens no stream for a child when the caller has no child handler', async () => {
    const { client, opened } = clientOf({ parent: [waiting('parent', 1, 'child', 'reviewer')] });

    await followRun(optionsOf(client, {}));

    expect(opened.map((entry) => entry.runId)).toEqual(['parent']);
  });

  it('fails with the failure of the child stream and stops following the parent', async () => {
    const { client } = clientOf({ parent: [waiting('parent', 1, 'child', 'reviewer')] }, new Set(['child']));
    const handler: ChildFrameHandler = () => undefined;

    await expect(followRun(optionsOf(client, { onChildEvent: handler }))).rejects.toThrow('stream of child is broken');
  });

  it('follows a subagent that was already waiting before the cursor the caller resumed from', async () => {
    const child = runView({ id: 'child', status: 'WAITING_TOOL', parentRunId: 'parent', agent: 'reviewer' });
    const { client, opened } = clientOf({ parent: [waiting('parent', 1, 'child', 'reviewer'), text('parent', 2)], child: [text('child', 1)] }, new Set(), [child]);
    const own: number[] = [];
    const seen: number[] = [];
    const children: string[] = [];

    await followRun(
      optionsOf(client, {
        seenThrough: 1,
        onSeenEvent: (frame) => seen.push(frame.id),
        onEvent: (frame) => own.push(frame.id),
        onChildEvent: (frame, agent) => children.push(`${agent}:${runIdOf(frame)}:${frame.id}`),
      }),
    );

    expect(seen).toEqual([1]);
    expect(own).toEqual([2]);
    expect(children).toEqual(['reviewer:child:1']);
    expect(opened.filter((entry) => entry.runId === 'child')).toHaveLength(1);
  });

  it('does not replay a subagent that had finished by the time the caller resumed', async () => {
    const child = runView({ id: 'child', status: 'COMPLETED', parentRunId: 'parent', agent: 'reviewer' });
    const { client, opened } = clientOf({ parent: [waiting('parent', 1, 'child', 'reviewer'), text('parent', 2)], child: [text('child', 1)] }, new Set(), [child]);

    await followRun(optionsOf(client, { seenThrough: 1, onChildEvent: () => undefined }));

    expect(opened.map((entry) => entry.runId)).toEqual(['parent']);
  });
});
