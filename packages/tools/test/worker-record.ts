export type WorkerRecord = { exited: boolean };

export const recordedWorkers = { started: [] as WorkerRecord[], onStart: undefined as (() => void) | undefined };

export const recordingWorkerModule = async (importOriginal: () => Promise<typeof import('node:worker_threads')>) => {
  const actual = await importOriginal();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      const record: WorkerRecord = { exited: false };
      recordedWorkers.started.push(record);
      this.once('exit', () => {
        record.exited = true;
      });
      recordedWorkers.onStart?.();
    }
  }
  return { ...actual, Worker: RecordedWorker, default: { ...actual, Worker: RecordedWorker } };
};
