import { parentPort } from 'node:worker_threads';
import { openStoreDatabase } from './store-database.ts';
import type { StoreDatabase } from './store-database.ts';
import { createStoredDataChecks } from './validation.ts';

export type StoreOperation = Exclude<keyof StoreDatabase, 'close'>;

export type StoreRequest = { id: number; kind: 'open'; dbPath: string } | { id: number; kind: 'close' } | { id: number; kind: StoreOperation; argument: unknown };

export type StoreReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; message: string };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const serve = (port: NonNullable<typeof parentPort>): void => {
  let database: StoreDatabase | undefined;
  const opened = (): StoreDatabase => {
    if (database === undefined) throw new Error('the store thread was asked before its database was opened');
    return database;
  };
  const answer = (request: StoreRequest): unknown => {
    if (request.kind === 'open') {
      database = openStoreDatabase(request.dbPath, createStoredDataChecks());
      return undefined;
    }
    if (request.kind === 'close') {
      opened().close();
      database = undefined;
      return undefined;
    }
    const operation = opened()[request.kind] as (argument: unknown) => unknown;
    return operation(request.argument);
  };
  port.on('message', (request: StoreRequest) => {
    let reply: StoreReply;
    try {
      reply = { id: request.id, ok: true, value: answer(request) };
    } catch (error) {
      reply = { id: request.id, ok: false, message: messageOf(error) };
    }
    port.postMessage(reply);
  });
};

if (parentPort !== null) serve(parentPort);
