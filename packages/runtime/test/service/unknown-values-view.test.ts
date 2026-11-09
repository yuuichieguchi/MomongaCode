import { describe, expect, it } from 'vitest';
import { expectSchema, startService } from './helpers.ts';

describe('the views of a run whose status this build does not know (H7, 11.4 rule 3)', () => {
  it('show the run and its session with the status unknown, when the database is newer', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const raw = env.raw();
    const highest = Number(raw.prepare('SELECT MAX(version) AS highest FROM schema_migrations').get()?.['highest']);
    raw.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)').run(highest + 1, 'a migration of a newer build', 'f'.repeat(64));
    raw.exec('PRAGMA ignore_check_constraints = ON');
    raw.prepare("UPDATE runs SET status = 'PAUSED' WHERE id = ?").run(run.id);

    const shown = await env.http('GET', `/v1/runs/${run.id}`);
    expect(shown.status).toBe(200);
    expect(shown.json.run.status).toBe('unknown');
    expectSchema('RunView', shown.json.run);
    const listed = await env.http('GET', `/v1/sessions/${session.id}`);
    expect(listed.status).toBe(200);
    const runs = await env.http('GET', `/v1/sessions/${session.id}/runs`);
    expect(runs.status).toBe(200);
    expect(runs.json.runs.map((entry: { id: string; status: string }) => [entry.id, entry.status])).toEqual([[run.id, 'unknown']]);
  });
});
