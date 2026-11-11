import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type Clock, answeredLater, askedPaths, createPathResolver, settledOrAborted } from '@momonga/foundation';
import type { PathAsking, PathFileSystem } from '@momonga/foundation';
import { readerFor, storedOneOf } from './rows.ts';
import type { DecodeContext } from './decode-context.ts';
import type { StoredTrustDecision, TrustAnswer, TrustDecision, TrustStore } from './types.ts';

const DECISIONS = ['trusted', 'untrusted'] as const;

const isNotFound = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

export const createTrustStore = (db: DatabaseSync, clock: Clock, home: string, context: DecodeContext, fileSystem: PathFileSystem): TrustStore => {
  const select = db.prepare('SELECT * FROM trust WHERE path = :path');
  const upsert = db.prepare(
    `INSERT INTO trust (path, decision, decided_at) VALUES (:path, :decision, :decidedAt)
     ON CONFLICT (path) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at`,
  );
  const remove = db.prepare('DELETE FROM trust WHERE path = :path');
  const decisionAt = (real: string): StoredTrustDecision | undefined => {
    const row = select.get({ path: real });
    if (row === undefined) return undefined;
    return storedOneOf(context, 'trust', real, 'decision', DECISIONS, readerFor('trust', real, row).string('decision'));
  };
  function* resolvedThroughExistingPart(target: string): PathAsking<string> {
    const missing: string[] = [];
    for (let current = path.resolve(target); ; current = path.dirname(current)) {
      try {
        return path.join(yield* askedPaths.realPath(current), ...missing);
      } catch (error) {
        if (!isNotFound(error) || path.dirname(current) === current) throw error;
        missing.unshift(path.basename(current));
      }
    }
  }
  function* deciding(target: string): PathAsking<TrustAnswer> {
    const start = yield* resolvedThroughExistingPart(target);
    for (let current = start; ; current = path.dirname(current)) {
      const decision = decisionAt(current);
      const exactOnly = yield* askedPaths.comparableContains(current, home);
      if (decision !== undefined && (current === start || !exactOnly)) {
        return current === start ? { decision } : { decision, inheritedFrom: current };
      }
      if (path.dirname(current) === current) return { decision: null };
    }
  }
  function* setting(target: string, decision: TrustDecision): PathAsking<void> {
    const real = yield* askedPaths.realPath(target);
    if (decision === 'trusted' && path.dirname(real) === real) {
      throw new Error(`trust: refusing to trust the filesystem root ${real}`);
    }
    upsert.run({ path: real, decision, decidedAt: clock.now() });
  }
  return {
    decisionAsked: (target, signal) => answeredLater(deciding(target), createPathResolver(fileSystem, signal), signal),
    setAsked: (target, decision, signal) => answeredLater(setting(target, decision), createPathResolver(fileSystem, signal), signal),
    clearAsked: async (target, signal) => {
      const present = await settledOrAborted(
        fileSystem.access(target, 'exists').then(
          () => true,
          (error: unknown) => {
            if (isNotFound(error)) return false;
            throw error;
          },
        ),
        signal,
      );
      const resolved = present ? await createPathResolver(fileSystem, signal).realPath(target) : path.resolve(target);
      remove.run({ path: resolved });
    },
  };
};
