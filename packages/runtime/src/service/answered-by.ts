import type { AnsweredByView } from '@momonga/protocol';
import { UNKNOWN_ANSWERER } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { readTargets } from '../worker/pins.ts';
import type { TargetPin } from '../worker/pins.ts';

export const answeredByOf = async (store: Pick<RuntimeStore, 'readRunEventsOfTypes' | 'answeringTargetsOf'>, runId: string): Promise<AnsweredByView[]> => {
  const started = store.readRunEventsOfTypes(runId, ['run.started']).at(-1);
  const pinned = started?.type === 'run.started' ? started.pins['targets'] : undefined;
  const pins: Record<string, TargetPin> = pinned === undefined ? {} : readTargets(pinned);
  return (await store.answeringTargetsOf(runId)).map((target) => {
    if (target === UNKNOWN_ANSWERER) return { target, answers: UNKNOWN_ANSWERER };
    const pin = Object.hasOwn(pins, target) ? pins[target] : undefined;
    if (pin === undefined) return { target, answers: UNKNOWN_ANSWERER };
    return { target, adapter: pin.adapter, upstreamModel: pin.model, answers: pin.answers ?? UNKNOWN_ANSWERER };
  });
};
