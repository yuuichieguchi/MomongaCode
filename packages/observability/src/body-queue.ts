import { reportError } from './errors.ts';
import type { BodyRecord } from './trace-store.ts';

export type BodyQueueLimits = { maxEntries: number; maxBytes: number };

export type BodyQueue = {
  push(record: BodyRecord): void;
  drain(): BodyRecord[];
  close(reason: string): void;
};

export const createBodyQueue = (limits: BodyQueueLimits): BodyQueue => {
  let pending: BodyRecord[] = [];
  let pendingBytes = 0;
  let overflowDrops = 0;
  let closedReason: string | undefined;
  let closedDrops = 0;
  let closedReportScheduled = false;

  const dropAfterClose = (reason: string): void => {
    closedDrops += 1;
    if (closedReportScheduled) return;
    closedReportScheduled = true;
    queueMicrotask(() => {
      const dropped = closedDrops;
      closedDrops = 0;
      closedReportScheduled = false;
      reportError(new Error(`${reason}; dropped ${dropped} bodies`));
    });
  };

  return {
    push: (record) => {
      if (closedReason !== undefined) {
        dropAfterClose(closedReason);
        return;
      }
      const size = Buffer.byteLength(record.content, 'utf8');
      if (pending.length >= limits.maxEntries || pendingBytes + size > limits.maxBytes) {
        overflowDrops += 1;
        return;
      }
      pending.push(record);
      pendingBytes += size;
    },
    drain: () => {
      if (overflowDrops > 0) {
        const dropped = overflowDrops;
        overflowDrops = 0;
        reportError(new Error(`dropped ${dropped} bodies since last export`));
      }
      const drained = pending;
      pending = [];
      pendingBytes = 0;
      return drained;
    },
    close: (reason) => {
      closedReason = reason;
    },
  };
};
