import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUdsClient, fixedSocket } from '@momonga/foundation';
import { mutableRole } from '../shared/mutable-role.ts';
import { launchService, openEventStream, serviceOptions, startService } from './helpers.ts';
import type { ServiceEnv } from './helpers.ts';

const FRAME = 'event: daemon.current\ndata: {"generation":2,"version":"1.2.4"}\n\n';

const openRaw = async (env: ServiceEnv, target: string, lastEventId?: number): Promise<{ text(): Promise<string> }> => {
  const response = await env.client.request({
    method: 'GET',
    path: target,
    headers: { accept: 'text/event-stream', ...(lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) }) },
  });
  expect(response.status).toBe(200);
  return { text: () => response.text() };
};

const withThreeEvents = async () => {
  const role = mutableRole('serving');
  const env = await startService({ role: role.port });
  const session = await env.createSession();
  const run = await env.createRun(session.id);
  const claim = env.claimRun(run.id);
  env.append(claim, env.notices(3));
  return { env, session, run, role };
};

describe('the daemon.current frame at the exit of a retiring runtime (20.44, rule 3b)', () => {
  it('ends a run stream and a session stream with the frame, without an id line, after the stored events', async () => {
    const { env, session, run, role } = await withThreeEvents();
    const runStream = await openRaw(env, `/v1/runs/${run.id}/events?after=0`);
    const sessionStream = await openRaw(env, `/v1/sessions/${session.id}/events?after=0`);
    role.set('retiring');

    const closing = env.service.retire({ generation: 2, version: '1.2.4' });
    const [runText, sessionText] = await Promise.all([runStream.text(), sessionStream.text()]);
    await closing;

    for (const text of [runText, sessionText]) {
      expect(text.endsWith(FRAME)).toBe(true);
      expect(text.slice(0, -FRAME.length)).toContain('event: notice');
      const lastFrame = text.slice(text.lastIndexOf('event: daemon.current'));
      expect(lastFrame).not.toMatch(/^id:/m);
    }
    expect(runText.match(/^event: notice$/gm)).toHaveLength(3);
  });

  it('sends no frame at a user stop', async () => {
    const { env, run } = await withThreeEvents();
    const stream = await openRaw(env, `/v1/runs/${run.id}/events?after=0`);

    const closing = env.closeService();
    const text = await stream.text().catch((error: unknown) => String(error));
    await closing;

    expect(text).not.toContain('daemon.current');
  });

  it('sends no frame when a stream opens on a runtime that is already retiring, and serves the stored events', async () => {
    const { env, run, role } = await withThreeEvents();
    role.set('retiring');
    const stream = await env.stream(`/v1/runs/${run.id}/events?after=0`);

    const events = [await stream.next(), await stream.next(), await stream.next()];

    expect(events.map((event) => event?.type)).toEqual(['user.message', 'notice', 'notice']);
    stream.close();
  });

  it('a resume with Last-Event-ID on the serving runtime of the same store delivers the later events once: none twice, none missing', async () => {
    const { env, run, role } = await withThreeEvents();
    const before = await openRaw(env, `/v1/runs/${run.id}/events?after=0`);
    role.set('retiring');
    const closing = env.service.retire({ generation: 2, version: '1.2.4' });
    const delivered = (await before.text()).match(/^id: (\d+)$/gm)?.map((line) => Number(line.slice(4))) ?? [];
    await closing;
    const lastSeen = delivered[delivered.length - 1];
    if (lastSeen === undefined) throw new Error('the first stream delivered no event');

    const socketPath = path.join(path.dirname(env.layout.socketPath), 'serving.sock');
    const serving = await launchService(serviceOptions({ store: env.store, clock: env.clock, home: env.layout.home, socketPath, ports: env.ports, notifier: env.notifier, errors: env.errors }));
    const client = createUdsClient(fixedSocket(socketPath));
    try {
      const claim = env.store.claim('serving-worker');
      if (claim === null) {
        const held = env.store.getRun(run.id);
        if (held === undefined) throw new Error('the run vanished');
      }
      const stored = env.runEvents(run.id).map((event) => event.seq);
      const resumed = await openEventStream(client, `/v1/runs/${run.id}/events`, { headers: { 'last-event-id': String(lastSeen - 1) } });
      const next = await resumed.next();
      resumed.close();

      expect(delivered).toEqual([...new Set(delivered)]);
      expect(delivered).toEqual(stored.filter((seq) => seq !== null && seq <= lastSeen));
      expect(next?.seq).toBe(lastSeen);
    } finally {
      await client.close();
      await serving.close();
    }
  });
});
