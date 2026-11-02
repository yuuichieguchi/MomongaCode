import type { DatabaseSync } from 'node:sqlite';
import { immediateTx, uuidv7 } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { MEMORY_EVIDENCE_KINDS, MEMORY_KINDS, MEMORY_ORIGINS, MEMORY_SCOPES, MEMORY_STATES } from '@momonga/protocol';
import type { MemoryEvidence, MemoryOrigin, MemoryScope, MemorySource } from '@momonga/protocol';
import { corrupt, expectOneOf, readerFor } from './rows.ts';
import type { Row, RowReader } from './rows.ts';
import { revisionChain } from './revision-chain.ts';
import { asciiLower, instrFilters, partitionTerms, quoted } from './search-terms.ts';
import type { MemoryRecord, MemoryStore, MemoryVisibility, SaveMemoryInput } from './types.ts';

const REFLECTION_CALL_ID = /^reflection:(\d+)$/;

const SOURCE_KINDS = ['tool', 'reflection'] as const;

const decodeSource = (identity: string, reader: RowReader): MemorySource => {
  const kind = expectOneOf('memories', identity, 'source_kind', SOURCE_KINDS, reader.string('source_kind'));
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

const decodeMemory = (row: Row, evidence: MemoryEvidence[]): MemoryRecord => {
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
    retiredAt: reader.nullableNumber('retired_at'),
    contributedAt: reader.nullableNumber('contributed_at'),
    evidence,
  };
};

const RECENCY = 'ORDER BY last_used_at DESC, created_at DESC, id';

const DEFAULT_MEMORY_KIND = 'fact';

const RECALLABLE = `state = 'active' AND retired_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM memories AS successor, json_each(successor.supersedes_json) AS replaced
  WHERE replaced.value = memories.id AND successor.state <> 'candidate'
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
  const insertEvidence = db.prepare(
    `INSERT INTO memory_evidence (memory_id, ordinal, kind, project, path, sha256, sha, run_id, call_id, seq, command, exit_code)
     VALUES (:memoryId, :ordinal, :kind, :project, :path, :sha256, :sha, :runId, :callId, :seq, :command, :exitCode)`,
  );
  const successors = db.prepare('SELECT m.* FROM memories m, json_each(m.supersedes_json) AS replaced WHERE replaced.value = :id');
  const retireOnce = db.prepare('UPDATE memories SET retired_at = :now WHERE id = :id AND retired_at IS NULL');
  const bySource = db.prepare('SELECT * FROM memories WHERE source_run_id = :runId AND source_call_id = :callId');
  const byId = db.prepare('SELECT * FROM memories WHERE id = :id');
  const all = db.prepare('SELECT * FROM memories ORDER BY created_at, id');
  const byScope = db.prepare('SELECT * FROM memories WHERE scope = :scope ORDER BY created_at, id');
  const byProject = db.prepare('SELECT * FROM memories WHERE project = :project ORDER BY created_at, id');
  const visibleInTrustedProject = db.prepare(`SELECT * FROM memories WHERE ${VISIBLE_TRUSTED} AND ${RECALLABLE} ${RECENCY}`);
  const visibleUntrusted = db.prepare(`SELECT * FROM memories WHERE ${VISIBLE_UNTRUSTED} AND ${RECALLABLE} ${RECENCY}`);
  const evidenceOf = db.prepare('SELECT * FROM memory_evidence WHERE memory_id = :id ORDER BY ordinal');
  const decode = (row: Row): MemoryRecord => {
    const id = String(row['id']);
    return decodeMemory(
      row,
      evidenceOf.all({ id }).map((evidenceRow) => decodeEvidence(id, evidenceRow)),
    );
  };
  const touch = db.prepare('UPDATE memories SET last_used_at = :now WHERE id = :id');
  const remove = db.prepare('DELETE FROM memories WHERE id = :id');

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
        return { memory: decode(row), created: true };
      }),
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
    delete: (id) => Number(remove.run({ id }).changes) === 1,
  };
};
