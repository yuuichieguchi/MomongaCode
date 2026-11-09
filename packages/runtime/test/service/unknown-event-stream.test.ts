import { describe, expect, it } from 'vitest';
import { startService } from './helpers.ts';

describe('a run stream read by an older build (H7, 11.4)', () => {
  it('passes an event type the build does not know through, when the database is newer than the build', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    env.append(claim, env.notices(1));
    const raw = env.raw();
    const highest = Number(raw.prepare('SELECT MAX(version) AS highest FROM schema_migrations').get()?.['highest']);
    raw.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)').run(highest + 1, 'a migration of a newer build', 'f'.repeat(64));
    const current = await env.getRun(run.id);
    const seq = Number(current.lastSeq) + 1;
    raw
      .prepare('INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run.id, session.id, seq, 0, claim.leaseToken, 1_800_000_000_000, 'made.up', JSON.stringify({ type: 'made.up', detail: 'from a newer build' }));
    raw.prepare('UPDATE runs SET last_seq = ? WHERE id = ?').run(seq, run.id);
    env.append(claim, env.notices(1, 'after'));

    const stream = await env.stream(`/v1/runs/${run.id}/events`);
    expect(stream.status).toBe(200);
    const delivered = await stream.until((event) => event.seq === seq + 1);
    expect(delivered.find((event) => event.seq === seq)).toMatchObject({ type: 'made.up', opaque: true, runId: run.id, seq, payload: { detail: 'from a newer build' } });
    expect(delivered.at(-1)).toMatchObject({ type: 'notice', message: 'after1' });
  });
});
