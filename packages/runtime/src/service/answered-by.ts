import type { AnsweredByView } from '@momonga/protocol';
import { UNKNOWN_ANSWERER } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { readTargets } from '../worker/pins.ts';
import type { TargetPin } from '../worker/pins.ts';

export const answeredByOf = async (store: Pick<RuntimeStore, 'readRunEventsOfTypes' | 'answeringTargetsOf'>, runId: string): Promise<AnsweredByView[]> => {
  const started = store.readRunEventsOfTypes(runId, ['run.started']).at(-1);
  if (started === undefined || started.type !== 'run.started') throw new Error(`run ${runId} has not recorded run.started, so it pinned no targets`);
  const pinned = started.pins['targets'];
  if (pinned === undefined) throw new Error(`run ${runId} pinned no targets, so it does not record what answered`);
  const pins: Record<string, TargetPin> = readTargets(pinned);
  return (await store.answeringTargetsOf(runId)).map((target) => {
    if (target === UNKNOWN_ANSWERER) return { target, answers: UNKNOWN_ANSWERER };
    const pin = pins[target];
    if (pin === undefined) throw new Error(`run ${runId} was answered by target ${target}, which its pins do not list`);
    return { target, adapter: pin.adapter, upstreamModel: pin.model, answers: pin.answers ?? UNKNOWN_ANSWERER };
  });
};
