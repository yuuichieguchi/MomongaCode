import { describe, expect, it } from 'vitest';
import { STREAM_FAILED_EVENT } from '@momonga/protocol';
import { startService } from './helpers.ts';

describe('a run stream that fails after it opened', () => {
  it('ends with one typed error frame naming the cause when a stored row cannot be read, instead of breaking the connection for a reconnect', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    env.append(claim, env.notices(1));
    const raw = env.raw();
    const current = await env.getRun(run.id);
    const seq = Number(current.lastSeq) + 1;
    raw
      .prepare('INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run.id, session.id, seq, 0, claim.leaseToken, 1_800_000_000_000, 'mode.changed', JSON.stringify({ type: 'mode.changed', mode: 5 }));
    raw.prepare('UPDATE runs SET last_seq = ? WHERE id = ?').run(seq, run.id);

    const response = await env.http('GET', `/v1/runs/${run.id}/events`, { headers: { accept: 'text/event-stream' } });

    expect(response.status).toBe(200);
    const frames = response.text.split('\n\n').filter((frame) => frame.trim() !== '' && !frame.startsWith(':'));
    const last = frames.at(-1) ?? '';
    expect(last).toContain(`event: ${STREAM_FAILED_EVENT}`);
    expect(last).not.toContain('id: ');
    const data = JSON.parse(last.split('\n').find((line) => line.startsWith('data: '))?.slice('data: '.length) ?? 'null');
    expect(data).toMatchObject({ code: 'stream_failed' });
    expect(data.message).toContain('is corrupt');
    expect(env.errors).toHaveLength(1);
  });
});
