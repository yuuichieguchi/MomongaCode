import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const PRE_DECISION_DIGEST = 'f'.repeat(64);

describe('a run resumed with a tool-set digest recorded before the fit order changed', () => {
  it('records the tools_changed note once and runs to completion', async () => {
    const env = await makeEnv();
    const target = path.join(env.project, 'out.txt');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'one' } }]));
    const run = await env.enqueue('Write a file');
    await env.runOnce(env.worker('worker-1'));
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');

    const db = env.raw();
    db.exec('DROP TRIGGER IF EXISTS events_reject_update');
    db.prepare('DELETE FROM snapshots WHERE run_id = ?').run(run.id);
    const started = db.prepare(`SELECT seq, payload_json FROM events WHERE run_id = ? AND type = 'run.started' ORDER BY seq`).all(run.id) as Array<{ seq: number; payload_json: string }>;
    expect(started.length).toBeGreaterThan(0);
    for (const row of started) {
      const payload = JSON.parse(row.payload_json) as { pins: { toolSetDigest: string } };
      expect(payload.pins.toolSetDigest).not.toBe(PRE_DECISION_DIGEST);
      payload.pins.toolSetDigest = PRE_DECISION_DIGEST;
      db.prepare('UPDATE events SET payload_json = ? WHERE run_id = ? AND seq = ?').run(JSON.stringify(payload), run.id, row.seq);
    }

    await env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(textStep('Written.'));
    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'tools_changed')).toHaveLength(1);
  });
});
