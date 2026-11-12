import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

const streamed: RunEventPayload[] = [
  { type: 'agent.thought.delta', step: 1, attempt: 1, itemId: 'rs_1', text: 'thinking' },
  { type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'msg_1', text: 'Hello ' },
  { type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'msg_2', text: 'world' },
];

const setup = async () => {
  const { store, dbPath } = harness();
  const run = await enqueue(store, newSession(store).id, 'go');
  const claim = mustClaim(store, 'w1');
  const fence = store.getSession(run.sessionId)?.fenceNonce ?? '';
  const fold = () => store.readRunEvents(run.id, 0, 1000).reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId, fence }));
  return { store, dbPath, run, claim, fold };
};

describe('a restarted stream withdraws the entries it names', () => {
  it('keeps the ids of the streamed thought and text entries of the stream in the run state', async () => {
    const { store, claim, fold } = await setup();
    store.append(claim, streamed);
    expect(fold().streaming).toEqual({
      step: 1,
      attempt: 1,
      seen: true,
      items: [
        { itemId: 'msg_1', text: 'Hello ' },
        { itemId: 'msg_2', text: 'world' },
      ],
      thoughtIds: ['rs_1'],
    });
  });

  it('drops exactly the entries whose ids the restart names, whatever its step and attempt say', async () => {
    const { store, claim, fold } = await setup();
    store.append(claim, [...streamed, { type: 'model.stream.restarted', step: 9, attempt: 9, itemIds: ['msg_1', 'rs_1'] }]);
    expect(fold().streaming).toEqual({ step: 1, attempt: 1, seen: true, items: [{ itemId: 'msg_2', text: 'world' }], thoughtIds: [] });
    store.append(claim, [{ type: 'model.stream.restarted', step: 1, attempt: 1, itemIds: ['msg_2'] }]);
    expect(fold().streaming).toBeUndefined();
  });

  it('reads a restart stored before it named its entries as one that names none', async () => {
    const { store, dbPath, run, claim } = await setup();
    store.append(claim, [...streamed, { type: 'model.stream.restarted', step: 1, attempt: 1, itemIds: [] }]);
    const db = rawDb(dbPath);
    db.exec('DROP TRIGGER events_reject_update');
    db.prepare("UPDATE events SET payload_json = json_remove(payload_json, '$.itemIds') WHERE run_id = ? AND type = 'model.stream.restarted'").run(run.id);
    const [restarted] = store.readRunEventsOfTypes(run.id, ['model.stream.restarted']);
    expect(restarted).toMatchObject({ type: 'model.stream.restarted', itemIds: [] });
  });
});
