import { foldMeter } from '@momonga/context';
import type { MeterMemory, ObservedEvent } from '@momonga/context';
import type { Capabilities, RunEvent } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { isRecord } from './json.ts';

type ObservedRunEvent = Extract<RunEvent, { type: 'meter.observed' }>;

const aliasOfRun = (store: RuntimeStore, runId: string): string | undefined => {
  const started = store.readRunEventsOfTypes(runId, ['run.started'])[0];
  if (started?.type !== 'run.started') return undefined;
  const alias = started.pins['modelAlias'];
  if (typeof alias !== 'string') throw new Error(`run ${runId} recorded run.started without a model alias pin`);
  return alias;
};

export const meterEventsOf = (store: RuntimeStore, sessionId: string, alias: string): ObservedRunEvent[] =>
  store.listRuns(sessionId).flatMap((run) => {
    const observed = store.readRunEventsOfTypes(run.id, ['meter.observed']).filter((event): event is ObservedRunEvent => event.type === 'meter.observed');
    return observed.length > 0 && aliasOfRun(store, run.id) === alias ? observed : [];
  });

export const foldMeterFor = (store: RuntimeStore, events: readonly ObservedRunEvent[], capabilities: Capabilities, fallbackTarget?: string): MeterMemory =>
  foldMeter(events, {
    capabilities,
    ...(fallbackTarget === undefined ? {} : { fallbackTarget }),
    bodyOf: (event: ObservedEvent) => {
      const { runId, seq } = event as ObservedRunEvent;
      const requested = store.readLatestRunEventBefore(runId, 'model.requested', seq);
      if (requested === undefined || !isRecord(requested.body)) throw new Error(`run ${runId} has no model.requested before its meter.observed at seq ${seq}`);
      return requested.body;
    },
  });
