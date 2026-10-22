import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '@momonga/foundation';
import { expectOneOf, readerFor } from './rows.ts';
import type { TrustDecision, TrustStore } from './types.ts';

const DECISIONS = ['trusted', 'untrusted'] as const;

export const createTrustStore = (db: DatabaseSync, clock: Clock): TrustStore => {
  const select = db.prepare('SELECT * FROM trust WHERE path = :path');
  const upsert = db.prepare(
    `INSERT INTO trust (path, decision, decided_at) VALUES (:path, :decision, :decidedAt)
     ON CONFLICT (path) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at`,
  );
  return {
    get: (path): TrustDecision | undefined => {
      const real = fs.realpathSync(path);
      const row = select.get({ path: real });
      if (row === undefined) return undefined;
      return expectOneOf('trust', real, 'decision', DECISIONS, readerFor('trust', real, row).string('decision'));
    },
    set: (path, decision) => {
      upsert.run({ path: fs.realpathSync(path), decision, decidedAt: clock.now() });
    },
  };
};
