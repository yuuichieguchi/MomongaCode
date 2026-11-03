import type { DatabaseSync } from 'node:sqlite';
import { immediateTx } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { hasForbiddenGuidelineCharacter } from '@momonga/protocol';
import { expectRecord, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import type { Guideline, GuidelineStore } from './types.ts';

export class GuidelineConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuidelineConflictError';
  }
}

export class GuidelineTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuidelineTextError';
  }
}

const decodeGuideline =(row: Row): Guideline => {
  const identity = String(row['version']);
  const reader = readerFor('compaction_guidelines', identity, row);
  return {
    version: reader.number('version'),
    text: reader.string('text'),
    parent: reader.nullableNumber('parent'),
    createdAt: reader.number('created_at'),
    adoptedAt: reader.number('adopted_at'),
    report: expectRecord('compaction_guidelines', identity, 'report_json', reader.json('report_json')),
  };
};

export const createGuidelineStore = (db: DatabaseSync, clock: Clock): GuidelineStore => {
  const insert = db.prepare(
    `INSERT INTO compaction_guidelines (version, text, parent, created_at, adopted_at, report_json)
     VALUES (:version, :text, :parent, :now, :now, :report)`,
  );
  const latest = db.prepare('SELECT * FROM compaction_guidelines WHERE adopted_at IS NOT NULL ORDER BY version DESC LIMIT 1');
  const byVersion = db.prepare('SELECT * FROM compaction_guidelines WHERE version = :version');
  const all = db.prepare('SELECT * FROM compaction_guidelines ORDER BY version');

  const current = (): Guideline | undefined => {
    const row = latest.get();
    return row === undefined ? undefined : decodeGuideline(row);
  };

  const append = (text: string, parent: number | null, report: Guideline['report']): Guideline => {
    const headVersion = current()?.version ?? null;
    if (parent !== headVersion) {
      throw new GuidelineConflictError(
        `the guideline was adopted on ${parent === null ? 'no version' : `version ${parent}`}, but ${headVersion === null ? 'none is adopted' : `version ${headVersion} is current`}`,
      );
    }
    const version = (headVersion ?? 0) + 1;
    insert.run({ version, text, parent, now: clock.now(), report: JSON.stringify(report) });
    const row = byVersion.get({ version });
    if (row === undefined) throw new Error('a guideline vanished after it was adopted');
    return decodeGuideline(row);
  };

  return {
    current,
    get: (version) => {
      const row = byVersion.get({ version });
      return row === undefined ? undefined : decodeGuideline(row);
    },
    list: () => all.all().map(decodeGuideline),
    adopt: (input) => {
      if (hasForbiddenGuidelineCharacter(input.text)) {
        throw new GuidelineTextError('a guideline holds no control character except a newline and a tab, because it could hide itself when printed');
      }
      return immediateTx(db, () => append(input.text, input.parent, input.report));
    },
    rollback: (version) =>
      immediateTx(db, () => {
        const row = byVersion.get({ version });
        if (row === undefined) throw new Error(`no guideline version ${version}`);
        const target = decodeGuideline(row);
        return append(target.text, current()?.version ?? null, { rollbackTo: version });
      }),
  };
};
