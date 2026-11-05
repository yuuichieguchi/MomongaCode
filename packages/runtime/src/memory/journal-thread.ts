import fs from 'node:fs';
import { MessagePort, isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';
import { openDatabase } from '@momonga/foundation/sqlite';

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

export type JournalRequest = Readonly<Record<string, unknown>>;
export type JournalReplyFields = Readonly<Record<string, unknown>>;
export type JournalHandler = (request: JournalRequest) => JournalReplyFields | Promise<JournalReplyFields>;

export type JournalChannel = {
  readonly incoming: { on(event: 'message', listener: (message: unknown) => void): unknown };
  readonly outgoing: { postMessage(message: unknown): void };
};

const requestOf = (message: unknown): { readonly id: number; readonly kind: string; readonly request: JournalRequest } => {
  const request = message as { id?: unknown; kind?: unknown };
  if (typeof request.id !== 'number' || typeof request.kind !== 'string') throw new TypeError('journal thread request must carry a numeric id and a string kind');
  return { id: request.id, kind: request.kind, request: request as JournalRequest };
};

const errorOf = (error: unknown): { name: string; message: string } =>
  error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) };

export const serveJournalReader = (handlers: Readonly<Record<string, JournalHandler>>, { incoming, outgoing }: JournalChannel): void => {
  incoming.on('message', (message: unknown) => {
    const { id, kind, request } = requestOf(message);
    const handler = Object.hasOwn(handlers, kind) ? handlers[kind] : undefined;
    if (handler === undefined) {
      outgoing.postMessage({ id, ok: false, error: { name: 'JournalThreadRequestError', message: `unknown journal thread request kind ${JSON.stringify(kind)}` } });
      return;
    }
    void (async () => {
      try {
        outgoing.postMessage({ ...(await handler(request)), id, ok: true });
      } catch (error) {
        outgoing.postMessage({ id, ok: false, error: errorOf(error) });
      }
    })();
  });
};

type JournalThreadData = { readonly databasePath: string; readonly port: MessagePort };

const isJournalThreadData = (value: unknown): value is JournalThreadData =>
  typeof value === 'object' && value !== null && typeof (value as { databasePath?: unknown }).databasePath === 'string' && (value as { port?: unknown }).port instanceof MessagePort;

const identityOf = (databasePath: string): { readonly dev: number; readonly ino: number } => {
  const { dev, ino } = fs.statSync(databasePath);
  return { dev, ino };
};

const serve = (data: JournalThreadData): void => {
  if (parentPort === null) throw new Error('journal thread has no parent port');
  const before = identityOf(data.databasePath);
  const db = openJournalConnection(data.databasePath);
  const after = identityOf(data.databasePath);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    db.close();
    throw new Error(`database file ${data.databasePath} was replaced while the journal thread opened it`);
  }
  serveJournalReader({ ping: () => ({ threadId }) }, { incoming: parentPort, outgoing: data.port });
  parentPort.on('close', () => db.close());
  data.port.postMessage({ ready: true, dev: after.dev, ino: after.ino });
};

if (!isMainThread && isJournalThreadData(workerData)) serve(workerData);
