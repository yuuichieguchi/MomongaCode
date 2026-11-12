import { Worker } from 'node:worker_threads';
import type { CommitRequest, CompactionCommit, RecordedSend, SendRecord, StoreDatabase, StoredCompaction, StoredIdempotency } from './store-database.ts';
import type { StoreOperation, StoreReply, StoreRequest } from './store-worker.ts';

export { MIGRATIONS } from './store-database.ts';
export type { CommitRequest, CompactionCommit, RecordedSend, SendRecord, StoredCompaction, StoredIdempotency } from './store-database.ts';

export const STORE_QUEUE_LENGTH = 256;

export class StoreWorkerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreWorkerError';
  }
}

export type GatewayStore = {
  getIdempotency(key: string, signal: AbortSignal): Promise<StoredIdempotency | undefined>;
  deleteIdempotency(key: string, signal: AbortSignal): Promise<void>;
  commit(request: CommitRequest, signal: AbortSignal): Promise<void>;
  recordSend(send: SendRecord, signal: AbortSignal): Promise<RecordedSend>;
  getCompaction(key: string, signal: AbortSignal): Promise<StoredCompaction | undefined>;
  deleteCompaction(key: string, signal: AbortSignal): Promise<void>;
  commitCompaction(commit: CompactionCommit, signal: AbortSignal): Promise<void>;
  close(forced: AbortSignal): Promise<void>;
};

export type GatewayStoreOptions = { dbPath: string; code: string; signal: AbortSignal };

type Waiting = { resolve(value: unknown): void; reject(error: unknown): void; settle(): void };

type Asked = { kind: 'open'; dbPath: string } | { kind: 'close' } | { kind: StoreOperation; argument: unknown };

const isReply = (value: unknown): value is StoreReply =>
  typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'number' && typeof (value as { ok?: unknown }).ok === 'boolean';

type Results = { [K in StoreOperation]: ReturnType<StoreDatabase[K]> };

export const openGatewayStore = async ({ dbPath, code, signal }: GatewayStoreOptions): Promise<GatewayStore> => {
  const worker = new Worker(code, { eval: true });
  const waiting = new Map<number, Waiting>();
  let nextId = 0;
  let failure: StoreWorkerError | undefined;

  const failAll = (error: StoreWorkerError): void => {
    failure = error;
    for (const entry of waiting.values()) {
      entry.settle();
      entry.reject(error);
    }
    waiting.clear();
  };

  worker.on('message', (reply: unknown) => {
    if (!isReply(reply)) {
      failAll(new StoreWorkerError('the store thread sent a message that is not a reply'));
      return;
    }
    const entry = waiting.get(reply.id);
    if (entry === undefined) return;
    waiting.delete(reply.id);
    entry.settle();
    if (reply.ok) entry.resolve(reply.value);
    else entry.reject(new Error(reply.message));
  });
  worker.on('error', (error: Error) => failAll(new StoreWorkerError(`the store thread failed: ${error.message}`, { cause: error })));
  worker.on('exit', (exitCode: number) => failAll(new StoreWorkerError(`the store thread exited with code ${exitCode}`)));

  const ask = (asked: Asked, asker: AbortSignal): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      if (asker.aborted) {
        reject(asker.reason);
        return;
      }
      if (waiting.size >= STORE_QUEUE_LENGTH) {
        reject(new StoreWorkerError(`the store has ${STORE_QUEUE_LENGTH} requests waiting and takes no more`));
        return;
      }
      nextId += 1;
      const id = nextId;
      const onAbort = (): void => {
        waiting.delete(id);
        reject(asker.reason);
      };
      asker.addEventListener('abort', onAbort, { once: true });
      waiting.set(id, { resolve, reject, settle: () => asker.removeEventListener('abort', onAbort) });
      const request: StoreRequest = { id, ...asked };
      worker.postMessage(request);
    });

  const operation =
    <K extends StoreOperation>(kind: K) =>
    async (argument: Parameters<StoreDatabase[K]>[0], asker: AbortSignal): Promise<Results[K]> =>
      (await ask({ kind, argument }, asker)) as Results[K];

  const terminate = async (): Promise<void> => {
    worker.removeAllListeners('exit');
    await worker.terminate();
  };

  try {
    await ask({ kind: 'open', dbPath }, signal);
  } catch (error) {
    await terminate();
    throw error;
  }

  const closedOrForced = (forced: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onForced = (): void => resolve();
      forced.addEventListener('abort', onForced, { once: true });
      ask({ kind: 'close' }, new AbortController().signal).then(
        () => {
          forced.removeEventListener('abort', onForced);
          resolve();
        },
        (error: unknown) => {
          forced.removeEventListener('abort', onForced);
          reject(error);
        },
      );
    });

  let closing: Promise<void> | undefined;
  return {
    getIdempotency: operation('getIdempotency'),
    deleteIdempotency: operation('deleteIdempotency'),
    commit: operation('commit'),
    recordSend: operation('recordSend'),
    getCompaction: operation('getCompaction'),
    deleteCompaction: operation('deleteCompaction'),
    commitCompaction: operation('commitCompaction'),
    close: (forced) => {
      closing ??= (async () => {
        try {
          if (failure === undefined && !forced.aborted) await closedOrForced(forced);
        } finally {
          await terminate();
        }
      })();
      return closing;
    },
  };
};
