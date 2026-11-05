import fs from 'node:fs';
import { MessagePort, isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';
import { openDatabase } from '@momonga/foundation';

export const openJournalConnection = (databasePath: string): ReturnType<typeof openDatabase> => {
  const db = openDatabase(databasePath);
  try {
    db.exec('PRAGMA query_only = ON');
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
};

type JournalThreadData = { readonly databasePath: string; readonly port: MessagePort };

const isJournalThreadData = (value: unknown): value is JournalThreadData =>
  typeof value === 'object' && value !== null && typeof (value as { databasePath?: unknown }).databasePath === 'string' && (value as { port?: unknown }).port instanceof MessagePort;

const requestOf = (message: unknown): { readonly id: number; readonly kind: string } => {
  const { id, kind } = message as { id?: unknown; kind?: unknown };
  if (typeof id !== 'number' || typeof kind !== 'string') throw new TypeError('journal thread request must carry a numeric id and a string kind');
  return { id, kind };
};

const serve = (data: JournalThreadData): void => {
  if (parentPort === null) throw new Error('journal thread has no parent port');
  const db = openJournalConnection(data.databasePath);
  const stat = fs.statSync(data.databasePath);
  parentPort.on('message', (message: unknown) => {
    const { id, kind } = requestOf(message);
    if (kind === 'ping') {
      data.port.postMessage({ id, ok: true, threadId });
      return;
    }
    data.port.postMessage({ id, ok: false, error: { name: 'JournalThreadRequestError', message: `unknown journal thread request kind ${JSON.stringify(kind)}` } });
  });
  parentPort.on('close', () => db.close());
  data.port.postMessage({ ready: true, dev: stat.dev, ino: stat.ino });
};

if (!isMainThread && isJournalThreadData(workerData)) serve(workerData);
