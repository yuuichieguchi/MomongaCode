import type { DatabaseSync } from 'node:sqlite';
import { immediateTx, uuidv7 } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { GOVERNING_ENFORCEMENT_BEHAVIORS, GOVERNING_KINDS } from '@momonga/protocol';
import type { GoverningFactView } from '@momonga/protocol';
import { corrupt, expectOneOf, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import { revisionChain } from './revision-chain.ts';
import type { AddGoverningFactInput, GoverningAdmissionResult, GoverningFactStore } from './types.ts';

const SOURCE_KINDS = ['command', 'proposal'] as const;

const SCOPE_LEVELS = ['user', 'project'] as const;

const decodeStrings = (identity: string, column: string, value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw corrupt('governing_facts', identity, `column ${column} must be a JSON array of strings`);
  return value as string[];
};

const decodeFact = (row: Row): GoverningFactView => {
  const identity = String(row['id']);
  const reader = readerFor('governing_facts', identity, row);
  const level = expectOneOf('governing_facts', identity, 'scope_level', SCOPE_LEVELS, reader.string('scope_level'));
  const behavior = reader.nullableString('enforcement_behavior');
  const rule = reader.nullableString('enforcement_rule');
  const sourceKind = expectOneOf('governing_facts', identity, 'source_kind', SOURCE_KINDS, reader.string('source_kind'));
  return {
    id: reader.string('id'),
    kind: expectOneOf('governing_facts', identity, 'kind', GOVERNING_KINDS, reader.string('kind')),
    target: reader.string('target'),
    text: reader.string('text'),
    scope: level === 'user' ? { level } : { level, project: reader.string('project'), paths: decodeStrings(identity, 'paths_json', reader.json('paths_json')) },
    validFrom: reader.number('valid_from'),
    validUntil: reader.nullableNumber('valid_until'),
    retiredAt: reader.nullableNumber('retired_at'),
    supersedes: decodeStrings(identity, 'supersedes_json', reader.json('supersedes_json')),
    enforcement:
      behavior === null || rule === null ? null : { behavior: expectOneOf('governing_facts', identity, 'enforcement_behavior', GOVERNING_ENFORCEMENT_BEHAVIORS, behavior), rule },
    source:
      sourceKind === 'command'
        ? { kind: sourceKind, at: reader.number('source_at') }
        : {
            kind: sourceKind,
            sessionId: reader.string('source_session_id'),
            runId: reader.string('source_run_id'),
            seq: reader.number('source_seq'),
            callId: reader.string('source_call_id'),
          },
  };
};

export const createGoverningFactStore = (db: DatabaseSync, clock: Clock): GoverningFactStore => {
  const insert = db.prepare(
    `INSERT INTO governing_facts (id, kind, target, text, scope_level, project, paths_json, valid_from, valid_until, supersedes_json,
       enforcement_behavior, enforcement_rule, source_kind, source_at, source_session_id, source_run_id, source_seq, source_call_id)
     VALUES (:id, :kind, :target, :text, :level, :project, :pathsJson, :now, :validUntil, :supersedesJson,
       :behavior, :rule, :sourceKind, :sourceAt, :sessionId, :runId, :seq, :callId)`,
  );
  const byId = db.prepare('SELECT * FROM governing_facts WHERE id = :id');
  const byProposal = db.prepare("SELECT * FROM governing_facts WHERE source_kind = 'proposal' AND source_run_id = :runId AND source_call_id = :callId");
  const all = db.prepare('SELECT * FROM governing_facts ORDER BY valid_from, id');
  const ofProject = db.prepare("SELECT * FROM governing_facts WHERE scope_level = 'user' OR project = :project ORDER BY valid_from, id");
  const successors = db.prepare('SELECT g.* FROM governing_facts g, json_each(g.supersedes_json) AS replaced WHERE replaced.value = :id');
  const retireOnce = db.prepare('UPDATE governing_facts SET retired_at = :now WHERE id = :id AND retired_at IS NULL');

  const get = (id: string): GoverningFactView | undefined => {
    const row = byId.get({ id });
    return row === undefined ? undefined : decodeFact(row);
  };

  const insertFact = (input: AddGoverningFactInput): { fact: GoverningFactView; created: boolean } => {
    const now = clock.now();
    const { source } = input;
    if (source.kind === 'proposal') {
      const existing = byProposal.get({ runId: source.runId, callId: source.callId });
      if (existing !== undefined) return { fact: decodeFact(existing), created: false };
    }
    const id = uuidv7(clock);
    insert.run({
      id,
      kind: input.kind,
      target: input.target,
      text: input.text,
      level: input.scope.level,
      project: input.scope.level === 'project' ? input.scope.project : null,
      pathsJson: JSON.stringify(input.scope.level === 'project' ? input.scope.paths : []),
      now,
      validUntil: input.validUntil,
      supersedesJson: JSON.stringify(input.supersedes),
      behavior: input.enforcement?.behavior ?? null,
      rule: input.enforcement?.rule ?? null,
      sourceKind: source.kind,
      sourceAt: source.kind === 'command' ? now : null,
      sessionId: source.kind === 'proposal' ? source.sessionId : null,
      runId: source.kind === 'proposal' ? source.runId : null,
      seq: source.kind === 'proposal' ? source.seq : null,
      callId: source.kind === 'proposal' ? source.callId : null,
    });
    const fact = get(id);
    if (fact === undefined) throw new Error(`governing fact ${id} vanished after it was added`);
    return { fact, created: true };
  };

  return {
    add: (input) => immediateTx(db, () => insertFact(input)),
    addAdmitted: (input, admit) =>
      immediateTx(db, (): GoverningAdmissionResult => {
        const { source } = input;
        if (source.kind === 'proposal') {
          const replayed = byProposal.get({ runId: source.runId, callId: source.callId });
          if (replayed !== undefined) return { kind: 'added', fact: decodeFact(replayed), created: false };
        }
        const admission = admit(all.all().map(decodeFact));
        if (!admission.ok) return { kind: 'refused', message: admission.message };
        return { kind: 'added', ...insertFact(input) };
      }),
    get,
    list: (filter) => (filter === undefined ? all.all() : ofProject.all({ project: filter.project })).map(decodeFact),
    retire: (id) =>
      immediateTx(db, () => {
        if (get(id) === undefined) return undefined;
        const retired = Number(retireOnce.run({ id, now: clock.now() }).changes) === 1;
        const fact = get(id);
        if (fact === undefined) throw new Error(`governing fact ${id} vanished after it was retired`);
        return { retired, fact };
      }),
    history: (id) => {
      const start = get(id);
      if (start === undefined) return [];
      return revisionChain(start, { byId: get, successorsOf: (successor) => successors.all({ id: successor }).map(decodeFact) }, (fact) => fact.validFrom);
    },
  };
};
