import type { DatabaseSync } from 'node:sqlite';
import { immediateTx, uuidv7 } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { MEMORY_SCOPES } from '@momonga/protocol';
import type { MemoryScope } from '@momonga/protocol';
import { corrupt, expectOneOf, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import type { MemoryRecord, MemoryStore, SaveMemoryInput } from './types.ts';

const decodeMemory = (row: Row): MemoryRecord => {
  const identity = String(row['id']);
  const reader = readerFor('memories', identity, row);
  const scope: MemoryScope = expectOneOf('memories', identity, 'scope', MEMORY_SCOPES, reader.string('scope'));
  const project = reader.nullableString('project');
  if ((scope === 'project') !== (project !== null)) throw corrupt('memories', identity, `scope ${scope} does not match project ${String(project)}`);
  return {
    id: reader.string('id'),
    scope,
    project,
    text: reader.string('text'),
    source: {
      sessionId: reader.string('source_session_id'),
      runId: reader.string('source_run_id'),
      step: reader.number('source_step'),
      callId: reader.string('source_call_id'),
      seq: reader.number('source_seq'),
    },
    createdAt: reader.number('created_at'),
    lastUsedAt: reader.number('last_used_at'),
  };
};

const RECENCY = 'ORDER BY last_used_at DESC, created_at DESC, id';

export const createMemoryStore = (db: DatabaseSync, clock: Clock): MemoryStore => {
  const toolCallEvent = db.prepare(
    "SELECT seq, session_id FROM events WHERE run_id = :runId AND type = 'tool.call' AND json_extract(payload_json, '$.callId') = :callId LIMIT 1",
  );
  const insert = db.prepare(
    `INSERT INTO memories (id, scope, project, text, source_session_id, source_run_id, source_step, source_call_id, source_seq, created_at, last_used_at)
     VALUES (:id, :scope, :project, :text, :sessionId, :runId, :step, :callId, :seq, :now, :now)
     ON CONFLICT (source_run_id, source_call_id) DO NOTHING`,
  );
  const bySource = db.prepare('SELECT * FROM memories WHERE source_run_id = :runId AND source_call_id = :callId');
  const byId = db.prepare('SELECT * FROM memories WHERE id = :id');
  const all = db.prepare('SELECT * FROM memories ORDER BY created_at, id');
  const byScope = db.prepare('SELECT * FROM memories WHERE scope = :scope ORDER BY created_at, id');
  const byProject = db.prepare('SELECT * FROM memories WHERE project = :project ORDER BY created_at, id');
  const visibleWithProject = db.prepare(`SELECT * FROM memories WHERE scope = 'user' OR project = :project ${RECENCY}`);
  const visibleUserOnly = db.prepare(`SELECT * FROM memories WHERE scope = 'user' ${RECENCY}`);
  const touch = db.prepare('UPDATE memories SET last_used_at = :now WHERE id = :id');
  const remove = db.prepare('DELETE FROM memories WHERE id = :id');

  const requireSource = (input: SaveMemoryInput): { seq: number; sessionId: string } => {
    const row = toolCallEvent.get({ runId: input.runId, callId: input.callId });
    if (row === undefined) throw new Error(`memory source ${input.runId}/${input.callId} has no recorded tool.call event`);
    const reader = readerFor('events', `${input.runId}/${input.callId}`, row);
    return { seq: reader.number('seq'), sessionId: reader.string('session_id') };
  };

  const visible = (project: string | undefined): MemoryRecord[] =>
    (project === undefined ? visibleUserOnly.all() : visibleWithProject.all({ project })).map(decodeMemory);

  return {
    save: (input) =>
      immediateTx(db, () => {
        if ((input.scope === 'project') !== (input.project !== null)) {
          throw new RangeError(`a ${input.scope} memory ${input.scope === 'project' ? 'requires' : 'cannot carry'} a project`);
        }
        const source = requireSource(input);
        const inserted = insert.run({
          id: uuidv7(clock),
          scope: input.scope,
          project: input.project,
          text: input.text,
          sessionId: source.sessionId,
          runId: input.runId,
          step: input.step,
          callId: input.callId,
          seq: source.seq,
          now: clock.now(),
        });
        const row = bySource.get({ runId: input.runId, callId: input.callId });
        if (row === undefined) throw new Error(`memory ${input.runId}/${input.callId} vanished after it was saved`);
        return { memory: decodeMemory(row), created: Number(inserted.changes) === 1 };
      }),
    get: (id) => {
      const row = byId.get({ id });
      return row === undefined ? undefined : decodeMemory(row);
    },
    list: (filter = {}) => {
      if (filter.project !== undefined) return byProject.all({ project: filter.project }).map(decodeMemory);
      if (filter.scope !== undefined) return byScope.all({ scope: filter.scope }).map(decodeMemory);
      return all.all().map(decodeMemory);
    },
    recall: visible,
    search: (project, terms) => {
      const needles = terms.map((term) => term.toLowerCase());
      return visible(project).filter((memory) => needles.every((needle) => memory.text.toLowerCase().includes(needle)));
    },
    markUsed: (ids) => {
      const now = clock.now();
      immediateTx(db, () => {
        for (const id of ids) touch.run({ id, now });
      });
    },
    delete: (id) => Number(remove.run({ id }).changes) === 1,
  };
};
