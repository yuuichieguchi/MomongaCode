import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUSY_WAIT_LIMIT_MS, openDatabase } from '@momonga/foundation';
import { makeEnv } from './harness.ts';
import { callsStep } from './scripts.ts';

const recordedBeforeShown = (dbPath: string, approvalId: string): void => {
  const db = openDatabase(dbPath, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
  db.exec('DROP TRIGGER events_reject_update');
  db.prepare("UPDATE events SET payload_json = json_remove(payload_json, '$.shown'), shown = NULL WHERE type = 'tool.permission.requested' AND approval_id = ?").run(approvalId);
  db.close();
};

describe('a pending approval recorded before the approval carried what it shows', () => {
  it('is asked again with the shown content and a new digest, and nothing runs on the old question', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    const target = path.join(env.project, 'out.txt');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'approved' } }]));
    const run = await env.enqueue('Write the file');
    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');
    const [old] = env.ofType(run.id, 'tool.permission.requested');
    if (old === undefined) throw new Error('expected the first request');
    recordedBeforeShown(env.dbPath, old.approvalId);

    expect(await env.store.reaskUnshownApprovals(() => undefined)).toEqual([run.id]);
    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');

    const requests = env.ofType(run.id, 'tool.permission.requested');
    expect(requests).toHaveLength(2);
    const [, fresh] = requests;
    expect(fresh?.approvalId).not.toBe(old.approvalId);
    expect(fresh?.shown).toMatchObject({ title: expect.stringContaining('out.txt'), input: { file_path: target, content: 'approved' } });
    expect(env.ofType(run.id, 'tool.permission.cancelled')).toEqual([expect.objectContaining({ approvalId: old.approvalId, reason: 'superseded' })]);
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(fs.existsSync(target)).toBe(false);
    expect(env.toolbox.executions).toEqual([]);
  });
});
