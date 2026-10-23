import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { comparableContains, type Clock } from '@momonga/foundation';
import { expectOneOf, readerFor } from './rows.ts';
import type { TrustDecision, TrustStore } from './types.ts';

const DECISIONS = ['trusted', 'untrusted'] as const;

export const createTrustStore = (db: DatabaseSync, clock: Clock, home: string): TrustStore => {
  const select = db.prepare('SELECT * FROM trust WHERE path = :path');
  const upsert = db.prepare(
    `INSERT INTO trust (path, decision, decided_at) VALUES (:path, :decision, :decidedAt)
     ON CONFLICT (path) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at`,
  );
  const remove = db.prepare('DELETE FROM trust WHERE path = :path');
  const decisionAt = (real: string): TrustDecision | undefined => {
    const row = select.get({ path: real });
    if (row === undefined) return undefined;
    return expectOneOf('trust', real, 'decision', DECISIONS, readerFor('trust', real, row).string('decision'));
  };
  return {
    get: (target): TrustDecision | undefined => decisionAt(fs.realpathSync.native(target)),
    decisionFor: (target) => {
      let start: string;
      try {
        start = fs.realpathSync.native(target);
      } catch {
        return { decision: null };
      }
      for (let current = start; ; current = path.dirname(current)) {
        const decision = decisionAt(current);
        const exactOnly = comparableContains(current, home);
        if (decision !== undefined && (current === start || !exactOnly)) {
          return current === start ? { decision } : { decision, inheritedFrom: current };
        }
        if (path.dirname(current) === current) return { decision: null };
      }
    },
    set: (target, decision) => {
      const real = fs.realpathSync.native(target);
      if (decision === 'trusted' && path.dirname(real) === real) {
        throw new Error(`trust: refusing to trust the filesystem root ${real}`);
      }
      upsert.run({ path: real, decision, decidedAt: clock.now() });
    },
    clear: (target) => {
      const resolved = fs.existsSync(target) ? fs.realpathSync.native(target) : path.resolve(target);
      remove.run({ path: resolved });
    },
  };
};
