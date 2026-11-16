import { describe, expect, it } from 'vitest';
import { parseSse, startService } from './helpers.ts';
import type { ServiceEnv, SseFrame } from './helpers.ts';

type Reading = { frames: SseFrame[]; until(count: number): Promise<SseFrame[]>; ended: Promise<void> };

const reading = async (env: ServiceEnv, target: string): Promise<Reading> => {
  const response = await env.client.request({ method: 'GET', path: target, headers: { accept: 'text/event-stream' } });
  expect(response.status).toBe(200);
  const frames: SseFrame[] = [];
  let wake: (() => void) | undefined;
  const ended = (async () => {
    try {
      for await (const frame of parseSse(response.body)) {
        if (frame.data === undefined) continue;
        frames.push(frame);
        wake?.();
      }
    } catch {
      return;
    }
  })();
  const until = async (count: number): Promise<SseFrame[]> => {
    while (frames.length < count) await new Promise<void>((resolve) => (wake = resolve));
    return frames;
  };
  return { frames, until, ended };
};

const isStopping = (frame: SseFrame): boolean => frame.event === 'daemon.stopping';

describe('the daemon.stopping frame of a stop (real-use-30)', () => {
  it('tells every open stream once, without an id, when the stop begins, and the stream goes on until the stop closes it', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    env.append(claim, env.notices(1));
    const runStream = await reading(env, `/v1/runs/${run.id}/events?after=0`);
    await runStream.until(2);

    env.service.beginDraining();
    await runStream.until(3);
    env.append(claim, env.notices(1));
    const frames = await runStream.until(4);
    const late = await reading(env, `/v1/runs/${run.id}/events?after=0`);
    const lateFrames = await late.until(4);

    expect(frames.map((frame) => frame.event)).toEqual(['user.message', 'notice', 'daemon.stopping', 'notice']);
    expect(frames[2]).toEqual({ event: 'daemon.stopping', data: '{}' });
    expect(lateFrames.filter(isStopping)).toHaveLength(1);
    await env.closeService();
    await Promise.all([runStream.ended, late.ended]);
    expect(runStream.frames.filter(isStopping)).toHaveLength(1);
  });
});
