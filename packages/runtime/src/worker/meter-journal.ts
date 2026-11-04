import { foldMeter } from '@momonga/context';
import type { MeterMemory } from '@momonga/context';
import type { Capabilities, RunEventPayload } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { isRecord } from './json.ts';

type RequestedEvent = Extract<RunEventPayload, { type: 'model.requested' }>;

export const meterEventsOf = (store: RuntimeStore, sessionId: string, alias: string): RunEventPayload[] => {
  const paired: RunEventPayload[] = [];
  for (const run of store.listRuns(sessionId)) {
    let requested: RequestedEvent | undefined;
    let pushed: RequestedEvent | undefined;
    for (const event of store.readRunEventsOfTypes(run.id, ['model.requested', 'meter.observed'])) {
      if (event.type === 'model.requested') {
        requested = isRecord(event.body) && event.body['model'] === alias ? event : undefined;
      } else if (event.type === 'meter.observed' && requested !== undefined) {
        if (requested !== pushed) paired.push(requested);
        pushed = requested;
        paired.push(event);
      }
    }
  }
  return paired;
};

export const foldMeterFor = (events: readonly RunEventPayload[], capabilities: Capabilities, fallbackTarget?: string): MeterMemory =>
  foldMeter(events, { capabilities, ...(fallbackTarget === undefined ? {} : { fallbackTarget }) });
