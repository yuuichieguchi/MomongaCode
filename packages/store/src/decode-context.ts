import type { DatabaseSync } from 'node:sqlite';
import { highestAppliedMigration } from '@momonga/foundation';
import { MIGRATIONS } from './schema.ts';

export type DecodeContext = { databaseIsNewer(): boolean };

export const decodeContextOf = (db: DatabaseSync): DecodeContext => ({ databaseIsNewer: () => highestAppliedMigration(db) > MIGRATIONS.length });

export const DATABASE_NOT_NEWER: DecodeContext = { databaseIsNewer: () => false };
