import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const writeUnknownMode = (env: Env): void => {
  const raw = env.raw();
  const highest = Number(raw.prepare('SELECT MAX(version) AS highest FROM schema_migrations').get()?.['highest']);
  raw.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)').run(highest + 1, 'a migration of a newer build', 'f'.repeat(64));
  raw.exec('PRAGMA ignore_check_constraints = ON');
  raw.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run('supervised', env.session.id);
};

describe('a held run whose session mode becomes unknown (11.4)', () => {
  it('ends the hold: the run is yielded untouched and the next step is not taken', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    const target = path.join(env.project, 'after.txt');
    env.toolbox.hooks['Echo'] = () => writeUnknownMode(env);
    env.gateway.script.push(
      callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'switch' } }]),
      callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'written' } }]),
      textStep('Done.'),
    );
    const run = await env.enqueue('Echo then write');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    const current = env.run(run.id);
    expect(current.status).toBe('QUEUED');
    expect(current.leaseOwner).toBeNull();
    expect(fs.existsSync(target)).toBe(false);
    expect(env.ofType(run.id, 'tool.permission.requested')).toEqual([]);
    expect(env.ofType(run.id, 'attempt.failed')).toEqual([]);
    expect(env.ofType(run.id, 'notice')).toEqual([]);
    expect(await env.runOnce(env.worker('worker-2'))).toBe('idle');
  });
});
