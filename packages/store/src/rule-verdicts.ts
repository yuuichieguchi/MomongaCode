import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { isFinalRuleVerdict, isRuleVerdict } from '@momonga/protocol';
import type { RuleVerdict } from '@momonga/protocol';
import { corrupt, readerFor } from './rows.ts';

export type StoredRuleVerdict = { fingerprint: string; verdict: RuleVerdict; createdAt: number };

export type RuleVerdictStore = {
  get(fingerprint: string): StoredRuleVerdict | undefined;
  put(fingerprint: string, verdict: RuleVerdict): void;
};

export const createRuleVerdictStore = (db: DatabaseSync, clock: Clock): RuleVerdictStore => {
  const select = db.prepare('SELECT verdict_json, created_at FROM rule_verdicts WHERE fingerprint = :fingerprint');
  const insert = db.prepare(
    `INSERT INTO rule_verdicts (fingerprint, verdict_json, solver_version, created_at) VALUES (:fingerprint, :verdict, :solver, :createdAt)
     ON CONFLICT (fingerprint) DO UPDATE SET verdict_json = excluded.verdict_json, solver_version = excluded.solver_version, created_at = excluded.created_at`,
  );
  return {
    get: (fingerprint) => {
      const row = select.get({ fingerprint });
      if (row === undefined) return undefined;
      const reader = readerFor('rule_verdicts', fingerprint, row);
      const verdict = reader.json('verdict_json');
      if (!isRuleVerdict(verdict)) throw corrupt('rule_verdicts', fingerprint, 'column verdict_json does not hold a verdict');
      return isFinalRuleVerdict(verdict) ? { fingerprint, verdict, createdAt: reader.number('created_at') } : undefined;
    },
    put: (fingerprint, verdict) => {
      if (!isFinalRuleVerdict(verdict)) throw new Error(`a rule verdict of kind ${verdict.verdict} is not stored: only a proved or refuted rule set is a final answer`);
      insert.run({ fingerprint, verdict: canonicalJson(verdict), solver: verdict.solver, createdAt: clock.now() });
    },
  };
};
