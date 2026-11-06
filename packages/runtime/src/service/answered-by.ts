import type { AnsweredByView } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { readTargets } from '../worker/pins.ts';
import type { TargetPin } from '../worker/pins.ts';

const TARGET_UNKNOWN = 'unknown' as const;

export const answeredByOf = (store: Pick<RuntimeStore, 'readRunEventsOfTypes'>, runId: string): AnsweredByView[] => {
  const started = store.readRunEventsOfTypes(runId, ['run.started']).at(-1);
  if (started === undefined || started.type !== 'run.started') throw new Error(`run ${runId} has not recorded run.started, so it pinned no targets`);
  const pinned = started.pins['targets'];
  if (pinned === undefined) throw new Error(`run ${runId} pinned no targets, so it does not record what answered`);
  const pins: Record<string, TargetPin> = readTargets(pinned);
  const answering = new Set(
    store.readRunEventsOfTypes(runId, ['meter.observed']).flatMap((event) => (event.type === 'meter.observed' ? [event.target] : [])),
  );
  return [...answering].sort().map((target) => {
    const pin = pins[target];
    if (pin === undefined) throw new Error(`run ${runId} was answered by target ${target}, which its pins do not list`);
    return { target, adapter: pin.adapter, upstreamModel: pin.model, answers: pin.answers ?? TARGET_UNKNOWN };
  });
};
