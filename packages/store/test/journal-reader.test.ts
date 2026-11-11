import { describe, expect, it } from 'vitest';
import { openDatabase } from '@momonga/foundation';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { createJournalReader } from '@momonga/store';
import type { TerminalContribution } from '@momonga/store';
import { enqueue, harness, mustClaim, mustRun, newSession, registerCleanup } from './helpers.ts';
import { contributionOf } from './preparer-fixture.ts';

const finalResponse: RunEventPayload = {
  type: 'model.responded',
  step: 1,
  attempt: 1,
  response: { status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
};

describe('createJournalReader: the reads the journal thread runs over its own connection', () => {
  it('measures a run over a second connection: the hook sees its event types from the journal followed by the leading events, and the reply carries the lastSeq it read', async () => {
    const h = harness();
    const run = await enqueue(h.store, newSession(h.store).id, 'measure me');
    mustClaim(h.store, 'w1');
    const lastSeq = mustRun(h.store, run.id).lastSeq;
    const seen: RunEvent[][] = [];
    const hook: TerminalContribution = {
      eventTypes: ['user.message', 'model.responded'],
      measure: ({ run: measured, events }) => {
        seen.push([...events]);
        expect(measured.id).toBe(run.id);
        return contributionOf('m7');
      },
    };
    const db = openDatabase(h.dbPath);
    registerCleanup(() => db.close());

    const measured = createJournalReader(db).measure(hook, { runId: run.id, leading: [finalResponse] });

    expect(measured.lastSeq).toBe(lastSeq);
    expect(measured.contribution?.items).toEqual(contributionOf('m7').items);
    expect(seen.map((events) => events.map((event) => event.type))).toEqual([['user.message', 'model.responded']]);
    expect(seen[0]?.[0]).toMatchObject({ type: 'user.message', text: 'measure me' });
    expect(seen[0]?.[1]?.seq).toBe(lastSeq + 1);
    expect(mustRun(h.store, run.id).lastSeq).toBe(lastSeq);
  });

  it('carries no journaled flag: a contribution is never read back from the journal', async () => {
    const h = harness();
    const run = await enqueue(h.store, newSession(h.store).id);
    const hook: TerminalContribution = { eventTypes: ['user.message'], measure: () => undefined };
    const db = openDatabase(h.dbPath);
    registerCleanup(() => db.close());

    const measured = createJournalReader(db).measure(hook, { runId: run.id, leading: [] });

    expect(measured).toEqual({ lastSeq: mustRun(h.store, run.id).lastSeq });
  });
});
