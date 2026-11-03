import type { DatabaseSync } from 'node:sqlite';
import { immediateTx, uuidv7 } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { DEFAULT_MEMORY_KIND, MEMORY_EVIDENCE_KINDS, MEMORY_KINDS, MEMORY_ORIGINS, MEMORY_SCOPES, MEMORY_STATES } from '@momonga/protocol';
import type { MemoryEvidence, MemoryOrigin, MemoryScope, MemorySource, MemoryState } from '@momonga/protocol';
import { corrupt, expectOneOf, readerFor } from './rows.ts';
import type { Row, RowReader } from './rows.ts';
import { revisionChain } from './revision-chain.ts';
import { asciiLower, instrFilters, partitionTerms, quoted } from './search-terms.ts';
import type { MemoryChange, MemoryRecord, MemoryStore, MemoryVisibility, SaveMemoryInput } from './types.ts';

const REFLECTION_SOURCE_STEP = 0;

const REFLECTION_SOURCE_SEQ = 0;

const REFLECTION_CALL_ID = /^reflection:(\d+)$/;

const SOURCE_KINDS = ['tool', 'reflection', 'command'] as const;

const decodeSource = (identity: string, reader: RowReader): MemorySource => {
  const kind = expectOneOf('memories', identity, 'source_kind', SOURCE_KINDS, reader.string('source_kind'));
  if (kind === 'command') return { kind, at: reader.number('created_at') };
  const sessionId = reader.string('source_session_id');
  const runId = reader.string('source_run_id');
  const callId = reader.string('source_call_id');
  if (kind === 'tool') return { kind, sessionId, runId, step: reader.number('source_step'), callId, seq: reader.number('source_seq') };
  const match = REFLECTION_CALL_ID.exec(callId);
  if (match === null) throw corrupt('memories', identity, `reflection source_call_id ${callId} does not name an ordinal`);
  return { kind, sessionId, runId, ordinal: Number(match[1]) };
};

const decodeStringList = (identity: string, reader: RowReader, column: string): string[] => {
  const value = reader.json(column);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw corrupt('memories', identity, `column ${column} must be a JSON array of strings`);
  return value as string[];
};

const decodeEvidence = (memoryId: string, row: Row): MemoryEvidence => {
  const identity = `${memoryId}/${String(row['ordinal'])}`;
  const reader = readerFor('memory_evidence', identity, row);
  const kind = expectOneOf('memory_evidence', identity, 'kind', MEMORY_EVIDENCE_KINDS, reader.string('kind'));
  switch (kind) {
    case 'file':
      return { kind, project: reader.string('project'), path: reader.string('path'), sha256: reader.string('sha256') };
    case 'commit':
      return { kind, sha: reader.string('sha') };
    case 'check':
      return { kind, runId: reader.string('run_id'), callId: reader.string('call_id'), seq: reader.number('seq'), command: reader.string('command'), exitCode: reader.number('exit_code') };
  }
};

const decodeMemory = (row: Row, evidence: MemoryEvidence[], supersededBy: string[]): MemoryRecord => {
  const identity = String(row['id']);
  const reader = readerFor('memories', identity, row);
  const scope: MemoryScope = expectOneOf('memories', identity, 'scope', MEMORY_SCOPES, reader.string('scope'));
  const origin: MemoryOrigin = expectOneOf('memories', identity, 'origin', MEMORY_ORIGINS, reader.string('origin'));
  const project = reader.nullableString('project');
  if ((scope === 'project') !== (project !== null)) throw corrupt('memories', identity, `scope ${scope} does not match project ${String(project)}`);
  return {
    id: reader.string('id'),
    scope,
    origin,
    project,
    text: reader.string('text'),
    source: decodeSource(identity, reader),
    createdAt: reader.number('created_at'),
    lastUsedAt: reader.number('last_used_at'),
    kind: expectOneOf('memories', identity, 'kind', MEMORY_KINDS, reader.string('kind')),
    state: expectOneOf('memories', identity, 'state', MEMORY_STATES, reader.string('state')),
    duplicateOf: reader.nullableString('duplicate_of'),
    supersedes: decodeStringList(identity, reader, 'supersedes_json'),
    supersededBy,
    retiredAt: reader.nullableNumber('retired_at'),
    contributedAt: reader.nullableNumber('contributed_at'),
    evidence,
  };
};

const RECENCY = 'ORDER BY last_used_at DESC, created_at DESC, id';

const RECALLABLE = `state = 'active' AND retired_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM memory_replacements AS r JOIN memories AS successor ON successor.id = r.successor_id
  WHERE r.replaced_id = memories.id AND successor.state <> 'candidate'
)`;

const VISIBLE_TRUSTED = "((scope = 'user' AND origin = 'trusted') OR project = :project)";

const VISIBLE_UNTRUSTED = "scope = 'user'";

const indexMatch = (parameter: string): string => `memories.id IN (SELECT memory_id FROM memories_index WHERE memories_index MATCH ${parameter})`;

export const createMemoryStore = (db: DatabaseSync, clock: Clock): MemoryStore => {
  const toolCallEvent = db.prepare(
    "SELECT seq, session_id FROM events WHERE run_id = :runId AND type = 'tool.call' AND json_extract(payload_json, '$.callId') = :callId LIMIT 1",
  );
  const insert = db.prepare(
    `INSERT INTO memories (id, scope, origin, project, text, source_session_id, source_run_id, source_step, source_call_id, source_seq, created_at, last_used_at, kind, supersedes_json)
     VALUES (:id, :scope, :origin, :project, :text, :sessionId, :runId, :step, :callId, :seq, :now, :now, :kind, :supersedesJson)`,
  );
  const insertByCommand = db.prepare(
    `INSERT INTO memories (id, scope, origin, project, text, created_at, last_used_at, kind, source_kind)
     VALUES (:id, :scope, 'trusted', :project, :text, :now, :now, :kind, 'command')`,
  );
  const insertEvidence = db.prepare(
    `INSERT INTO memory_evidence (memory_id, ordinal, kind, project, path, sha256, sha, run_id, call_id, seq, command, exit_code)
     VALUES (:memoryId, :ordinal, :kind, :project, :path, :sha256, :sha, :runId, :callId, :seq, :command, :exitCode)`,
  );
  const successors = db.prepare('SELECT m.* FROM memory_replacements r JOIN memories m ON m.id = r.successor_id WHERE r.replaced_id = :id');
  const retireOnce = db.prepare('UPDATE memories SET retired_at = :now WHERE id = :id AND retired_at IS NULL');
  const bySource = db.prepare('SELECT * FROM memories WHERE source_run_id = :runId AND source_call_id = :callId');
  const byId = db.prepare('SELECT * FROM memories WHERE id = :id');
  const all = db.prepare('SELECT * FROM memories ORDER BY created_at, id');
  const byScope = db.prepare('SELECT * FROM memories WHERE scope = :scope ORDER BY created_at, id');
  const byProject = db.prepare('SELECT * FROM memories WHERE project = :project ORDER BY created_at, id');
  const visibleInTrustedProject = db.prepare(`SELECT * FROM memories WHERE ${VISIBLE_TRUSTED} AND ${RECALLABLE} ${RECENCY}`);
  const visibleUntrusted = db.prepare(`SELECT * FROM memories WHERE ${VISIBLE_UNTRUSTED} AND ${RECALLABLE} ${RECENCY}`);
  const evidenceOf = db.prepare('SELECT * FROM memory_evidence WHERE memory_id = :id ORDER BY ordinal');
  const replacedBy = db.prepare(
    "SELECT m.id FROM memory_replacements r JOIN memories m ON m.id = r.successor_id WHERE r.replaced_id = :id AND m.state <> 'candidate' ORDER BY m.created_at, m.id",
  );
  const decode = (row: Row): MemoryRecord => {
    const id = String(row['id']);
    return decodeMemory(
      row,
      evidenceOf.all({ id }).map((evidenceRow) => decodeEvidence(id, evidenceRow)),
      replacedBy.all({ id }).map((successor) => readerFor('memories', id, successor).string('id')),
    );
  };
  const touch = db.prepare('UPDATE memories SET last_used_at = :now WHERE id = :id');
  const stamp = db.prepare('UPDATE memories SET contributed_at = :now WHERE id = :id AND contributed_at IS NULL');
  const remove = db.prepare('DELETE FROM memories WHERE id = :id');
  const supersededIds = db.prepare(
    "SELECT DISTINCT r.replaced_id AS id FROM memory_replacements r JOIN memories successor ON successor.id = r.successor_id WHERE successor.state <> 'candidate'",
  );
  const activePage = db.prepare(
    "SELECT * FROM memories WHERE state = 'active' AND retired_at IS NULL AND (created_at, id) > (:createdAt, :id) ORDER BY created_at, id LIMIT :limit",
  );
  let revision = 0;
  const insertCandidate = db.prepare(
    `INSERT INTO memories (id, scope, origin, project, text, source_session_id, source_run_id, source_step, source_call_id, source_seq, created_at, last_used_at, kind, state, source_kind)
     VALUES (:id, :scope, :origin, :project, :text, :sessionId, :runId, ${REFLECTION_SOURCE_STEP}, :callId, ${REFLECTION_SOURCE_SEQ}, :now, :now, :kind, 'candidate', 'reflection')`,
  );
  const sessionOfRun = db.prepare('SELECT session_id FROM runs WHERE id = :runId');
  const candidateRows = db.prepare("SELECT * FROM memories WHERE state = 'candidate' ORDER BY created_at, id");
  const candidateRowsOfProject = db.prepare("SELECT * FROM memories WHERE state = 'candidate' AND project = :project ORDER BY created_at, id");
  const moveState = db.prepare(
    'UPDATE memories SET state = :to, duplicate_of = :duplicateOf, last_used_at = CASE WHEN :touched = 1 THEN :now ELSE last_used_at END WHERE id = :id AND state = :from',
  );

  const change = <Done extends string, Refused extends string>(
    id: string,
    from: MemoryState,
    to: MemoryState,
    outcome: { done: Done; refused: Refused },
    options: { duplicateOf?: string; touched?: boolean } = {},
  ): MemoryChange<Done, Refused> =>
    immediateTx(db, () => {
      if (byId.get({ id }) === undefined) return { kind: 'not_found' };
      const moved = Number(moveState.run({ id, from, to, duplicateOf: options.duplicateOf ?? null, touched: options.touched === true ? 1 : 0, now: clock.now() }).changes) === 1;
      const row = byId.get({ id });
      if (row === undefined) throw new Error(`memory ${id} vanished after it was changed`);
      if (moved) revision += 1;
      return moved ? { kind: outcome.done, memory: decode(row) } : { kind: outcome.refused, memory: decode(row) };
    });

  const requireSource = (input: SaveMemoryInput): { seq: number; sessionId: string } => {
    const row = toolCallEvent.get({ runId: input.runId, callId: input.callId });
    if (row === undefined) throw new Error(`memory source ${input.runId}/${input.callId} has no recorded tool.call event`);
    const reader = readerFor('events', `${input.runId}/${input.callId}`, row);
    return { seq: reader.number('seq'), sessionId: reader.string('session_id') };
  };

  const visible = (visibility: MemoryVisibility): MemoryRecord[] =>
    (visibility.trusted ? visibleInTrustedProject.all({ project: visibility.project }) : visibleUntrusted.all()).map(decode);

  const visibilityOf = (visibility: MemoryVisibility): { sql: string; params: Record<string, string> } =>
    visibility.trusted ? { sql: VISIBLE_TRUSTED, params: { project: visibility.project } } : { sql: VISIBLE_UNTRUSTED, params: {} };

  const evidenceParams = (memoryId: string, ordinal: number, entry: MemoryEvidence) => ({
    memoryId,
    ordinal,
    kind: entry.kind,
    project: entry.kind === 'file' ? entry.project : null,
    path: entry.kind === 'file' ? entry.path : null,
    sha256: entry.kind === 'file' ? entry.sha256 : null,
    sha: entry.kind === 'commit' ? entry.sha : null,
    runId: entry.kind === 'check' ? entry.runId : null,
    callId: entry.kind === 'check' ? entry.callId : null,
    seq: entry.kind === 'check' ? entry.seq : null,
    command: entry.kind === 'check' ? entry.command : null,
    exitCode: entry.kind === 'check' ? entry.exitCode : null,
  });

  return {
    save: (input) =>
      immediateTx(db, () => {
        if ((input.scope === 'project') !== (input.project !== null)) {
          throw new RangeError(`a ${input.scope} memory ${input.scope === 'project' ? 'requires' : 'cannot carry'} a project`);
        }
        const existing = bySource.get({ runId: input.runId, callId: input.callId });
        if (existing !== undefined) return { memory: decode(existing), created: false };
        const source = requireSource(input);
        const supersedes = input.supersedes ?? [];
        for (const id of supersedes) {
          if (byId.get({ id }) === undefined) throw new RangeError(`memory ${id} cannot be superseded: it does not exist`);
        }
        const id = uuidv7(clock);
        insert.run({
          id,
          scope: input.scope,
          origin: input.origin,
          project: input.project,
          text: input.text,
          sessionId: source.sessionId,
          runId: input.runId,
          step: input.step,
          callId: input.callId,
          seq: source.seq,
          now: clock.now(),
          kind: input.kind ?? DEFAULT_MEMORY_KIND,
          supersedesJson: JSON.stringify(supersedes),
        });
        (input.evidence ?? []).forEach((entry, ordinal) => void insertEvidence.run(evidenceParams(id, ordinal, entry)));
        const row = bySource.get({ runId: input.runId, callId: input.callId });
        if (row === undefined) throw new Error(`memory ${input.runId}/${input.callId} vanished after it was saved`);
        revision += 1;
        return { memory: decode(row), created: true };
      }),
    addByCommand: (input) =>
      immediateTx(db, () => {
        if ((input.scope === 'project') !== (input.project !== null)) {
          throw new RangeError(`a ${input.scope} memory ${input.scope === 'project' ? 'requires' : 'cannot carry'} a project`);
        }
        const id = uuidv7(clock);
        insertByCommand.run({ id, scope: input.scope, project: input.project, text: input.text, now: clock.now(), kind: input.kind ?? DEFAULT_MEMORY_KIND });
        input.evidence.forEach((entry, ordinal) => void insertEvidence.run(evidenceParams(id, ordinal, entry)));
        const row = byId.get({ id });
        if (row === undefined) throw new Error(`memory ${id} vanished after it was added`);
        revision += 1;
        return decode(row);
      }),
    saveCandidate: (input) =>
      immediateTx(db, () => {
        if ((input.scope === 'project') !== (input.project !== null)) {
          throw new RangeError(`a ${input.scope} memory ${input.scope === 'project' ? 'requires' : 'cannot carry'} a project`);
        }
        const callId = `reflection:${input.ordinal}`;
        const existing = bySource.get({ runId: input.runId, callId });
        if (existing !== undefined) return { memory: decode(existing), created: false };
        const session = sessionOfRun.get({ runId: input.runId });
        if (session === undefined) throw new Error(`memory source run ${input.runId} does not exist`);
        const id = uuidv7(clock);
        insertCandidate.run({
          id,
          scope: input.scope,
          origin: input.origin,
          project: input.project,
          text: input.text,
          sessionId: readerFor('runs', input.runId, session).string('session_id'),
          runId: input.runId,
          callId,
          now: clock.now(),
          kind: input.kind,
        });
        input.evidence.forEach((entry, ordinal) => void insertEvidence.run(evidenceParams(id, ordinal, entry)));
        const row = bySource.get({ runId: input.runId, callId });
        if (row === undefined) throw new Error(`memory ${input.runId}/${callId} vanished after it was saved`);
        revision += 1;
        return { memory: decode(row), created: true };
      }),
    revision: () => revision,
    supersededIds: () => new Set(supersededIds.all().map((row) => String(row['id']))),
    activePage: (after, limit) =>
      activePage.all({ createdAt: after?.createdAt ?? -1, id: after?.id ?? '', limit }).map((row) => {
        const id = String(row['id']);
        return decodeMemory(row, evidenceOf.all({ id }).map((evidenceRow) => decodeEvidence(id, evidenceRow)), []);
      }),
    candidates: (filter = {}) => (filter.project === undefined ? candidateRows.all() : candidateRowsOfProject.all({ project: filter.project })).map(decode),
    accept: (id) => change(id, 'candidate', 'active', { done: 'accepted', refused: 'not_candidate' }, { touched: true }),
    reject: (id) => change(id, 'candidate', 'rejected', { done: 'rejected', refused: 'not_candidate' }),
    markDuplicate: (id, of) => {
      if (byId.get({ id: of }) === undefined) throw new RangeError(`memory ${of} cannot be the original of ${id}: it does not exist`);
      return change(id, 'active', 'duplicate', { done: 'marked', refused: 'not_active' }, { duplicateOf: of });
    },
    archive: (id) => change(id, 'active', 'archived', { done: 'archived', refused: 'not_active' }),
    restore: (id) => change(id, 'archived', 'active', { done: 'restored', refused: 'not_archived' }, { touched: true }),
    get: (id) => {
      const row = byId.get({ id });
      return row === undefined ? undefined : decode(row);
    },
    list: (filter = {}) => {
      if (filter.project !== undefined) return byProject.all({ project: filter.project }).map(decode);
      if (filter.scope !== undefined) return byScope.all({ scope: filter.scope }).map(decode);
      return all.all().map(decode);
    },
    recall: visible,
    search: (visibility, terms, options = { include: 'live' }) => {
      const { indexed, short } = partitionTerms(terms.map(asciiLower));
      const filters = instrFilters('memories.text', short);
      const scope = visibilityOf(visibility);
      const live = options.include === 'live' ? ` AND ${RECALLABLE}` : '';
      const match = indexed.length === 0 ? '' : ` AND ${indexMatch(':match')}`;
      const params = { ...scope.params, ...filters.params, ...(indexed.length === 0 ? {} : { match: indexed.map(quoted).join(' ') }) };
      return db
        .prepare(`SELECT * FROM memories WHERE ${scope.sql}${live}${match}${filters.sql} ${RECENCY}`)
        .all(params)
        .map(decode);
    },
    matchingIds: (visibility, terms) => {
      const { indexed, short } = partitionTerms(terms.map(asciiLower));
      const scope = visibilityOf(visibility);
      const alternatives = [
        ...(indexed.length === 0 ? [] : [indexMatch(':match')]),
        ...short.map((_term, index) => `instr(lower(memories.text), :short${index}) > 0`),
      ];
      if (alternatives.length === 0) return new Set();
      const params = {
        ...scope.params,
        ...Object.fromEntries(short.map((term, index) => [`short${index}`, term])),
        ...(indexed.length === 0 ? {} : { match: indexed.map(quoted).join(' OR ') }),
      };
      const rows = db.prepare(`SELECT id FROM memories WHERE ${scope.sql} AND ${RECALLABLE} AND (${alternatives.join(' OR ')})`).all(params);
      return new Set(rows.map((row) => readerFor('memories', 'matching', row).string('id')));
    },
    retire: (id) =>
      immediateTx(db, () => {
        const before = byId.get({ id });
        if (before === undefined) return undefined;
        const retired = Number(retireOnce.run({ id, now: clock.now() }).changes) === 1;
        const row = byId.get({ id });
        if (row === undefined) throw new Error(`memory ${id} vanished after it was retired`);
        if (retired) revision += 1;
        return { retired, memory: decode(row) };
      }),
    history: (id) => {
      const start = byId.get({ id });
      if (start === undefined) return [];
      const lookup = {
        byId: (memoryId: string): MemoryRecord | undefined => {
          const row = byId.get({ id: memoryId });
          return row === undefined ? undefined : decode(row);
        },
        successorsOf: (memoryId: string): MemoryRecord[] => successors.all({ id: memoryId }).map(decode),
      };
      return revisionChain(decode(start), lookup, (memory) => memory.createdAt);
    },
    markUsed: (ids) => {
      const now = clock.now();
      immediateTx(db, () => {
        for (const id of ids) touch.run({ id, now });
      });
    },
    stampContributed: (ids) => {
      const now = clock.now();
      for (const id of ids) stamp.run({ id, now });
    },
    delete: (id) => {
      const removed = Number(remove.run({ id }).changes) === 1;
      if (removed) revision += 1;
      return removed;
    },
  };
};
