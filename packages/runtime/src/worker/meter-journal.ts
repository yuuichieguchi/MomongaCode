import { foldMeter } from '@momonga/context';
import type { MeterMemory, ObservedEvent } from '@momonga/context';
import type { Capabilities, RunEvent } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { isRecord } from './json.ts';

type ObservedRunEvent = Extract<RunEvent, { type: 'meter.observed' }>;

export const meterEventsOf = (store: RuntimeStore, sessionId: string): ObservedRunEvent[] =>
  store
    .listRuns(sessionId)
    .flatMap((run) => store.readRunEventsOfTypes(run.id, ['meter.observed']).filter((event): event is ObservedRunEvent => event.type === 'meter.observed'));

export const foldMeterFor = (store: RuntimeStore, events: readonly ObservedRunEvent[], capabilities: Capabilities, counter: string): MeterMemory =>
  foldMeter(events, {
    counter,
    capabilities,
    bodyOf: (event: ObservedEvent) => {
      const { runId, seq } = event as ObservedRunEvent;
      const requested = store.readLatestRunEventBefore(runId, 'model.requested', seq);
      if (requested === undefined || !isRecord(requested.body)) throw new Error(`run ${runId} has no model.requested before its meter.observed at seq ${seq}`);
      return requested.body;
    },
  });
