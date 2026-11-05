import { meterMemoryOf } from '@momonga/context';
import type { MeterMemory, ObservedEvent } from '@momonga/context';
import type { Capabilities, RunEvent } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { isRecord } from './json.ts';

type ObservedRunEvent = Extract<RunEvent, { type: 'meter.observed' }>;

export const foldMeterFor = (store: RuntimeStore, sessionId: string, capabilities: Capabilities, counter: string): MeterMemory => {
  const record = store.meterRecordOf(sessionId, {
    counter,
    contextWindow: capabilities.contextWindow,
    ...(capabilities.tokenErrorRatio === undefined ? {} : { tokenErrorRatio: capabilities.tokenErrorRatio }),
    tokenCounting: capabilities.tokenCounting,
  });
  return meterMemoryOf(record === undefined ? undefined : { event: { ...record.event, runId: record.runId, seq: record.seq } as ObservedEvent, misses: record.misses }, (event: ObservedEvent) => {
    const { runId, seq } = event as ObservedRunEvent;
    const requested = store.readLatestRunEventBefore(runId, 'model.requested', seq);
    if (requested === undefined || !isRecord(requested.body)) throw new Error(`run ${runId} has no model.requested before its meter.observed at seq ${seq}`);
    return requested.body;
  });
};
