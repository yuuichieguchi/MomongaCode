import type { DatabaseSync } from 'node:sqlite';
import { readTx } from '@momonga/foundation/sqlite';
import type { Clock } from '@momonga/foundation';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { decodeRun, decodeRunEvents } from './codec.ts';
import { foldRunState, initialRunState } from './fold.ts';
import { createGoverningFactStore } from './governing.ts';
import { createMemoryStore } from './memories.ts';
import { readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import type { ContributionMeasured, ContributionRequest, Run, TerminalContribution } from './types.ts';

export const payloadStep = (payload: RunEventPayload): number => ('step' in payload ? payload.step : 0);

export const PINNED_ROLES = "'system', 'developer'";

const PINNED_REQUEST_PAYLOAD = `(SELECT json_object(
  'type', 'model.requested',
  'step', json_extract(x.j, '$.step'),
  'attempt', json_extract(x.j, '$.attempt'),
  'digest', json_extract(x.j, '$.digest'),
  'body', json_object(
    'input', json((SELECT json_group_array(json(json_extract(x.j, t.path))) FROM json_tree(x.j, '$.body.input') AS t WHERE t.key = 'role' AND t.atom IN (${PINNED_ROLES}) AND t.path GLOB '$.body.input[[]*]' AND t.path NOT GLOB '*.*.*.*')),
    'tools', json_extract(x.j, '$.body.tools'),
    'tool_choice', json_extract(x.j, '$.body.tool_choice')
  )
) FROM (SELECT jsonb(e.payload_json) AS j) AS x)`;

const HOOK_EVENT_COLUMNS = `e.id, e.run_id, e.session_id, e.seq, e.step, e.lease_token, e.created_at, e.type,
  CASE WHEN e.type = 'model.requested' THEN ${PINNED_REQUEST_PAYLOAD} ELSE e.payload_json END AS payload_json`;

const NO_CLOCK: Clock = {
  now: () => {
    throw new Error('the journal reader reads and has no clock');
  },
};

export type JournalReaderOptions = { unit?: () => void };

export type JournalReader = {
  measure(hook: TerminalContribution, request: ContributionRequest): ContributionMeasured;
};

const typePlaceholders = (types: readonly string[]): { list: string; bound: Record<string, string> } => ({
  list: types.map((_type, index) => `:type${index}`).join(', '),
  bound: Object.fromEntries(types.map((type, index) => [`type${index}`, type])),
});

export const createJournalReader = (db: DatabaseSync, options: JournalReaderOptions = {}): JournalReader => {
  const unit = options.unit ?? ((): void => undefined);
  const memories = createMemoryStore(db, NO_CLOCK);
  const governing = createGoverningFactStore(db, NO_CLOCK);
  const selectRun = db.prepare('SELECT * FROM runs WHERE id = :id');
  const pinnedDigests = db.prepare("SELECT seq, pinned_digest FROM events WHERE run_id = :runId AND type = 'model.requested' ORDER BY seq");

  const decodeEach = (rows: Iterable<Row>): RunEvent[] => {
    const events: RunEvent[] = [];
    for (const row of rows) {
      const [event] = decodeRunEvents([row]);
      if (event === undefined) throw new Error('a journal row did not decode to an event');
      events.push(event);
      unit();
    }
    return events;
  };

  const seqsOfNewPinnedLayers = (runId: string): number[] => {
    const known = new Set<string>();
    const wanted: number[] = [];
    for (const row of pinnedDigests.iterate({ runId })) {
      const reader = readerFor('events', runId, row);
      const digest = reader.nullableString('pinned_digest');
      if (digest !== null && known.has(digest)) continue;
      if (digest !== null) known.add(digest);
      wanted.push(reader.number('seq'));
      unit();
    }
    return wanted;
  };

  const eventsOfTypes = (runId: string, types: readonly RunEventPayload['type'][]): RunEvent[] => {
    const { list, bound } = typePlaceholders(types);
    return decodeEach(db.prepare(`SELECT * FROM events WHERE run_id = :runId AND type IN (${list}) ORDER BY seq`).iterate({ runId, ...bound }));
  };

  const hookEventsOfTypes = (runId: string, types: readonly RunEventPayload['type'][]): RunEvent[] => {
    const plain = types.filter((type) => type !== 'model.requested');
    const events = plain.length === 0 ? [] : eventsOfTypes(runId, plain);
    if (plain.length === types.length) return events;
    const requests = decodeEach(
      db
        .prepare(`SELECT ${HOOK_EVENT_COLUMNS} FROM events e WHERE e.run_id = :runId AND e.type = 'model.requested' AND e.seq IN (SELECT value FROM json_each(:seqs)) ORDER BY e.seq`)
        .iterate({ runId, seqs: JSON.stringify(seqsOfNewPinnedLayers(runId)) }),
    );
    return [...events, ...requests].sort((a, b) => a.seq - b.seq);
  };

  const replayRun = (run: Run, readEvents: readonly RunEvent[], visit: (state: RunState, event: RunEvent) => void, leading: readonly RunEvent[]): void => {
    const readTypes = [...new Set<string>([...readEvents.map((event) => event.type), 'model.requested'])];
    const { list, bound } = typePlaceholders(readTypes);
    const rest = decodeEach(db.prepare(`SELECT * FROM events WHERE run_id = :runId AND type NOT IN (${list})`).iterate({ runId: run.id, ...bound }));
    const unread = leading.filter((event) => !readEvents.includes(event) && event.type !== 'model.requested');
    const journal = [...readEvents.filter((event) => event.type !== 'model.requested'), ...rest, ...unread].sort((a, b) => a.seq - b.seq);
    let state = initialRunState({ runId: run.id, sessionId: run.sessionId });
    for (const event of journal) {
      state = foldRunState(state, event);
      visit(state, event);
      unit();
    }
  };

  const measure = (hook: TerminalContribution, request: ContributionRequest): ContributionMeasured =>
    readTx(db, () => {
      const row = selectRun.get({ id: request.runId });
      if (row === undefined) throw new Error(`unknown run ${request.runId}`);
      const run = decodeRun(row);
      const leading = request.leading.map(
        (payload, index): RunEvent => ({
          ...payload,
          id: 0,
          runId: run.id,
          sessionId: run.sessionId,
          seq: run.lastSeq + 1 + index,
          step: Math.max(run.step, payloadStep(payload)),
          leaseToken: run.leaseToken,
          createdAt: 0,
        }),
      );
      const events = [...hookEventsOfTypes(run.id, hook.eventTypes), ...leading.filter((event) => hook.eventTypes.includes(event.type))];
      const contribution = hook.measure({ run, events, replay: (visit) => replayRun(run, events, visit, leading), memories, governing, unit });
      return contribution === undefined ? { lastSeq: run.lastSeq } : { lastSeq: run.lastSeq, contribution };
    });

  return { measure };
};
