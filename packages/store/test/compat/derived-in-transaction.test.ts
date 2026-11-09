import { describe, expect, it } from 'vitest';
import { awaitingApproval } from '../approval-fixture.ts';
import { harness, rawDb } from '../helpers.ts';

const asWrittenByOlderBuild = (dbPath: string, runId: string): void => {
  const db = rawDb(dbPath);
  db.exec('DROP TRIGGER events_reject_update');
  const requested = db.prepare("SELECT seq FROM events WHERE run_id = ? AND type = 'tool.permission.requested' ORDER BY seq LIMIT 1").get(runId);
  const seq = Number(requested?.['seq']);
  db.prepare("UPDATE events SET approval_id = NULL WHERE run_id = ? AND type = 'tool.permission.requested'").run(runId);
  db.prepare('UPDATE derived_through SET through_seq = ? WHERE run_id = ?').run(seq - 1, runId);
};

describe('a read of approval_id inside a store operation, for a request an older build appended (H7, 11.5 correction rule 1; pending the person)', () => {
  it('resolveApproval finds the tool.permission.requested event and resolves', async () => {
    const { store, dbPath } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    asWrittenByOlderBuild(dbPath, runId);
    expect((await store.resolveApproval(approvals[0]?.id ?? '', 'allow_once')).kind).toBe('ok');
  });

  it('cancelling the run appends tool.permission.cancelled for the withdrawn request', async () => {
    const { store, dbPath } = harness();
    const { runId } = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    asWrittenByOlderBuild(dbPath, runId);
    store.requestCancel(runId);
    expect(rawDb(dbPath).prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'tool.permission.cancelled'").get(runId)).toEqual({ n: 1 });
  });
});
