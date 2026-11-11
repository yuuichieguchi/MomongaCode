import { parentPort, workerData } from 'node:worker_threads';
import { openJournalConnection } from '../../../src/memory/journal-thread.ts';
import { BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';

const { databasePath } = workerData as { databasePath: string };
const db = openJournalConnection(databasePath, BUSY_WAIT_LIMIT_MS);
const pragmas = { journalMode: db.prepare('PRAGMA journal_mode').get()?.['journal_mode'], queryOnly: db.prepare('PRAGMA query_only').get()?.['query_only'] };
let insert: { threw: boolean; message: string };
try {
  db.exec(`INSERT INTO events (payload_json) VALUES ('{}')`);
  insert = { threw: false, message: '' };
} catch (error) {
  insert = { threw: true, message: (error as Error).message };
}
db.close();
parentPort?.postMessage({ ...pragmas, insert });
